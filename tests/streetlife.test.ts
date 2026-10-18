import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { CitySim, createCity } from '../src/sim/CitySim';
import { districtCenter } from '../src/sim/layout';
import { nearestNode, nodeX, nodeZ, roadWidth } from '../src/sim/streets';
import type { CityState } from '../src/sim/types';
import { Agents, OUT_BY_DAY } from '../src/world/Agents';
import { Cars } from '../src/world/Cars';
import type { Effects } from '../src/world/Effects';

const effects = { tracer: () => {} } as unknown as Effects;
const named = (s: CityState, name: string) => s.districts.find((d) => d.name === name)!;

/** A quiet city: no dead, no infected anywhere. */
function quiet(seed: string): CityState {
  const s = createCity(seed);
  for (const d of s.districts) {
    d.zombies = 0;
    d.infected = 0;
  }
  return s;
}

interface Seen {
  kind: number;
  x: number;
  z: number;
  leader?: unknown;
  car?: number;
  truck?: unknown;
  post: number;
}
const people = (agents: Agents) => (agents as unknown as { people: Seen[] }).people;
const CIVILIAN = 0;
const POLICE = 2;
const RIOT = 3;

function watch(state: CityState, name: string, seconds: number, agents = new Agents('street', effects)): Agents {
  const d = named(state, name);
  const c = districtCenter(d.col, d.row);
  const heli = new THREE.Vector3(c.x + 60, 120, c.z + 60);
  for (let t = 0; t < seconds; t += 1 / 20) agents.update(1 / 20, heli, 120, 1, state, 0, 120);
  return agents;
}

describe('riot police', () => {
  it('stay at the station while the district is calm, and roll out for a riot or the gathering dead', () => {
    const s = quiet('riot-calm');
    const sim = new CitySim(s);
    sim.step(30);
    const downtown = named(s, 'Downtown');
    expect(downtown.police.riot).toBeGreaterThan(0);
    expect(downtown.police.riotOut).toBeFalsy();

    downtown.rioting = true;
    downtown.order = 20;
    sim.step(2);
    expect(downtown.police.riotOut).toBe(true);

    const east = named(s, 'Eastside');
    expect(east.police.riotOut).toBeFalsy();
    east.zombies = 12;
    sim.step(2);
    expect(east.police.riotOut).toBe(true);
  });

  it('are on screen only when called out, in squads with their trucks', () => {
    const calm = quiet('riot-screen');
    const agents = watch(calm, 'Downtown', 4);
    expect(people(agents).filter((p) => p.kind === RIOT).length).toBe(0);

    const s = quiet('riot-screen');
    const d = named(s, 'Downtown');
    d.rioting = true;
    d.police.riotOut = true;
    const out = watch(s, 'Downtown', 4);
    const riot = people(out).filter((p) => p.kind === RIOT);
    expect(riot.length).toBeGreaterThan(4);
    // Every one of them belongs to a squad with a truck, and squads are several strong.
    expect(riot.every((p) => p.truck)).toBe(true);
    const squads = new Map<unknown, number>();
    for (const p of riot) squads.set(p.truck, (squads.get(p.truck) ?? 0) + 1);
    expect(Math.min(...squads.values())).toBeGreaterThanOrEqual(3);
  });
});

describe('police on foot', () => {
  it('walk their beat in twos and threes, more of them downtown than in the suburbs', () => {
    const s = quiet('foot');
    const count = (name: string) => {
      const agents = watch(s, name, 4);
      const foot = people(agents).filter((p) => p.kind === POLICE && p.car === undefined && p.post !== 1000);
      // Nobody alone: each lead officer has a partner, each partner its lead.
      const leads = new Set(foot.filter((p) => p.leader).map((p) => p.leader));
      for (const p of foot) expect(p.leader ? foot.includes(p.leader as Seen) : leads.has(p)).toBe(true);
      return foot.length;
    };
    const downtown = count('Downtown');
    const suburb = count('Northside');
    expect(downtown).toBeGreaterThanOrEqual(2);
    expect(downtown).toBeGreaterThan(suburb);
  });
});

describe('civilians', () => {
  it('keep to the sidewalks in a calm district', () => {
    const s = quiet('sidewalks');
    const agents = watch(s, 'Westfield', 20);
    const walkers = people(agents).filter((p) => p.kind === CIVILIAN);
    expect(walkers.length).toBeGreaterThan(30);
    // Out in the carriageway: only those at a crosswalk, a moment at a time.
    const inRoad = walkers.filter((p) => {
      const [i, j] = nearestNode(p.x, p.z);
      const dx = Math.abs(p.x - nodeX(i));
      const dz = Math.abs(p.z - nodeZ(j));
      const crossing = dx < roadWidth(i) / 2 + 6 && dz < roadWidth(j) / 2 + 6;
      return !crossing && (dx < roadWidth(i) / 2 - 0.5 || dz < roadWidth(j) / 2 - 0.5);
    });
    expect(inRoad.length / walkers.length).toBeLessThan(0.03);
  });
});

describe('patrol cars', () => {
  it('pull over for the dead and send two officers out on foot, who get back in once it is quiet', () => {
    const s = quiet('cars-crew');
    // An hour of traffic on the streets.
    new CitySim(s).step(8 * 60);
    for (const x of s.districts) x.zombies = 0;
    const d = named(s, 'Westfield');
    const c = districtCenter(d.col, d.row);
    // Plenty of police, so plenty of patrol cars.
    d.police.officers = 600;
    const agents = new Agents('crew', effects);
    const cars = new Cars();
    const heli = new THREE.Vector3(c.x, 120, c.z);
    const step = () => {
      agents.update(1 / 20, heli, 120, 1, s, 0, 120);
      cars.update(1 / 20, s, heli.x, heli.z, agents);
    };
    for (let k = 0; k < 40; k++) step();
    const patrol = cars as unknown as { cars: { police: boolean }[] };
    expect(patrol.cars.filter((x) => x.police).length).toBeGreaterThan(0);
    // The dead turn up in the district.
    d.zombies = 80;
    let crews = 0;
    for (let k = 0; k < 20 * 15; k++) {
      step();
      crews = Math.max(crews, people(agents).filter((p) => p.car !== undefined).length);
    }
    expect(crews).toBeGreaterThanOrEqual(2);
    expect(crews % 2).toBe(0);
    // With the dead gone, the crews get back in.
    d.zombies = 0;
    for (let k = 0; k < 20 * 30; k++) step();
    expect(people(agents).filter((p) => p.car !== undefined).length).toBe(0);
  });
});

describe('what you see on the ground', () => {
  const inView = (agents: Agents, state: CityState, name: string) => {
    const d = named(state, name);
    const c = districtCenter(d.col, d.row);
    const share = (agents as unknown as { areaShare: (x: number, z: number) => Map<number, number> }).areaShare(c.x + 60, c.z + 60).get(d.id)!;
    return { d, share };
  };

  it('matches the simulation one to one when it can: people out on the street, the dead, the soldiers', () => {
    const s = quiet('one-to-one');
    const d = named(s, 'Eastside');
    d.zombies = 400;
    d.troops.strength = 30;
    const agents = watch(s, 'Eastside', 6);
    const { share } = inView(agents, s, 'Eastside');
    expect(agents.scale).toBe(1);
    const out = (d.population - d.sheltered) * OUT_BY_DAY * share;
    const civilians = people(agents).filter((p) => p.kind === CIVILIAN && p.car === undefined).length;
    expect(civilians).toBeGreaterThan(out * 0.85);
    expect(civilians).toBeLessThan(out * 1.15);
    expect(agents.crowd.living()).toBeGreaterThan(400 * share * 0.85);
    expect(agents.crowd.living()).toBeLessThan(400 * share * 1.15 + 6);
  });

  it('draws everyone at one shared scale when there are too many to draw', () => {
    const s = quiet('shared-scale');
    const d = named(s, 'Eastside');
    d.zombies = 60000;
    const agents = watch(s, 'Eastside', 8);
    const { share } = inView(agents, s, 'Eastside');
    expect(agents.scale).toBeLessThan(1);
    const civilians = people(agents).filter((p) => p.kind === CIVILIAN && p.car === undefined).length;
    // The ratio of the living to the dead on screen is the simulation's.
    const real = ((d.population - d.sheltered) * OUT_BY_DAY * share) / (60000 * share);
    const seen = civilians / agents.crowd.living();
    expect(seen).toBeGreaterThan(real * 0.8);
    expect(seen).toBeLessThan(real * 1.25);
  });

  it('door-gun kills come off the simulation\'s count', () => {
    const s = quiet('kills');
    const d = named(s, 'Westfield');
    d.zombies = 100;
    const sim = new CitySim(s);
    expect(sim.command({ type: 'killZombies', district: d.id, count: 30 })).toBe(true);
    expect(d.zombies).toBe(70);
  });
});
