import { describe, expect, it } from 'vitest';
import { CitySim, createCity } from '../src/sim/CitySim';
import type { CityState } from '../src/sim/types';

const named = (s: CityState, name: string) => s.districts.find((d) => d.name === name)!;

/** A quiet city with one district set up for the test. */
function city(seed: string): CityState {
  const s = createCity(seed);
  for (const d of s.districts) {
    d.infected = 0;
    d.zombies = 0;
  }
  return s;
}

describe('police', () => {
  it('start in every city district, with the most riot police downtown, and none at the base', () => {
    const s = city('police');
    for (const d of s.districts) {
      if (d.kind === 'airbase') expect(d.police.officers + d.police.riot).toBe(0);
      else expect(d.police.officers).toBeGreaterThan(0);
    }
    const downtown = named(s, 'Downtown');
    expect(Math.max(...s.districts.map((d) => d.police.riot))).toBe(downtown.police.riot);
  });

  it('kill the dead, but far less well than the same number of soldiers', () => {
    const killed = (setup: (s: CityState) => void) => {
      const s = city('kills');
      const d = named(s, 'Westfield');
      d.troops.strength = 0;
      d.police.officers = 0;
      d.police.riot = 0;
      d.zombies = 2000;
      setup(s);
      new CitySim(s).step(60);
      return d.dead;
    };
    const nobody = killed(() => {});
    const police = killed((s) => (named(s, 'Westfield').police.officers = 100));
    const soldiers = killed((s) => {
      const d = named(s, 'Westfield');
      d.troops.strength = 100;
      d.troops.ammo = 100 * 300;
    });
    expect(police).toBeGreaterThan(nobody);
    expect(soldiers).toBeGreaterThan(police);
  });

  it('riot police bring a riot back under control', () => {
    const order = (riot: number) => {
      const s = city('riot');
      const d = named(s, 'Eastside');
      d.rioting = true;
      d.order = 20;
      d.police.riot = riot;
      new CitySim(s).step(360);
      return d.order;
    };
    expect(order(80)).toBeGreaterThan(order(0) + 5);
  });

  it('walk off the job as the days wear on, going home as civilians', () => {
    const s = city('quit');
    const d = named(s, 'Northside');
    const sim = new CitySim(s);
    // Day 9 of a city overrun next door: morale drains away.
    s.t += 1440 * 8;
    for (const n of d.neighbors) s.districts[n].status = 'overrun';
    const police = d.police.officers + d.police.riot;
    const people = d.population;
    sim.step(1440);
    expect(d.police.officers + d.police.riot).toBeLessThan(police * 0.8);
    // They join the civilians (some of whom leave the city by road).
    expect(d.population + sim.state.traffic.fled).toBeGreaterThan(people - 1);
    expect(sim.state.log.some((e) => /walking off the job/.test(e.text))).toBe(true);
  });
});
