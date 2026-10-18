// The civilian food chain. Freight trains run into the rail yard in the industrial district from
// outside the city; civilian trucks carry food from the yard and the Market District warehouse to
// districts running low, along the streets. A district with no infection never runs out of food:
// if the city's own stocks can't cover it, regional trucks come in from outside. Districts with
// the dead in them get trucks only while there's stock and drivers willing to go, and trucks
// crossing overrun ground don't always make it.
//
// Trucks and trains have fixed routes and timetables, so the 3D view can place them at any moment.

import { waitingForCover, watched } from './requests';
import { CITY_DEPTH, districtAt, districtCenter, DISTRICT_TEMPLATES } from './layout';
import { totalZombies } from './hordes';
import { nextRandom } from './rng';
import { blockLot, BLOCKS_PER_DISTRICT, nearestNode, nodeX, nodeZ } from './streets';
import { siteHolds } from './sites';
import { EXITS, routesFrom } from './traffic';
import type { CityState, DistrictState, Severity, Supply, Truck, Train } from './types';

type Emit = (district: number | null, severity: Severity, text: string, radio?: boolean) => void;

/** Rations one truck carries (a loaded semi-trailer). */
export const TRUCK_RATIONS = 6000;
/** Metres per game minute: about 50 km/h through city streets at the daytime clock rate. */
export const TRUCK_SPEED = 25;
/** Rations one freight train brings. */
export const TRAIN_RATIONS = 60000;
export const TRAIN_INTERVAL = 240;
/** Metres per game minute. */
export const TRAIN_SPEED = 40;
const TRAIN_DWELL = 45;
/** Districts are kept stocked with this many days of food. */
const TARGET_DAYS = 2;
/** At most this many trucks set off for one district each hour. */
const TRUCKS_PER_HOUR = 4;
/** A clean district's shops are never empty: this much food is always on the shelves. */
const FLOOR_DAYS = 0.3;

const INDUSTRIAL = DISTRICT_TEMPLATES.findIndex((d) => d.kind === 'industrial');

/**
 * The railway: one line from the south, past the city edge, into the yard on the industrial
 * district's south-east blocks. Trains run north into the yard and back out.
 */
export const RAIL = (() => {
  const tpl = DISTRICT_TEMPLATES[INDUSTRIAL];
  const i = tpl.col * BLOCKS_PER_DISTRICT + 10;
  const j = tpl.row * BLOCKS_PER_DISTRICT + 10;
  const north = blockLot(i, j);
  return {
    /** Blocks the yard covers (global indices). */
    blocks: [[i, j], [i, j + 1]] as [number, number][],
    x: north.cx,
    /** Where the head of a train stops, at the north end of the yard. */
    stopZ: north.z0 + 12,
    /** Where trains appear and vanish, out in the countryside. */
    farZ: CITY_DEPTH / 2 + 2600,
  };
})();

/** Train length in metres (locomotive and wagons), for the 3D view. */
export const TRAIN_LENGTH = 220;

export function createSupply(): Supply {
  return { yard: TRAIN_RATIONS * 2, trucks: [], trains: [], seq: 0, nextTrain: 0, railHalted: false };
}

/** No infected or dead in the district at all. */
export function clean(d: DistrictState): boolean {
  return d.infected + totalZombies(d) < 1;
}

const people = (d: DistrictState) => d.population + d.troops.strength + d.infected;

/** Every game minute: trains, truck arrivals and losses; every hour: dispatch. */
export function updateSupply(s: CityState, hourly: boolean, emit: Emit): void {
  runTrains(s, emit);
  for (const d of s.districts) {
    // The shelves of a clean district never go bare.
    if (clean(d) && d.status !== 'overrun') d.rations = Math.max(d.rations, people(d) * FLOOR_DAYS);
  }
  arrivals(s, emit);
  if (hourly) {
    losses(s, emit);
    dispatch(s, emit);
  }
}

function runTrains(s: CityState, emit: Emit): void {
  const sup = s.supply;
  const yard = s.districts[INDUSTRIAL];
  const open = clean(yard) && yard.status !== 'overrun';
  if (s.t >= sup.nextTrain) {
    sup.nextTrain = s.t + TRAIN_INTERVAL;
    if (open) {
      const run = (RAIL.farZ - RAIL.stopZ) / TRAIN_SPEED;
      sup.trains.push({ id: ++sup.seq, depart: s.t, arrive: s.t + run, leave: s.t + run + TRAIN_DWELL, gone: s.t + run * 2 + TRAIN_DWELL, done: false });
    }
  }
  if (!open && !sup.railHalted) {
    sup.railHalted = true;
    emit(yard.id, 'critical', `Freight trains have stopped running into ${yard.name}: infection at the rail yard.`);
  } else if (open && sup.railHalted) {
    sup.railHalted = false;
    emit(yard.id, 'info', `Freight trains are running into ${yard.name} again.`);
  }
  for (const tr of sup.trains) {
    if (tr.done || s.t < tr.arrive) continue;
    tr.done = true;
    if (open) sup.yard += TRAIN_RATIONS;
  }
  sup.trains = sup.trains.filter((tr) => s.t < tr.gone);
}

function arrivals(s: CityState, emit: Emit): void {
  s.supply.trucks = s.supply.trucks.filter((tr) => {
    if (s.t < tr.arrive) return true;
    const d = s.districts[tr.to];
    if (d.status === 'overrun') {
      lost(s, d, emit);
      return false;
    }
    d.rations += tr.rations;
    return false;
  });
}

/** Trucks crossing dangerous ground are sometimes lost; rioters hijack them. */
function losses(s: CityState, emit: Emit): void {
  s.supply.trucks = s.supply.trucks.filter((tr) => {
    const { x, z } = truckPose(tr, s.t);
    const d = s.districts[districtAt(x, z)];
    if (!d) return true;
    // A truck stuck in a jam with the dead about is a sitting target.
    const jam = 1 + Math.min(2, s.traffic.jam[d.id] ?? 0);
    // Under a helicopter's eye it's safe; waiting for one, its crew keeps its head down.
    const cover = watched(s, tr.id) ? 0 : waitingForCover(s, tr.id) ? 0.3 : 1;
    const risk = (d.status === 'overrun' ? 0.25 : d.status === 'contested' ? 0.04 : 0) * jam * cover;
    if (d.rioting && nextRandom(s) < 0.08) {
      d.rations += tr.rations;
      if (s.t - (d.cooldowns.hijack ?? -Infinity) > 180) {
        d.cooldowns.hijack = s.t;
        emit(d.id, 'warn', `Rioters have hijacked a food truck in ${d.name}.`);
      }
      return false;
    }
    if (risk > 0 && nextRandom(s) < risk) {
      lost(s, d, emit);
      return false;
    }
    return true;
  });
}

function lost(s: CityState, d: DistrictState, emit: Emit): void {
  if (s.t - (d.cooldowns.truckLost ?? -Infinity) < 180) return;
  d.cooldowns.truckLost = s.t;
  emit(d.id, 'warn', `A food truck has been lost in ${d.name}.`);
}

interface Depot {
  district: number;
  node: [number, number];
  stock: () => number;
  take: (n: number) => void;
}

function depots(s: CityState): Depot[] {
  const out: Depot[] = [];
  const yard = s.districts[INDUSTRIAL];
  // Trucks load at the rail yard only through the distribution depot.
  if (yard.status !== 'overrun' && !yard.rioting && siteHolds(s, 'depot')) {
    out.push({
      district: yard.id,
      node: nearestNode(RAIL.x, RAIL.stopZ + 60),
      stock: () => s.supply.yard,
      take: (n) => (s.supply.yard -= n),
    });
  }
  // The depot's own stock goes out by truck too.
  const depot = s.sites.find((x) => x.kind === 'depot' && x.status !== 'fallen');
  if (depot) {
    out.push({
      district: depot.district,
      node: nearestNode(depot.x, depot.z),
      stock: () => depot.rations,
      take: (n) => (depot.rations -= n),
    });
  }
  const wh = s.districts.find((d) => d.features.warehouse);
  if (wh && wh.status !== 'overrun' && !wh.rioting && wh.order > 30) {
    const c = districtCenter(wh.col, wh.row);
    // The warehouse keeps its own district's share back.
    out.push({
      district: wh.id,
      node: nearestNode(c.x, c.z),
      stock: () => wh.rations - people(wh) * TARGET_DAYS,
      take: (n) => (wh.rations -= n),
    });
  }
  return out;
}

function dispatch(s: CityState, emit: Emit): void {
  // One route search per starting point this hour.
  const searches = new Map<string, ReturnType<typeof routesFrom>>();
  const routeFrom = (start: [number, number]) => {
    const key = `${start[0]},${start[1]}`;
    let search = searches.get(key);
    if (!search) searches.set(key, (search = routesFrom(s, start)));
    return search;
  };
  const inbound = new Map<number, number>();
  for (const tr of s.supply.trucks) inbound.set(tr.to, (inbound.get(tr.to) ?? 0) + tr.rations);
  const sources = depots(s);
  for (const d of s.districts) {
    if (d.status === 'overrun' || people(d) < 1) continue;
    const isClean = clean(d);
    // Drivers go into a district with the dead in it only while it holds, or is still fighting with order kept.
    if (!isClean && !(d.status === 'held' || (d.status === 'contested' && d.order > 30 && !d.rioting))) continue;
    let need = people(d) * TARGET_DAYS - d.rations - (inbound.get(d.id) ?? 0);
    const dest = nearestNode(districtCenter(d.col, d.row).x, districtCenter(d.col, d.row).z);
    // Small places (the airport) call for a truck before they're half a truckload short.
    const order = Math.min(TRUCK_RATIONS * 0.5, people(d) * 0.5);
    for (let n = 0; n < TRUCKS_PER_HOUR && need > order; n++) {
      const depot = sources
        .filter((x) => x.stock() >= TRUCK_RATIONS)
        .sort((a, b) => dist(a.node, dest) - dist(b.node, dest))[0];
      if (depot) {
        if (!send(s, depot.district, d.id, routeFrom(depot.node)(dest))) {
          blockedIn(s, d, emit);
          break;
        }
        depot.take(TRUCK_RATIONS);
      } else if (isClean) {
        // The city's stocks are spent: regional trucks come in from outside, by the nearest open highway.
        const sent = EXITS.map((x) => routeFrom(x.node)(dest)).filter((r) => r)
          .sort((a, b) => a!.times[a!.times.length - 1] - b!.times[b!.times.length - 1])[0];
        if (!send(s, -1, d.id, sent ?? null)) {
          blockedIn(s, d, emit);
          break;
        }
      } else {
        if (s.t - (d.cooldowns.trucksCut ?? -Infinity) > 720) {
          d.cooldowns.trucksCut = s.t;
          emit(d.id, 'warn', `No food is left to truck into ${d.name}.`);
        }
        break;
      }
      need -= TRUCK_RATIONS;
    }
  }
}

const dist = (a: [number, number], b: [number, number]) => Math.hypot(nodeX(a[0]) - nodeX(b[0]), nodeZ(a[1]) - nodeZ(b[1]));

function blockedIn(s: CityState, d: DistrictState, emit: Emit): void {
  if (s.t - (d.cooldowns.roadsCut ?? -Infinity) < 720) return;
  d.cooldowns.roadsCut = s.t;
  emit(d.id, 'warn', `Food trucks can't get through to ${d.name}: the roads are blocked.`);
}

/** Put a truck on the road along a route through the traffic. Returns false if there is no route. */
function send(s: CityState, from: number, to: number, drive: { path: number[]; times: number[] } | null): boolean {
  if (!drive) return false;
  const last = drive.times[drive.times.length - 1];
  s.supply.trucks.push({
    id: ++s.supply.seq, from, to, rations: TRUCK_RATIONS, path: drive.path, times: drive.times,
    depart: s.t, arrive: s.t + Math.max(5, last),
  });
  return true;
}

/** Where a truck is at game minute t, and which way it faces (radians, 0 facing -Z). */
export function truckPose(tr: Truck, t: number): { x: number; z: number; heading: number } {
  const p = tr.path;
  const elapsed = Math.max(0, t - tr.depart);
  for (let k = 1; k < tr.times.length; k++) {
    if (elapsed <= tr.times[k] || k === tr.times.length - 1) {
      const ax = nodeX(p[k * 2 - 2]);
      const az = nodeZ(p[k * 2 - 1]);
      const bx = nodeX(p[k * 2]);
      const bz = nodeZ(p[k * 2 + 1]);
      const span = tr.times[k] - tr.times[k - 1];
      const u = span > 0 ? Math.min(1, Math.max(0, (elapsed - tr.times[k - 1]) / span)) : 1;
      return { x: ax + (bx - ax) * u, z: az + (bz - az) * u, heading: Math.atan2(-(bx - ax), -(bz - az)) };
    }
  }
  return { x: nodeX(p[0]), z: nodeZ(p[1]), heading: 0 };
}

/** Where the head of a train is at game minute t (z along the line), and whether it's heading in. */
export function trainPose(tr: Train, t: number): { z: number; inbound: boolean } {
  if (t < tr.arrive) return { z: RAIL.farZ - (t - tr.depart) * TRAIN_SPEED, inbound: true };
  if (t < tr.leave) return { z: RAIL.stopZ, inbound: true };
  // Backs out the way it came.
  return { z: RAIL.stopZ + (t - tr.leave) * TRAIN_SPEED, inbound: false };
}
