import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { deployed } from './helpers';
import { Operations, type GroundContext } from '../src/game/Operations';
import { FUEL_CAPACITY, Helicopter, type CollisionWorld } from '../src/heli/Helicopter';
import type { FlightInput } from '../src/input/Input';
import { CitySim } from '../src/sim/CitySim';
import { baseOf, BLADDER_LITRES, FARP_GUARDS, seatsUsed, type PlayerCommand } from '../src/sim/operations';

const byName = (sim: CitySim, name: string) => sim.state.districts.find((d) => d.name === name)!;

describe('fuel in the simulation', () => {
  it('draws refuelling from the source stock', () => {
    const sim = deployed(new CitySim('pump'));
    const base = baseOf(sim.state);
    const before = base.fuel;
    sim.command({ type: 'refuel', source: { district: base.id }, litres: 500 });
    expect(base.fuel).toBe(before - 500);
  });

  it('carries a bladder from a depot and sets it down elsewhere', () => {
    const sim = deployed(new CitySim('bladder'));
    const harbor = byName(sim, 'Harbor');
    const hospital = byName(sim, "St. Mary's");
    expect(sim.command({ type: 'hookBladder', district: byName(sim, 'Northside').id })).toBe(false);
    const depot = harbor.fuel;
    expect(sim.command({ type: 'hookBladder', district: harbor.id })).toBe(true);
    expect(harbor.fuel).toBe(depot - BLADDER_LITRES);
    expect(sim.state.cargo.sling).toBe(BLADDER_LITRES);
    const generator = hospital.fuel;
    sim.command({ type: 'releaseBladder', district: hospital.id });
    expect(hospital.fuel).toBe(generator + BLADDER_LITRES);
    expect(sim.state.cargo.sling).toBe(0);
  });

  it('loses a bladder dropped from height', () => {
    const sim = deployed(new CitySim('burst'));
    sim.command({ type: 'hookBladder', district: byName(sim, 'Harbor').id });
    sim.command({ type: 'burstBladder', district: 0 });
    expect(sim.state.cargo.sling).toBe(0);
  });

  it('sets up a guarded forward refuelling point that can be refilled and is lost when overrun', () => {
    const sim = deployed(new CitySim('farp'));
    const d = byName(sim, 'Eastside');
    const setup: PlayerCommand = { type: 'setupFarp', district: d.id, x: 100, z: 0 };
    sim.command({ type: 'hookBladder', district: baseOf(sim.state).id });
    expect(sim.command(setup)).toBe(false); // no guards aboard
    for (let i = 0; i < FARP_GUARDS; i++) sim.command({ type: 'loadTroop' });
    const troops = d.troops.strength;
    expect(sim.command(setup)).toBe(true);
    expect(d.troops.strength).toBe(troops + FARP_GUARDS);
    expect(sim.state.farps).toHaveLength(1);
    const farp = sim.state.farps[0];
    expect(farp.fuel).toBe(BLADDER_LITRES);

    // Too close to another refuelling point.
    sim.command({ type: 'hookBladder', district: baseOf(sim.state).id });
    for (let i = 0; i < FARP_GUARDS; i++) sim.command({ type: 'loadTroop' });
    expect(sim.command({ ...setup, x: 150 })).toBe(false);
    sim.command({ type: 'releaseBladder', district: d.id, farp: farp.id });
    expect(farp.fuel).toBe(2 * BLADDER_LITRES);

    sim.command({ type: 'refuel', source: { farp: farp.id }, litres: 300 });
    expect(farp.fuel).toBe(2 * BLADDER_LITRES - 300);

    d.status = 'overrun';
    d.population = 0;
    d.troops.strength = 0;
    d.zombies = 5000;
    sim.step(1);
    expect(sim.state.farps).toHaveLength(0);
  });

  it('trucks fuel from defended depots to the base, and stops when a depot falls', () => {
    const sim = deployed(new CitySim('convoy'));
    const base = baseOf(sim.state);
    const harbor = byName(sim, 'Harbor');
    const fuel = base.fuel;
    sim.step(60);
    expect(base.fuel).toBeGreaterThan(fuel);
    harbor.troops.strength = 0;
    sim.step(60);
    expect(sim.state.log.some((e) => e.text.includes('Fuel convoys from Harbor have stopped'))).toBe(true);
  });

  it('leaves passengers and cargo in the district when the helicopter is abandoned', () => {
    const sim = deployed(new CitySim('abandon'));
    const d = byName(sim, 'Southgate');
    for (let i = 0; i < 3; i++) sim.command({ type: 'board', district: d.id, kind: 'civilian' });
    const people = d.population + d.infected;
    sim.command({ type: 'abandon', district: d.id });
    expect(seatsUsed(sim.state.cargo)).toBe(0);
    expect(d.population + d.infected).toBe(people + 3);
  });
});

describe('flying on fuel', () => {
  const DT = 1 / 120;
  const flat: CollisionWorld = { surfaceHeight: () => 0, collide: () => new THREE.Vector3() };
  const input = (o: Partial<FlightInput> = {}): FlightInput => ({ collective: 0, yaw: 0, pitch: 0, roll: 0, ...o });
  const fly = (h: Helicopter, seconds: number, i: FlightInput) => {
    for (let t = 0; t < seconds; t += DT) h.update(DT, i, flat);
  };
  const airborne = (altitude: number, fuel = FUEL_CAPACITY) => {
    const h = new Helicopter();
    h.reset(0, 0, 0, 0, fuel);
    fly(h, 5, input());
    h.position.y = altitude;
    h.landed = false;
    return h;
  };

  it('burns roughly a tank in 12–16 minutes of hovering', () => {
    const h = airborne(100);
    const start = h.fuel;
    fly(h, 60, input());
    const perMinute = start - h.fuel;
    expect(FUEL_CAPACITY / perMinute).toBeGreaterThan(12);
    expect(FUEL_CAPACITY / perMinute).toBeLessThan(16);
  });

  it('autorotates down survivably when the engine flames out', () => {
    const h = airborne(150, 0.01);
    fly(h, 40, input());
    expect(h.landed).toBe(true);
    expect(h.health).toBeGreaterThan(60);
  });

  it('cannot take off without fuel', () => {
    const h = new Helicopter();
    h.reset(0, 0, 0, 0, 0);
    fly(h, 5, input({ collective: 1 }));
    expect(h.position.y).toBeLessThan(2.5);
  });

  it('hangs a slung bladder below on its rope', () => {
    const h = airborne(60);
    h.sling = BLADDER_LITRES;
    fly(h, 3, input());
    expect(h.bladder.y).toBeLessThan(h.position.y - 8);
    expect(h.bladderClearance).toBeGreaterThan(30);
  });
});

describe('fuel on the ground menu', () => {
  const ctx = (sim: CitySim, name: string, extra: Partial<GroundContext> = {}): GroundContext => ({
    landed: true, district: byName(sim, name).id, onRoof: false, threat: 0, grabbers: 0,
    x: 0, z: 0, fuel: FUEL_CAPACITY, fuelCapacity: FUEL_CAPACITY, base: name === 'Kessler Airport' ? 'airport' : null, ...extra,
  });

  it('refuels automatically at the base from its stores', () => {
    const sim = deployed(new CitySim('auto-fuel'));
    let fuel = 200;
    const ops = new Operations((c) => sim.command(c), (l) => (fuel += l));
    const stores = baseOf(sim.state).fuel;
    for (let t = 0; t < 5; t += 1 / 30) ops.update(1 / 30, ctx(sim, 'Kessler Airport', { fuel }), sim.state, new Set());
    expect(fuel).toBeGreaterThan(200 + 300);
    expect(baseOf(sim.state).fuel).toBeCloseTo(stores - (fuel - 200), 0);
  });

  it('offers a bladder at depots and abandonment only when stranded', () => {
    const sim = deployed(new CitySim('menu-fuel'));
    const ops = new Operations((c) => sim.command(c));
    ops.update(1 / 30, ctx(sim, 'Harbor'), sim.state, new Set());
    expect(ops.view!.options.some((o) => o.label === 'Hook up a fuel bladder')).toBe(true);
    expect(ops.view!.options.some((o) => o.label === 'Abandon the helicopter')).toBe(false);

    byName(sim, 'Northside').fuel = 0;
    ops.update(1 / 30, { ...ctx(sim, 'Northside'), fuel: 10 }, sim.state, new Set());
    expect(ops.view!.options.some((o) => o.label === 'Abandon the helicopter')).toBe(true);
  });
});
