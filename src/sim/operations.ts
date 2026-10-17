// What the player's helicopter can do to the city: load at the base, deploy troops, drop relief
// crates, evacuate people and rotate exhausted soldiers out. Each command moves one person or
// one crate, so the game can pace them (and a hot landing zone can interrupt them).

import { nextRandom } from './rng';
import type { Cargo, CityState, CrateKind, DistrictState, Severity } from './types';

export const SEATS = 8;
export const CRATE_SLOTS = 2;
/** The base keeps this many soldiers back for its own defence. */
export const BASE_RESERVE_TROOPS = 50;
export const ROUNDS_PER_TROOP = 300;

/** What one crate holds and how much it calms the district it lands in. */
export const CRATES: Record<CrateKind, { amount: number; order: number; label: string }> = {
  rations: { amount: 5000, order: 6, label: 'rations' },
  ammo: { amount: 15000, order: 2, label: 'ammunition' },
  medicine: { amount: 3000, order: 3, label: 'medicine' },
};

const PASSENGER_KG = 100;
const TROOP_KG = 120;
const CRATE_KG = 800;
export const MAX_PAYLOAD_KG = SEATS * TROOP_KG + CRATE_SLOTS * CRATE_KG;

export type BoardKind = 'civilian' | 'soldier' | 'scientist';

export type PlayerCommand =
  | { type: 'loadTroop' }
  | { type: 'returnTroop' }
  | { type: 'loadCrate'; kind: CrateKind }
  | { type: 'deployTroop'; district: number }
  | { type: 'dropCrate'; district: number }
  | { type: 'board'; district: number; kind: BoardKind }
  | { type: 'unloadAtBase' }
  /** The helicopter went down: everyone and everything aboard is lost. */
  | { type: 'crash'; district: number };

export type Emit = (district: number | null, severity: Severity, text: string) => void;

export function emptyCargo(): Cargo {
  return { troops: 0, troopFatigue: 0, civilians: 0, infected: 0, tired: 0, tiredFatigue: 0, scientists: 0, crates: [] };
}

export function seatsUsed(c: Cargo): number {
  return c.troops + c.civilians + c.infected + c.tired + c.scientists;
}

export function passengers(c: Cargo): number {
  return c.civilians + c.infected + c.tired + c.scientists;
}

export function payloadKg(c: Cargo): number {
  return (c.troops + c.tired) * TROOP_KG + (c.civilians + c.infected + c.scientists) * PASSENGER_KG + c.crates.length * CRATE_KG;
}

export function baseOf(s: CityState): DistrictState {
  return s.districts.find((d) => d.kind === 'airbase')!;
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

/** Whether a command can run right now (the UI uses this to grey out options). */
export function canApply(s: CityState, cmd: PlayerCommand): boolean {
  const c = s.cargo;
  const base = baseOf(s);
  const seatFree = seatsUsed(c) < SEATS;
  switch (cmd.type) {
    case 'loadTroop':
      return seatFree && base.troops.strength >= BASE_RESERVE_TROOPS + 1;
    case 'returnTroop':
      return c.troops >= 1;
    case 'loadCrate':
      return c.crates.length < CRATE_SLOTS && baseStock(base, cmd.kind) >= CRATES[cmd.kind].amount;
    case 'deployTroop':
      return c.troops >= 1;
    case 'dropCrate':
      return c.crates.length > 0;
    case 'board': {
      if (!seatFree) return false;
      const d = s.districts[cmd.district];
      if (cmd.kind === 'civilian') return d.population + d.infected >= 1;
      if (cmd.kind === 'soldier') return d.troops.strength >= 1;
      return d.scientists >= 1;
    }
    case 'unloadAtBase':
      return passengers(c) > 0;
    case 'crash':
      return true;
  }
}

/** Apply a command. Returns false (and changes nothing) if it can't run. */
export function applyCommand(s: CityState, cmd: PlayerCommand, emit: Emit): boolean {
  if (!canApply(s, cmd)) return false;
  const c = s.cargo;
  const base = baseOf(s);
  switch (cmd.type) {
    case 'loadTroop': {
      const tr = base.troops;
      const ammo = Math.min(ROUNDS_PER_TROOP, tr.ammo / Math.max(1, tr.strength));
      c.troopFatigue = (c.troopFatigue * c.troops + tr.fatigue) / (c.troops + 1);
      c.troops += 1;
      tr.strength -= 1;
      tr.ammo -= ammo;
      return true;
    }
    case 'returnTroop':
      c.troops -= 1;
      mergeTroops(base, 1, c.troopFatigue, base.troops.morale, ROUNDS_PER_TROOP);
      if (c.troops === 0) c.troopFatigue = 0;
      return true;
    case 'loadCrate':
      takeBaseStock(base, cmd.kind, CRATES[cmd.kind].amount);
      c.crates.push(cmd.kind);
      return true;
    case 'deployTroop': {
      const d = s.districts[cmd.district];
      // Fresh troops arriving lift the defenders' spirits a little.
      mergeTroops(d, 1, c.troopFatigue, 0.95, ROUNDS_PER_TROOP);
      c.troops -= 1;
      s.stats.troopsDeployed += 1;
      if (c.troops === 0) {
        c.troopFatigue = 0;
        emit(d.id, 'info', `Fresh troops have landed in ${d.name}.`);
      }
      return true;
    }
    case 'dropCrate': {
      const d = s.districts[cmd.district];
      const kind = c.crates.shift()!;
      const crate = CRATES[kind];
      if (kind === 'rations') d.rations += crate.amount;
      else if (kind === 'medicine') d.medicine += crate.amount;
      else d.troops.ammo += crate.amount;
      d.order = Math.min(100, d.order + crate.order);
      s.stats.cratesDelivered += 1;
      emit(d.id, 'info', `A relief crate of ${crate.label} has been delivered to ${d.name}.`);
      return true;
    }
    case 'board': {
      const d = s.districts[cmd.district];
      if (cmd.kind === 'civilian') {
        // The bitten hide among the people you pick up.
        const infected = nextRandom(s) < d.infected / (d.population + d.infected);
        if (infected) {
          d.infected -= 1;
          c.infected += 1;
        } else {
          d.population = Math.max(0, d.population - 1);
          c.civilians += 1;
        }
      } else if (cmd.kind === 'soldier') {
        const tr = d.troops;
        const ammo = tr.ammo / Math.max(1, tr.strength);
        c.tiredFatigue = (c.tiredFatigue * c.tired + tr.fatigue) / (c.tired + 1);
        c.tired += 1;
        tr.strength -= 1;
        tr.ammo = Math.max(0, tr.ammo - ammo);
      } else {
        d.scientists -= 1;
        c.scientists += 1;
      }
      return true;
    }
    case 'unloadAtBase': {
      const parts: string[] = [];
      if (c.civilians + c.infected > 0) parts.push(`${c.civilians + c.infected} civilians`);
      if (c.tired > 0) parts.push(`${c.tired} exhausted soldiers`);
      if (c.scientists > 0) parts.push(`${c.scientists} scientists`);
      base.population += c.civilians;
      base.infected += c.infected;
      if (c.tired > 0) mergeTroops(base, c.tired, c.tiredFatigue, 0.6, 0);
      base.scientists += c.scientists;
      s.stats.civiliansEvacuated += c.civilians + c.infected;
      s.stats.scientistsEvacuated += c.scientists;
      s.stats.troopsRelieved += c.tired;
      c.civilians = c.infected = c.tired = c.tiredFatigue = c.scientists = 0;
      emit(base.id, 'info', `${parts.join(', ')} brought in to ${base.name}.`);
      return true;
    }
    case 'crash': {
      const aboard = seatsUsed(c);
      s.stats.lostInCrashes += aboard;
      const where = s.districts[cmd.district]?.name;
      s.cargo = emptyCargo();
      emit(cmd.district >= 0 ? cmd.district : null, 'critical',
        `Helicopter down${where ? ` over ${where}` : ''}${aboard ? ` with ${aboard} aboard` : ''}.`);
      return true;
    }
  }
}

function baseStock(base: DistrictState, kind: CrateKind): number {
  return kind === 'rations' ? base.rations : kind === 'medicine' ? base.medicine : base.troops.ammo;
}

function takeBaseStock(base: DistrictState, kind: CrateKind, amount: number): void {
  if (kind === 'rations') base.rations -= amount;
  else if (kind === 'medicine') base.medicine -= amount;
  else base.troops.ammo -= amount;
}
