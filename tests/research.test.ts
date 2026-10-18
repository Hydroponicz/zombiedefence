import { describe, expect, it } from 'vitest';
import { CitySim, createCity } from '../src/sim/CitySim';
import { BLADDER_LITRES, HEAVY_BLADDER_LITRES } from '../src/sim/operations';
import { hasResearch, LURE_HOURS, RESEARCH, researchBlocked, researchPoints } from '../src/sim/research';
import type { CityState } from '../src/sim/types';

const named = (s: CityState, name: string) => s.districts.find((d) => d.name === name)!;

describe('research', () => {
  it('is earned by scientists at the base and spent on projects, in order', () => {
    const sim = new CitySim('points');
    const s = sim.state;
    expect(researchBlocked(s, 'rapidTests')).toMatch(/more points/);
    s.army.scientists = 20;
    sim.step(6 * 60 + 5);
    expect(researchPoints(s)).toBeGreaterThanOrEqual(RESEARCH.rapidTests.cost);
    expect(researchBlocked(s, 'vaccine')).toMatch(/Needs Rapid bite tests/);
    expect(sim.command({ type: 'research', id: 'rapidTests' })).toBe(true);
    expect(hasResearch(s, 'rapidTests')).toBe(true);
    expect(researchPoints(s)).toBeLessThan(RESEARCH.rapidTests.cost);
    expect(sim.command({ type: 'research', id: 'rapidTests' })).toBe(false);
  });

  it('rapid tests keep the bitten off the helicopter', () => {
    const board = (tests: boolean) => {
      const s = createCity('tests');
      const d = named(s, 'Westfield');
      d.infected = d.population;
      if (tests) s.unlocked.push('rapidTests');
      const sim = new CitySim(s);
      for (let k = 0; k < 8; k++) sim.command({ type: 'board', district: d.id, kind: 'civilian' });
      return s.cargo.infected;
    };
    expect(board(false)).toBeGreaterThan(0);
    expect(board(true)).toBe(0);
  });

  it('noise lures pull the dead toward where they sound', () => {
    const pull = (lure: boolean) => {
      const s = createCity('lure');
      for (const d of s.districts) d.zombies = 0;
      const target = named(s, 'Northside');
      for (const n of target.neighbors) s.districts[n].zombies = 3000;
      if (lure) {
        s.unlocked.push('noiseLures');
        const sim = new CitySim(s);
        expect(sim.command({ type: 'loadLure', at: 'army' })).toBe(true);
        expect(sim.command({ type: 'dropLure', district: target.id, x: 0, z: 0 })).toBe(true);
        sim.step(LURE_HOURS * 60 - 1);
        expect(s.lures).toHaveLength(1);
        sim.step(2);
        expect(s.lures).toHaveLength(0);
      } else {
        new CitySim(s).step(LURE_HOURS * 60 + 1);
      }
      return target.zombies + target.hordeZombies;
    };
    expect(pull(true)).toBeGreaterThan(pull(false) * 1.3);
  });

  it('the heavy sling carries more fuel', () => {
    const s = createCity('sling');
    const depot = s.districts.find((d) => d.features.fuelDepot && d.kind !== 'airbase')!;
    const sim = new CitySim(s);
    sim.command({ type: 'hookBladder', district: depot.id });
    expect(s.cargo.sling).toBe(BLADDER_LITRES);
    sim.command({ type: 'burstBladder', district: depot.id });
    s.unlocked.push('heavySling');
    sim.command({ type: 'hookBladder', district: depot.id });
    expect(s.cargo.sling).toBe(HEAVY_BLADDER_LITRES);
  });

  it('the antiviral treats the bitten among evacuees instead of turning them away', () => {
    const s = createCity('antiviral');
    s.unlocked.push('antiviral');
    s.cargo.infected = 3;
    s.cargo.civilians = 2;
    const sim = new CitySim(s);
    const flown = s.stats.flownOut;
    sim.command({ type: 'unloadAtBase', at: 'army' });
    sim.step(1);
    expect(s.stats.flownOut - flown).toBe(5);
  });

  it('the vaccine means bitten soldiers die rather than turn, and fewer fall', () => {
    const fight = (vaccine: boolean) => {
      const s = createCity('vaccine');
      for (const d of s.districts) {
        d.zombies = 0;
        d.infected = 0;
      }
      const d = named(s, 'Eastside');
      d.population = 0;
      d.police.officers = 0;
      d.police.riot = 0;
      d.troops.strength = 200;
      d.troops.ammo = 200 * 300;
      d.zombies = 3000;
      if (vaccine) s.unlocked.push('vaccine');
      new CitySim(s).step(30);
      return { infected: d.infected, troops: d.troops.strength };
    };
    const without = fight(false);
    const with_ = fight(true);
    expect(without.infected).toBeGreaterThan(0);
    // Only the odd person drifting in from elsewhere: no turned soldiers.
    expect(with_.infected).toBeLessThan(without.infected * 0.1);
    expect(with_.troops).toBeGreaterThan(without.troops);
  });
});
