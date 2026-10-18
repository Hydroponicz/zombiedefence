// What the player's helicopter can do to the city: load at the base, deploy troops, drop relief
// crates, evacuate people and rotate exhausted soldiers out. Each command moves one person or
// one crate, so the game can pace them (and a hot landing zone can interrupt them).

import { replaceHelicopter } from './campaign';
import { districtAt } from './layout';
import { assignable, credit, overwatch } from './requests';
import { deliver, deliveryEffect, deliveryPlace } from './supplies';
import { hasResearch, LURE_CAPACITY, LURE_HOURS, researchBlocked, startResearch } from './research';
import { airportOf, establishJoc, hubOf, mergeTroops } from './command';
import { addAirframe, maybeRecruit, validOrder } from './pilots';
import { nextRandom } from './rng';
import { screenAtGate } from './quarantine';
import { siteName } from './sites';
import type { Cargo, CityState, CrateKind, DistrictState, Farp, JobKind, Order, Request, ResearchId, Severity, Site } from './types';

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

/** Litres in one sling-loaded fuel bladder (the heavy sling takes more). */
export const BLADDER_LITRES = 2000;
export const HEAVY_BLADDER_LITRES = 3000;

export function bladderLitres(s: CityState): number {
  return hasResearch(s, 'heavySling') ? HEAVY_BLADDER_LITRES : BLADDER_LITRES;
}
/** Soldiers left behind to guard a forward refuelling point. */
export const FARP_GUARDS = 4;
/** Minimum distance between forward refuelling points, in metres. */
export const FARP_SPACING = 150;
const FUEL_KG_PER_LITRE = 0.8;

const PASSENGER_KG = 100;
const TROOP_KG = 120;
const CRATE_KG = 800;
const LURE_KG = 60;
export const MAX_PAYLOAD_KG = SEATS * TROOP_KG + CRATE_SLOTS * CRATE_KG;

export type BoardKind = 'civilian' | 'soldier' | 'scientist' | 'pilot';

/** Which base: Camp Ridgeway, or the airport once the JOC is there (omitted: whichever is the hub). */
export type BaseId = 'army' | 'airport';

export type PlayerCommand =
  | { type: 'loadTroop'; at?: BaseId }
  | { type: 'returnTroop'; at?: BaseId }
  /** From a base's stores, or from a site's stock when `site` is given. */
  | { type: 'loadCrate'; kind: CrateKind; site?: number; at?: BaseId }
  /** At Camp Ridgeway: take the Joint Operations Command staff aboard. */
  | { type: 'loadCommandTeam' }
  /** At the airport, with the command team aboard: set up the JOC. */
  | { type: 'establishJoc' }
  /** Into the district; with `site`, posted to guard that site. */
  | { type: 'deployTroop'; district: number; site?: number }
  /**
   * Deliver a crate here (the street, or `site`): `kind`, or the first aboard that can go here.
   * Each kind has its places (see supplies.ts).
   */
  | { type: 'dropCrate'; district: number; site?: number; kind?: CrateKind }
  /** With `site`, civilians come out of that shelter. */
  | { type: 'board'; district: number; kind: BoardKind; site?: number }
  | { type: 'unloadAtBase'; at?: BaseId }
  /** The helicopter went down: everyone and everything aboard is lost. */
  | { type: 'crash'; district: number }
  /** Pump fuel into the helicopter from a district's stocks or a forward refuelling point. */
  | { type: 'refuel'; source: FuelSource; litres: number }
  | { type: 'hookBladder'; district: number }
  /** Set the slung bladder down: into a forward refuelling point if given, else the district's stocks. */
  | { type: 'releaseBladder'; district: number; farp?: number }
  /** Dropped from too high: the fuel is lost. */
  | { type: 'burstBladder'; district: number }
  | { type: 'setupFarp'; district: number; x: number; z: number }
  /** Out of fuel with no way to get more: everything aboard stays in the district and the crew is recovered. */
  | { type: 'abandon'; district: number }
  /** Give an AI pilot orders (null clears them). */
  | { type: 'setOrder'; pilot: number; order: Order | null }
  | { type: 'dismissPilot'; pilot: number }
  | { type: 'hirePilot'; pilot: number }
  /** Make an abandoned helicopter in the district airworthy; it is ferried to the base. */
  | { type: 'salvage'; district: number }
  /** After the campaign has ended: let the city run on and keep flying. */
  | { type: 'freePlay' }
  /** Take a Command request on (or drop it): it shows on the HUD and in the world. */
  | { type: 'trackRequest'; request: number }
  /** Hand a Command request to an AI pilot as a one-off order. */
  | { type: 'assignRequest'; request: number; pilot: number }
  /** The helicopter is watching over a request's food truck this minute. */
  | { type: 'overwatch'; request: number }
  /** Where the next army platoon goes (null: Command's choice), or hold them at the airport. */
  | { type: 'setPlatoon'; target: number | null; hold: boolean }
  /** The dead the player's own guns killed on the ground (in the simulation's numbers). */
  | { type: 'killZombies'; district: number; count: number }
  /** Spend research points on a project. */
  | { type: 'research'; id: ResearchId }
  /** At a base, once researched: take a noise lure aboard. */
  | { type: 'loadLure'; at?: BaseId }
  /** Drop a noise lure (from the air or on the ground) at a place in a district. */
  | { type: 'dropLure'; district: number; x: number; z: number };

export type FuelSource = { district: number } | { farp: number } | { army: true };

/** Litres available from a fuel source. */
export function fuelStock(s: CityState, source: FuelSource): number {
  if ('farp' in source) return s.farps.find((f) => f.id === source.farp)?.fuel ?? 0;
  if ('army' in source) return s.army.fuel;
  return s.districts[source.district]?.fuel ?? 0;
}

export function farpNear(s: CityState, x: number, z: number, radius: number): Farp | undefined {
  return s.farps.find((f) => Math.hypot(f.x - x, f.z - z) < radius);
}

export type Emit = (district: number | null, severity: Severity, text: string, radio?: boolean) => void;

export function emptyCargo(): Cargo {
  return { troops: 0, troopFatigue: 0, civilians: 0, infected: 0, tired: 0, tiredFatigue: 0, scientists: 0, crates: [], sling: 0, pilots: [], commandTeam: false, lures: 0 };
}

/** Seats the command team takes. */
export const COMMAND_TEAM_SEATS = 4;

export function seatsUsed(c: Cargo): number {
  return c.troops + passengers(c) + (c.commandTeam ? COMMAND_TEAM_SEATS : 0);
}

export function passengers(c: Cargo): number {
  return c.civilians + c.infected + c.tired + c.scientists + c.pilots.length;
}

export function payloadKg(c: Cargo): number {
  return (c.troops + c.tired + (c.commandTeam ? COMMAND_TEAM_SEATS : 0)) * TROOP_KG + (c.civilians + c.infected + c.scientists) * PASSENGER_KG +
    c.crates.length * CRATE_KG + c.lures * LURE_KG + c.sling * FUEL_KG_PER_LITRE;
}

/** The military's hub: Camp Ridgeway, then the airport once the JOC is up. */
export function baseOf(s: CityState): DistrictState {
  return hubOf(s);
}

export function baseAt(s: CityState, at: BaseId | undefined): DistrictState {
  return at === 'army' ? s.army : at === 'airport' ? airportOf(s) : hubOf(s);
}

export { mergeTroops };

/** Whether a command can run right now (the UI uses this to grey out options). */
export function canApply(s: CityState, cmd: PlayerCommand): boolean {
  const c = s.cargo;
  const base = baseAt(s, 'at' in cmd ? cmd.at : undefined);
  const seatFree = seatsUsed(c) < SEATS;
  switch (cmd.type) {
    case 'loadTroop':
      // Command holds the troops back until the JOC is running.
      return !!s.flags.joc && seatFree && base.troops.strength >= BASE_RESERVE_TROOPS + 1;
    case 'loadCommandTeam':
      return !!s.flags.jocAuthorized && !s.flags.joc && !c.commandTeam && seatsUsed(c) + COMMAND_TEAM_SEATS <= SEATS;
    case 'establishJoc':
      return c.commandTeam && !s.flags.joc;
    case 'returnTroop':
      return c.troops >= 1;
    case 'loadCrate': {
      if (c.crates.length >= CRATE_SLOTS) return false;
      if (cmd.site === undefined) return baseStock(base, cmd.kind) >= CRATES[cmd.kind].amount;
      const site = siteOf(s, cmd.site);
      return !!site && siteStock(site, cmd.kind) >= CRATES[cmd.kind].amount;
    }
    case 'deployTroop':
      return c.troops >= 1 && (cmd.site === undefined || !!siteOf(s, cmd.site));
    case 'dropCrate':
      return crateToDrop(s, cmd) !== null;
    case 'board': {
      if (!seatFree) return false;
      const d = s.districts[cmd.district];
      if (cmd.kind === 'civilian' && cmd.site !== undefined) {
        const site = siteOf(s, cmd.site);
        return !!site && site.status !== 'fallen' && site.sheltered >= 1 && d.population >= 1;
      }
      if (cmd.kind === 'civilian') return d.population + d.infected >= 1;
      if (cmd.kind === 'soldier') return d.troops.strength >= 1;
      if (cmd.kind === 'pilot') return s.pilots.some((p) => p.status === 'stranded' && p.district === d.id);
      return d.scientists >= 1;
    }
    case 'unloadAtBase':
      return passengers(c) > 0;
    case 'crash':
    case 'abandon':
      return true;
    case 'freePlay':
      return s.campaign.outcome !== 'running' && !s.flags.freePlay;
    case 'trackRequest':
      return s.requests.some((r) => r.id === cmd.request && r.status === 'open');
    case 'assignRequest': {
      const r = s.requests.find((x) => x.id === cmd.request && x.status === 'open');
      const p = s.pilots.find((x) => x.id === cmd.pilot);
      return !!r && assignable(r) && !!p && p.hired && !['dead', 'deserted', 'stranded'].includes(p.status) && validOrder(s, requestOrder(r));
    }
    case 'overwatch':
      return true;
    case 'research':
      return researchBlocked(s, cmd.id) === null;
    case 'killZombies':
      return !!s.districts[cmd.district] && cmd.count > 0;
    case 'loadLure':
      return hasResearch(s, 'noiseLures') && c.lures < LURE_CAPACITY;
    case 'dropLure':
      return c.lures > 0 && !!s.districts[cmd.district];
    case 'setPlatoon':
      return cmd.target === null || (!!s.districts[cmd.target] && s.districts[cmd.target].kind !== 'airbase' && s.districts[cmd.target].status !== 'overrun');
    case 'setOrder': {
      const p = s.pilots.find((x) => x.id === cmd.pilot);
      return !!p && p.hired && !['dead', 'deserted', 'stranded'].includes(p.status) && (cmd.order === null || validOrder(s, cmd.order));
    }
    case 'dismissPilot': {
      const p = s.pilots.find((x) => x.id === cmd.pilot);
      return !!p && (p.status === 'idle' || p.status === 'resting');
    }
    case 'salvage':
      return s.districts[cmd.district].salvage >= 1;
    case 'hirePilot': {
      const p = s.pilots.find((x) => x.id === cmd.pilot);
      return !!p && !p.hired && (p.status === 'idle' || p.status === 'resting');
    }
    case 'refuel':
      return cmd.litres > 0 && fuelStock(s, cmd.source) > 0;
    case 'hookBladder': {
      const d = s.districts[cmd.district];
      return c.sling === 0 && !!d.features.fuelDepot && d.fuel >= bladderLitres(s);
    }
    case 'releaseBladder':
      return c.sling > 0 && (cmd.farp === undefined || s.farps.some((f) => f.id === cmd.farp));
    case 'burstBladder':
      return c.sling > 0;
    case 'setupFarp':
      return c.sling > 0 && c.troops >= FARP_GUARDS && s.districts[cmd.district].kind !== 'airbase' &&
        !farpNear(s, cmd.x, cmd.z, FARP_SPACING);
  }
}

/** Apply a command. Returns false (and changes nothing) if it can't run. */
export function applyCommand(s: CityState, cmd: PlayerCommand, emit: Emit): boolean {
  if (!canApply(s, cmd)) return false;
  const c = s.cargo;
  const base = baseAt(s, 'at' in cmd ? cmd.at : undefined);
  switch (cmd.type) {
    case 'loadCommandTeam':
      c.commandTeam = true;
      emit(null, 'info', 'The Joint Operations Command team is aboard. Fly them to Kessler Airport.', true);
      return true;
    case 'establishJoc':
      c.commandTeam = false;
      establishJoc(s, emit, false);
      return true;
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
    case 'loadCrate': {
      const site = cmd.site === undefined ? undefined : siteOf(s, cmd.site);
      if (site) takeSiteStock(site, cmd.kind, CRATES[cmd.kind].amount);
      else takeBaseStock(base, cmd.kind, CRATES[cmd.kind].amount);
      c.crates.push(cmd.kind);
      return true;
    }
    case 'deployTroop': {
      const d = s.districts[cmd.district];
      // Fresh troops arriving lift the defenders' spirits a little.
      mergeTroops(d, 1, c.troopFatigue, 0.95, ROUNDS_PER_TROOP);
      c.troops -= 1;
      s.stats.troopsDeployed += 1;
      credit(s, { what: 'troops', district: d.id, amount: 1, by: 'player' }, emit);
      const site = cmd.site === undefined ? undefined : siteOf(s, cmd.site);
      if (site) {
        site.pinned += 1;
        site.guards += 1;
      }
      if (c.troops === 0) {
        c.troopFatigue = 0;
        emit(d.id, 'info', site ? `Fresh troops are holding ${siteName(site, d)}.` : `Fresh troops have landed in ${d.name}.`, true);
      }
      return true;
    }
    case 'dropCrate': {
      const d = s.districts[cmd.district];
      const index = crateToDrop(s, cmd)!;
      const kind = c.crates[index];
      const site = cmd.site === undefined ? undefined : siteOf(s, cmd.site);
      const place = deliveryPlace(s, kind, d.id, site) as { ok: true; share: number };
      const effect = deliveryEffect(s, kind, d.id, place.share);
      c.crates.splice(index, 1);
      deliver(s, kind, d, place.share);
      d.order = Math.min(100, d.order + CRATES[kind].order);
      s.stats.cratesDelivered += 1;
      emit(d.id, 'info', `A crate of ${CRATES[kind].label} has reached ${site ? siteName(site, d) : d.name}` +
        `${place.share < 1 ? ', some of it lost in the fighting' : ''}: ${effect}.`, true);
      credit(s, { what: 'crate', district: d.id, site: site?.id, crate: kind, amount: 1, by: 'player' }, emit);
      return true;
    }
    case 'board': {
      const d = s.districts[cmd.district];
      if (cmd.kind === 'civilian' && cmd.site !== undefined) {
        // A shelter screens people at the door: few of the bitten get through.
        const site = siteOf(s, cmd.site)!;
        site.sheltered -= 1;
        d.sheltered = Math.max(0, d.sheltered - 1);
        if (d.infected >= 1 && !hasResearch(s, 'rapidTests') && nextRandom(s) < (0.25 * d.infected) / (d.population + d.infected)) {
          d.infected -= 1;
          c.infected += 1;
        } else {
          d.population = Math.max(0, d.population - 1);
          c.civilians += 1;
        }
        credit(s, { what: 'civilians', district: d.id, site: site.id, amount: 1, by: 'player' }, emit);
      } else if (cmd.kind === 'civilian') {
        // The bitten hide among the people you pick up.
        // Rapid tests catch them at the door (when there's anyone healthy to take instead).
        const tested = hasResearch(s, 'rapidTests') && d.population >= 1;
        const infected = !tested && nextRandom(s) < d.infected / (d.population + d.infected);
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
      } else if (cmd.kind === 'pilot') {
        const p = s.pilots.find((x) => x.status === 'stranded' && x.district === d.id)!;
        p.status = 'resting';
        p.district = -1;
        c.pilots.push(p.id);
      } else {
        d.scientists -= 1;
        c.scientists += 1;
        credit(s, { what: 'scientists', district: d.id, amount: 1, by: 'player' }, emit);
      }
      return true;
    }
    case 'trackRequest': {
      for (const r of s.requests) r.tracked = r.id === cmd.request ? !r.tracked : false;
      return true;
    }
    case 'assignRequest': {
      const r = s.requests.find((x) => x.id === cmd.request)!;
      const p = s.pilots.find((x) => x.id === cmd.pilot)!;
      p.order = requestOrder(r);
      p.blockedReason = '';
      r.assigned = p.id;
      emit(r.district, 'info', `${p.name} is taking on: ${r.title}.`, true);
      return true;
    }
    case 'overwatch':
      return overwatch(s, cmd.request, emit);
    case 'research':
      return startResearch(s, cmd.id, emit);
    case 'killZombies': {
      // From the district's own dead first, then any horde there.
      const d = s.districts[cmd.district];
      let left = cmd.count;
      const own = Math.min(left, d.zombies);
      d.zombies -= own;
      left -= own;
      for (const h of s.hordes) {
        if (left <= 0) break;
        if (districtAt(h.x, h.z) !== d.id) continue;
        const n = Math.min(left, h.size);
        h.size -= n;
        left -= n;
      }
      d.dead += cmd.count - left;
      return true;
    }
    case 'loadLure':
      c.lures += 1;
      return true;
    case 'dropLure': {
      const d = s.districts[cmd.district];
      c.lures -= 1;
      s.lures.push({ id: ++s.lureSeq, district: d.id, x: cmd.x, z: cmd.z, until: s.t + LURE_HOURS * 60 });
      emit(d.id, 'info', `A noise lure is sounding in ${d.name}. The dead around will come to it for ${LURE_HOURS} hours.`, true);
      return true;
    }
    case 'setPlatoon': {
      s.platoonTarget = cmd.target;
      s.flags.holdPlatoons = cmd.hold;
      const where = cmd.target === null ? null : s.districts[cmd.target].name;
      emit(null, 'info', cmd.hold ? 'Army platoons are held at the airport until you send them.'
        : where ? `The next army platoon will go to ${where}.` : 'Command will choose where the next army platoon goes.', true);
      return true;
    }
    case 'setOrder': {
      const p = s.pilots.find((x) => x.id === cmd.pilot)!;
      p.order = cmd.order ? { ...cmd.order } : null;
      p.blockedReason = '';
      return true;
    }
    case 'dismissPilot': {
      const p = s.pilots.find((x) => x.id === cmd.pilot)!;
      s.pilots = s.pilots.filter((x) => x !== p);
      emit(null, 'info', p.hired ? `${p.name} has been let go.` : `${p.name} has been turned away.`, true);
      return true;
    }
    case 'hirePilot': {
      const p = s.pilots.find((x) => x.id === cmd.pilot)!;
      p.hired = true;
      emit(null, 'info', `${p.name} has signed on for ${p.wage.toLocaleString('en-US')} rations a day.`, true);
      return true;
    }
    case 'salvage': {
      const d = s.districts[cmd.district];
      d.salvage -= 1;
      addAirframe(s);
      emit(d.id, 'info', `An abandoned helicopter in ${d.name} has been made airworthy and ferried to ${base.name}.`, true);
      return true;
    }
    case 'unloadAtBase': {
      const parts: string[] = [];
      if (c.civilians + c.infected > 0) parts.push(`${c.civilians + c.infected} civilians`);
      if (c.tired > 0) parts.push(`${c.tired} exhausted soldiers`);
      if (c.scientists > 0) parts.push(`${c.scientists} scientists`);
      if (c.pilots.length > 0) parts.push(`${c.pilots.length} rescued pilot${c.pilots.length > 1 ? 's' : ''}`);
      for (const id of c.pilots) {
        const p = s.pilots.find((x) => x.id === id);
        // Grateful to be alive, and ready after a rest.
        if (p) {
          p.status = 'resting';
          p.restUntil = s.t + 120;
          p.loyalty = Math.min(1, p.loyalty + 0.2);
        }
      }
      // With the antiviral, the bitten are treated instead of turned away.
      if (hasResearch(s, 'antiviral') && c.infected > 0) {
        parts.push(`${c.infected} bitten treated with the antiviral`);
        c.civilians += c.infected;
        c.infected = 0;
      }
      const civilians = c.civilians;
      // From here they're flown (or bussed) out of the city.
      base.population += c.civilians;
      const caught = screenAtGate(s, base, c.infected);
      if (caught > 0) parts.push(`${caught} bitten caught at the quarantine checkpoint`);
      if (c.tired > 0) mergeTroops(base, c.tired, c.tiredFatigue, 0.6, 0);
      base.scientists += c.scientists;
      s.stats.civiliansEvacuated += c.civilians + c.infected;
      s.stats.scientistsEvacuated += c.scientists;
      s.stats.troopsRelieved += c.tired;
      c.civilians = c.infected = c.tired = c.tiredFatigue = c.scientists = 0;
      c.pilots = [];
      emit(base.id, 'info', `${parts.join(', ')} brought in to ${base.name}.`, true);
      maybeRecruit(s, civilians, emit);
      return true;
    }
    case 'refuel': {
      const take = Math.min(cmd.litres, fuelStock(s, cmd.source));
      if ('farp' in cmd.source) s.farps.find((f) => f.id === (cmd.source as { farp: number }).farp)!.fuel -= take;
      else if ('army' in cmd.source) s.army.fuel -= take;
      else s.districts[cmd.source.district].fuel -= take;
      return true;
    }
    case 'hookBladder': {
      const d = s.districts[cmd.district];
      d.fuel -= bladderLitres(s);
      c.sling = bladderLitres(s);
      return true;
    }
    case 'releaseBladder': {
      const d = s.districts[cmd.district];
      const farp = s.farps.find((f) => f.id === cmd.farp);
      if (farp) farp.fuel += c.sling;
      else d.fuel += c.sling;
      emit(d.id, 'info', `${c.sling.toLocaleString('en-US')} litres of fuel delivered to ${farp ? `the refuelling point in ${d.name}` : d.name}.`, true);
      c.sling = 0;
      return true;
    }
    case 'burstBladder':
      emit(cmd.district >= 0 ? cmd.district : null, 'warn', 'A fuel bladder burst on impact. The fuel is lost.');
      c.sling = 0;
      return true;
    case 'setupFarp': {
      const d = s.districts[cmd.district];
      const farp: Farp = { id: ++s.farpSeq, district: d.id, x: cmd.x, z: cmd.z, fuel: c.sling };
      s.farps.push(farp);
      mergeTroops(d, FARP_GUARDS, c.troopFatigue, 0.95, FARP_GUARDS * ROUNDS_PER_TROOP);
      c.troops -= FARP_GUARDS;
      if (c.troops === 0) c.troopFatigue = 0;
      c.sling = 0;
      emit(d.id, 'info', `Forward refuelling point set up in ${d.name}, guarded by ${FARP_GUARDS} troops.`, true);
      return true;
    }
    case 'abandon': {
      const d = s.districts[cmd.district];
      if (d) {
        d.population += c.civilians;
        if (d.kind === 'airbase') screenAtGate(s, d, c.infected);
        else d.infected += c.infected;
        d.scientists += c.scientists;
        if (c.troops + c.tired > 0) mergeTroops(d, c.troops + c.tired, (c.troopFatigue * c.troops + c.tiredFatigue * c.tired) / (c.troops + c.tired), 0.7, c.troops * ROUNDS_PER_TROOP);
        for (const kind of c.crates) {
          if (kind === 'rations') d.rations += CRATES.rations.amount;
          else if (kind === 'medicine') d.medicine += CRATES.medicine.amount;
          else d.troops.ammo += CRATES.ammo.amount;
        }
        d.fuel += c.sling;
      }
      // Rescued pilots aboard wait with everyone else.
      for (const id of c.pilots) {
        const p = s.pilots.find((x) => x.id === id);
        if (p && d) {
          p.status = 'stranded';
          p.district = d.id;
        }
      }
      s.cargo = emptyCargo();
      emit(d ? d.id : null, 'warn', `Helicopter abandoned${d ? ` in ${d.name}` : ''} out of fuel. The crew has been recovered.`);
      replaceHelicopter(s, emit);
      return true;
    }
    case 'crash': {
      const aboard = seatsUsed(c);
      s.stats.lostInCrashes += aboard;
      for (const id of c.pilots) {
        const p = s.pilots.find((x) => x.id === id);
        if (p) p.status = 'dead';
      }
      const where = s.districts[cmd.district]?.name;
      s.cargo = emptyCargo();
      emit(cmd.district >= 0 ? cmd.district : null, 'critical',
        `Helicopter down${where ? ` over ${where}` : ''}${aboard ? ` with ${aboard} aboard` : ''}.`);
      replaceHelicopter(s, emit);
      return true;
    }
    case 'freePlay':
      s.flags.freePlay = true;
      emit(null, 'info', 'Flying on. The city runs on without a deadline.');
      return true;
  }
}

function siteOf(s: CityState, id: number): Site | undefined {
  return s.sites.find((x) => x.id === id);
}

export function siteStock(site: Site, kind: CrateKind): number {
  return kind === 'rations' ? site.rations : kind === 'medicine' ? site.medicine : site.ammo;
}

function takeSiteStock(site: Site, kind: CrateKind, amount: number): void {
  if (kind === 'rations') site.rations -= amount;
  else if (kind === 'medicine') site.medicine -= amount;
  else site.ammo -= amount;
}

function baseStock(base: DistrictState, kind: CrateKind): number {
  return kind === 'rations' ? base.rations : kind === 'medicine' ? base.medicine : base.troops.ammo;
}

function takeBaseStock(base: DistrictState, kind: CrateKind, amount: number): void {
  if (kind === 'rations') base.rations -= amount;
  else if (kind === 'medicine') base.medicine -= amount;
  else base.troops.ammo -= amount;
}

/** The AI pilot order that answers a request (one trip). */
export function requestOrder(r: Request): Order {
  const kind: JobKind = r.kind === 'supply' ? 'resupply' : r.kind === 'reinforce' ? 'reinforce' : 'evacuate';
  return { kind, district: r.district, crate: r.crate ?? 'rations', repeat: false };
}

/** Which crate aboard a drop would deliver (its index), or null if none can go there. */
export function crateToDrop(s: CityState, cmd: { district: number; site?: number; kind?: CrateKind }): number | null {
  const site = cmd.site === undefined ? undefined : siteOf(s, cmd.site);
  if (cmd.site !== undefined && !site) return null;
  const i = s.cargo.crates.findIndex((k) => (cmd.kind === undefined || k === cmd.kind) && deliveryPlace(s, k, cmd.district, site).ok);
  return i < 0 ? null : i;
}
