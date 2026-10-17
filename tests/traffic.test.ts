import { describe, expect, it } from 'vitest';
import { createCity } from '../src/sim/CitySim';
import { districtCenter } from '../src/sim/layout';
import { nearestNode, NODES_X, NODES_Z } from '../src/sim/streets';
import { EDGES, edgeIndex, EXITS, route, updateTraffic } from '../src/sim/traffic';
import type { CityState } from '../src/sim/types';

const quiet = () => {};

function city(): CityState {
  const s = createCity('traffic');
  for (const d of s.districts) {
    d.infected = 0;
    d.zombies = 0;
  }
  return s;
}

const named = (s: CityState, name: string) => s.districts.find((d) => d.name === name)!;
const total = (s: CityState) => s.traffic.load.reduce((a, b) => a + b, 0);
const meanBlocked = (s: CityState, id: number) => s.traffic.blockedShare![id];

/** Every street touching a district's ground (a crude way to wreck it). */
function wreck(s: CityState, id: number, amount: number): void {
  const d = s.districts[id];
  const c = districtCenter(d.col, d.row);
  const [ci, cj] = nearestNode(c.x, c.z);
  for (let i = ci - 6; i <= ci + 6; i++) {
    for (let j = cj - 6; j <= cj + 6; j++) {
      if (i < 0 || j < 0) continue;
      if (i + 1 < NODES_X) s.traffic.blocked[edgeIndex(i, j, i + 1, j)] = amount;
      if (j + 1 < NODES_Z) s.traffic.blocked[edgeIndex(i, j, i, j + 1)] = amount;
    }
  }
}

describe('traffic', () => {
  it('is heavier at rush hour than in the middle of the night', () => {
    const s = city();
    s.t = 8 * 60;
    updateTraffic(s, false, quiet);
    const rush = total(s);
    s.t = 3 * 60;
    updateTraffic(s, true, quiet);
    expect(rush).toBeGreaterThan(total(s) * 4);
  });

  it('breaks down where the dead are: drivers abandon their cars, and the wrecks stay', () => {
    const s = city();
    const d = named(s, 'Eastside');
    d.zombies = 3000;
    d.troops.strength = 0;
    d.police.officers = 0;
    s.t = 8 * 60;
    for (let h = 0; h < 24; h++, s.t += 60) updateTraffic(s, false, quiet);
    const wrecked = meanBlocked(s, d.id);
    expect(wrecked).toBeGreaterThan(0.2);
    expect(meanBlocked(s, named(s, 'Westfield').id)).toBeLessThan(0.05);
  });

  it('troops tow the wrecks clear in a district they hold', () => {
    const s = city();
    const d = named(s, 'Westfield');
    wreck(s, d.id, 0.5);
    d.troops.strength = 80;
    s.t = 3 * 60;
    updateTraffic(s, true, quiet);
    const before = meanBlocked(s, d.id);
    for (let h = 0; h < 12; h++, s.t += 60) updateTraffic(s, true, quiet);
    expect(meanBlocked(s, d.id)).toBeLessThan(before);
  });

  it('routes around streets choked with wrecks, and finds no way through a sealed-off district', () => {
    const s = city();
    const from = nearestNode(districtCenter(0, 1).x, districtCenter(0, 1).z);
    const to = nearestNode(districtCenter(3, 1).x, districtCenter(3, 1).z);
    const clear = route(s, from, to)!;
    expect(clear).not.toBeNull();
    // Choke the first street the clear route takes: the next route avoids it.
    const first = edgeIndex(clear.path[0], clear.path[1], clear.path[2], clear.path[3]);
    s.traffic.blocked[first] = 0.95;
    const around = route(s, from, to)!;
    expect(edgeIndex(around.path[0], around.path[1], around.path[2], around.path[3])).not.toBe(first);
    // Every street in the city choked: nowhere to go.
    s.traffic.blocked.fill(0.95);
    expect(route(s, from, to)).toBeNull();
  });

  it('slows trucks in jams', () => {
    const s = city();
    const from = nearestNode(districtCenter(0, 1).x, districtCenter(0, 1).z);
    const to = nearestNode(districtCenter(3, 1).x, districtCenter(3, 1).z);
    const free = route(s, from, to)!;
    for (let e = 0; e < EDGES; e++) s.traffic.load[e] = 3000;
    const jammed = route(s, from, to)!;
    expect(jammed.times[jammed.times.length - 1]).toBeGreaterThan(free.times[free.times.length - 1] * 2);
  });

  it('lets people escape by road while the highways flow, and traps them when they do not', () => {
    const s = city();
    const d = named(s, 'Southgate');
    d.zombies = 1500;
    s.t = 8 * 60;
    updateTraffic(s, false, quiet);
    expect(s.traffic.fled).toBeGreaterThan(0);

    const t = city();
    const events: string[] = [];
    const e = named(t, 'Southgate');
    e.zombies = 1500;
    t.traffic.blocked.fill(0.95);
    t.t = 8 * 60;
    updateTraffic(t, false, (_d, _s, text) => events.push(text));
    expect(t.traffic.fled).toBe(0);
    expect(events.some((x) => x.includes('trapped'))).toBe(true);
    expect(EXITS.length).toBeGreaterThan(2);
  });
});
