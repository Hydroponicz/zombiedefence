// Military convoys between Camp Ridgeway and the airport. Once the Joint Operations Command is up,
// engineers drive in to fortify the airport, a stage a convoy (barriers at the gate, a barrier line
// around it, razor wire, guard towers, HESCO walls), and tankers and cargo trucks bring Camp
// Ridgeway's fuel and stores forward. Each convoy unloads at the JOC and drives back.

import { airportOf } from './command';
import { ARMY_BASE, CITY_WIDTH, districtCenter } from './layout';
import type { CityState, ConvoyKind, DistrictState, MilitaryConvoy, Severity } from './types';

type Emit = (district: number | null, severity: Severity, text: string, radio?: boolean) => void;

/** Game minutes each way, and on the ground at the JOC. */
export const CONVOY_DRIVE = 30;
export const CONVOY_UNLOAD = 20;
/** Minutes between convoys while the airport is being fortified, and after. */
const BUILD_EVERY = 60;
const FUEL_EVERY = 240;
const SUPPLY_EVERY = 480;
/** The airport's fortification stages, one an engineer convoy. */
export const WORKS_STAGES = 5;
/** What a fuel convoy brings (its tankers), and a supply convoy. */
const FUEL_LOAD = 20000;
const SUPPLY_LOAD = { rations: 12000, medicine: 3000, ammo: 40000 };

export const WORKS_LABELS = [
  'concrete barriers at the gate and around the JOC',
  'a concrete barrier line around the airport',
  'razor wire along the perimeter',
  'guard towers at the corners and the gate',
  'HESCO bastion walls and floodlights',
];

/** The vehicles in each kind of convoy, front to back. */
export const CONVOY_VEHICLES: Record<ConvoyKind, ('humvee' | 'tanker' | 'cargo' | 'flatbed' | 'crane')[]> = {
  engineers: ['humvee', 'flatbed', 'flatbed', 'crane', 'cargo', 'humvee'],
  fuel: ['humvee', 'tanker', 'tanker', 'tanker', 'humvee'],
  supply: ['humvee', 'cargo', 'cargo', 'cargo', 'cargo', 'humvee'],
};

/**
 * The road from Camp Ridgeway's gate to the JOC: east along the camp road to the city, in at the
 * airport's west gate, round the terminal and across the apron (world x, z).
 */
export function convoyRoute(): [number, number][] {
  const airport = districtCenter(0, 2);
  const gateX = -CITY_WIDTH / 2 + 20;
  return [
    [ARMY_BASE.x + 450, ARMY_BASE.z],
    [gateX - 40, ARMY_BASE.z],
    [gateX + 160, ARMY_BASE.z],
    [gateX + 160, airport.z + 60],
    [airport.x - 260, airport.z + 60],
    [airport.x - 260, airport.z + 115],
  ];
}

/** The airport's west gate, where the camp road comes in. */
export function airportGate(): { x: number; z: number } {
  return { x: -CITY_WIDTH / 2 + 20, z: ARMY_BASE.z };
}

export function airportWorks(s: CityState): number {
  return s.airportWorks;
}

/** How much the airport's fortifications multiply its defence (the JOC's fortification, then the works). */
export function fortification(s: CityState, d: DistrictState): number {
  if (!d.features.fortified) return 1;
  return d.kind === 'airbase' ? 2 + 0.25 * s.airportWorks : 2;
}

/** Every minute: send convoys out, unload them, bring them home. */
export function updateConvoys(s: CityState, emit: Emit): void {
  if (!s.flags.joc) return;
  const airport = airportOf(s);
  for (const c of s.convoys) {
    if (c.phase === 'outbound' && s.t >= c.depart + CONVOY_DRIVE) {
      c.phase = 'unloading';
      unload(s, c, airport, emit);
    } else if (c.phase === 'unloading' && s.t >= c.depart + CONVOY_DRIVE + CONVOY_UNLOAD) {
      c.phase = 'return';
    }
  }
  s.convoys = s.convoys.filter((c) => s.t < c.depart + CONVOY_DRIVE * 2 + CONVOY_UNLOAD);
  if (airport.status === 'overrun' || s.t < s.nextConvoy) return;

  // The works first, with fuel and stores in between; then regular runs.
  const building = s.airportWorks + s.convoys.filter((c) => c.kind === 'engineers').length < WORKS_STAGES;
  let kind: ConvoyKind;
  if (building) kind = s.convoySeq % 2 === 0 ? 'engineers' : s.convoySeq % 4 === 1 ? 'fuel' : 'supply';
  else kind = s.convoySeq % 3 === 2 ? 'supply' : 'fuel';
  if (kind === 'fuel' && s.army.fuel < FUEL_LOAD * 0.25) kind = 'supply';
  s.convoys.push({ id: ++s.convoySeq, kind, depart: s.t, phase: 'outbound' });
  s.nextConvoy = s.t + (building ? BUILD_EVERY : kind === 'fuel' ? FUEL_EVERY : SUPPLY_EVERY / 2);
  emit(null, 'info', `A ${kind === 'engineers' ? 'combat engineer' : kind} convoy has left ${s.army.name} for ${airport.name}.`);
}

function unload(s: CityState, c: MilitaryConvoy, airport: DistrictState, emit: Emit): void {
  if (c.kind === 'engineers') {
    if (s.airportWorks >= WORKS_STAGES) return;
    s.airportWorks += 1;
    emit(airport.id, 'info', `Engineers at ${airport.name} have put up ${WORKS_LABELS[s.airportWorks - 1]}.` +
      (s.airportWorks === WORKS_STAGES ? ' The airport is fully fortified.' : ''), true);
    return;
  }
  if (c.kind === 'fuel') {
    const litres = Math.min(FUEL_LOAD, s.army.fuel);
    s.army.fuel -= litres;
    airport.fuel += litres;
    emit(airport.id, 'info', `Tankers have brought ${Math.round(litres).toLocaleString('en-US')} L of fuel to ${airport.name}.`);
    return;
  }
  const rations = Math.min(SUPPLY_LOAD.rations, s.army.rations);
  const medicine = Math.min(SUPPLY_LOAD.medicine, s.army.medicine);
  // Only the camp's spare rounds: its soldiers keep their own.
  const ammo = Math.min(SUPPLY_LOAD.ammo, Math.max(0, s.army.troops.ammo - s.army.troops.strength * 300));
  s.army.rations -= rations;
  s.army.medicine -= medicine;
  s.army.troops.ammo -= ammo;
  airport.rations += rations;
  airport.medicine += medicine;
  airport.troops.ammo += ammo;
  emit(airport.id, 'info', `A supply convoy has unloaded food, medicine and ammunition at ${airport.name}.`);
}

/** How far along the route a convoy's lead vehicle is (metres), at game time t. */
export function convoyDistance(c: MilitaryConvoy, t: number, length: number): number {
  const into = t - c.depart;
  if (into <= CONVOY_DRIVE) return (into / CONVOY_DRIVE) * length;
  if (into <= CONVOY_DRIVE + CONVOY_UNLOAD) return length;
  return Math.max(0, (1 - (into - CONVOY_DRIVE - CONVOY_UNLOAD) / CONVOY_DRIVE) * length);
}
