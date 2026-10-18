import { describe, expect, it } from 'vitest';
import { CitySim, createCity } from '../src/sim/CitySim';
import { airportOf } from '../src/sim/command';
import { FLEET, spare } from '../src/sim/logistics';
import { issueRequests, openRequests } from '../src/sim/requests';
import { districtOfEdge, EDGES } from '../src/sim/traffic';
import type { CityState } from '../src/sim/types';

const named = (s: CityState, name: string) => s.districts.find((d) => d.name === name)!;

/** A city with the JOC up, the airport stocked, and every district well supplied but `short`. */
function stocked(seed: string, short: string[] = []): CityState {
  const s = createCity(seed);
  s.flags.joc = true;
  const airport = airportOf(s);
  airport.medicine = 30000;
  for (const d of s.districts) {
    if (d.kind === 'airbase') continue;
    d.medicine = short.includes(d.name) ? 0 : 1e6;
    d.rations = 1e7;
  }
  // On the hour, when the trucks go out (08:00, after the morning supply flight).
  s.t = Math.ceil(s.t / 60) * 60 + 120;
  return s;
}

describe('Army supply trucks', () => {
  it('carry the airport\'s medicine out to the district that has run out, and come back', () => {
    const s = stocked('medicine', ['Eastside']);
    const eastside = named(s, 'Eastside');
    const airport = airportOf(s);
    const before = airport.medicine;
    const sim = new CitySim(s);
    sim.step(1);
    const runs = s.logistics.runs.filter((r) => r.to === eastside.id);
    expect(runs.length).toBeGreaterThan(0);
    expect(airport.medicine).toBeLessThan(before);
    // The airport keeps some back for the helicopters' crates.
    expect(spare(s).medicine).toBeGreaterThanOrEqual(0);
    const arrive = Math.max(...runs.map((r) => r.arrive));
    sim.step(arrive - s.t + 1);
    expect(eastside.medicine).toBeGreaterThan(0);
    expect(s.log.some((e) => /Army trucks delivered .* medicine .* to Eastside/.test(e.text))).toBe(true);
    // Then they drive back, and are free again.
    const ids = runs.map((r) => r.id);
    expect(s.logistics.runs.filter((r) => ids.includes(r.id)).every((r) => r.phase === 'back')).toBe(true);
    const home = Math.max(...s.logistics.runs.filter((r) => ids.includes(r.id)).map((r) => r.arrive));
    sim.step(home - s.t + 1);
    expect(s.logistics.runs.filter((r) => ids.includes(r.id))).toHaveLength(0);
  });

  it('go to the district the player puts first', () => {
    const s = stocked('priority', ['Eastside', 'Westfield', 'Northside', 'Southgate', 'Harbor', 'Riverside', 'Downtown', 'Market District', 'University Heights']);
    const southgate = named(s, 'Southgate');
    const sim = new CitySim(s);
    expect(sim.command({ type: 'setSupplyPriority', district: southgate.id })).toBe(true);
    sim.step(1);
    expect(s.logistics.runs[0].to).toBe(southgate.id);
    expect(s.logistics.runs.length).toBeLessThanOrEqual(FLEET);
  });

  it('can\'t reach a district whose roads are blocked: Command asks for it to be supplied by air', () => {
    const s = stocked('cut', ['Westfield']);
    const westfield = named(s, 'Westfield');
    westfield.flags.outbreak = true;
    westfield.infected = 50;
    for (let e = 0; e < EDGES; e++) if (districtOfEdge(e) === westfield.id) s.traffic.blocked[e] = 1;
    const sim = new CitySim(s);
    sim.step(1);
    expect(s.logistics.cutOff).toContain(westfield.id);
    expect(s.logistics.runs.some((r) => r.to === westfield.id)).toBe(false);
    s.requests = [];
    issueRequests(s, () => {});
    const r = openRequests(s)[0];
    expect(r.district).toBe(westfield.id);
    expect(r.title).toMatch(/roads are cut/);
  });

  it('wait for stock: with the stores empty, nothing goes out', () => {
    const s = stocked('empty', ['Eastside']);
    airportOf(s).medicine = 0;
    new CitySim(s).step(1);
    expect(s.logistics.runs.filter((r) => r.cargo.medicine > 0)).toHaveLength(0);
  });
});
