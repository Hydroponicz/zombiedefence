import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { createCity } from '../src/sim/CitySim';
import { districtCenter, DISTRICT_TEMPLATES } from '../src/sim/layout';
import { Agents } from '../src/world/Agents';
import type { Effects } from '../src/world/Effects';

describe('hot landing zone', () => {
  const effects = { tracer: () => {} } as unknown as Effects;
  const index = DISTRICT_TEMPLATES.findIndex((d) => d.name === 'Northside');
  const c = districtCenter(DISTRICT_TEMPLATES[index].col, DISTRICT_TEMPLATES[index].row);
  // District centres sit on an intersection, so this is a street landing.
  const heli = new THREE.Vector3(c.x, 1.9, c.z);

  function horde() {
    const state = createCity('lz');
    for (const d of state.districts) d.zombies = 0;
    // A dense horde: the district is 1.4 km across, so it takes numbers to crowd a landing zone.
    state.districts[index].zombies = 1200;
    state.districts[index].troops.strength = 0;
    return state;
  }

  it('zombies reach a helicopter on the street, block the doors and grab the skids', () => {
    const agents = new Agents('lz', effects);
    const state = horde();
    let threat = 0;
    let grabbers = 0;
    for (let t = 0; t < 90; t += 1 / 20) {
      agents.update(1 / 20, heli, 0, 1, state, 0, 0);
      threat = Math.max(threat, agents.attract.threat);
      grabbers = Math.max(grabbers, agents.attract.grabbers);
    }
    expect(threat).toBeGreaterThan(0);
    expect(grabbers).toBeGreaterThan(0);

    // Climbing shakes them off.
    agents.update(1 / 20, new THREE.Vector3(c.x, 12, c.z), 10, 1, state, 0, 10);
    agents.update(1 / 20, new THREE.Vector3(c.x, 12, c.z), 10, 1, state, 0, 10);
    expect(agents.attract.grabbers).toBe(0);
  });

  it('cannot be reached on a rooftop', () => {
    const agents = new Agents('lz', effects);
    const state = horde();
    let grabbers = 0;
    for (let t = 0; t < 60; t += 1 / 20) {
      // Landed on a 30 m roof: low over the roof, high over the street.
      agents.update(1 / 20, new THREE.Vector3(c.x, 31.9, c.z), 0, 1, state, 0, 30);
      grabbers = Math.max(grabbers, agents.attract.grabbers + agents.attract.threat);
    }
    expect(grabbers).toBe(0);
  });

  it('troops aboard fire from the doors', () => {
    const agents = new Agents('lz', effects);
    const state = horde();
    let kills = 0;
    for (let t = 0; t < 30; t += 1 / 20) {
      agents.update(1 / 20, heli, 0, 1, state, 0, 0);
      kills += agents.doorGunners(1 / 20, heli, 6);
    }
    expect(kills).toBeGreaterThan(5);
  });
});
