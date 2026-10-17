// The military response. The army starts at Camp Ridgeway, its base on the outskirts, and the city
// begins with its police alone. Once the outbreak is spreading Command authorizes a Joint Operations
// Command at the airport: the player flies the command team in (or, if nobody does, Command sends
// its own), the first airlift lands, and the army pushes a platoon into each district to support the
// police. From then on the airport is the military's hub: supply flights land there, troops are
// ferried out from there, and evacuees are flown out of the city from there.

import { AIRPORT_STAFF, ARMY_BASE, districtCenter, DISTRICT_TEMPLATES } from './layout';
import type { CityState, DistrictState, Severity } from './types';

type Emit = (district: number | null, severity: Severity, text: string, radio?: boolean) => void;

/** Camp Ridgeway's id (it isn't one of the districts). */
export const ARMY_ID = 100;
export const ARMY_TROOPS = 1500;
/** Districts with a confirmed outbreak before Command authorizes the JOC. */
const AUTHORIZE_OUTBREAKS = 2;
/** Game minutes Command waits for the player before flying its own team in. */
const COMMAND_FALLBACK = 720;
/** The first airlift into the airport once the JOC is up. */
const AIRLIFT_TROOPS = 400;
/** Camp Ridgeway keeps this many back. */
const CAMP_RESERVE = 150;
/** The airport keeps this many for its own defence before sending platoons out. */
const AIRPORT_RESERVE = 120;
/** Outbound evacuation flights from the airport. */
const EVAC_FLIGHT_MINUTES = 180;
const EVAC_FLIGHT_SEATS = 400;

export function createArmy(): DistrictState {
  return {
    id: ARMY_ID, name: ARMY_BASE.name, kind: 'army', col: -1, row: -1, neighbors: [],
    features: { fortified: true, generator: 300, fuelDepot: true },
    population: 0, infected: 0, zombies: 0, dead: 0,
    troops: { strength: ARMY_TROOPS, fatigue: 0, morale: 0.9, ammo: ARMY_TROOPS * 300 + 500000 },
    police: { officers: 0, riot: 0, morale: 0, stage: 'patrol' },
    rations: 60000, medicine: 20000, fuel: 200000,
    power: 'on', powerThreshold: 0, order: 100, rioting: false, status: 'held',
    noise: 0, killRate: 0, playerNoise: 0, burning: 0, scientists: 0, salvage: 0,
    hordeZombies: 0, sheltered: 0, outposts: 0, flags: {}, cooldowns: {},
  };
}

export function airportOf(s: CityState): DistrictState {
  return s.districts.find((d) => d.kind === 'airbase')!;
}

/** Where the military works from: Camp Ridgeway, then the airport once the JOC is set up. */
export function hubOf(s: CityState): DistrictState {
  return s.flags.joc ? airportOf(s) : s.army;
}

/** Where the hub is on the ground. */
export function hubPosition(s: CityState): { x: number; z: number } {
  if (!s.flags.joc) return ARMY_BASE;
  const a = airportOf(s);
  return districtCenter(a.col, a.row);
}

export function mergeTroops(to: DistrictState, strength: number, fatigue: number, morale: number, ammo: number): void {
  const tr = to.troops;
  const total = tr.strength + strength;
  if (total <= 0) return;
  tr.fatigue = (tr.fatigue * tr.strength + fatigue * strength) / total;
  tr.morale = (tr.morale * tr.strength + morale * strength) / total;
  tr.strength = total;
  tr.ammo += ammo;
}

/** Move soldiers (and their share of ammunition) from one place to another. */
function send(from: DistrictState, to: DistrictState, n: number): number {
  const moving = Math.max(0, Math.min(n, from.troops.strength));
  if (moving <= 0) return 0;
  const ammo = (from.troops.ammo / Math.max(1, from.troops.strength)) * moving;
  from.troops.strength -= moving;
  from.troops.ammo -= ammo;
  mergeTroops(to, moving, from.troops.fatigue, Math.max(0.8, from.troops.morale), ammo);
  return moving;
}

/**
 * Set up the Joint Operations Command at the airport: it's fortified, the first airlift lands with
 * troops and stores, and the army starts pushing platoons into the districts.
 */
export function establishJoc(s: CityState, emit: Emit, byCommand: boolean): void {
  if (s.flags.joc) return;
  const airport = airportOf(s);
  s.flags.joc = true;
  airport.features = { ...airport.features, fortified: true };
  const troops = send(s.army, airport, Math.min(AIRLIFT_TROOPS, s.army.troops.strength - CAMP_RESERVE));
  for (const [key, amount] of [['rations', 30000], ['medicine', 8000]] as const) {
    const n = Math.min(amount, s.army[key]);
    s.army[key] -= n;
    airport[key] += n;
  }
  // The research team moves with Command.
  airport.scientists += s.army.scientists;
  s.army.scientists = 0;
  emit(airport.id, 'critical', `${byCommand ? 'Command has flown its own team in. ' : ''}Joint Operations Command is up at ${airport.name}. ` +
    `The first airlift is landing: ${Math.round(troops)} troops, food and medicine. Platoons will deploy into the districts.`, true);
}

/**
 * Every district has fallen: Command throws what's left at Camp Ridgeway into the airport for a
 * last stand (and sets up the JOC there if nobody had).
 */
export function lastStand(s: CityState, emit: Emit): void {
  if (!s.flags.joc) establishJoc(s, emit, true);
  const airport = airportOf(s);
  const troops = send(s.army, airport, s.army.troops.strength - CAMP_RESERVE);
  if (troops >= 1) emit(airport.id, 'critical', `Command is throwing everything into ${airport.name}: ${Math.round(troops)} more troops are landing.`, true);
}

/** Hourly (and every minute for the clock checks): authorization, the fallback, deployments and evacuation flights. */
export function updateCommand(s: CityState, emit: Emit): void {
  const t = Math.floor(s.t);
  if (!s.flags.jocAuthorized) {
    const outbreaks = s.districts.filter((d) => d.flags.outbreak).length;
    if (outbreaks >= AUTHORIZE_OUTBREAKS) {
      s.flags.jocAuthorized = true;
      s.army.cooldowns.jocAuthorized = s.t;
      emit(null, 'critical', 'State of emergency declared. Command authorizes a Joint Operations Command at Kessler Airport: ' +
        `fly the command team in from ${ARMY_BASE.name}.`, true);
    }
  } else if (!s.flags.joc && s.t - s.army.cooldowns.jocAuthorized >= COMMAND_FALLBACK) {
    establishJoc(s, emit, true);
  }

  // Bussed out of the area from Camp Ridgeway.
  if (s.army.population > 0) {
    s.stats.flownOut += s.army.population;
    s.army.population = 0;
  }
  if (!s.flags.joc) return;
  const airport = airportOf(s);

  // One platoon an hour into the districts that need one, the ones under attack first.
  if (t % 60 === 0) {
    const next = s.districts
      .filter((d) => d !== airport && !d.flags.armyDeployed && d.status !== 'overrun' && DISTRICT_TEMPLATES[d.id].troops > 0)
      .sort((a, b) => (a.status === 'contested' ? 0 : 1) - (b.status === 'contested' ? 0 : 1) || b.population - a.population)[0];
    const size = next ? DISTRICT_TEMPLATES[next.id].troops : 0;
    if (next && airport.troops.strength - AIRPORT_RESERVE >= size) {
      next.flags.armyDeployed = true;
      send(airport, next, size);
      emit(next.id, 'info', `An army platoon (${size}) has deployed into ${next.name} to support the police.`, true);
    } else if (next && s.army.troops.strength - CAMP_RESERVE >= size) {
      // The airport is short: Camp Ridgeway sends more forward.
      send(s.army, airport, Math.min(200, s.army.troops.strength - CAMP_RESERVE));
    }
  }

  // Evacuees waiting at the airport fly out.
  if (t % EVAC_FLIGHT_MINUTES === 0 && airport.status !== 'overrun') {
    const waiting = Math.floor(airport.population - AIRPORT_STAFF);
    const seats = Math.min(EVAC_FLIGHT_SEATS, waiting);
    if (seats > 0) {
      airport.population -= seats;
      s.stats.flownOut += seats;
      emit(airport.id, 'info', `An evacuation flight has left ${airport.name} with ${seats} civilians aboard.`);
    }
  }
}
