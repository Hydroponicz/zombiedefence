import { describe, expect, it } from 'vitest';
import { CitySim, createCity } from '../src/sim/CitySim';
import { nextPlatoon } from '../src/sim/command';
import { issueRequests, openRequests, streetName } from '../src/sim/requests';
import type { CityState } from '../src/sim/types';

const named = (s: CityState, name: string) => s.districts.find((d) => d.name === name)!;
const quietEmit = () => {};

/** A calm city with nobody short of anything. */
function calm(seed: string): CityState {
  const s = createCity(seed);
  for (const d of s.districts) {
    d.zombies = 0;
    d.infected = 0;
    d.medicine = 1e6;
    d.rations = 1e7;
  }
  s.supply.trucks = [];
  return s;
}

describe('Command requests', () => {
  it('asks for medicine where an outbreak has emptied the shelves, and rewards the delivery', () => {
    const s = calm('medicine');
    const d = named(s, 'Westfield');
    d.flags.outbreak = true;
    d.medicine = 0;
    d.infected = 50;
    issueRequests(s, quietEmit);
    const r = openRequests(s)[0];
    expect(r.kind).toBe('supply');
    expect(r.crate).toBe('medicine');
    expect(r.district).toBe(d.id);
    expect(r.title).toMatch(/out of medicine/);

    const sim = new CitySim(s);
    const camp = s.army;
    const troops = camp.troops.strength;
    // Medicine goes to the place that asked: a pharmacy or shelter.
    expect(r.site).not.toBeNull();
    for (let k = 0; k < r.needed; k++) {
      expect(sim.command({ type: 'loadCrate', kind: 'medicine', at: 'army' })).toBe(true);
      expect(sim.command({ type: 'dropCrate', district: d.id, site: r.site! })).toBe(true);
    }
    expect(r.status).toBe('done');
    expect(camp.troops.strength).toBe(troops + 15);
  });

  it('fails a request that runs out of time, and does not repeat it straight away', () => {
    const s = calm('timeout');
    const d = named(s, 'Eastside');
    d.flags.outbreak = true;
    d.medicine = 0;
    d.infected = 50;
    const sim = new CitySim(s);
    sim.step(60);
    const r = s.requests[0];
    expect(r.status).toBe('open');
    sim.step(r.deadline - s.t + 1);
    expect(r.status).toBe('failed');
    expect(s.requests.filter((x) => x.district === d.id && x.kind === 'supply' && x.crate === 'medicine')).toHaveLength(1);
  });

  it('can be handed to an AI pilot, whose trip completes it', () => {
    const s = calm('assign');
    const d = named(s, 'Northside');
    d.scientists = 4;
    d.flags.outbreak = true;
    issueRequests(s, quietEmit);
    const r = openRequests(s).find((x) => x.kind === 'extract')!;
    expect(r).toBeTruthy();
    const sim = new CitySim(s);
    const pilot = s.pilots.find((p) => p.hired)!;
    expect(sim.command({ type: 'assignRequest', request: r.id, pilot: pilot.id })).toBe(true);
    const research = s.research;
    sim.step(150);
    expect(r.status).toBe('done');
    expect(d.scientists).toBeLessThan(1);
    expect(s.research).toBeGreaterThanOrEqual(research + 80);
  });

  it('counts people brought out of a besieged shelter', () => {
    const s = calm('shelter');
    const shelter = s.sites.find((x) => x.kind === 'shelter')!;
    const d = s.districts[shelter.district];
    shelter.status = 'besieged';
    shelter.sheltered = 40;
    d.sheltered = 40;
    issueRequests(s, quietEmit);
    const r = openRequests(s).find((x) => x.kind === 'evacuate')!;
    expect(r.site).toBe(shelter.id);
    const sim = new CitySim(s);
    for (let trip = 0; r.status === 'open' && trip < 10; trip++) {
      for (let k = 0; k < 8; k++) sim.command({ type: 'board', district: d.id, kind: 'civilian', site: shelter.id });
      sim.command({ type: 'unloadAtBase', at: 'army' });
    }
    expect(r.status).toBe('done');
    expect(s.pilots.some((p) => !p.hired)).toBe(true);
  });

  it('asks for overwatch of a food truck in danger, which keeps it safe and earns a helicopter', () => {
    const s = createCity('overwatch');
    const sim = new CitySim(s);
    // Wait for a truck with a way still to go, then make the city dangerous.
    for (let k = 0; k < 1440 && !s.supply.trucks.some((t) => t.arrive - s.t > 40); k++) sim.step(1);
    const truck = s.supply.trucks.find((t) => t.arrive - s.t > 40)!;
    s.requests = [];
    expect(truck).toBeTruthy();
    for (const d of s.districts) if (d.kind !== 'airbase') d.status = 'contested';
    for (let k = 0; k < 5; k++) issueRequests(s, quietEmit);
    const r = openRequests(s).find((x) => x.kind === 'overwatch' && x.truck === truck.id)!;
    expect(r.title).toMatch(/(Avenue|Street)/);
    const fleet = s.airframes.length;
    while (r.status === 'open') {
      sim.command({ type: 'overwatch', request: r.id });
      sim.step(1);
      for (const d of s.districts) if (d.kind !== 'airbase') d.status = 'contested';
    }
    expect(r.status).toBe('done');
    expect(s.airframes.length).toBe(fleet + 1);
  });

  it('names streets by their numbers', () => {
    expect(streetName(-2880, 0, 0)).toBe('1st Avenue');
    expect(streetName(0, -2160 + 120 * 11, Math.PI / 2)).toBe('12th Street');
  });
});

describe('platoon deployments', () => {
  it('go where the player sends them, else where Command chooses, and can be held', () => {
    const s = createCity('platoons');
    for (const name of ['Westfield', 'Eastside']) named(s, name).flags.outbreak = true;
    const sim = new CitySim(s);
    sim.step(60);
    sim.command({ type: 'loadCommandTeam' });
    sim.command({ type: 'establishJoc' });
    const southgate = named(s, 'Southgate');
    expect(nextPlatoon(s)!.chosenBy).toBe('command');
    expect(sim.command({ type: 'setPlatoon', target: southgate.id, hold: false })).toBe(true);
    expect(nextPlatoon(s)!.district).toBe(southgate);
    sim.step(61);
    expect(southgate.troops.strength).toBeGreaterThan(0);
    expect(s.platoonTarget).toBeNull();

    sim.command({ type: 'setPlatoon', target: null, hold: true });
    const deployed = s.districts.filter((d) => d.flags.armyDeployed).length;
    sim.step(180);
    expect(s.districts.filter((d) => d.flags.armyDeployed).length).toBe(deployed);
  });
});
