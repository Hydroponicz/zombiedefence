import { describe, expect, it } from 'vitest';
import { CitySim, createCity } from '../src/sim/CitySim';
import { CURFEW_FROM, foodPoints, foodRun, foodRunStart, movement, policyCallDue, travel } from '../src/sim/policy';
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
    expect(sim.command({ type: 'setPolicy', policy: 'curfew' })).toBe(false);
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
