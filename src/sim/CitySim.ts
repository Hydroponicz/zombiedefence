// The abstract city simulation. One tick = one game minute. Every rate below is written per
// game hour and multiplied by H. The simulation is deterministic for a given seed: all
// randomness comes from the RNG state stored inside CityState.

import { dayNumber, isDaytime, START_MINUTE } from './clock';
import { DISTRICT_TEMPLATES, neighborsOf } from './layout';
import { applyCommand, baseOf, emptyCargo, mergeTroops, type PlayerCommand } from './operations';
import { applyHordeLosses, countHordes, formHordes, moveHordes, totalZombies } from './hordes';
import { initialFleet, payday, updatePilots } from './pilots';
import { createSites, siteHolds, updateSites } from './sites';
import { createSupply, updateSupply } from './supply';
import { baseSealed, checkSeal, isBase } from './quarantine';
import { hashSeed, nextRandom } from './rng';
import type { CityState, DistrictState, Severity, SimEvent } from './types';

const H = 1 / 60;
const LOG_LIMIT = 200;

const clamp = (v: number, lo = 0, hi = 1) => (v < lo ? lo : v > hi ? hi : v);

export const TUNING = {
  /** Encounters per free zombie per hour, by day and by night. */
  biteRateDay: 0.08,
  biteRateNight: 0.14,
  /** Average hours from bite to turning. */
  turnHours: 4,
  /** Kills per effective soldier per hour when fully engaged. */
  soldierKillRate: 2,
  /**
   * Zombie count at which soldiers find targets at half their full rate (zombies are spread out
   * across the district). Grows with population: more people to search through.
   */
  huntHalfSaturation: 700,
  huntPerCivilian: 0.02,
  /** Zombies a single effective soldier can screen civilians from. */
  soldierScreen: 15,
  /** Civilians one effective soldier can cover. */
  soldierCoverage: 250,
  /** Soldier casualties per zombie per hour (before effectiveness). */
  troopLossRate: 0.012,
  roundsPerKill: 6,
  roundsPerSoldier: 300,
  zombieWanderRate: 0.01,
  /** Rations each district starts with, in days. */
  startingRationDays: 2,
  warehouseDays: 1.5,
  /** Truck deliveries per hour, as a share of daily need, divided by grid distance from the warehouse. */
  truckRate: 0.08,
  /** Grid decay per hour from staff not turning up (scaled by city disorder). */
  gridDecay: 0.0045,
  /** Extra decay per hour from maintenance backlog, from day 3. */
  gridBacklog: 0.0015,
  outbreakStartInfected: 25,
  /** Police officers per resident, and riot police per district with a police station. */
  officersPerResident: 1 / 900,
  riotPolice: 12,
  riotPoliceDowntown: 40,
  /** Kills per officer and riot officer relative to a soldier (pistols and batons against rifles). */
  officerKillShare: 0.25,
  riotKillShare: 0.15,
  /** Police morale lost per day of the outbreak (families at home, no relief coming). */
  policeMoraleDecay: 0.08,
  /** Daily supply flight into the base from outside the city, at 07:00. */
  supplyFlightMinute: 7 * 60,
  supplyFlightTroops: 60,
  supplyFlightRations: 8000,
  supplyFlightMedicine: 2000,
  supplyFlightAmmo: 30000,
  /** Research points per scientist at the base per game hour. */
  researchPerScientist: 1,
  /** Litres per hour a defended fuel depot trucks to the base. */
  convoyLitres: 600,
  /** Troops a depot needs to keep its convoys running. */
  convoyGuards: 15,
};

export class CitySim {
  state: CityState;
  private pending: SimEvent[] = [];

  constructor(seedOrState: number | string | CityState) {
    this.state = typeof seedOrState === 'object' ? seedOrState : createCity(seedOrState);
  }

  step(ticks = 1): void {
    for (let i = 0; i < ticks; i++) tick(this.state, this.pending);
  }

  /** A player action (loading, deploying, boarding...). Returns whether it happened. */
  command(cmd: PlayerCommand): boolean {
    return applyCommand(this.state, cmd, makeEmit(this.state, this.pending));
  }

  /** Rotor noise from the player's helicopter hovering low over a district. */
  addPlayerNoise(district: number, amount: number): void {
    const d = this.state.districts[district];
    if (d) d.playerNoise = clamp(d.playerNoise + amount, 0, 3);
  }

  /** Events produced since the last call. */
  takeEvents(): SimEvent[] {
    const out = this.pending;
    this.pending = [];
    return out;
  }
}

export function createCity(seed: number | string): CityState {
  const state: CityState = {
    seed,
    t: START_MINUTE,
    rng: hashSeed(seed),
    grid: 1,
    districts: [],
    history: [],
    log: [],
    eventSeq: 0,
    collapsed: false,
    collapsedAt: null,
    flags: {},
    cargo: emptyCargo(),
    farps: [],
    farpSeq: 0,
    research: 0,
    stats: { civiliansEvacuated: 0, scientistsEvacuated: 0, troopsDeployed: 0, troopsRelieved: 0, cratesDelivered: 0, lostInCrashes: 0,
      pilotsRecruited: 0, aiTrips: 0 },
    pilots: [],
    airframes: [],
    hordes: [],
    hordeSeq: 0,
    sites: [],
    supply: createSupply(),
    pilotSeq: 0,
    airframeSeq: 0,
  };
  const rand = () => nextRandom(state);
  const totalPop = DISTRICT_TEMPLATES.reduce((s, d) => s + d.population, 0);

  state.districts = DISTRICT_TEMPLATES.map((tpl, id) => {
    const people = tpl.population + tpl.troops;
    const d: DistrictState = {
      id,
      name: tpl.name,
      kind: tpl.kind,
      col: tpl.col,
      row: tpl.row,
      neighbors: neighborsOf(id),
      features: tpl.features,
      population: tpl.population,
      infected: 0,
      zombies: 0,
      dead: 0,
      troops: { strength: tpl.troops, fatigue: 0, morale: 0.85, ammo: tpl.troops * TUNING.roundsPerSoldier },
      police: tpl.kind === 'airbase'
        ? { officers: 0, riot: 0, morale: 0 }
        : {
          officers: Math.round(tpl.population * TUNING.officersPerResident),
          riot: tpl.kind === 'downtown' ? TUNING.riotPoliceDowntown : tpl.kind === 'industrial' ? 0 : TUNING.riotPolice,
          morale: 0.85,
        },
      rations: tpl.rations ?? people * TUNING.startingRationDays * (0.75 + rand() * 0.5),
      medicine: tpl.medicine ?? people * 0.05,
      // Districts without a depot still have a little at petrol stations.
      fuel: tpl.fuel ?? 3000,
      power: 'on',
      powerThreshold: tpl.powerThreshold ?? 0.35 + rand() * 0.45,
      order: 80,
      rioting: false,
      status: 'held',
      noise: 0,
      killRate: 0,
      playerNoise: 0,
      burning: 0,
      scientists: tpl.scientists ?? 0,
      salvage: tpl.salvage ?? 0,
      hordeZombies: 0,
      sheltered: 0,
      outposts: 0,
      flags: {},
      cooldowns: {},
    };
    if (tpl.features.warehouse) d.rations += totalPop * TUNING.warehouseDays;
    if (tpl.kind === 'airbase') d.troops.ammo += 500000; // armoury
    return d;
  });

  // Patient zero: a random populated district that isn't the base.
  const candidates = state.districts.filter((d) => d.kind !== 'airbase' && d.population > 5000);
  const first = candidates[Math.floor(rand() * candidates.length)];
  first.infected = TUNING.outbreakStartInfected;
  first.population -= TUNING.outbreakStartInfected;

  createSites(state);
  initialFleet(state);
  sampleHistory(state);
  return state;
}

function tick(s: CityState, out: SimEvent[]): void {
  const t = s.t;
  const day = dayNumber(t);
  const night = !isDaytime(t);
  const hourly = Math.floor(t) % 60 === 0;
  const ds = s.districts;
  const emit = makeEmit(s, out);

  if (Math.floor(t) % 1440 === 360) {
    emit(null, 'info', `Day ${day} begins.`);
    payday(s, emit);
  }
  if (Math.floor(t) % 1440 === TUNING.supplyFlightMinute) supplyFlight(s, emit);

  if (hourly) spontaneousOutbreaks(s, day, emit);
  updatePower(s, day, night, emit);

  countHordes(s);
  for (const d of ds) applyHordeLosses(s, d.id, updateDistrict(s, d, day, night, emit));

  migrate(s, night);
  updateSupply(s, hourly, emit);
  if (hourly) fuelConvoys(s, emit);
  if (hourly) formHordes(s, emit);
  if (hourly) updateSites(s, night, emit, (d) => effectiveness(d, night));
  moveHordes(s, night, emit);
  countHordes(s);
  for (const d of ds) updateStatus(d, emit);
  if (checkSeal(s)) {
    const base = baseOf(s);
    emit(base.id, 'critical', `Every district has fallen. The dead are at the gates of ${base.name}.`);
  }
  loseFarps(s, emit);
  updatePilots(s, emit);

  const base = baseOf(s);
  s.research += base.scientists * TUNING.researchPerScientist * H;
  if (!s.collapsed && base.status === 'overrun') {
    s.collapsed = true;
    s.collapsedAt = t;
    emit(base.id, 'critical', `${base.name} has fallen. The city has collapsed.`);
  }

  s.t = t + 1;
  if (hourly) sampleHistory(s);
}

type Emit = (district: number | null, severity: Severity, text: string, radio?: boolean) => void;

function makeEmit(s: CityState, out: SimEvent[]): Emit {
  return (district, severity, text, radio) => {
    const e: SimEvent = { id: ++s.eventSeq, t: s.t, district, severity, text, ...(radio ? { radio } : {}) };
    out.push(e);
    s.log.push(e);
    if (s.log.length > LOG_LIMIT) s.log.shift();
  };
}

/** Defended depots truck fuel to the base. Convoys stop when a depot riots, falls or loses its guards. */
function fuelConvoys(s: CityState, emit: Emit): void {
  const base = baseOf(s);
  if (base.status === 'overrun') return;
  for (const d of s.districts) {
    if (!d.features.fuelDepot || d === base) continue;
    // The industrial park's fuel goes out through its terminal.
    const terminal = d.kind !== 'industrial' || siteHolds(s, 'fuelTerminal');
    const running = terminal && d.status !== 'overrun' && !d.rioting && d.troops.strength >= TUNING.convoyGuards && d.fuel > 0;
    const key = 'convoyStopped';
    if (running) {
      const litres = Math.min(TUNING.convoyLitres, d.fuel);
      d.fuel -= litres;
      base.fuel += litres;
      if (d.flags[key]) {
        d.flags[key] = false;
        emit(d.id, 'info', `Fuel convoys from ${d.name} are running again.`);
      }
    } else if (!d.flags[key]) {
      d.flags[key] = true;
      emit(d.id, 'warn', `Fuel convoys from ${d.name} have stopped.`);
    }
  }
}

/** A forward refuelling point is lost when its district is overrun. */
function loseFarps(s: CityState, emit: Emit): void {
  s.farps = s.farps.filter((f) => {
    const d = s.districts[f.district];
    if (d.status !== 'overrun') return true;
    emit(d.id, 'critical', `The forward refuelling point in ${d.name} has been overrun.`);
    return false;
  });
}

/** Fresh soldiers and supplies flown in from outside, while the base holds. */
function supplyFlight(s: CityState, emit: Emit): void {
  const base = baseOf(s);
  if (base.status === 'overrun') return;
  mergeTroops(base, TUNING.supplyFlightTroops, 0, 0.9, TUNING.supplyFlightTroops * 300 + TUNING.supplyFlightAmmo);
  base.rations += TUNING.supplyFlightRations;
  base.medicine += TUNING.supplyFlightMedicine;
  emit(base.id, 'info', `Supply flight landed at ${base.name}: ${TUNING.supplyFlightTroops} fresh troops, food, medicine and ammunition.`);
}

function spontaneousOutbreaks(s: CityState, day: number, emit: Emit): void {
  if (day > 3 || nextRandom(s) > 0.03) return;
  const options = s.districts.filter((d) => d.kind !== 'airbase' && d.population > 1000 && d.zombies < 5);
  if (!options.length) return;
  const d = options[Math.floor(nextRandom(s) * options.length)];
  const n = Math.min(d.population, 5 + Math.floor(nextRandom(s) * 15));
  d.population -= n;
  d.infected += n;
  if (d.flags.outbreak) emit(d.id, 'warn', `New infections reported in ${d.name}.`);
}

function updatePower(s: CityState, day: number, night: boolean, emit: Emit): void {
  const ds = s.districts;
  let weight = 0;
  let orderSum = 0;
  for (const d of ds) {
    if (d.status === 'overrun') continue;
    weight += d.population;
    orderSum += d.order * d.population;
  }
  const cityOrder = weight > 0 ? orderSum / weight : 0;
  const before = s.grid;
  let decay = TUNING.gridDecay * (1 - cityOrder / 100) + (day >= 3 ? TUNING.gridBacklog : 0);
  for (const d of ds) if (d.features.substation && d.rioting) decay += 0.003;
  s.grid = clamp(s.grid - decay * H);

  let cap = 1;
  for (const d of ds) {
    if (d.features.substation && d.status === 'overrun') cap -= 0.1;
    if (d.features.powerPlant && d.status === 'overrun') cap -= 0.45;
  }
  s.grid = Math.min(s.grid, clamp(cap));

  for (const mark of [0.75, 0.5, 0.25]) {
    if (before >= mark && s.grid < mark) {
      emit(null, mark > 0.5 ? 'warn' : 'critical', `City power grid down to ${Math.round(mark * 100)}%.`);
    }
  }

  for (const d of ds) {
    const prev = d.power;
    const gridOk = s.grid >= d.powerThreshold && !(d.features.substation && d.status === 'overrun');
    if (gridOk) d.power = 'on';
    else if (d.features.generator && d.fuel > 0) d.power = 'backup';
    else d.power = 'dark';

    if (d.power === 'backup') d.fuel = Math.max(0, d.fuel - (d.features.generator ?? 0) * H);

    if (prev !== d.power) {
      if (d.power === 'backup') emit(d.id, 'warn', `${d.name} has lost grid power and is running on generators.`);
      else if (d.power === 'dark') {
        const why = prev === 'backup' ? 'Generators are out of fuel. ' : '';
        emit(d.id, night ? 'critical' : 'warn', `${why}${d.name} has gone dark.`);
      } else emit(d.id, 'info', `Power restored in ${d.name}.`);
    }
  }
}

/** How well the police fight: morale, light and riots; they have no ammunition problem to speak of. */
function policeEffectiveness(d: DistrictState, night: boolean): number {
  const light = night ? (d.power === 'dark' ? 0.6 : 0.85) : 1;
  return (0.35 + 0.65 * d.police.morale) * light * (d.rioting ? 0.8 : 1);
}

function effectiveness(d: DistrictState, night: boolean): number {
  const tr = d.troops;
  if (tr.strength < 0.5) return 0;
  const ammoF = clamp(tr.ammo / Math.max(1, tr.strength * 60), 0.1, 1);
  const light = night ? (d.power === 'dark' ? 0.6 : 0.85) : 1;
  return ammoF * (1 - 0.6 * tr.fatigue) * (0.35 + 0.65 * tr.morale) * light * (d.rioting ? 0.6 : 1);
}

/** Returns the zombies killed out of hordes in the district, for applyHordeLosses. */
function updateDistrict(s: CityState, d: DistrictState, day: number, night: boolean, emit: Emit): number {
  const tr = d.troops;
  const P = d.population;
  const T = tr.strength;
  // Residents and any hordes passing through fight as one.
  const Z = totalZombies(d);
  const e = effectiveness(d, night);
  const fort = d.features.fortified ? 2 : 1;
  const pol = d.police;
  const O = pol.officers;
  const R = pol.riot;
  const pe = O + R > 0 ? policeEffectiveness(d, night) : 0;

  // --- Outbreak and combat ---
  // Soldiers and police only protect the part of the district they can cover. Officers patrol
  // widely; riot police hold a tight shield line.
  const strength = (T * e * fort + (O * 0.3 + R * 0.45) * pe) * TUNING.soldierScreen;
  const coverage = clamp(((T * e * fort + (O * 0.35 + R * 0.25) * pe) * TUNING.soldierCoverage) / Math.max(1, P));
  const screen = T + O + R > 0 ? coverage * (strength / (strength + Z + 1)) : 0;
  const freeZ = Z * (1 - 0.85 * screen);
  const biteRate = night ? TUNING.biteRateNight : TUNING.biteRateDay;
  const crowd = (d.rioting ? 1.5 : 1) * (d.power === 'dark' ? 1.2 : 1);
  // In an overrun district the survivors left are barricaded holdouts.
  const exposure = d.status === 'overrun' ? 0.08 : 1;
  // Civilians inside held shelters are mostly out of reach.
  const sheltered = P > 0 ? Math.min(d.sheltered, P) / P : 0;
  const encounters = Math.min(P * 0.5, biteRate * crowd * exposure * (1 - 0.9 * sheltered) * freeZ * (P / (P + T + 10)) * H);
  const bitten = encounters * 0.75;
  let civDeaths = encounters * 0.1;
  const civKills = Math.min(Z, encounters * 0.15);

  // Soldiers kill far better than the police: rifles and training against pistols and batons.
  const policePower = (O * TUNING.officerKillShare + R * TUNING.riotKillShare) * pe;
  const killers = T * e + policePower;
  const fighterKills = Math.min(
    Z - civKills,
    killers * TUNING.soldierKillRate * H * (Z / (Z + TUNING.huntHalfSaturation + P * TUNING.huntPerCivilian)),
  );
  const soldierKills = killers > 0 ? fighterKills * ((T * e) / killers) : 0;
  const troopLoss = T > 0 ? Math.min(T * 0.2, Z * TUNING.troopLossRate * (1 - 0.7 * e) * H / fort) : 0;
  // Police take worse losses than soldiers (no armour but the riot squads'), shared by who's out there.
  const policeLoss = O + R > 0
    ? Math.min((O + R) * 0.2, Z * TUNING.troopLossRate * 1.5 * (1 - 0.5 * pe) * H * ((O + R) / (T + O + R)))
    : 0;
  const officerLoss = policeLoss * (O / (O + 0.6 * R + 1e-9));
  const riotLoss = Math.min(R, policeLoss - officerLoss);

  const medicineShort = d.medicine <= 0;
  if (medicineShort) civDeaths += encounters * 0.1;

  // Scientists share the civilians' risk.
  if (d.scientists > 0 && P > 0) {
    const before = d.scientists;
    d.scientists = Math.max(0, d.scientists * (1 - (bitten + civDeaths) / P));
    if (before >= 1 && d.scientists < 1) {
      d.scientists = 0;
      emit(d.id, 'critical', `The research team in ${d.name} has been lost.`);
    }
  }
  d.population = Math.max(0, P - bitten - civDeaths);
  d.infected += bitten + (troopLoss + policeLoss) * 0.5;
  d.dead += civDeaths + (troopLoss + policeLoss) * 0.5 + civKills + fighterKills;
  pol.officers = Math.max(0, O - officerLoss);
  pol.riot = Math.max(0, R - riotLoss);
  const kills = civKills + fighterKills;
  const residentShare = Z > 0 ? d.zombies / Z : 1;
  const hordeLosses = kills * (1 - residentShare);
  d.zombies = Math.max(0, d.zombies - kills * residentShare);
  tr.strength = Math.max(0, T - troopLoss);
  tr.ammo = Math.max(0, tr.ammo - soldierKills * TUNING.roundsPerKill);
  if (tr.strength < 0.5) {
    tr.strength = 0;
  }

  const turned = d.infected * (H / TUNING.turnHours);
  d.infected -= turned;
  d.zombies += turned;

  d.killRate = d.killRate * 0.95 + (kills / H) * 0.05;
  d.noise = d.noise * 0.9 + clamp(d.killRate / 50, 0, 2) * 0.1;
  d.playerNoise *= 0.97;
  d.burning = Math.max(0, d.burning - 1);

  if (!d.flags.outbreak && totalZombies(d) > 15) {
    d.flags.outbreak = true;
    emit(d.id, 'warn', `Outbreak confirmed in ${d.name}.`);
  }

  // --- Supplies ---
  const people = d.population + tr.strength + d.infected;
  const fear = 1 - d.order / 100;
  const hoarding = day <= 4 ? 1 + 0.8 * fear : 1;
  // Pumps stop without power; with the waterworks lost the taps run dry everywhere.
  const thirst = !siteHolds(s, 'waterworks');
  const water = (d.power === 'dark' ? 1.3 : 1) * (thirst ? 1.25 : 1);
  d.rations = Math.max(0, d.rations - (people / 1440) * hoarding * water);
  d.medicine = Math.max(0, d.medicine - encounters * 0.5 - (people / 1440) * 0.02);
  if (Math.floor(s.t) % 60 === 0) {
    // Food comes in by truck (see supply.ts); without it people scavenge, finding less each day.
    const scavenged = d.rations <= 0 ? Math.max(0.1, 0.5 - 0.03 * day) : 0;
    d.rations += (people * scavenged) / 24;
  }
  if (d.rioting) {
    d.rations *= 1 - 0.03 * H;
    d.medicine *= 1 - 0.03 * H;
    d.fuel *= 1 - 0.02 * H;
    if (d.features.fuelDepot && Math.floor(s.t) % 60 === 0 && nextRandom(s) < 0.03 && d.fuel > 1000) {
      d.fuel *= 0.7;
      d.noise = 2;
      d.burning = 360;
      emit(d.id, 'critical', `Fuel depot fire in ${d.name}. The blaze is drawing the dead.`);
    }
  }
  if (d.rations <= 0) {
    const starving = d.population * 0.0004 * H;
    d.population -= starving;
    d.dead += starving;
  }
  const supplyDays = d.rations / Math.max(1, people);
  const shortage = clamp((1.5 - supplyDays) / 1.5);
  if (people > 200) {
    if (!d.flags.foodLow && supplyDays < 0.5) {
      d.flags.foodLow = true;
      emit(d.id, 'warn', `${d.name} is running low on food and water.`);
    }
    if (!d.flags.foodOut && d.rations <= 0) {
      d.flags.foodOut = true;
      emit(d.id, 'critical', `${d.name} has run out of food.`);
    }
  }

  // --- Social order ---
  const threat = clamp(totalZombies(d) / (d.population * 0.01 + tr.strength * 2 + 20));
  let neighborThreat = 0;
  for (const n of d.neighbors) {
    const st = s.districts[n].status;
    neighborThreat = Math.max(neighborThreat, st === 'overrun' ? 0.5 : st === 'contested' ? 0.25 : 0);
  }
  const fearNow = clamp(threat + neighborThreat * 0.6);
  // Riot police are what keep order: a shield line breaks up a riot far better than rifles do.
  const security = clamp((tr.strength + pol.officers * 0.8 * pe + pol.riot * 3 * pe) / Math.max(1, d.population / 400));
  const quell = d.rioting ? Math.min(20, pol.riot * pe * 0.8) : 0;
  const dread = Math.min(15, (day - 1) * 2);
  const dark = d.power === 'dark' ? (night ? 18 : 10) : 0;
  // Guarded police stations, shelters and food points steady people.
  const outposts = Math.min(10, d.outposts * 3);
  const target = clamp(
    85 - 25 * shortage - 30 * fearNow - dark - dread + 15 * security + outposts + quell - (medicineShort ? 5 : 0) -
      (thirst ? 5 : 0),
    0,
    100,
  );
  // A shield line restores order faster than it would come back on its own.
  const rate = target < d.order ? 4 : 2 + quell * 0.2;
  d.order += clamp(target - d.order, -rate * H, rate * H);

  if (!d.rioting && d.order < 25 && d.population > 500) {
    d.rioting = true;
    emit(d.id, 'critical', `Riots have broken out in ${d.name}.`);
  } else if (d.rioting && (d.order > 35 || d.population <= 500)) {
    d.rioting = false;
    emit(d.id, 'info', `Rioting in ${d.name} has died down.`);
  }
  if (!d.flags.anarchy && d.order < 10 && d.population > 500) {
    d.flags.anarchy = true;
    emit(d.id, 'critical', `Civil order has collapsed in ${d.name}. People are fleeing.`);
  }

  // --- Police ---
  updatePolice(d, day, night, fearNow, policeLoss, emit);

  // --- Military ---
  if (tr.strength > 0) {
    const engaged = totalZombies(d) > 5;
    // Heavy fighting exhausts troops in about a day; patrolling an infected district takes about two weeks.
    const intensity = clamp(totalZombies(d) / (tr.strength * 8 + 200));
    const strain = (0.04 * intensity + (d.flags.outbreak ? 0.003 : 0)) * (night ? 1.3 : 1);
    tr.fatigue = clamp(tr.fatigue + (intensity < 0.05 ? -0.01 : strain) * H);
    const lossFrac = troopLoss / H / tr.strength;
    const ammoF = tr.ammo / Math.max(1, tr.strength * 60);
    const moraleTarget = clamp(
      0.85 - 0.45 * tr.fatigue - Math.min(0.3, lossFrac * 6) - (d.rioting ? 0.1 : 0) -
        (ammoF < 0.5 ? 0.2 : 0) - (night && d.power === 'dark' ? 0.1 : 0),
    );
    tr.morale += clamp(moraleTarget - tr.morale, -0.1 * H, 0.1 * H);
    if (!d.flags.tired && tr.fatigue > 0.7) {
      d.flags.tired = true;
      emit(d.id, 'warn', `Troops in ${d.name} are exhausted and need relief.`);
    }
    if (tr.morale < 0.12 && engaged && s.t - (d.cooldowns.rout ?? -Infinity) > 360) rout(s, d, emit);
  }
  return hordeLosses;
}

/**
 * Police morale wears down day by day, with losses, riots and darkness; below about a third
 * officers start walking off the job, back to their families (they become civilians).
 */
function updatePolice(d: DistrictState, day: number, night: boolean, fear: number, lost: number, emit: Emit): void {
  const pol = d.police;
  const total = pol.officers + pol.riot;
  if (total < 0.5) {
    pol.officers = 0;
    pol.riot = 0;
    return;
  }
  const lossFrac = lost / H / total;
  const target = clamp(
    0.85 - TUNING.policeMoraleDecay * (day - 1) - Math.min(0.3, lossFrac * 6) - 0.25 * fear -
      (d.rioting ? 0.1 : 0) - (night && d.power === 'dark' ? 0.1 : 0),
  );
  pol.morale += clamp(target - pol.morale, -0.1 * H, 0.05 * H);
  if (pol.morale < 0.35) {
    const rate = (0.35 - pol.morale) * 0.3 * H;
    const officers = pol.officers * rate;
    const riot = pol.riot * rate * 0.5;
    pol.officers -= officers;
    pol.riot -= riot;
    d.population += officers + riot;
    if (!d.flags.policeLeaving && total >= 5) {
      d.flags.policeLeaving = true;
      emit(d.id, 'warn', `Police officers in ${d.name} are walking off the job.`);
    }
  }
  if (!d.flags.policeGone && pol.officers + pol.riot < 1 && total >= 1) {
    d.flags.policeGone = true;
    pol.officers = 0;
    pol.riot = 0;
    emit(d.id, 'critical', `The police in ${d.name} are gone.`);
  }
}

function safety(d: DistrictState): number {
  const statusPenalty = d.status === 'overrun' ? 2 : d.status === 'contested' ? 0.5 : 0;
  return d.order / 100 - clamp(totalZombies(d) / (d.population * 0.01 + d.troops.strength * 2 + 20)) - statusPenalty;
}

function safestNeighbor(s: CityState, d: DistrictState): DistrictState | null {
  let best: DistrictState | null = null;
  for (const n of d.neighbors) {
    const c = s.districts[n];
    if (c.status === 'overrun') continue;
    if (!best || safety(c) > safety(best)) best = c;
  }
  return best;
}

function rout(s: CityState, d: DistrictState, emit: Emit): void {
  const to = safestNeighbor(s, d);
  const tr = d.troops;
  if (!to || safety(to) <= safety(d)) return;
  d.cooldowns.rout = s.t;
  to.cooldowns.rout = s.t;
  const moving = tr.strength * 0.7;
  const survivors = moving * 0.7;
  const ammo = tr.ammo * 0.7 * 0.7;
  mergeTroops(to, survivors, tr.fatigue, 0.4, ammo);
  d.dead += moving - survivors;
  tr.strength -= moving;
  tr.ammo -= tr.ammo * 0.7;
  tr.morale = 0.3;
  emit(d.id, 'critical', `Troops in ${d.name} have broken and are falling back to ${to.name}.`);
}

function migrate(s: CityState, night: boolean): void {
  const ds = s.districts;
  const dz = new Float64Array(ds.length);
  const dp = new Float64Array(ds.length);
  const di = new Float64Array(ds.length);

  const hospital = ds.find((d) => d.features.hospital && d.status !== 'overrun');
  // Until the city has fallen, the base's perimeter keeps the dead and the bitten out.
  const sealed = baseSealed(s);
  const shut = (d: DistrictState) => sealed && isBase(d);

  for (const d of ds) {
    // Zombies wander toward people, light and noise. Hordes move on once prey runs out.
    const humans = d.population + d.troops.strength;
    if (d.zombies > 1) {
      // Residents drift; the big movements are hordes (see hordes.ts).
      let rate = TUNING.zombieWanderRate;
      if (humans / (d.zombies + 1) > 0.2) rate *= 0.3;
      // A helicopter hovering low keeps the local dead busy.
      rate /= 1 + d.playerNoise;
      const outflow = d.zombies * rate * H;
      let total = 0;
      const pull = d.neighbors.map((n) => {
        const c = ds[n];
        if (shut(c)) return 0;
        const a = Math.sqrt(c.population + c.troops.strength + 1) * (night && c.power !== 'dark' ? 1.6 : 1) * (1 + c.noise + c.playerNoise);
        total += a;
        return a;
      });
      if (total > 0) {
        d.neighbors.forEach((n, i) => {
          dz[n] += (outflow * pull[i]) / total;
        });
        dz[d.id] -= outflow;
      }
    }

    // Civilians flee from danger or collapse. The bitten hide among them.
    if (d.population > 10) {
      const threat = clamp(totalZombies(d) / (d.population * 0.01 + d.troops.strength * 2 + 20));
      let rate = d.status === 'overrun' ? 0.15 : d.order < 10 ? 0.06 : clamp((threat - 0.4) * 0.05, 0, 0.04);
      const to = rate > 0 ? safestNeighbor(s, d) : null;
      if (to && safety(to) > safety(d)) {
        const p = d.population * rate * H;
        const inf = d.infected * rate * H;
        dp[d.id] -= p;
        dp[to.id] += p * 0.97;
        if (shut(to)) {
          // Refugees at the base gate: the healthy are let in, the bitten turned back.
          dp[to.id] += p * 0.03;
        } else {
          di[d.id] -= inf;
          di[to.id] += inf + p * 0.03;
        }
      } else rate = 0;
    }

    // The bitten seek treatment, turning the hospital into a hot spot.
    if (hospital && d !== hospital && d.infected > 1) {
      const moving = d.infected * 0.015 * H;
      di[d.id] -= moving;
      di[hospital.id] += moving;
    }
  }

  ds.forEach((d, i) => {
    d.zombies = Math.max(0, d.zombies + dz[i]);
    d.population = Math.max(0, d.population + dp[i]);
    d.infected = Math.max(0, d.infected + di[i]);
  });
}

function updateStatus(d: DistrictState, emit: Emit): void {
  const humans = d.population + d.troops.strength;
  const defense = d.troops.strength * 0.8 * TUNING.soldierScreen * (d.features.fortified ? 2 : 1) +
    (d.police.officers * 0.3 + d.police.riot * 0.4) * d.police.morale * TUNING.soldierScreen + d.population * 0.03;
  const zombies = totalZombies(d);
  const pressure = zombies / (defense + 1);
  const prev = d.status;
  if (prev === 'held') {
    if (humans < 50 && zombies > 20) d.status = 'overrun';
    else if (zombies > 30 && pressure > 0.2) d.status = 'contested';
  } else if (prev === 'contested') {
    if (pressure > 3 || (humans < 100 && zombies > 20)) d.status = 'overrun';
    else if (zombies < 15 || pressure < 0.05) d.status = 'held';
  } else if (humans > 200 && pressure < 1.5) {
    d.status = 'contested';
  }
  if (prev === d.status) return;
  if (d.status === 'overrun') emit(d.id, 'critical', `${d.name} has been overrun.`);
  else if (d.status === 'contested') {
    emit(d.id, 'warn', prev === 'held' ? `${d.name} is under attack.` : `Survivors are fighting back in ${d.name}.`);
  } else emit(d.id, 'info', `${d.name} is secure again.`);
}

function sampleHistory(s: CityState): void {
  let population = 0, infected = 0, zombies = 0, troops = 0, dead = 0;
  for (const d of s.districts) {
    population += d.population;
    infected += d.infected;
    zombies += totalZombies(d);
    troops += d.troops.strength;
    dead += d.dead;
  }
  s.history.push({ t: s.t, population, infected, zombies, troops, dead, grid: s.grid });
}
