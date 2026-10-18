import { describe, expect, it } from 'vitest';
import { CitySim, createCity } from '../src/sim/CitySim';
import { CURFEW_FROM, foodPoints, foodRun, foodRunStart, foodSource, movement, policyCallDue, policyUnrest, travel } from '../src/sim/policy';
import type { CityState, Policy } from '../src/sim/types';

const quietEmit = () => {};
const named = (s: CityState, name: string) => s.districts.find((d) => d.name === name)!;
/** Game minute `minute` of the next day. */
const at = (s: CityState, minute: number) => (Math.floor(s.t / 1440) + 1) * 1440 + minute;

function decided(seed: string, policy: Policy): CityState {
  const s = createCity(seed);
  s.flags.jocAuthorized = true;
  s.flags.policyCall = true;
  s.flags.policyDecided = true;
  s.policy = policy;
  s.policySince = s.t;
  return s;
}

describe('Movement restrictions', () => {
  it('are put to the player once the infection spreads after the state of emergency', () => {
    const s = createCity('ask');
    const sim = new CitySim(s);
    // Nothing to put off before Command asks.
    expect(sim.command({ type: 'setPolicy', policy: null })).toBe(false);
    s.flags.jocAuthorized = true;
    s.army.cooldowns.jocAuthorized = s.t;
    for (const name of ['Westfield', 'Eastside', 'Northside']) named(s, name).flags.outbreak = true;
    sim.step(60);
    expect(policyCallDue(s)).toBe(true);
    // Standing by puts it off; Command asks again later.
    expect(sim.command({ type: 'setPolicy', policy: null })).toBe(true);
    expect(policyCallDue(s)).toBe(false);
    sim.step(121);
    expect(policyCallDue(s)).toBe(true);
    expect(sim.command({ type: 'setPolicy', policy: 'quarantine' })).toBe(true);
    expect(policyCallDue(s)).toBe(false);
    expect(s.policy).toBe('quarantine');
    // It can be changed later, but not put off again.
    expect(sim.command({ type: 'setPolicy', policy: null })).toBe(false);
    expect(sim.command({ type: 'setPolicy', policy: 'curfew' })).toBe(true);
    expect(s.policy).toBe('curfew');
  });

  it('can be ordered before Command asks, and then it doesn\'t', () => {
    const s = createCity('early');
    const sim = new CitySim(s);
    expect(sim.command({ type: 'setPolicy', policy: 'curfew' })).toBe(true);
    expect(s.policy).toBe('curfew');
    s.flags.jocAuthorized = true;
    for (const name of ['Westfield', 'Eastside', 'Northside']) named(s, name).flags.outbreak = true;
    sim.step(60);
    expect(policyCallDue(s)).toBe(false);
    expect(s.policy).toBe('curfew');
  });

  it('keep people in: a curfew outside its hours, a quarantine but for the food run', () => {
    const curfew = decided('hours', 'curfew');
    const d = named(curfew, 'Westfield');
    expect(movement(curfew, d, at(curfew, 9 * 60))).toBe(1);
    expect(movement(curfew, d, at(curfew, 22 * 60))).toBeLessThan(0.6);
    expect(movement(curfew, d, at(curfew, CURFEW_FROM - 1))).toBeLessThan(0.6);

    const quarantine = decided('hours', 'quarantine');
    const q = named(quarantine, 'Westfield');
    const run = foodRunStart(q);
    expect(movement(quarantine, q, at(quarantine, run + 30))).toBeGreaterThan(1);
    expect(movement(quarantine, q, at(quarantine, run + 180))).toBeLessThan(0.6);
    expect(travel(quarantine, q)).toBeLessThan(travel(curfew, d));
    // Nobody's restricted with no rule.
    const free = decided('hours', 'unrestricted');
    expect(movement(free, named(free, 'Westfield'), at(free, 22 * 60))).toBe(1);
  });

  it('funnel each district through its food points, where an unscreened line spreads the bite and a screened one catches it', () => {
    const line = (guards: number) => {
      const s = decided('line', 'quarantine');
      const d = named(s, 'Westfield');
      d.infected = 200;
      for (const x of foodPoints(s, d)) x.guards = guards;
      s.t = at(s, foodRunStart(d));
      const healthy = d.population;
      let dead = d.dead;
      for (let k = 0; k < 120; k++, s.t++) foodRun(s, d, quietEmit);
      dead = d.dead - dead;
      return { bitten: healthy - d.population, caught: dead };
    };
    const open = line(0);
    const screened = line(10);
    expect(open.bitten).toBeGreaterThan(50);
    expect(screened.caught).toBeGreaterThan(30);
    expect(screened.bitten).toBeLessThan(open.bitten * 0.5);
  });

  it('feed a district with no store or shelter at a site its soldiers run, or else at a neighbour\'s', () => {
    const s = decided('nofood', 'quarantine');
    const park = named(s, 'Industrial Park');
    expect(foodPoints(s, park)).toHaveLength(0);
    // Nobody to run a point: they walk to a neighbour's food point, which costs some patience.
    const away = foodSource(s, park)!;
    expect(away.away).toBe(true);
    expect(park.neighbors).toContain(away.district.id);
    const walking = policyUnrest(s, park);
    // Soldiers at the supply depot hand food out there.
    const depot = s.sites.find((x) => x.district === park.id && x.kind === 'depot')!;
    depot.guards = 5;
    const own = foodSource(s, park)!;
    expect(own.away).toBe(false);
    expect(own.points).toEqual([depot]);
    expect(policyUnrest(s, park)).toBeLessThan(walking);
    // The food run goes on there, the bitten in it too.
    park.infected = 100;
    s.t = at(s, foodRunStart(park));
    const healthy = park.population;
    for (let k = 0; k < 120; k++, s.t++) foodRun(s, park, quietEmit);
    expect(park.population).toBeLessThan(healthy);
  });

  it('mean fewer get out of the city by road', () => {
    const run = (policy: Policy) => {
      const s = decided('spread', policy);
      const sim = new CitySim(s);
      sim.step(1440 * 2);
      return { fled: s.traffic.fled };
    };
    const free = run('unrestricted');
    const kept = run('quarantine');
    expect(kept.fled).toBeLessThan(free.fled);
  });
});
