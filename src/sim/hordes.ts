// Hordes: the dead gathering into masses that roam the city. A district that runs short of prey
// (or falls) sheds part of its zombies into a horde; hordes walk the street grid toward whatever
// draws them most (people, light at night, gunfire, the player's rotors), absorb the dead of
// the districts they pass through, merge when they meet, and hit districts as a wave.
//
// Hordes move at a believable shamble in real time (about 2.5 m/s), so in game time they cover a
// block an hour and a district in half a day: they snowball slowly into a few huge masses.

import { districtAt, districtCenter, DISTRICT_TEMPLATES } from './layout';
import { nextRandom } from './rng';
import { baseSealed, isBase } from './quarantine';
import { neighbors, nearestNode, nodeX, nodeZ } from './streets';
import type { CityState, DistrictState, Horde, Severity } from './types';

type Emit = (district: number | null, severity: Severity, text: string, radio?: boolean) => void;

/** Metres per game minute: about 2.5 m/s at the daytime clock rate; twice that when hunting. */
export const HORDE_SPEED = 3.5;
export const HUNT_SPEED = 7;
/** A district sheds a horde once it has this many zombies and too little prey. */
const FORM_MIN = 250;
const FORM_SHARE = 0.3;
/** Share of a district's resident zombies a horde passing through picks up each hour. */
const ABSORB_SHARE = 0.15;
const MERGE_DISTANCE = 220;
const DISBAND_SIZE = 40;
const SETTLE_MINUTES = 180;
/** Hordes this big get announced on the radio. */
const NOTABLE = 800;
/** A horde only changes course for a clearly stronger draw. */
const RETARGET_MARGIN = 1.3;
const ANNOUNCE_EVERY = 180;

export const totalZombies = (d: DistrictState) => d.zombies + d.hordeZombies;

const roughly = (n: number) => (n >= 1000 ? `~${(n / 1000).toFixed(1)}k` : `~${Math.round(n / 10) * 10}`);

/** Recount how many horde zombies are in each district. Call before district updates. */
export function countHordes(s: CityState): void {
  for (const d of s.districts) d.hordeZombies = 0;
  for (const h of s.hordes) {
    const d = s.districts[districtAt(h.x, h.z)];
    if (d) d.hordeZombies += h.size;
  }
}

/** Apply combat losses suffered by hordes in a district, in proportion to their size. */
export function applyHordeLosses(s: CityState, district: number, losses: number): void {
  if (losses <= 0) return;
  const here = s.hordes.filter((h) => districtAt(h.x, h.z) === district);
  const total = here.reduce((n, h) => n + h.size, 0);
  if (total <= 0) return;
  for (const h of here) h.size = Math.max(0, h.size - (losses * h.size) / total);
}

/** How strongly a district draws a horde standing at (x, z). */
function attraction(d: DistrictState, x: number, z: number, night: boolean): number {
  const c = districtCenter(d.col, d.row);
  const prey = Math.sqrt(d.population + d.troops.strength + 1);
  const light = night && d.power !== 'dark' ? 1.6 : 1;
  const noise = 1 + d.noise + d.playerNoise * 2;
  return (prey * light * noise) / (1 + Math.hypot(c.x - x, c.z - z) / 1500);
}

/**
 * Pick the strongest draw. Unless forced (on arrival), a horde keeps its course unless something
 * draws it clearly harder, so it doesn't waver between two targets.
 */
function chooseTarget(s: CityState, h: Horde, night: boolean, emit: Emit, force = false): void {
  let best = h.target;
  let bestScore = -Infinity;
  const sealed = baseSealed(s);
  if (sealed && isBase(s.districts[h.target])) force = true;
  for (const d of s.districts) {
    if (sealed && isBase(d)) continue;
    const score = attraction(d, h.x, h.z, night) * (0.9 + nextRandom(s) * 0.2);
    if (score > bestScore) {
      bestScore = score;
      best = d.id;
    }
  }
  const current = attraction(s.districts[h.target], h.x, h.z, night);
  if (!force && bestScore < current * RETARGET_MARGIN) best = h.target;
  const d = s.districts[best];
  h.hunting = d.playerNoise > 1 || d.noise > 1;
  if (best === h.target) return;
  h.target = best;
  if (h.size >= NOTABLE && d.population + d.troops.strength > 500 && s.t - h.announcedAt >= ANNOUNCE_EVERY) {
    h.announcedAt = s.t;
    emit(d.id, h.size >= NOTABLE * 3 ? 'critical' : 'warn', `A horde of ${roughly(h.size)} is heading for ${d.name}.`);
  }
}

function spawnHorde(s: CityState, d: DistrictState, size: number, emit: Emit): Horde {
  const tpl = DISTRICT_TEMPLATES[d.id];
  const c = districtCenter(tpl.col, tpl.row);
  // Start at a street corner somewhere in the district.
  const [ni, nj] = nearestNode(c.x + (nextRandom(s) - 0.5) * 900, c.z + (nextRandom(s) - 0.5) * 900);
  const h: Horde = {
    id: ++s.hordeSeq, x: nodeX(ni), z: nodeZ(nj), size, heading: 0,
    target: d.id, ni, nj, settle: 0, hunting: false, announcedAt: -Infinity,
  };
  s.hordes.push(h);
  if (size >= NOTABLE) emit(d.id, 'warn', `A horde of ${roughly(size)} has formed in ${d.name}.`);
  return h;
}

/** Hourly: districts short of prey shed hordes; hordes pick up the dead of districts they're in. */
export function formHordes(s: CityState, emit: Emit): void {
  for (const d of s.districts) {
    const humans = d.population + d.troops.strength;
    const here = s.hordes.filter((h) => districtAt(h.x, h.z) === d.id);
    if (here.length) {
      const biggest = here.reduce((a, b) => (b.size > a.size ? b : a));
      const join = d.zombies * ABSORB_SHARE;
      biggest.size += join;
      d.zombies -= join;
      continue;
    }
    const starving = humans < d.zombies * 1.5 || d.status === 'overrun';
    if (d.zombies >= FORM_MIN && starving) {
      const migrants = d.zombies * FORM_SHARE;
      d.zombies -= migrants;
      spawnHorde(s, d, migrants, emit);
    }
  }
}

/** The neighbouring corner that gets closest to (x, z), never inside the sealed base. */
function nextCorner(s: CityState, i: number, j: number, x: number, z: number): [number, number] {
  const sealed = baseSealed(s);
  let best: [number, number] = [i, j];
  let bestD = Infinity;
  for (const [ni, nj] of neighbors(i, j)) {
    if (sealed && isBase(s.districts[districtAt(nodeX(ni), nodeZ(nj))])) continue;
    const d = Math.hypot(nodeX(ni) - x, nodeZ(nj) - z);
    if (d < bestD) {
      bestD = d;
      best = [ni, nj];
    }
  }
  return best;
}

/** Every game minute: walk the streets, settle on targets, merge and disband. */
export function moveHordes(s: CityState, night: boolean, emit: Emit): void {
  for (const h of s.hordes) {
    if (h.settle > 0) {
      h.settle -= 1;
      if (h.settle <= 0) {
        // Stay while there's still feeding to be done.
        const d = s.districts[h.target];
        if (d.population + d.troops.strength > 300 && districtAt(h.x, h.z) === d.id) h.settle = 60;
        else chooseTarget(s, h, night, emit, true);
      }
      continue;
    }
    if (Math.floor(s.t) % 30 === h.id % 30) chooseTarget(s, h, night, emit);

    let budget = h.hunting ? HUNT_SPEED : HORDE_SPEED;
    for (let step = 0; step < 4 && budget > 0; step++) {
      const tx = nodeX(h.ni);
      const tz = nodeZ(h.nj);
      const dx = tx - h.x;
      const dz = tz - h.z;
      const dist = Math.hypot(dx, dz);
      if (dist > 1e-6) h.heading = Math.atan2(-dx, -dz);
      if (dist > budget) {
        h.x += (dx / dist) * budget;
        h.z += (dz / dist) * budget;
        break;
      }
      h.x = tx;
      h.z = tz;
      budget -= dist;
      // At the next corner: on to the target's centre, or settle in to attack.
      const t = DISTRICT_TEMPLATES[h.target];
      const c = districtCenter(t.col, t.row);
      const [ci, cj] = nearestNode(c.x, c.z);
      if (h.ni === ci && h.nj === cj) {
        h.settle = SETTLE_MINUTES;
        break;
      }
      [h.ni, h.nj] = nextCorner(s, h.ni, h.nj, c.x, c.z);
    }
  }

  // Hordes that meet become one.
  for (let i = 0; i < s.hordes.length; i++) {
    for (let j = i + 1; j < s.hordes.length; j++) {
      const a = s.hordes[i];
      const b = s.hordes[j];
      if (a.size <= 0 || b.size <= 0 || Math.hypot(a.x - b.x, a.z - b.z) > MERGE_DISTANCE) continue;
      const [big, small] = a.size >= b.size ? [a, b] : [b, a];
      big.size += small.size;
      small.size = 0;
      if (big.size >= NOTABLE * 3 && big.size - small.size < NOTABLE * 3) {
        const d = s.districts[districtAt(big.x, big.z)];
        emit(d?.id ?? null, 'critical', `Two hordes have merged${d ? ` in ${d.name}` : ''}: ${roughly(big.size)} strong.`);
      }
    }
  }

  // Remnants scatter back into the districts they're in.
  s.hordes = s.hordes.filter((h) => {
    if (h.size >= DISBAND_SIZE) return true;
    const d = s.districts[districtAt(h.x, h.z)];
    if (d) d.zombies += h.size;
    return false;
  });
}
