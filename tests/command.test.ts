import { describe, expect, it } from 'vitest';
import { CitySim, createCity } from '../src/sim/CitySim';
import { airportOf, hubOf } from '../src/sim/command';
import { fortification, WORKS_STAGES } from '../src/sim/convoys';
import { AIRPORT_STAFF } from '../src/sim/layout';
import type { CityState } from '../src/sim/types';

const named = (s: CityState, name: string) => s.districts.find((d) => d.name === name)!;

/** Confirm outbreaks in two districts so Command authorizes the JOC. */
function spreading(s: CityState): void {
  for (const name of ['Westfield', 'Eastside']) {
    const d = named(s, name);
    d.flags.outbreak = true;
  }
}

describe('the military response', () => {
  it('starts with the army at Camp Ridgeway and the city held by its police alone', () => {
    const s = createCity('start');
    expect(s.army.troops.strength).toBeGreaterThan(1000);
    for (const d of s.districts) expect(d.troops.strength).toBe(0);
    expect(named(s, 'Downtown').police.officers).toBeGreaterThan(0);
    expect(hubOf(s)).toBe(s.army);
    // An airport's worth of staff, not a town.
    expect(airportOf(s).population).toBe(AIRPORT_STAFF);
  });

  it('holds troops back until the JOC is set up, which the player flies in', () => {
    const sim = new CitySim('joc');
    expect(sim.command({ type: 'loadTroop', at: 'army' })).toBe(false);
    expect(sim.command({ type: 'loadCommandTeam' })).toBe(false);
    spreading(sim.state);
    sim.step(60);
    expect(sim.state.flags.jocAuthorized).toBe(true);
    expect(sim.command({ type: 'loadCommandTeam' })).toBe(true);
    expect(sim.command({ type: 'establishJoc' })).toBe(true);
    expect(sim.state.flags.joc).toBe(true);
    const airport = airportOf(sim.state);
    expect(hubOf(sim.state)).toBe(airport);
    expect(airport.troops.strength).toBeGreaterThan(300);
    expect(airport.features.fortified).toBe(true);
    expect(sim.command({ type: 'loadTroop', at: 'airport' })).toBe(true);
  });

  it('flies its own command team in if nobody does', () => {
    const sim = new CitySim('fallback');
    spreading(sim.state);
    sim.step(60);
    expect(sim.state.flags.joc).toBeFalsy();
    sim.step(12 * 60);
    expect(sim.state.flags.joc).toBe(true);
  });

  it('pushes a platoon into each district once the JOC is up', () => {
    const sim = new CitySim('platoons');
    spreading(sim.state);
    sim.step(60);
    sim.command({ type: 'loadCommandTeam' });
    sim.command({ type: 'establishJoc' });
    sim.step(6 * 60);
    const deployed = sim.state.districts.filter((d) => d.kind !== 'airbase' && d.troops.strength > 0).length;
    expect(deployed).toBeGreaterThanOrEqual(5);
  });

  it('keeps refugees out of the airport and flies evacuees out of the city', () => {
    const s = createCity('airport');
    const airport = airportOf(s);
    // Fear in the district next door: people flee, but not to the closed airport.
    const next = named(s, 'Westfield');
    next.zombies = 8000;
    new CitySim(s).step(180);
    expect(airport.population).toBeLessThanOrEqual(AIRPORT_STAFF);

    const sim = new CitySim('flights');
    spreading(sim.state);
    sim.step(60);
    sim.command({ type: 'loadCommandTeam' });
    sim.command({ type: 'establishJoc' });
    const a = airportOf(sim.state);
    a.population += 900;
    sim.step(600);
    expect(a.population).toBeLessThan(AIRPORT_STAFF + 900);
    expect(sim.state.stats.flownOut).toBeGreaterThan(0);
  });
});

describe('the police response', () => {
  it('escalates from patrols to checkpoints to supporting the army', () => {
    const sim = new CitySim('stages');
    const d = named(sim.state, 'Northside');
    expect(d.police.stage).toBe('patrol');
    d.flags.outbreak = true;
    d.zombies = 200;
    sim.step(2);
    expect(d.police.stage).toBe('checkpoints');
    d.troops.strength = 40;
    d.troops.ammo = 40 * 300;
    sim.step(2);
    expect(d.police.stage).toBe('support');
  });

  it('screens the bitten at checkpoints', () => {
    const run = (checkpoints: boolean) => {
      const s = createCity('screen');
      for (const x of s.districts) {
        x.zombies = 0;
        x.infected = 0;
      }
      const d = named(s, 'Southgate');
      d.infected = 500;
      if (checkpoints) {
        d.flags.outbreak = true;
        d.police.stage = 'checkpoints';
      }
      new CitySim(s).step(60);
      return d.infected;
    };
    expect(run(true)).toBeLessThan(run(false));
  });
});

describe('military convoys', () => {
  it('fortify the airport stage by stage and bring Camp Ridgeway\'s fuel and stores forward', () => {
    const sim = new CitySim('convoys');
    const s = sim.state;
    sim.step(120);
    expect(s.convoys).toHaveLength(0);
    spreading(s);
    sim.step(60);
    sim.command({ type: 'loadCommandTeam' });
    sim.command({ type: 'establishJoc' });
    const airport = airportOf(s);
    const fuel = airport.fuel;
    const campFuel = s.army.fuel;
    sim.step(5);
    expect(s.convoys.length).toBe(1);
    expect(s.convoys[0].kind).toBe('engineers');
    sim.step(12 * 60);
    expect(s.airportWorks).toBe(WORKS_STAGES);
    expect(airport.fuel).toBeGreaterThan(fuel);
    expect(s.army.fuel).toBeLessThan(campFuel);
    expect(s.log.some((e) => /razor wire/.test(e.text))).toBe(true);
    // Fortified, it holds better.
    expect(fortification(s, airport)).toBeGreaterThan(2);
  });
});
