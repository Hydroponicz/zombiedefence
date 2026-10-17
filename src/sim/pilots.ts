// AI pilots: recruited from evacuees and rescued crews, paid in rations, flying standing or
// one-off orders. Their trips are resolved here in game time: outbound flight, time on the
// ground (where the risk is), and the flight home.

import { districtCenter, DISTRICT_TEMPLATES } from './layout';
import { BASE_RESERVE_TROOPS, baseOf, BLADDER_LITRES, CRATES, mergeTroops, ROUNDS_PER_TROOP, SEATS, type Emit } from './operations';
import { hubPosition } from './command';
import { totalZombies } from './hordes';
import { screenAtGate } from './quarantine';
import { nextRandom } from './rng';
import type { CityState, CrateKind, DistrictState, JobKind, Order, Pilot, Trip } from './types';

export const JOB_LABELS: Record<JobKind, string> = {
  reinforce: 'Reinforce',
  resupply: 'Resupply',
  evacuate: 'Evacuate',
  relieve: 'Relieve troops',
  fuel: 'Fuel run',
};

/** AI cruise speed converted to game time: metres per game minute (60 m/s at the daytime clock rate). */
const METRES_PER_GAME_MINUTE = 86;
const TAKEOFF_MINUTES = 5;
const GROUND_MINUTES = 15;
const TURNAROUND_MINUTES = 20;
/** Fuel drawn from the base for each round trip. */
export const TRIP_FUEL = 700;
const FATIGUE_PER_TRIP = 0.14;
const REST_PER_HOUR = 0.08;
const TOO_TIRED = 0.85;
const REFUSE_LOYALTY = 0.3;
const DESERT_LOYALTY = 0.12;
const DANGER_BONUS = 300;
const RECRUIT_CHANCE = 0.03;
const PILOT_SURVIVES_CRASH = 0.55;
const STRANDED_DEATH_PER_HOUR = 0.1;

const NAMES = [
  'Sgt. Marcus Bell',
  'Dale Whitford (news pilot)',
  'Officer Priya Nair (police air unit)',
  'Capt. Tom Okafor (National Guard)',
  'Jess Lindqvist (crop duster)',
  'Ray Castillo (medevac)',
  'Hannah Cho (tour pilot)',
  'Wes Dunleavy (oil rig shuttle)',
  'Lt. Sofia Marchetti',
  'Bo Tran (flight instructor)',
  'Gus Halvorsen (logging)',
  'Nadia Petrov (air ambulance)',
];
const AIRFRAME_NAMES = ['Dustoff 2', 'Medevac 1', 'Channel 7 News', 'Police Air 4', 'Dustoff 3', 'Dustoff 4'];

export function createPilot(s: CityState, name?: string): Pilot {
  const r = () => nextRandom(s);
  const skill = 0.25 + r() * 0.7;
  return {
    id: ++s.pilotSeq,
    name: name ?? NAMES[(s.pilotSeq - 2 + NAMES.length) % NAMES.length],
    skill,
    nerve: 0.2 + r() * 0.75,
    loyalty: 0.55 + r() * 0.35,
    fatigue: 0,
    wage: Math.round((800 + skill * 1200) / 50) * 50,
    hired: false,
    status: 'idle',
    order: null,
    trip: null,
    airframe: null,
    district: -1,
    restUntil: 0,
    unpaid: 0,
    trips: 0,
    blockedAt: -Infinity,
    blockedReason: '',
  };
}

export function addAirframe(s: CityState): void {
  const id = ++s.airframeSeq;
  s.airframes.push({ id, name: AIRFRAME_NAMES[(id - 1) % AIRFRAME_NAMES.length], status: 'ready' });
}

/** The fleet at the start of a run: one pilot and one spare helicopter. */
export function initialFleet(s: CityState): void {
  const reyes = createPilot(s, 'Lt. Ana Reyes');
  reyes.hired = true;
  s.pilots.push(reyes);
  addAirframe(s);
}

/** How dangerous a landing zone is: 0 quiet .. ~0.7 overrun. */
export function dangerOf(d: DistrictState): number {
  const status = d.status === 'overrun' ? 0.6 : d.status === 'contested' ? 0.25 : 0.03;
  const crowd = Math.min(0.15, totalZombies(d) / (d.population * 0.02 + d.troops.strength * 5 + 200) * 0.1);
  return status + crowd;
}

/** Would this pilot fly into this district? */
export function willFly(p: Pilot, d: DistrictState): boolean {
  return dangerOf(d) <= 0.1 + p.nerve * 0.6;
}

/** Flight time from the hub (Camp Ridgeway or the airport) to a district. */
function travelMinutes(s: CityState, to: number): number {
  const pa = hubPosition(s);
  const b = DISTRICT_TEMPLATES[to];
  const pb = districtCenter(b.col, b.row);
  return TAKEOFF_MINUTES + Math.hypot(pa.x - pb.x, pa.z - pb.z) / METRES_PER_GAME_MINUTE;
}

export function validOrder(s: CityState, order: Order): boolean {
  const d = s.districts[order.district];
  if (!d) return false;
  if (order.kind === 'fuel') return !!d.features.fuelDepot && d.kind !== 'airbase';
  // Troops go into the city only once the JOC is running.
  if ((order.kind === 'reinforce' || order.kind === 'relieve') && !s.flags.joc) return false;
  return d.kind !== 'airbase';
}

/** Some of the people you bring in turn out to be pilots. */
export function maybeRecruit(s: CityState, civilians: number, emit: Emit): void {
  for (let i = 0; i < civilians; i++) {
    if (nextRandom(s) >= RECRUIT_CHANCE) continue;
    const p = createPilot(s);
    s.pilots.push(p);
    s.stats.pilotsRecruited += 1;
    emit(baseOf(s).id, 'info', `Among the evacuees is a pilot: ${p.name}. They'll fly for ${p.wage.toLocaleString('en-US')} rations a day if hired.`, true);
  }
}

/** Advance every pilot by one game minute. */
export function updatePilots(s: CityState, emit: Emit): void {
  const base = baseOf(s);
  for (const p of s.pilots) {
    switch (p.status) {
      case 'idle':
      case 'resting':
        p.fatigue = Math.max(0, p.fatigue - REST_PER_HOUR / 60);
        if (p.status === 'resting' && s.t >= p.restUntil) p.status = 'idle';
        if (p.status === 'idle' && p.order) dispatch(s, p, emit);
        break;
      case 'flying':
        advanceTrip(s, p, emit);
        break;
      case 'stranded': {
        const d = s.districts[p.district];
        if (d.status === 'overrun' && Math.floor(s.t) % 60 === 0 && nextRandom(s) < STRANDED_DEATH_PER_HOUR) {
          p.status = 'dead';
          emit(d.id, 'critical', `${p.name}, stranded in ${d.name}, has stopped answering the radio.`);
        }
        break;
      }
    }
  }
  if (base.status === 'overrun') {
    for (const p of s.pilots) if (p.status === 'idle' || p.status === 'resting') p.status = 'dead';
  }
}

function block(s: CityState, p: Pilot, reason: string, emit: Emit): void {
  // Report each reason once an hour at most.
  if (p.blockedReason === reason && s.t - p.blockedAt < 60) return;
  p.blockedAt = s.t;
  p.blockedReason = reason;
  emit(null, 'warn', `${p.name}: ${reason}`);
}

function dispatch(s: CityState, p: Pilot, emit: Emit): void {
  const order = p.order!;
  const d = s.districts[order.district];
  const base = baseOf(s);
  if (p.fatigue >= TOO_TIRED) return block(s, p, 'too tired to fly. Resting.', emit);
  if (p.loyalty < REFUSE_LOYALTY) return block(s, p, 'refuses to fly until they are paid properly.', emit);
  if (!willFly(p, d)) return block(s, p, `won't fly into ${d.name}. Too hot.`, emit);
  const airframe = s.airframes.find((a) => a.status === 'ready');
  if (!airframe) return block(s, p, 'no helicopter free at the base.', emit);
  if (base.fuel < TRIP_FUEL) return block(s, p, 'grounded: the base is out of fuel.', emit);

  const trip: Trip = {
    phase: 'outbound', district: d.id, start: s.t, end: s.t + travelMinutes(s, d.id),
    troops: 0, crates: [], civilians: 0, infected: 0, tired: 0, tiredFatigue: 0, fuel: 0, danger: dangerOf(d),
  };
  if (order.kind === 'reinforce' || order.kind === 'relieve') {
    const available = Math.floor(base.troops.strength - BASE_RESERVE_TROOPS);
    if (available < 2) return block(s, p, 'no troops to spare at the base.', emit);
    trip.troops = Math.min(SEATS, available);
    base.troops.strength -= trip.troops;
    base.troops.ammo = Math.max(0, base.troops.ammo - trip.troops * ROUNDS_PER_TROOP);
  }
  if (order.kind === 'resupply') {
    const kind: CrateKind = order.crate;
    const stock = kind === 'rations' ? base.rations : kind === 'medicine' ? base.medicine : base.troops.ammo;
    const crates = Math.min(2, Math.floor(stock / CRATES[kind].amount));
    if (crates < 1) return block(s, p, `no ${CRATES[kind].label} left in base stores.`, emit);
    for (let i = 0; i < crates; i++) {
      if (kind === 'rations') base.rations -= CRATES.rations.amount;
      else if (kind === 'medicine') base.medicine -= CRATES.medicine.amount;
      else base.troops.ammo -= CRATES.ammo.amount;
      trip.crates.push(kind);
    }
  }
  base.fuel -= TRIP_FUEL;
  airframe.status = 'flying';
  p.airframe = airframe.id;
  p.trip = trip;
  p.status = 'flying';
  p.blockedReason = '';
  emit(d.id, 'info', `${p.name}: wheels up for ${d.name} (${JOB_LABELS[order.kind].toLowerCase()}).`, true);
}

function advanceTrip(s: CityState, p: Pilot, emit: Emit): void {
  const trip = p.trip!;
  if (s.t < trip.end) return;
  const d = s.districts[trip.district];
  if (trip.phase === 'outbound') {
    // The landing is where it goes wrong.
    const tired = p.fatigue > 0.7 ? 1.8 : 1;
    const loss = dangerOf(d) * 0.12 * (1.3 - p.skill) * tired;
    if (nextRandom(s) < loss) return crash(s, p, d, emit);
    land(s, p, d);
    trip.phase = 'ground';
    trip.start = s.t;
    trip.end = s.t + GROUND_MINUTES;
  } else if (trip.phase === 'ground') {
    trip.phase = 'return';
    trip.start = s.t;
    trip.end = s.t + travelMinutes(s, d.id);
  } else {
    homecoming(s, p, emit);
  }
}

/** Do the job at the landing zone. */
function land(s: CityState, p: Pilot, d: DistrictState): void {
  const trip = p.trip!;
  const order = p.order;
  const kind = order?.kind;
  if (trip.troops > 0) {
    mergeTroops(d, trip.troops, 0, 0.95, trip.troops * ROUNDS_PER_TROOP);
    s.stats.troopsDeployed += trip.troops;
    trip.troops = 0;
  }
  for (const crate of trip.crates) {
    if (crate === 'rations') d.rations += CRATES.rations.amount;
    else if (crate === 'medicine') d.medicine += CRATES.medicine.amount;
    else d.troops.ammo += CRATES.ammo.amount;
    d.order = Math.min(100, d.order + CRATES[crate].order);
    s.stats.cratesDelivered += 1;
  }
  trip.crates = [];
  if (kind === 'evacuate') {
    // Pilots land at the fullest shelter still holding, where people are screened at the door.
    const shelter = s.sites
      .filter((x) => x.district === d.id && x.status !== 'fallen' && x.sheltered >= 1)
      .sort((a, b) => b.sheltered - a.sheltered)[0];
    const screened = shelter ? 0.25 : 1;
    for (let i = 0; i < SEATS && d.population + d.infected >= 1; i++) {
      if (shelter && shelter.sheltered >= 1) {
        shelter.sheltered -= 1;
        d.sheltered = Math.max(0, d.sheltered - 1);
      }
      if (nextRandom(s) < (screened * d.infected) / (d.population + d.infected)) {
        d.infected -= 1;
        trip.infected += 1;
      } else {
        d.population -= 1;
        trip.civilians += 1;
      }
    }
  }
  if (kind === 'relieve') {
    const n = Math.min(SEATS, Math.floor(d.troops.strength));
    trip.tiredFatigue = d.troops.fatigue;
    trip.tired = n;
    d.troops.ammo = Math.max(0, d.troops.ammo - (d.troops.ammo / Math.max(1, d.troops.strength)) * n);
    d.troops.strength -= n;
  }
  if (kind === 'fuel') {
    const litres = Math.min(BLADDER_LITRES, d.fuel);
    d.fuel -= litres;
    trip.fuel = litres;
  }
}

function homecoming(s: CityState, p: Pilot, emit: Emit): void {
  const trip = p.trip!;
  const base = baseOf(s);
  const d = s.districts[trip.district];
  base.population += trip.civilians;
  screenAtGate(s, base, trip.infected);
  if (trip.tired > 0) mergeTroops(base, trip.tired, trip.tiredFatigue, 0.6, 0);
  base.fuel += trip.fuel;
  s.stats.civiliansEvacuated += trip.civilians + trip.infected;
  s.stats.troopsRelieved += trip.tired;
  s.stats.aiTrips += 1;
  const brought = [
    trip.civilians + trip.infected && `${trip.civilians + trip.infected} civilians`,
    trip.tired && `${trip.tired} exhausted soldiers`,
    trip.fuel && `${trip.fuel.toLocaleString('en-US')} L of fuel`,
  ].filter(Boolean);
  emit(d.id, 'info', `${p.name} is back from ${d.name}${brought.length ? ` with ${brought.join(', ')}` : ''}.`, true);
  maybeRecruit(s, trip.civilians, emit);

  // Danger money, if the stores can cover it.
  if (trip.danger >= 0.25) {
    if (base.rations >= DANGER_BONUS) base.rations -= DANGER_BONUS;
    else p.loyalty = Math.max(0, p.loyalty - 0.05);
  }
  p.fatigue = Math.min(1, p.fatigue + FATIGUE_PER_TRIP * (1 + trip.danger));
  p.loyalty = Math.min(1, p.loyalty + 0.01 - (trip.danger > p.nerve * 0.5 ? 0.03 : 0));
  p.trips += 1;
  const airframe = s.airframes.find((a) => a.id === p.airframe);
  if (airframe) airframe.status = 'ready';
  p.airframe = null;
  p.trip = null;
  if (!p.order?.repeat) p.order = null;
  p.status = 'resting';
  p.restUntil = s.t + TURNAROUND_MINUTES;
}

function crash(s: CityState, p: Pilot, d: DistrictState, emit: Emit): void {
  const airframe = s.airframes.find((a) => a.id === p.airframe);
  if (airframe) airframe.status = 'lost';
  p.airframe = null;
  p.trip = null;
  p.order = null;
  for (const other of s.pilots) if (other !== p && other.status !== 'dead') other.loyalty = Math.max(0, other.loyalty - 0.05);
  if (nextRandom(s) < PILOT_SURVIVES_CRASH * (0.6 + p.skill * 0.6)) {
    p.status = 'stranded';
    p.district = d.id;
    emit(d.id, 'critical', `${p.name}'s helicopter went down in ${d.name}. The pilot survived and is waiting for pickup.`);
  } else {
    p.status = 'dead';
    emit(d.id, 'critical', `${p.name}'s helicopter went down in ${d.name}. No survivors.`);
  }
}

/** 06:00: wages come out of the base's rations. Unpaid pilots lose faith; some take their helicopter and go. */
export function payday(s: CityState, emit: Emit): void {
  const base = baseOf(s);
  const crew = s.pilots.filter((p) => p.hired && (p.status === 'idle' || p.status === 'resting' || p.status === 'flying'));
  // The most loyal are paid last: the ones most likely to leave get paid first.
  crew.sort((a, b) => a.loyalty - b.loyalty);
  let unpaid = 0;
  for (const p of crew) {
    if (base.rations >= p.wage) {
      base.rations -= p.wage;
      p.unpaid = 0;
      p.loyalty = Math.min(1, p.loyalty + 0.05);
    } else {
      p.unpaid += 1;
      p.loyalty = Math.max(0, p.loyalty - 0.25);
      unpaid++;
    }
  }
  if (unpaid) emit(base.id, 'warn', `Not enough rations to pay ${unpaid} pilot${unpaid > 1 ? 's' : ''}.`);
  for (const p of crew) {
    if (p.loyalty >= DESERT_LOYALTY || p.status === 'flying') continue;
    const airframe = s.airframes.find((a) => a.status === 'ready');
    if (airframe) airframe.status = 'lost';
    p.status = 'deserted';
    p.order = null;
    emit(base.id, 'critical', `${p.name} has deserted${airframe ? ` and taken ${airframe.name} with them` : ''}.`);
  }
}

export function orderSummary(s: CityState, order: Order | null): string {
  if (!order) return 'No orders';
  const d = s.districts[order.district];
  const what = order.kind === 'resupply' ? `Resupply ${CRATES[order.crate].label}` : JOB_LABELS[order.kind];
  return `${what} · ${d.name}${order.repeat ? ' · repeating' : ''}`;
}
