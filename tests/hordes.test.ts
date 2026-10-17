import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { CitySim, createCity } from '../src/sim/CitySim';
import { applyHordeLosses, countHordes, formHordes, moveHordes, totalZombies } from '../src/sim/hordes';
import { districtAt, districtCenter, DISTRICT_TEMPLATES } from '../src/sim/layout';
import { nearestNode, nodeX, nodeZ } from '../src/sim/streets';
import type { CityState, Horde } from '../src/sim/types';
import { Agents } from '../src/world/Agents';
import { CROWD_CAPACITY } from '../src/world/Crowd';
import type { Effects } from '../src/world/Effects';

const DAY = 1440;
const quiet = () => {};

function emptyCity(): CityState {
  const s = createCity('hordes');
  for (const d of s.districts) {
    d.zombies = 0;
    d.infected = 0;
  }
  return s;
}

function horde(s: CityState, id: number, x: number, z: number, size: number): Horde {
  const [ni, nj] = nearestNode(x, z);
  const h: Horde = { id, x: nodeX(ni), z: nodeZ(nj), size, heading: 0, target: 0, ni, nj, settle: 0, hunting: false, announcedAt: -Infinity };
  s.hordes.push(h);
  s.hordeSeq = Math.max(s.hordeSeq, id);
  return h;
}

const zombiesIn = (s: CityState) => s.districts.reduce((n, d) => n + d.zombies, 0) + s.hordes.reduce((n, h) => n + h.size, 0);

describe('hordes', () => {
  it('form on their own as the outbreak grows', () => {
    const sim = new CitySim('1');
    sim.step(DAY * 10);
    expect(sim.state.hordes.length).toBeGreaterThan(0);
    expect(Math.max(...sim.state.hordes.map((h) => h.size))).toBeGreaterThan(1000);
  });

  it('are shed by a district that has run out of prey, without losing anyone', () => {
    const s = emptyCity();
    const d = s.districts[0];
    d.zombies = 2000;
    d.population = 100;
    const before = zombiesIn(s);
    formHordes(s, quiet);
    expect(s.hordes.length).toBe(1);
    expect(d.zombies).toBeLessThan(2000);
    expect(zombiesIn(s)).toBeCloseTo(before, 6);
  });

  it('walk the streets toward prey', () => {
    const s = emptyCity();
    const from = districtCenter(DISTRICT_TEMPLATES[0].col, DISTRICT_TEMPLATES[0].row);
    const h = horde(s, 1, from.x, from.z, 3000);
    // Everyone else is gone; only St. Mary's still draws them.
    const prey = s.districts.find((d) => d.kind === 'hospital')!;
    for (const d of s.districts) if (d !== prey) {
      d.population = 0;
      d.troops.strength = 0;
    }
    h.target = prey.id;
    const c = districtCenter(prey.col, prey.row);
    const start = Math.hypot(c.x - h.x, c.z - h.z);
    for (let m = 0; m < 240; m++) {
      s.t++;
      moveHordes(s, false, quiet);
    }
    expect(Math.hypot(c.x - h.x, c.z - h.z)).toBeLessThan(start - 400);
  });

  it('stay out of the sealed base until every other district has fallen', () => {
    const s = emptyCity();
    const base = s.districts.find((d) => d.kind === 'airbase')!;
    // Only the base has anyone left, and a horde waits next door.
    for (const d of s.districts) if (d !== base) {
      d.population = 0;
      d.troops.strength = 0;
    }
    const next = districtCenter(base.col + 1, base.row);
    const h = horde(s, 1, next.x, next.z, 5000);
    const walk = (minutes: number) => {
      let inside = 0;
      for (let m = 0; m < minutes; m++) {
        s.t++;
        moveHordes(s, false, quiet);
        if (districtAt(h.x, h.z) === base.id) inside++;
      }
      return inside;
    };
    expect(walk(1200)).toBe(0);
    expect(h.target).not.toBe(base.id);
    s.flags.baseOpen = true;
    h.settle = 0;
    expect(walk(1200)).toBeGreaterThan(0);
  });

  it('merge when they meet', () => {
    const s = emptyCity();
    const c = districtCenter(DISTRICT_TEMPLATES[5].col, DISTRICT_TEMPLATES[5].row);
    horde(s, 1, c.x, c.z, 1200);
    horde(s, 2, c.x + 120, c.z, 800);
    moveHordes(s, false, quiet);
    expect(s.hordes.length).toBe(1);
    expect(s.hordes[0].size).toBeCloseTo(2000, 6);
  });

  it('count toward the district they stand in and share its losses', () => {
    const s = emptyCity();
    const c = districtCenter(DISTRICT_TEMPLATES[5].col, DISTRICT_TEMPLATES[5].row);
    const big = horde(s, 1, c.x, c.z, 3000);
    const small = horde(s, 2, c.x + 500, c.z + 500, 1000);
    countHordes(s);
    expect(s.districts[5].hordeZombies).toBe(4000);
    expect(totalZombies(s.districts[5])).toBe(4000);
    applyHordeLosses(s, 5, 400);
    expect(big.size).toBeCloseTo(2700, 6);
    expect(small.size).toBeCloseTo(900, 6);
  });
});

describe('crowd', () => {
  const effects = { tracer: () => {} } as unknown as Effects;

  it('puts thousands of a nearby horde on screen, within capacity', () => {
    const s = emptyCity();
    const c = districtCenter(DISTRICT_TEMPLATES[5].col, DISTRICT_TEMPLATES[5].row);
    const h = horde(s, 1, c.x, c.z, 20000);
    h.settle = 100;
    const agents = new Agents('crowd', effects);
    const heli = new THREE.Vector3(h.x + 30, 0, h.z + 30);
    for (let t = 0; t < 8; t += 1 / 30) agents.update(1 / 30, heli, 150, 1, s, 0);
    expect(agents.crowd.count).toBeGreaterThan(5000);
    expect(agents.crowd.count).toBeLessThanOrEqual(CROWD_CAPACITY);
    expect(agents.census().zombies).toBe(agents.crowd.living());
  });

  it('keeps distant zombies moving on their slower update tier', () => {
    const s = emptyCity();
    const c = districtCenter(DISTRICT_TEMPLATES[5].col, DISTRICT_TEMPLATES[5].row);
    const h = horde(s, 1, c.x, c.z, 2000);
    const agents = new Agents('tier', effects);
    // Far enough that the whole horde sits on the slowest tier, but within view.
    const heli = new THREE.Vector3(c.x + 700, 0, c.z);
    for (let t = 0; t < 3; t += 1 / 30) agents.update(1 / 30, heli, 150, 1, s, 0);
    const crowd = agents.crowd;
    const before = Array.from({ length: crowd.count }, (_, i) => [crowd.posX(i), crowd.posZ(i)]);
    // The horde shambles west a few metres each simulation minute; the column follows its path.
    for (let minute = 0; minute < 8; minute++) {
      h.x -= 3.5;
      s.t += 1;
      for (let t = 0; t < 1; t += 1 / 30) agents.update(1 / 30, heli, 150, 1, s, 0);
    }
    for (let t = 0; t < 4; t += 1 / 30) agents.update(1 / 30, heli, 150, 1, s, 0);
    expect(crowd.count).toBe(before.length);
    const moved = before.reduce((sum, [x, z], i) => sum + Math.hypot(crowd.posX(i) - x, crowd.posZ(i) - z), 0) / before.length;
    expect(moved).toBeGreaterThan(8);
  });
});
