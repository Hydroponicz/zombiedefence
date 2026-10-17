// City traffic on the street grid. Every hour people drive: commuting between districts by the time
// of day, fleeing danger toward safer districts, and leaving the city by the highways. Trips follow
// routes over the streets (avenues carry three times a side street), and each street slows as it
// fills, on the usual volume-delay curve. As the outbreak grows the network breaks down: gridlock
// and the dead nearby make drivers abandon their cars, the wrecks choke the streets for good unless
// soldiers and police tow them clear, rioters burn cars, and the city's food trucks and fuel convoys
// have to find their way through what's left.

import { CITY_DEPTH, CITY_WIDTH, districtAt, districtCenter } from './layout';
import { totalZombies } from './hordes';
import { nearestNode, NODES_X, NODES_Z, nodeX, nodeZ, roadWidth, STREET_SPACING } from './streets';
import type { CityState, DistrictState, Severity, Traffic } from './types';

type Emit = (district: number | null, severity: Severity, text: string, radio?: boolean) => void;

/** Edges: horizontal (i, j)-(i+1, j) first, then vertical (i, j)-(i, j+1). */
export const H_EDGES = (NODES_X - 1) * NODES_Z;
export const EDGES = H_EDGES + NODES_X * (NODES_Z - 1);

/** Vehicles per hour a street carries in free flow; an avenue carries three times as many. */
const STREET_CAPACITY = 600;
/** Abandoned cars clog at most this share of a street. */
const MAX_BLOCKED = 0.98;
/** Above this share blocked, a street is impassable. */
const IMPASSABLE = 0.9;
/** Free-flow speed in metres per game minute (about 40 km/h at the daytime clock rate). */
export const FREE_SPEED = 25;
/** Routes are recomputed every few hours (and when the streets change). */
const ROUTE_HOURS = 3;

/** The highways out of the city: west, south (two) and east. The north edge is the sea. */
export const EXITS: { name: string; node: [number, number] }[] = [
  { name: 'Highway 9 west', node: [0, Math.round((NODES_Z - 1) * 0.55)] },
  { name: 'Route 4 south', node: [Math.round((NODES_X - 1) * 0.35), NODES_Z - 1] },
  { name: 'Route 7 south', node: [Math.round((NODES_X - 1) * 0.85), NODES_Z - 1] },
  { name: 'Highway 9 east', node: [NODES_X - 1, Math.round((NODES_Z - 1) * 0.5)] },
];

export function createTraffic(): Traffic {
  return { load: new Float32Array(EDGES), blocked: new Float32Array(EDGES), jam: [], fled: 0 };
}

export function edgeIndex(i: number, j: number, ni: number, nj: number): number {
  if (j === nj) return j * (NODES_X - 1) + Math.min(i, ni);
  return H_EDGES + Math.min(j, nj) * NODES_X + i;
}

/** The two corners of an edge: [i, j, ni, nj]. */
export function edgeEnds(e: number): [number, number, number, number] {
  if (e < H_EDGES) {
    const j = Math.floor(e / (NODES_X - 1));
    const i = e - j * (NODES_X - 1);
    return [i, j, i + 1, j];
  }
  const k = e - H_EDGES;
  const j = Math.floor(k / NODES_X);
  const i = k - j * NODES_X;
  return [i, j, i, j + 1];
}

/** Whether an edge runs along an avenue. */
export function isAvenue(e: number): boolean {
  const [i, j] = edgeEnds(e);
  return e < H_EDGES ? roadWidth(j) > 20 : roadWidth(i) > 20;
}

export function capacity(e: number): number {
  return isAvenue(e) ? STREET_CAPACITY * 3 : STREET_CAPACITY;
}

/** Volume over what the street can carry with its wrecks (1 = at capacity). */
export function congestion(t: Traffic, e: number): number {
  const slow = t.slow?.[EDGE_DISTRICT[e]] ?? 1;
  return t.load[e] / (capacity(e) * slow * (1 - t.blocked[e]) + 1);
}

/** Share of free-flow speed: the volume-delay curve, and nothing through a street choked with wrecks. */
export function speedFactor(t: Traffic, e: number): number {
  if (t.blocked[e] > IMPASSABLE) return 0;
  const vc = congestion(t, e);
  return Math.max(0.03, 1 / (1 + 0.15 * vc ** 4)) * (1 - t.blocked[e] * 0.5);
}

const edgeDistrict = (e: number) => {
  const [i, j, ni, nj] = edgeEnds(e);
  return districtAt((nodeX(i) + nodeX(ni)) / 2, (nodeZ(j) + nodeZ(nj)) / 2);
};

/** District of every edge, computed once. */
const EDGE_DISTRICT = (() => {
  const out = new Int16Array(EDGES);
  for (let e = 0; e < EDGES; e++) out[e] = edgeDistrict(e);
  return out;
})();

// --- Routing ---------------------------------------------------------------------------------

const NODES = NODES_X * NODES_Z;
const nodeId = (i: number, j: number) => j * NODES_X + i;

/** Single-source shortest paths over the streets. Cost is travel time; impassable streets are skipped. */
function dijkstra(t: Traffic, source: number, congested: boolean): { dist: Float64Array; prev: Int32Array } {
  const dist = new Float64Array(NODES).fill(Infinity);
  const prev = new Int32Array(NODES).fill(-1);
  const heap: number[] = [];
  const keys: number[] = [];
  const push = (n: number, k: number) => {
    heap.push(n);
    keys.push(k);
    let c = heap.length - 1;
    while (c > 0) {
      const p = (c - 1) >> 1;
      if (keys[p] <= keys[c]) break;
      [heap[p], heap[c]] = [heap[c], heap[p]];
      [keys[p], keys[c]] = [keys[c], keys[p]];
      c = p;
    }
  };
  const pop = (): number => {
    const top = heap[0];
    const lastN = heap.pop()!;
    const lastK = keys.pop()!;
    if (heap.length) {
      heap[0] = lastN;
      keys[0] = lastK;
      let c = 0;
      for (;;) {
        const l = c * 2 + 1;
        const r = l + 1;
        let m = c;
        if (l < heap.length && keys[l] < keys[m]) m = l;
        if (r < heap.length && keys[r] < keys[m]) m = r;
        if (m === c) break;
        [heap[m], heap[c]] = [heap[c], heap[m]];
        [keys[m], keys[c]] = [keys[c], keys[m]];
        c = m;
      }
    }
    return top;
  };
  dist[source] = 0;
  push(source, 0);
  while (heap.length) {
    const k0 = keys[0];
    const n = pop();
    if (k0 > dist[n]) continue;
    const i = n % NODES_X;
    const j = (n - i) / NODES_X;
    for (const [ni, nj] of [[i + 1, j], [i - 1, j], [i, j + 1], [i, j - 1]]) {
      if (ni < 0 || nj < 0 || ni >= NODES_X || nj >= NODES_Z) continue;
      const e = edgeIndex(i, j, ni, nj);
      const f = congested ? speedFactor(t, e) : t.blocked[e] > IMPASSABLE ? 0 : 1 - t.blocked[e] * 0.5;
      if (f <= 0) continue;
      // Avenues are quicker; drivers prefer them.
      const cost = STREET_SPACING / (FREE_SPEED * f * (isAvenue(e) ? 1.3 : 1));
      const m = nodeId(ni, nj);
      const d = dist[n] + cost;
      if (d < dist[m]) {
        dist[m] = d;
        prev[m] = n;
        push(m, d);
      }
    }
  }
  return { dist, prev };
}

function trace(prev: Int32Array, source: number, target: number): number[] | null {
  if (source !== target && prev[target] < 0) return null;
  const nodes: number[] = [];
  for (let n = target; n !== -1 && nodes.length <= NODES; n = n === source ? -1 : prev[n]) nodes.push(n);
  nodes.reverse();
  return nodes;
}

/**
 * The quickest drive between two corners right now, as flattened corners (i0, j0, i1, j1, ...) and
 * the game minutes to reach each one; null if the streets are blocked.
 */
export function route(s: CityState, from: [number, number], to: [number, number]): { path: number[]; times: number[] } | null {
  return routesFrom(s, from)(to);
}

/** Routes from one corner to anywhere, sharing one search (for a depot sending several trucks). */
export function routesFrom(s: CityState, from: [number, number]): (to: [number, number]) => { path: number[]; times: number[] } | null {
  const source = nodeId(from[0], from[1]);
  const { prev } = dijkstra(s.traffic, source, true);
  return (to) => drive(s.traffic, prev, source, to);
}

function drive(t: Traffic, prev: Int32Array, source: number, to: [number, number]): { path: number[]; times: number[] } | null {
  const nodes = trace(prev, source, nodeId(to[0], to[1]));
  if (!nodes) return null;
  const path: number[] = [];
  const times: number[] = [];
  let time = 0;
  for (let k = 0; k < nodes.length; k++) {
    const i = nodes[k] % NODES_X;
    const j = (nodes[k] - i) / NODES_X;
    if (k > 0) {
      const pi = path[path.length - 2];
      const pj = path[path.length - 1];
      time += STREET_SPACING / (FREE_SPEED * Math.max(0.03, speedFactor(t, edgeIndex(pi, pj, i, j))));
    }
    path.push(i, j);
    times.push(time);
  }
  return { path, times };
}

/** Free-flow routes between district centres and to the exits, recomputed every few hours. */
interface Routes {
  hour: number;
  /** Edges along the route from district a to b (or exit -1 - k). */
  edges: Map<string, number[]>;
}
const routeCache = new WeakMap<Traffic, Routes>();

function centreNode(d: DistrictState): [number, number] {
  const c = districtCenter(d.col, d.row);
  return nearestNode(c.x, c.z);
}

function routes(s: CityState): Routes {
  const hour = Math.floor(s.t / 60);
  const cached = routeCache.get(s.traffic);
  if (cached && hour - cached.hour < ROUTE_HOURS) return cached;
  const edges = new Map<string, number[]>();
  for (const a of s.districts) {
    const [ai, aj] = centreNode(a);
    const source = nodeId(ai, aj);
    const { prev } = dijkstra(s.traffic, source, false);
    const add = (key: string, target: [number, number]) => {
      const nodes = trace(prev, source, nodeId(target[0], target[1]));
      if (!nodes) return;
      const list: number[] = [];
      for (let k = 1; k < nodes.length; k++) {
        const i0 = nodes[k - 1] % NODES_X;
        const j0 = (nodes[k - 1] - i0) / NODES_X;
        const i1 = nodes[k] % NODES_X;
        const j1 = (nodes[k] - i1) / NODES_X;
        list.push(edgeIndex(i0, j0, i1, j1));
      }
      edges.set(key, list);
    };
    for (const b of s.districts) if (b !== a) add(`${a.id}-${b.id}`, centreNode(b));
    EXITS.forEach((x, k) => add(`${a.id}-x${k}`, x.node));
  }
  const out = { hour, edges };
  routeCache.set(s.traffic, out);
  return out;
}

/** How freely traffic moves from district a to b: the slowest street on the way (0 = no road). */
export function roadFlow(s: CityState, a: number, b: number): number {
  const list = routes(s).edges.get(`${a}-${b}`);
  if (!list) return 0;
  let worst = 1;
  for (const e of list) worst = Math.min(worst, speedFactor(s.traffic, e));
  return worst;
}

/** Whether a district can still reach the outside by road, and how freely. */
export function exitAccess(s: CityState, d: DistrictState): number {
  const r = routes(s);
  let best = 0;
  EXITS.forEach((_, k) => {
    const list = r.edges.get(`${d.id}-x${k}`);
    if (!list) return;
    let worst = 1;
    for (const e of list) worst = Math.min(worst, speedFactor(s.traffic, e));
    best = Math.max(best, worst);
  });
  return best;
}

// --- Hourly update ---------------------------------------------------------------------------

/** Share of the population driving each hour: morning and evening rush, quiet nights. */
function rush(minuteOfDay: number): number {
  const h = minuteOfDay / 60;
  if (h >= 7 && h < 9.5) return 1;
  if (h >= 16 && h < 19) return 1;
  if (h >= 9.5 && h < 16) return 0.6;
  if (h >= 19 && h < 23) return 0.4;
  return 0.08;
}

/** How frightened a district is: the dead in its streets and the state of its neighbours. */
function fearOf(s: CityState, d: DistrictState): number {
  const threat = Math.min(1, totalZombies(d) / (d.population * 0.01 + d.troops.strength * 2 + 20));
  let near = 0;
  for (const n of d.neighbors) near = Math.max(near, s.districts[n].status === 'overrun' ? 0.6 : s.districts[n].status === 'contested' ? 0.3 : 0);
  return Math.min(1, threat + near + (d.status === 'contested' ? 0.2 : 0));
}

const civilian = (d: DistrictState) => d.kind !== 'airbase' && d.status !== 'overrun';

export function updateTraffic(s: CityState, night: boolean, emit: Emit): void {
  const t = s.traffic;
  const r = routes(s);
  const load = t.load;
  // Checkpoints at the intersections hold every car up.
  t.slow = s.districts.map((d) => (d.police.stage !== 'patrol' && d.police.officers >= 5 ? 0.75 : 1));
  load.fill(0);
  const curve = rush(((s.t % 1440) + 1440) % 1440);
  const total = s.districts.reduce((n, d) => n + (civilian(d) ? d.population : 0), 0) + 1;
  const along = (key: string, cars: number) => {
    const list = r.edges.get(key);
    if (list) for (const e of list) load[e] += cars;
  };

  // Local traffic inside each district, spread over its streets.
  const edgesIn = new Float64Array(s.districts.length);
  for (let e = 0; e < EDGES; e++) if (EDGE_DISTRICT[e] >= 0) edgesIn[EDGE_DISTRICT[e]]++;
  const local = s.districts.map((d) => (civilian(d) ? (d.population * 0.03 * curve * 10) / Math.max(1, edgesIn[d.id]) : 0));
  for (let e = 0; e < EDGES; e++) if (EDGE_DISTRICT[e] >= 0) load[e] += local[EDGE_DISTRICT[e]];

  const fear = s.districts.map((d) => (civilian(d) ? fearOf(s, d) : 0));
  for (const a of s.districts) {
    if (!civilian(a) || a.population < 100) continue;
    // Commuting, less as fear grows.
    for (const b of s.districts) {
      if (b === a || !civilian(b)) continue;
      const trips = (0.012 * a.population * b.population) / total * curve * (1 - 0.7 * fear[a.id]);
      along(`${a.id}-${b.id}`, trips);
    }
    // Flight: frightened people drive for the calmest neighbour and for the highways.
    const flight = a.population * fear[a.id] * 0.01;
    if (flight > 1) {
      const calm = a.neighbors.map((n) => s.districts[n]).filter(civilian).sort((x, y) => fear[x.id] - fear[y.id])[0];
      if (calm) along(`${a.id}-${calm.id}`, flight * 0.5);
    }
    // Leaving the city: a trickle at first, a flood once afraid, as long as the roads out flow.
    const leaving = a.population * (0.0004 + 0.004 * fear[a.id]) + flight * 0.5;
    let k = 0;
    let bestLen = Infinity;
    EXITS.forEach((_, x) => {
      const len = r.edges.get(`${a.id}-x${x}`)?.length ?? Infinity;
      if (len < bestLen) {
        bestLen = len;
        k = x;
      }
    });
    along(`${a.id}-x${k}`, leaving);
    const access = exitAccess(s, a);
    if (access > 0.05) {
      // About two people a car; the bitten slip out with them.
      const escaped = Math.min(a.population * 0.005, leaving * 2 * access * 0.12);
      const share = a.infected / Math.max(1, a.population + a.infected);
      a.population -= escaped * (1 - share);
      a.infected = Math.max(0, a.infected - escaped * share);
      t.fled += escaped;
    } else if (fear[a.id] > 0.3 && s.t - (a.cooldowns.trapped ?? -Infinity) > 720) {
      a.cooldowns.trapped = s.t;
      emit(a.id, 'warn', `The roads out of ${a.name} are jammed solid. People are trapped in their cars.`);
    }
  }

  // Breakdown: gridlock and the dead make drivers abandon their cars; troops and police tow wrecks.
  let changed = false;
  for (let e = 0; e < EDGES; e++) {
    const di = EDGE_DISTRICT[e];
    const d = di >= 0 ? s.districts[di] : undefined;
    const before = t.blocked[e];
    const jam = congestion(t, e);
    let b = before;
    if (jam > 1) b += 0.015 * Math.min(3, jam - 1);
    if (d) {
      const dead = Math.min(1, totalZombies(d) / (d.population * 0.02 + 200));
      b += 0.05 * dead * Math.min(1, jam + 0.2) * (night ? 1.3 : 1);
      if (d.rioting) b += 0.006;
      // Tow trucks and engineers keep a held district's streets open.
      if (d.status !== 'overrun') {
        const crews = Math.min(1, (d.troops.strength + d.police.officers * 0.5) / 60);
        b -= 0.012 * crews;
      }
    }
    b = Math.max(0, Math.min(MAX_BLOCKED, b));
    t.blocked[e] = b;
    if ((before <= IMPASSABLE) !== (b <= IMPASSABLE)) changed = true;
  }
  if (changed) routeCache.delete(t);

  // Each district's mean congestion, for the HUD and for bites in jammed streets.
  const sum = new Float64Array(s.districts.length);
  const blocked = new Float64Array(s.districts.length);
  for (let e = 0; e < EDGES; e++) {
    const di = EDGE_DISTRICT[e];
    if (di < 0) continue;
    sum[di] += Math.min(3, congestion(t, e));
    blocked[di] += t.blocked[e];
  }
  t.jam = s.districts.map((d) => Math.min(2, sum[d.id] / Math.max(1, edgesIn[d.id])));
  t.blockedShare = s.districts.map((d) => blocked[d.id] / Math.max(1, edgesIn[d.id]));
}

/** "jammed · 30% wrecked": how a district's roads are doing, for the HUD and map. */
export function roadStatus(t: Traffic, district: number): string {
  const jam = t.jam[district] ?? 0;
  const wrecked = t.blockedShare?.[district] ?? 0;
  const flow = jam < 0.5 ? 'flowing' : jam < 0.9 ? 'heavy' : jam < 1.3 ? 'jammed' : 'gridlock';
  return wrecked >= 0.05 ? `${flow} · ${Math.round(wrecked * 100)}% wrecked` : flow;
}

/**
 * Where a district's police set up checkpoints: the four avenue intersections three blocks out from
 * its centre.
 */
export function checkpointNodes(d: { col: number; row: number }): [number, number][] {
  const c = districtCenter(d.col, d.row);
  const [ci, cj] = nearestNode(c.x, c.z);
  return [[ci - 3, cj], [ci + 3, cj], [ci, cj - 3], [ci, cj + 3]];
}

/** The district an edge lies in, for the client. */
export function districtOfEdge(e: number): number {
  return EDGE_DISTRICT[e];
}

/** Rough bounds check for drawing. */
export const CITY_HALF = { x: CITY_WIDTH / 2, z: CITY_DEPTH / 2 };
