// The army's supply chain out of the airport. Once the Joint Operations Command is up, everything
// flown and driven in (the daily supply flight, the convoys from Camp Ridgeway, Command's rewards)
// lands in the airport's stores, and a fleet of army trucks carries it out to the districts by road:
// medicine where the bitten need isolating, food where the civilian trucks can't keep up, and
// ammunition for the troops. Each truck loads, drives the streets as they are (jams, wrecks, the
// dead), unloads, and drives back for more.
//
// The stores are finite and the need is greater, so the neediest go first (or the district the
// player puts first). A district the trucks can't reach by road is cut off: only helicopters can
// supply it. Trucks crossing dangerous ground are sometimes lost with their cargo.

import { minuteOfDay } from './clock';
import { ACCESS_END } from './airportGrounds';
import { airportOf } from './command';
import { CRATES } from './operations';
import { districtAt, districtCenter } from './layout';
import { nextRandom } from './rng';
import { nearestNode } from './streets';
import { recordDelivery } from './daystats';
import { AMMO_FULL, DOSES_PER_ISOLATION, foodDays, policeAmmo } from './supplies';
import { truckPose } from './supply';
import { routesFrom } from './traffic';
import type { ArmyCargo, ArmyRun, CityState, DistrictState, Logistics, Severity } from './types';

type Emit = (district: number | null, severity: Severity, text: string, radio?: boolean) => void;

/** Army supply trucks at the start, and what one carries. */
export const FLEET = 8;
export const TRUCK_LOAD: ArmyCargo = { medicine: 1500, rations: 5000, ammo: 30000 };
/** Game minutes to unload at a district before driving back. */
const UNLOAD = 20;
/** Trucks are sent out this often (game minutes). */
const DISPATCH_EVERY = 60;
/** Medicine a person uses a day, and the days of it a district is kept stocked with. */
const MEDICINE_PER_DAY = 0.02;
const MEDICINE_DAYS = 3;
/** Days of food the army tops a district up to, where the civilian trucks fall short. */
const FOOD_DAYS = 1;
/** Rounds per soldier the troops are kept stocked with, and in each police armoury with no troops. */
const AMMO_PER_SOLDIER = AMMO_FULL * 2;
const POLICE_AMMO = 15000;
/** The airport keeps back crates' worth of each for the helicopters. */
const RESERVE_CRATES = 3;
/** A truck lost on the road is replaced with the next morning's supply flight. */
const REPLACE_MINUTE = 7 * 60;

export function createLogistics(): Logistics {
  return { fleet: FLEET, runs: [], seq: 0, priority: null, cutOff: [] };
}

const people = (d: DistrictState) => d.population + d.troops.strength + d.infected;

/** What a district is short of, against what it should hold (counting what's on its way). */
export function shortage(s: CityState, d: DistrictState): ArmyCargo {
  const inbound: ArmyCargo = { medicine: 0, rations: 0, ammo: 0 };
  for (const r of s.logistics.runs) {
    if (r.to !== d.id || r.phase !== 'out') continue;
    inbound.medicine += r.cargo.medicine;
    inbound.rations += r.cargo.rations;
    inbound.ammo += r.cargo.ammo;
  }
  const n = people(d);
  const isolating = d.flags.outbreak ? d.infected * DOSES_PER_ISOLATION : 0;
  return {
    medicine: Math.max(0, n * MEDICINE_PER_DAY * MEDICINE_DAYS + isolating - d.medicine - inbound.medicine),
    rations: Math.max(0, (FOOD_DAYS - foodDays(d, s.sites)) * n - inbound.rations),
    // Troops' rifles; with none, the police's armouries.
    ammo: Math.max(0, d.troops.strength >= 1 ? d.troops.strength * AMMO_PER_SOLDIER - d.troops.ammo - inbound.ammo
      : hasStation(s, d) ? POLICE_AMMO - policeAmmo(s, d) - inbound.ammo : 0),
  };
}

const hasStation = (s: CityState, d: DistrictState) => s.sites.some((x) => x.district === d.id && x.kind === 'police' && x.status !== 'fallen');

/** Days of medicine a district holds at the rate it uses it. */
export function medicineDays(d: DistrictState): number {
  return d.medicine / Math.max(1, people(d) * MEDICINE_PER_DAY);
}

/** How badly a district needs a truck: days of medicine and food short, and ammunition. */
function urgency(d: DistrictState, short: ArmyCargo): number {
  const n = Math.max(1, people(d));
  const ammoNeed = d.troops.strength >= 1 ? d.troops.strength * AMMO_PER_SOLDIER : POLICE_AMMO;
  return (short.medicine / (n * MEDICINE_PER_DAY)) * 2 + short.rations / n + (short.ammo / ammoNeed) * 1.5;
}

/** What the airport's stores can spare for the trucks. */
export function spare(s: CityState): ArmyCargo {
  const a = airportOf(s);
  return {
    medicine: Math.max(0, a.medicine - CRATES.medicine.amount * RESERVE_CRATES),
    rations: Math.max(0, a.rations - a.population * 2 - CRATES.rations.amount * RESERVE_CRATES),
    ammo: Math.max(0, a.troops.ammo - a.troops.strength * 300 - CRATES.ammo.amount * RESERVE_CRATES),
  };
}

/** Every minute: arrivals and returns; hourly, losses, and trucks go out. */
export function updateLogistics(s: CityState, emit: Emit): void {
  if (!s.flags.joc) return;
  const lg = s.logistics;
  arrivals(s, emit);
  const t = Math.floor(s.t);
  if (t % 60 === 0) losses(s, emit);
  if (minuteOfDay(t) === REPLACE_MINUTE && lg.fleet < FLEET) lg.fleet += 1;
  if (t % DISPATCH_EVERY === 0) dispatch(s, emit);
}

function arrivals(s: CityState, emit: Emit): void {
  const lg = s.logistics;
  lg.runs = lg.runs.filter((r) => {
    if (s.t < r.arrive) return true;
    // Home: the truck is free again.
    if (r.phase === 'back') return false;
    const d = s.districts[r.to];
    if (d.status === 'overrun') emit(d.id, 'warn', `Army supply trucks reached ${d.name} to find it overrun, and turned back.`);
    else unload(s, d, r.cargo, emit);
    // Drive back the way it came.
    const last = r.times[r.times.length - 1];
    const path: number[] = [];
    for (let k = r.path.length - 2; k >= 0; k -= 2) path.push(r.path[k], r.path[k + 1]);
    r.path = path;
    r.times = r.times.map((_, k) => last - r.times[r.times.length - 1 - k]);
    r.phase = 'back';
    r.depart = s.t + UNLOAD;
    r.arrive = r.depart + Math.max(5, last);
    return true;
  });
}

function unload(s: CityState, d: DistrictState, cargo: ArmyCargo, emit: Emit): void {
  for (const kind of ['medicine', 'rations', 'ammo'] as const) recordDelivery(s, 'trucks', d.id, kind, cargo[kind]);
  d.medicine += cargo.medicine;
  d.rations += cargo.rations;
  if (d.troops.strength >= 1) d.troops.ammo += cargo.ammo;
  else {
    // No troops: the police station's armoury takes it.
    const armoury = s.sites.find((x) => x.district === d.id && x.kind === 'police' && x.status !== 'fallen');
    if (armoury) armoury.ammo += cargo.ammo;
  }
  const what = [
    cargo.medicine >= 1 && `${Math.round(cargo.medicine).toLocaleString('en-US')} doses of medicine (${medicineDays(d).toFixed(1)} days' worth there now)`,
    cargo.rations >= 1 && `food for ${Math.round(cargo.rations).toLocaleString('en-US')}`,
    cargo.ammo >= 1 && `${Math.round(cargo.ammo).toLocaleString('en-US')} rounds`,
  ].filter(Boolean);
  if (what.length) emit(d.id, 'info', `Army trucks delivered ${what.join(', ')} to ${d.name}.`);
}

/** Trucks crossing dangerous ground are sometimes lost; they're armed, so less often than food trucks. */
function losses(s: CityState, emit: Emit): void {
  const lg = s.logistics;
  lg.runs = lg.runs.filter((r) => {
    if (s.t < r.depart) return true;
    const { x, z } = truckPose(r, s.t);
    const d = s.districts[districtAt(x, z)];
    if (!d) return true;
    const jam = 1 + Math.min(2, s.traffic.jam[d.id] ?? 0);
    const risk = (d.status === 'overrun' ? 0.08 : d.status === 'contested' ? 0.012 : 0) * jam;
    if (risk <= 0 || nextRandom(s) >= risk) return true;
    lg.fleet -= 1;
    emit(d.id, 'warn', `An army supply truck has been lost in ${d.name}${r.phase === 'out' ? ' with its cargo' : ''}.`, true);
    return false;
  });
}

function dispatch(s: CityState, emit: Emit): void {
  const lg = s.logistics;
  const airport = airportOf(s);
  if (airport.status === 'overrun') return;
  if (lg.priority !== null && s.districts[lg.priority].status === 'overrun') lg.priority = null;
  const routeTo = routesFrom(s, ACCESS_END);
  const routes = new Map<number, ReturnType<typeof routeTo>>();

  // Which districts the trucks can reach at all.
  const cut: number[] = [];
  for (const d of s.districts) {
    if (d.kind === 'airbase' || d.status === 'overrun') continue;
    const c = districtCenter(d.col, d.row);
    const route = routeTo(nearestNode(c.x, c.z));
    routes.set(d.id, route);
    if (route) continue;
    cut.push(d.id);
    if (!lg.cutOff.includes(d.id)) {
      emit(d.id, 'warn', `Army supply trucks can't reach ${d.name}: the roads are blocked. It can only be supplied by air.`, true);
    }
  }
  for (const id of lg.cutOff) {
    const d = s.districts[id];
    if (!cut.includes(id) && d.status !== 'overrun') emit(id, 'info', `The roads to ${d.name} are open again: army supply trucks can get through.`);
  }
  lg.cutOff = cut;

  // Free trucks go to the neediest districts they can reach, the player's choice first.
  let free = lg.fleet - lg.runs.length;
  const wanted = s.districts
    .filter((d) => d.kind !== 'airbase' && d.status !== 'overrun' && people(d) >= 50 && routes.get(d.id))
    .map((d) => ({ d, short: shortage(s, d) }))
    .map((x) => ({ ...x, score: urgency(x.d, x.short) + (lg.priority === x.d.id ? 100 : 0) }))
    .filter((x) => x.score > 0.25)
    .sort((a, b) => b.score - a.score);
  for (const { d, short } of wanted) {
    // A big shortage takes more than one truck.
    while (free > 0) {
      const stock = spare(s);
      const cargo: ArmyCargo = {
        medicine: Math.min(short.medicine, TRUCK_LOAD.medicine, stock.medicine),
        rations: Math.min(short.rations, TRUCK_LOAD.rations, stock.rations),
        ammo: Math.min(short.ammo, TRUCK_LOAD.ammo, stock.ammo),
      };
      // Worth a trip only with a real load aboard.
      if (cargo.medicine < 200 && cargo.rations < 1000 && cargo.ammo < 5000) break;
      const route = routes.get(d.id)!;
      airport.medicine -= cargo.medicine;
      airport.rations -= cargo.rations;
      airport.troops.ammo -= cargo.ammo;
      short.medicine -= cargo.medicine;
      short.rations -= cargo.rations;
      short.ammo -= cargo.ammo;
      const last = route.times[route.times.length - 1];
      const run: ArmyRun = {
        id: ++lg.seq, to: d.id, cargo, phase: 'out', path: route.path, times: route.times, depart: s.t, arrive: s.t + Math.max(5, last),
      };
      lg.runs.push(run);
      free--;
    }
    if (free <= 0) break;
  }
}

/** "1,500 medicine · 30,000 rounds": a truckload, for Flight Command. */
export function cargoText(c: ArmyCargo): string {
  return [
    c.medicine >= 1 && `${Math.round(c.medicine).toLocaleString('en-US')} medicine`,
    c.rations >= 1 && `${Math.round(c.rations).toLocaleString('en-US')} food`,
    c.ammo >= 1 && `${Math.round(c.ammo).toLocaleString('en-US')} rounds`,
  ].filter(Boolean).join(' · ') || 'empty';
}

/**
 * What a district's shortages are costing it right now, for the HUD: the bitten turning untreated,
 * troops holding their fire, police with empty armouries, roads the trucks can't use.
 */
export function shortageAlerts(s: CityState, d: DistrictState): string[] {
  if (d.status === 'overrun' || d.kind === 'airbase' || d.kind === 'army') return [];
  const out: string[] = [];
  if (d.flags.medicineOut) out.push(`No medicine: ~${Math.round(d.infected / 4)} bitten turning an hour, untreated`);
  if (d.flags.ammoLow) out.push(`Troops holding fire: ${Math.round(d.troops.ammo / Math.max(1, d.troops.strength))} rounds each`);
  if (d.flags.policeDry) out.push('Police out of ammunition: batons only');
  if (s.logistics.cutOff.includes(d.id)) out.push('Cut off by road: army trucks can\'t get through');
  return out;
}
