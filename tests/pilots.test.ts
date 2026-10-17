import { describe, expect, it } from 'vitest';
import { CitySim } from '../src/sim/CitySim';
import { baseOf, seatsUsed } from '../src/sim/operations';
import { createPilot, dangerOf, payday, TRIP_FUEL, willFly } from '../src/sim/pilots';
import type { Order } from '../src/sim/types';

const byName = (sim: CitySim, name: string) => sim.state.districts.find((d) => d.name === name)!;
const reyes = (sim: CitySim) => sim.state.pilots[0];
const order = (sim: CitySim, kind: Order['kind'], district: string, repeat = false): Order => ({
  kind, district: byName(sim, district).id, crate: 'rations', repeat,
});
/** Make Reyes reliable so tests aren't at the mercy of a random crash. */
const steady = (sim: CitySim) => Object.assign(reyes(sim), { skill: 1, nerve: 1, loyalty: 0.9 });

describe('AI pilots', () => {
  it('start with one pilot and one spare helicopter', () => {
    const sim = new CitySim('fleet');
    expect(sim.state.pilots).toHaveLength(1);
    expect(sim.state.pilots[0].name).toBe('Lt. Ana Reyes');
    expect(sim.state.airframes.filter((a) => a.status === 'ready')).toHaveLength(1);
  });

  it('fly a reinforcement run there and back, using base troops and fuel', () => {
    const sim = new CitySim('reinforce');
    steady(sim);
    const base = baseOf(sim.state);
    const westfield = byName(sim, 'Westfield');
    // Stop the depot convoys so the base's fuel only moves with the trip.
    byName(sim, 'Harbor').troops.strength = 0;
    byName(sim, 'Industrial Park').troops.strength = 0;
    const troops = westfield.troops.strength;
    const fuel = base.fuel;
    sim.command({ type: 'setOrder', pilot: reyes(sim).id, order: order(sim, 'reinforce', 'Westfield') });
    sim.step(2);
    expect(reyes(sim).status).toBe('flying');
    expect(base.fuel).toBe(fuel - TRIP_FUEL);
    sim.step(180);
    expect(westfield.troops.strength).toBeGreaterThanOrEqual(troops + 7);
    expect(reyes(sim).status).not.toBe('flying');
    expect(reyes(sim).order).toBeNull(); // one-off
    expect(sim.state.stats.aiTrips).toBe(1);
    expect(sim.state.airframes[0].status).toBe('ready');
  });

  it('keep flying a standing route', () => {
    const sim = new CitySim('route');
    steady(sim);
    sim.command({ type: 'setOrder', pilot: reyes(sim).id, order: order(sim, 'resupply', 'Market District', true) });
    sim.step(60 * 8);
    expect(sim.state.stats.aiTrips).toBeGreaterThanOrEqual(3);
    expect(reyes(sim).order).not.toBeNull();
    expect(reyes(sim).fatigue).toBeGreaterThan(0);
  });

  it('bring evacuees back to the base', () => {
    const sim = new CitySim('ai-evac');
    steady(sim);
    const base = baseOf(sim.state);
    const people = base.population + base.infected;
    sim.command({ type: 'setOrder', pilot: reyes(sim).id, order: order(sim, 'evacuate', 'Southgate') });
    sim.step(200);
    expect(base.population + base.infected).toBeGreaterThanOrEqual(people + 8);
  });

  it('refuse landing zones beyond their nerve', () => {
    const sim = new CitySim('nerve');
    const p = reyes(sim);
    p.nerve = 0.1;
    const d = byName(sim, 'Northside');
    d.status = 'overrun';
    d.zombies = 50000;
    expect(dangerOf(d)).toBeGreaterThan(0.5);
    expect(willFly(p, d)).toBe(false);
    sim.command({ type: 'setOrder', pilot: p.id, order: order(sim, 'reinforce', 'Northside') });
    sim.step(5);
    expect(p.status).toBe('idle');
    expect(sim.state.log.some((e) => e.text.includes("won't fly into Northside"))).toBe(true);
  });

  it('are paid at dawn, and desert with a helicopter when they go unpaid', () => {
    const sim = new CitySim('payday');
    const base = baseOf(sim.state);
    const p = reyes(sim);
    const rations = base.rations;
    payday(sim.state, () => {});
    expect(base.rations).toBe(rations - p.wage);

    base.rations = 0;
    p.loyalty = 0.3;
    payday(sim.state, () => {});
    expect(p.status).toBe('deserted');
    expect(sim.state.airframes[0].status).toBe('lost');
  });

  it('can be rescued when stranded after a crash', () => {
    const sim = new CitySim('rescue');
    const p = reyes(sim);
    const d = byName(sim, 'Eastside');
    p.status = 'stranded';
    p.district = d.id;
    expect(sim.command({ type: 'board', district: d.id, kind: 'pilot' })).toBe(true);
    expect(seatsUsed(sim.state.cargo)).toBe(1);
    sim.command({ type: 'unloadAtBase' });
    expect(p.status).toBe('resting');
  });

  it('gain helicopters from salvage', () => {
    const sim = new CitySim('salvage');
    const hospital = byName(sim, "St. Mary's");
    expect(sim.command({ type: 'salvage', district: hospital.id })).toBe(true);
    expect(sim.command({ type: 'salvage', district: hospital.id })).toBe(false);
    expect(sim.state.airframes.filter((a) => a.status === 'ready')).toHaveLength(2);
  });

  it('must be hired before they are paid or take orders', () => {
    const sim = new CitySim('hire');
    const recruit = createPilot(sim.state);
    sim.state.pilots.push(recruit);
    const base = baseOf(sim.state);
    const rations = base.rations;
    payday(sim.state, () => {});
    expect(base.rations).toBe(rations - reyes(sim).wage);
    expect(sim.command({ type: 'setOrder', pilot: recruit.id, order: order(sim, 'evacuate', 'Southgate') })).toBe(false);
    expect(sim.command({ type: 'hirePilot', pilot: recruit.id })).toBe(true);
    expect(sim.command({ type: 'setOrder', pilot: recruit.id, order: order(sim, 'evacuate', 'Southgate') })).toBe(true);
  });

  it('turn up among evacuees', () => {
    const sim = new CitySim('recruit');
    const before = sim.state.pilots.length;
    for (let trip = 0; trip < 20; trip++) {
      for (let i = 0; i < 8; i++) sim.command({ type: 'board', district: byName(sim, 'Riverside').id, kind: 'civilian' });
      sim.command({ type: 'unloadAtBase' });
    }
    expect(sim.state.pilots.length).toBeGreaterThan(before);
    expect(sim.state.stats.pilotsRecruited).toBe(sim.state.pilots.length - before);
  });

  it('only take fuel runs to depots', () => {
    const sim = new CitySim('fuel-run');
    expect(sim.command({ type: 'setOrder', pilot: reyes(sim).id, order: order(sim, 'fuel', 'Northside') })).toBe(false);
    expect(sim.command({ type: 'setOrder', pilot: reyes(sim).id, order: order(sim, 'fuel', 'Harbor') })).toBe(true);
  });

  it('have varied traits and wages', () => {
    const sim = new CitySim('traits');
    const crew = Array.from({ length: 10 }, () => createPilot(sim.state));
    expect(new Set(crew.map((p) => p.wage)).size).toBeGreaterThan(2);
    for (const p of crew) {
      expect(p.skill).toBeGreaterThan(0);
      expect(p.skill).toBeLessThan(1);
    }
  });
});
