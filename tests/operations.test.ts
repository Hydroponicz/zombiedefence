import { describe, expect, it } from 'vitest';
import { Operations, type GroundContext } from '../src/game/Operations';
import type { Action } from '../src/input/Input';
import { CitySim } from '../src/sim/CitySim';
import { BASE_RESERVE_TROOPS, baseOf, CRATES, CRATE_SLOTS, SEATS, seatsUsed, type PlayerCommand } from '../src/sim/operations';

const byName = (sim: CitySim, name: string) => sim.state.districts.find((d) => d.name === name)!;

describe('player operations in the simulation', () => {
  it('loads troops at the base and deploys them fresh into a district', () => {
    const sim = new CitySim('ops');
    const base = baseOf(sim.state);
    const westfield = byName(sim, 'Westfield');
    westfield.troops.fatigue = 0.8;
    const before = base.troops.strength;
    for (let i = 0; i < 10; i++) sim.command({ type: 'loadTroop' });
    expect(sim.state.cargo.troops).toBe(SEATS);
    expect(base.troops.strength).toBe(before - SEATS);

    const troops = westfield.troops.strength;
    for (let i = 0; i < SEATS; i++) sim.command({ type: 'deployTroop', district: westfield.id });
    expect(westfield.troops.strength).toBe(troops + SEATS);
    expect(westfield.troops.fatigue).toBeLessThan(0.8);
    expect(sim.state.cargo.troops).toBe(0);
    expect(sim.state.stats.troopsDeployed).toBe(SEATS);
  });

  it('keeps a reserve at the base', () => {
    const sim = new CitySim('reserve');
    baseOf(sim.state).troops.strength = BASE_RESERVE_TROOPS + 1;
    expect(sim.command({ type: 'loadTroop' })).toBe(true);
    expect(sim.command({ type: 'loadTroop' })).toBe(false);
  });

  it('carries relief crates from base stores to a district', () => {
    const sim = new CitySim('crates');
    const base = baseOf(sim.state);
    const market = byName(sim, 'Market District');
    const stock = base.rations;
    for (let i = 0; i < 3; i++) sim.command({ type: 'loadCrate', kind: 'rations' });
    expect(sim.state.cargo.crates).toHaveLength(CRATE_SLOTS);
    expect(base.rations).toBe(stock - CRATE_SLOTS * CRATES.rations.amount);
    market.order = 40;
    const food = market.rations;
    sim.command({ type: 'dropCrate', district: market.id });
    expect(market.rations).toBe(food + CRATES.rations.amount);
    expect(market.order).toBe(40 + CRATES.rations.order);
  });

  it('evacuates civilians to the base, where the bitten among them are caught at the gate', () => {
    const sim = new CitySim('evac');
    const d = byName(sim, 'Northside');
    d.infected = d.population; // half of everyone is bitten
    const base = baseOf(sim.state);
    const pop = base.population;
    const dead = base.dead;
    for (let i = 0; i < SEATS + 2; i++) sim.command({ type: 'board', district: d.id, kind: 'civilian' });
    expect(seatsUsed(sim.state.cargo)).toBe(SEATS);
    const bitten = sim.state.cargo.infected;
    expect(bitten).toBeGreaterThan(0);
    sim.command({ type: 'unloadAtBase' });
    expect(base.population).toBe(pop + SEATS - bitten);
    expect(base.infected).toBe(0);
    expect(base.dead).toBe(dead + bitten);
    expect(sim.state.stats.civiliansEvacuated).toBe(SEATS);
  });

  it('lets the bitten in once every other district has fallen', () => {
    const sim = new CitySim('open');
    const base = baseOf(sim.state);
    for (const x of sim.state.districts) {
      if (x === base) continue;
      Object.assign(x, { status: 'overrun', population: 0, zombies: 500 });
      x.troops.strength = 0;
    }
    sim.step(1);
    expect(sim.state.flags.baseOpen).toBe(true);
    sim.state.cargo.infected = 2;
    sim.command({ type: 'unloadAtBase' });
    expect(base.infected).toBeGreaterThanOrEqual(2);
  });

  it('rotates exhausted soldiers out to rest at the base', () => {
    const sim = new CitySim('relieve');
    const d = byName(sim, 'Downtown');
    d.troops.fatigue = 0.9;
    const base = baseOf(sim.state);
    for (let i = 0; i < 4; i++) sim.command({ type: 'board', district: d.id, kind: 'soldier' });
    expect(sim.state.cargo.tired).toBe(4);
    expect(sim.state.cargo.tiredFatigue).toBeCloseTo(0.9);
    const fatigue = base.troops.fatigue;
    sim.command({ type: 'unloadAtBase' });
    expect(base.troops.fatigue).toBeGreaterThan(fatigue);
    // Resting at a quiet base brings fatigue back down.
    const tired = base.troops.fatigue;
    sim.step(600);
    expect(base.troops.fatigue).toBeLessThan(tired);
  });

  it('turns scientists at the base into research', () => {
    const sim = new CitySim('science');
    const lab = byName(sim, 'University Heights');
    for (let i = 0; i < 5; i++) sim.command({ type: 'board', district: lab.id, kind: 'scientist' });
    sim.command({ type: 'unloadAtBase' });
    expect(baseOf(sim.state).scientists).toBe(5);
    sim.step(120);
    expect(sim.state.research).toBeCloseTo(10, 0);
  });

  it('loses everyone aboard in a crash', () => {
    const sim = new CitySim('crash');
    for (let i = 0; i < 3; i++) sim.command({ type: 'loadTroop' });
    sim.command({ type: 'crash', district: 0 });
    expect(seatsUsed(sim.state.cargo)).toBe(0);
    expect(sim.state.stats.lostInCrashes).toBe(3);
  });

  it('flies in fresh troops and supplies every morning', () => {
    const sim = new CitySim('flight');
    const base = baseOf(sim.state);
    const troops = base.troops.strength;
    sim.step(70); // 06:00 -> 07:10
    expect(base.troops.strength).toBeGreaterThan(troops + 50);
  });
});

describe('ground operations menu', () => {
  const at = (sim: CitySim, name: string, extra: Partial<GroundContext> = {}): GroundContext => ({
    landed: true,
    district: byName(sim, name).id,
    onRoof: false,
    threat: 0,
    grabbers: 0,
    x: 0,
    z: 0,
    fuel: 1360,
    fuelCapacity: 1360,
    ...extra,
  });

  function harness(sim: CitySim) {
    const ops = new Operations((cmd: PlayerCommand) => sim.command(cmd));
    // Each button press arrives on its own frame, as it would from a real player.
    const tick = (ctx: GroundContext, seconds: number, actions: Action[] = []) => {
      ops.update(1 / 30, ctx, sim.state, new Set());
      for (const a of actions) ops.update(1 / 30, ctx, sim.state, new Set([a]));
      for (let t = 0; t < seconds; t += 1 / 30) ops.update(1 / 30, ctx, sim.state, new Set());
    };
    return { ops, tick };
  }

  it('loads troops one at a time until the seats are full', () => {
    const sim = new CitySim('menu');
    const { ops, tick } = harness(sim);
    const ctx = at(sim, 'Fort Kessler');
    tick(ctx, 0);
    expect(ops.view?.options[0].label).toBe('Load fresh troops');
    tick(ctx, 1.1, ['confirm']);
    expect(sim.state.cargo.troops).toBe(2);
    tick(ctx, 5);
    expect(sim.state.cargo.troops).toBe(SEATS);
  });

  it('pauses boarding while zombies are at the doors', () => {
    const sim = new CitySim('doors');
    const { tick } = harness(sim);
    const ctx = at(sim, 'Northside');
    tick(ctx, 0, ['dpadDown', 'dpadDown']);
    tick(ctx, 3.2, ['confirm']);
    const boarded = seatsUsed(sim.state.cargo);
    expect(boarded).toBe(3);
    tick({ ...ctx, threat: 2 }, 3);
    expect(seatsUsed(sim.state.cargo)).toBe(boarded);
    tick(ctx, 2.1);
    expect(seatsUsed(sim.state.cargo)).toBe(boarded + 2);
  });

  it('boards more slowly from a rooftop', () => {
    const sim = new CitySim('roof');
    const { tick } = harness(sim);
    const ctx = at(sim, 'Northside', { onRoof: true });
    tick(ctx, 0, ['dpadDown', 'dpadDown']);
    tick(ctx, 5.1, ['confirm']);
    expect(seatsUsed(sim.state.cargo)).toBe(2);
  });

  it('unloads passengers automatically on touching down at the base', () => {
    const sim = new CitySim('auto');
    for (let i = 0; i < 4; i++) sim.command({ type: 'board', district: byName(sim, 'Northside').id, kind: 'civilian' });
    const { tick } = harness(sim);
    tick(at(sim, 'Fort Kessler'), 0.1);
    expect(seatsUsed(sim.state.cargo)).toBe(0);
    expect(sim.state.stats.civiliansEvacuated).toBe(4);
  });
});
