import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { CitySim, createCity } from '../src/sim/CitySim';
import { districtCenter, DISTRICT_SIZE, DISTRICT_TEMPLATES } from '../src/sim/layout';
import type { CityState } from '../src/sim/types';
import { ACTIVE_RADIUS, Agents } from '../src/world/Agents';
import type { Effects } from '../src/world/Effects';

const DAY = 1440;

describe('rotor noise in the simulation', () => {
  it('draws zombies in from neighbouring districts', () => {
    // Find a moment with a horde next to a district we can make noise over.
    const base = new CitySim('noise');
    base.step(DAY * 6);
    const state = base.state;
    const loud = state.districts
      .filter((d) => d.kind !== 'airbase')
      .sort((a, b) => b.neighbors.reduce((s, n) => s + state.districts[n].zombies, 0) - a.neighbors.reduce((s, n) => s + state.districts[n].zombies, 0))[0];

    const quiet = new CitySim(structuredClone(state));
    const noisy = new CitySim(structuredClone(state));
    for (let m = 0; m < 180; m++) {
      noisy.addPlayerNoise(loud.id, 0.15);
      quiet.step(1);
      noisy.step(1);
    }
    const inflow = (s: CitySim) => s.state.districts[loud.id].zombies + s.state.districts[loud.id].dead;
    expect(inflow(noisy)).toBeGreaterThan(inflow(quiet));
    expect(noisy.state.districts[loud.id].playerNoise).toBeGreaterThan(0);
  });

  it('decays when the helicopter leaves', () => {
    const sim = new CitySim('decay');
    sim.addPlayerNoise(0, 3);
    sim.step(120);
    expect(sim.state.districts[0].playerNoise).toBeLessThan(0.1);
  });
});

describe('street scene', () => {
  const effects = { tracer: () => {} } as unknown as Effects;
  const index = DISTRICT_TEMPLATES.findIndex((d) => d.name === 'Downtown');
  const centre = districtCenter(DISTRICT_TEMPLATES[index].col, DISTRICT_TEMPLATES[index].row);

  function cityWith(zombies: number): CityState {
    const state = createCity('scene');
    for (const d of state.districts) {
      d.zombies = 0;
      d.infected = 0;
    }
    state.districts[index].zombies = zombies;
    return state;
  }

  function run(agents: Agents, state: CityState, seconds: number, altitude: number, heli = new THREE.Vector3(centre.x, 0, centre.z)) {
    for (let t = 0; t < seconds; t += 1 / 30) agents.update(1 / 30, heli, altitude, 1, state, 0);
  }

  it('populates the streets in proportion to the simulation', () => {
    const agents = new Agents('scene', effects);
    run(agents, cityWith(60), 4, 200);
    const census = agents.census();
    // Most of Downtown is inside the active circle, so most of its 60 zombies should be on screen.
    const share = (Math.PI * ACTIVE_RADIUS * ACTIVE_RADIUS) / (DISTRICT_SIZE * DISTRICT_SIZE);
    expect(census.zombies).toBeGreaterThan(60 * Math.min(1, share) * 0.5);
    // Local bites can briefly add a few before the next reconciliation trims them.
    expect(census.zombies).toBeLessThanOrEqual(66);
    expect(census.civilians).toBeGreaterThan(50);
    expect(census.soldiers).toBeGreaterThan(0);
  });

  it('shows no zombies where the simulation has none', () => {
    const agents = new Agents('scene', effects);
    run(agents, cityWith(0), 3, 200);
    expect(agents.census().zombies).toBe(0);
  });

  it('draws zombies toward a helicopter hovering low', () => {
    const agents = new Agents('scene', effects);
    const state = cityWith(200);
    // Kill the posts' soldiers so the zombies aren't shot on the way.
    state.districts[index].troops.strength = 0;
    run(agents, state, 2, 200);
    run(agents, state, 6, 20);
    expect(agents.attract.active).toBe(true);
    expect(agents.attract.drawn).toBeGreaterThan(0);
  });
});
