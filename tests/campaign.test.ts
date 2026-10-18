import { describe, expect, it } from 'vitest';
import { finalEvacuation, minutesLeft, SEAL_DAYS } from '../src/sim/campaign';
import { CitySim } from '../src/sim/CitySim';
import { DAY_START, dayNumber, MINUTES_PER_DAY } from '../src/sim/clock';
import type { CityState } from '../src/sim/types';

const named = (s: CityState, name: string) => s.districts.find((d) => d.name === name)!;

describe('the campaign', () => {
  it('sets a deadline when Command authorizes the JOC, evacuates on the last day, and ends at the seal', () => {
    const sim = new CitySim('deadline');
    const s = sim.state;
    expect(s.campaign.deadline).toBeNull();
    named(s, 'Westfield').flags.outbreak = true;
    named(s, 'Eastside').flags.outbreak = true;
    sim.step(2);
    const authorized = dayNumber(s.t);
    expect(s.campaign.deadline).toBe((authorized + SEAL_DAYS - 1) * MINUTES_PER_DAY + DAY_START);

    // Skip to the day before the seal.
    s.flags.joc = true;
    s.t = s.campaign.deadline! - MINUTES_PER_DAY - 2;
    sim.step(3);
    expect(finalEvacuation(s)).toBe(true);
    expect(s.flags.finalEvac).toBe(true);
    const airport = s.districts.find((d) => d.kind === 'airbase')!;
    const flown = s.stats.flownOut;
    airport.population += 3000;
    sim.step(MINUTES_PER_DAY);
    expect(s.campaign.outcome).toBe('sealed');
    expect(minutesLeft(s)).toBe(0);
    // Hourly flights: well over the 400 every three hours of normal times.
    expect(s.stats.flownOut - flown).toBeGreaterThan(3000);

    // The city stands still once it's over, until the player flies on.
    const t = s.t;
    sim.step(60);
    expect(s.t).toBe(t);
    expect(sim.command({ type: 'freePlay' })).toBe(true);
    sim.step(60);
    expect(s.t).toBe(t + 60);
  });

  it('ends if the player runs out of helicopters', () => {
    const sim = new CitySim('grounded');
    const s = sim.state;
    const fleet = s.airframes.filter((a) => a.status === 'ready').length;
    expect(fleet).toBeGreaterThan(0);
    for (let k = 0; k < fleet; k++) {
      sim.command({ type: 'crash', district: 0 });
      sim.step(1);
      expect(s.campaign.outcome).toBe('running');
    }
    sim.command({ type: 'crash', district: 0 });
    sim.step(1);
    expect(s.campaign.outcome).toBe('grounded');
  });
});

describe('daily reports', () => {
  it('report each day against a replay without the player', () => {
    const sim = new CitySim('report', true);
    const s = sim.state;
    sim.step(MINUTES_PER_DAY);
    expect(s.campaign.reports).toHaveLength(1);
    // The player did nothing: the replay is the same day.
    const quiet = s.campaign.reports[0];
    expect(quiet.day).toBe(1);
    expect(quiet.saved).toBe(0);
    expect(quiet.heldBecause).toEqual([]);

    // Day 2: the player brings people out of a district into the base, where they're bussed away.
    const d = s.districts.findIndex((x) => x.name === 'Southgate');
    for (let trip = 0; trip < 10; trip++) {
      for (let k = 0; k < 8; k++) sim.command({ type: 'board', district: d, kind: 'civilian' });
      sim.command({ type: 'unloadAtBase', at: 'army' });
      sim.step(60);
    }
    sim.step(MINUTES_PER_DAY - 600);
    expect(s.campaign.reports).toHaveLength(2);
    const busy = s.campaign.reports[1];
    expect(busy.evacuated).toBeGreaterThan(50);
    expect(busy.saved).toBeGreaterThan(0);
  });
});
