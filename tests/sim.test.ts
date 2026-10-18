import { describe, expect, it } from 'vitest';
import { CitySim } from '../src/sim/CitySim';
import {
  advanceGameTime,
  dayNumber,
  daylight,
  isDaytime,
  MINUTES_PER_DAY,
  minuteOfDay,
  START_MINUTE,
} from '../src/sim/clock';
import { districtAt, districtCenter, DISTRICT_TEMPLATES } from '../src/sim/layout';

const DAY = MINUTES_PER_DAY;

describe('clock', () => {
  it('runs a full day in 30 real minutes, 20 of them daytime', () => {
    expect(advanceGameTime(START_MINUTE, 20 * 60)).toBeCloseTo(20 * 60, 6);
    expect(advanceGameTime(START_MINUTE, 30 * 60)).toBeCloseTo(START_MINUTE + DAY, 6);
  });

  it('advances correctly across the day/night boundary', () => {
    // 19:00 + 10 real minutes = 1 game hour of day (~85.7 s), then the rest at 1 game minute per second.
    const t = advanceGameTime(19 * 60, 600);
    const dayPart = 60 * (1200 / 840);
    expect(t).toBeCloseTo(20 * 60 + (600 - dayPart), 6);
  });

  it('reports day number and daylight', () => {
    expect(dayNumber(START_MINUTE)).toBe(1);
    expect(dayNumber(START_MINUTE + DAY)).toBe(2);
    expect(isDaytime(12 * 60)).toBe(true);
    expect(isDaytime(23 * 60)).toBe(false);
    expect(daylight(12 * 60)).toBe(1);
    expect(daylight(2 * 60)).toBe(0);
    expect(minuteOfDay(DAY + 5)).toBe(5);
  });
});

describe('layout', () => {
  it('maps every district centre back to its district', () => {
    DISTRICT_TEMPLATES.forEach((d, i) => {
      const c = districtCenter(d.col, d.row);
      expect(districtAt(c.x, c.z)).toBe(i);
    });
    expect(districtAt(1e6, 0)).toBe(-1);
  });
});

describe('city simulation', () => {
  it('is deterministic for a seed', () => {
    const a = new CitySim('det');
    const b = new CitySim('det');
    a.step(DAY * 4);
    b.step(DAY * 4);
    expect(JSON.stringify(a.state)).toBe(JSON.stringify(b.state));
  });

  it('differs between seeds', () => {
    const a = new CitySim('alpha');
    const b = new CitySim('beta');
    a.step(DAY * 4);
    b.step(DAY * 4);
    expect(JSON.stringify(a.state.districts)).not.toBe(JSON.stringify(b.state.districts));
  });

  it('never produces negative or non-finite values', () => {
    const sim = new CitySim('sanity');
    for (let day = 0; day < 20; day++) {
      sim.step(DAY);
      for (const d of sim.state.districts) {
        for (const v of [d.population, d.infected, d.zombies, d.dead, d.rations, d.medicine, d.fuel,
          d.order, d.troops.strength, d.troops.ammo, d.troops.fatigue, d.troops.morale]) {
          expect(Number.isFinite(v)).toBe(true);
          expect(v).toBeGreaterThanOrEqual(0);
        }
      }
      expect(sim.state.grid).toBeGreaterThanOrEqual(0);
    }
  }, 20000);

  it('collapses on its own eventually, but not in the first week', () => {
    for (const seed of ['1', '2', '3']) {
      const sim = new CitySim(seed);
      sim.step(DAY * 7);
      expect(sim.state.collapsed).toBe(false);
      // Past the seal: the city runs on.
      sim.state.flags.freePlay = true;
      sim.step(DAY * 23);
      expect(sim.state.collapsed).toBe(true);
    }
    // A month of simulated city, three times over: give it time.
  }, 60_000);

  it('reports what happens as events', () => {
    const sim = new CitySim('events');
    sim.step(DAY * 8);
    const events = sim.takeEvents();
    expect(events.some((e) => e.text.includes('Outbreak confirmed'))).toBe(true);
    expect(events.some((e) => e.text.includes('has gone dark'))).toBe(true);
    expect(sim.takeEvents()).toHaveLength(0);
  });
});
