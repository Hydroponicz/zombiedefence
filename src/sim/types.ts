import type { DistrictFeatures, DistrictKind } from './layout';

export type PowerState = 'on' | 'backup' | 'dark';
export type DistrictStatus = 'held' | 'contested' | 'overrun';
export type Severity = 'info' | 'warn' | 'critical';

export interface Troops {
  /** Number of soldiers. */
  strength: number;
  /** 0 fresh .. 1 exhausted. */
  fatigue: number;
  /** 0 broken .. 1 steady. */
  morale: number;
  /** Rounds of ammunition held by the district's troops. */
  ammo: number;
}

/**
 * The district's police: patrol officers with pistols, and riot police with shields and batons.
 * They hold the line in the first days, kill the dead far less well than soldiers, are what keeps
 * order in a riot, and go home to their families as the days wear on.
 */
/**
 * How the police are working the outbreak: routine patrols on foot and in cars; checkpoints at
 * intersections screening for the infected once it spreads; then supporting the military.
 */
export type PoliceStage = 'patrol' | 'checkpoints' | 'support';

export interface Police {
  officers: number;
  riot: number;
  /** 0 broken .. 1 steady. Officers start walking off the job below about a third. */
  morale: number;
  stage: PoliceStage;
  /** Days of hard duty worked (a quiet district's days count for less); wears morale down. */
  duty?: number;
  /**
   * Riot squads out on the street in their trucks: called out by a riot or by the infected
   * gathering in the district. Otherwise they're held in reserve at the station.
   */
  riotOut?: boolean;
}

export interface DistrictState {
  id: number;
  name: string;
  kind: DistrictKind;
  col: number;
  row: number;
  neighbors: number[];
  features: DistrictFeatures;

  population: number;
  infected: number;
  zombies: number;
  dead: number;
  troops: Troops;
  police: Police;

  /** Food and water, in person-days. */
  rations: number;
  /** Medical supplies, in person-days. */
  medicine: number;
  /** Litres. */
  fuel: number;

  power: PowerState;
  /** The district loses grid power when city grid integrity drops below this. */
  powerThreshold: number;
  /** 0 collapse .. 100 calm. */
  order: number;
  rioting: boolean;
  status: DistrictStatus;

  /** Combat noise 0..2. Attracts zombies from neighbouring districts. */
  noise: number;
  /** Zombie kills per game hour, smoothed. */
  killRate: number;
  /** Rotor noise from the player's helicopter, 0..3. Draws zombies in from neighbouring districts. */
  playerNoise: number;
  /** Game minutes a depot fire has left to burn. */
  burning: number;
  /** Researchers in the district (the lab, the hospital, and at base once evacuated). */
  scientists: number;
  /** Abandoned helicopters here that the player can salvage. */
  salvage: number;
  /** Zombies in hordes currently inside the district (recounted every tick). */
  hordeZombies: number;
  /** Civilians inside the district's standing shelters, a share of `population` (recounted hourly). */
  sheltered: number;
  /** Strategic sites still held and guarded: they steady the district (recounted hourly). */
  outposts: number;

  /** One-shot event flags. */
  flags: Record<string, boolean>;
  /** Game minute something last happened, for rate-limiting. */
  cooldowns: Record<string, number>;
}

/**
 * City sites: police stations, supermarkets, shelters, pharmacies. Industrial sites keep the city
 * supplied: the food distribution depot, the ration factory, the waterworks and the fuel terminal.
 */
export type SiteKind = 'police' | 'supermarket' | 'shelter' | 'pharmacy' | 'depot' | 'factory' | 'waterworks' | 'fuelTerminal';
export type SiteStatus = 'held' | 'besieged' | 'fallen';

/**
 * A building the military holds in a district: a police station (armoury), a supermarket (food),
 * a school or hall used as a shelter, or a pharmacy. Held sites hand out their stock to the district,
 * and shelters keep the civilians inside away from the dead.
 */
export interface Site {
  id: number;
  district: number;
  kind: SiteKind;
  name: string;
  /** Landing zone (parking lot or playing field) in world metres. */
  x: number;
  z: number;
  status: SiteStatus;
  /** Barricades and doors, 0..100. The site falls at 0. */
  integrity: number;
  /** Soldiers posted here (a share of the district's troops). */
  guards: number;
  /** Soldiers the player landed here; the military leaves them in place. */
  pinned: number;
  /** Civilians inside (a share of the district's population). */
  sheltered: number;
  capacity: number;
  rations: number;
  medicine: number;
  ammo: number;
  /** Looting has been reported, to report it once. */
  looted: boolean;
}

/** A roaming mass of the dead. Positions are world metres; it walks the street grid. */
export interface Horde {
  id: number;
  x: number;
  z: number;
  size: number;
  /** Direction of travel, radians (0 faces -Z, like the helicopter). */
  heading: number;
  /** District it is making for. */
  target: number;
  /** Next street corner. */
  ni: number;
  nj: number;
  /** Game minutes left attacking where it has arrived. */
  settle: number;
  /** Drawn by noise: moves twice as fast. */
  hunting: boolean;
  /** Game minute it was last announced on the radio. */
  announcedAt: number;
  /** Street corners it has walked through, oldest first (flattened i, j), for drawing its column. */
  trail?: number[];
}

export type CrateKind = 'rations' | 'ammo' | 'medicine';

/** What the player's helicopter is carrying. Lives in the simulation so it is the one source of truth. */
export interface Cargo {
  /** Fresh troops on their way to a district. */
  troops: number;
  troopFatigue: number;
  /** Evacuated civilians, and the bitten hiding among them (the player can't tell them apart). */
  civilians: number;
  infected: number;
  /** Exhausted soldiers being rotated out. */
  tired: number;
  tiredFatigue: number;
  scientists: number;
  crates: CrateKind[];
  /** Litres in a fuel bladder slung under the helicopter (0 = nothing on the hook). */
  sling: number;
  /** Rescued pilots aboard (by id); each takes a seat. */
  pilots: number[];
  /** The Joint Operations Command staff, on their way from Camp Ridgeway to the airport (four seats). */
  commandTeam: boolean;
  /** Noise lures aboard (once researched). */
  lures: number;
}

export type JobKind = 'reinforce' | 'resupply' | 'evacuate' | 'relieve' | 'fuel';

/** A standing or one-off order for an AI pilot. */
export interface Order {
  kind: JobKind;
  district: number;
  /** What a resupply run carries. */
  crate: CrateKind;
  /** Keep flying it until told otherwise. */
  repeat: boolean;
}

export type TripPhase = 'outbound' | 'ground' | 'return';

/** An AI pilot's flight in progress. */
export interface Trip {
  phase: TripPhase;
  district: number;
  /** Game minutes the current phase began and ends. */
  start: number;
  end: number;
  troops: number;
  crates: CrateKind[];
  civilians: number;
  infected: number;
  tired: number;
  tiredFatigue: number;
  /** Scientists brought out (an evacuation takes them first). */
  scientists?: number;
  fuel: number;
  /** Danger at the landing zone when the trip was planned, for the bonus. */
  danger: number;
}

export type PilotStatus = 'idle' | 'flying' | 'resting' | 'stranded' | 'dead' | 'deserted';

export interface Pilot {
  id: number;
  name: string;
  /** 0..1: lowers the chance of a crash. */
  skill: number;
  /** 0..1: how dangerous a landing zone they'll accept. */
  nerve: number;
  /** 0..1: low loyalty means refusals, then desertion. */
  loyalty: number;
  /** 0..1: builds per trip; rest brings it down. */
  fatigue: number;
  /** Rations a day. */
  wage: number;
  /** Candidates turn up among evacuees; only hired pilots are paid and take orders. */
  hired: boolean;
  status: PilotStatus;
  order: Order | null;
  trip: Trip | null;
  airframe: number | null;
  /** Where a stranded pilot is waiting. */
  district: number;
  /** Game minute a resting pilot is ready again. */
  restUntil: number;
  /** Paydays missed in a row. */
  unpaid: number;
  trips: number;
  /** Last game minute this pilot refused or couldn't fly, to avoid repeating the message. */
  blockedAt: number;
  blockedReason: string;
}

export interface Airframe {
  id: number;
  name: string;
  status: 'ready' | 'flying' | 'lost';
}

/** A civilian food truck on its way to a district. Its route is fixed when it sets off. */
export interface Truck {
  id: number;
  /** Depot district it loaded at, or -1 for a regional truck from outside the city. */
  from: number;
  to: number;
  rations: number;
  /** Street corners along the route, flattened: i0, j0, i1, j1, ... */
  path: number[];
  /** Game minutes after setting off that it reaches each corner (traffic decides). */
  times: number[];
  /** Game minutes it set off and will arrive. */
  depart: number;
  arrive: number;
}

/** A freight train bringing food into the rail yard from outside the city. */
export interface Train {
  id: number;
  /** Game minutes: leaves the horizon, reaches the yard, pulls out, is gone. */
  depart: number;
  arrive: number;
  leave: number;
  gone: number;
  /** Unloaded (or turned back) at the yard. */
  done: boolean;
}

/** Traffic on the street grid (see traffic.ts). Arrays are indexed by edge. */
export interface Traffic {
  /** Vehicles per hour on each street. */
  load: Float32Array;
  /** Share of each street choked with abandoned cars and wrecks, 0..1. */
  blocked: Float32Array;
  /** Mean congestion per district (1 = at capacity). */
  jam: number[];
  /** Mean share of each district's streets blocked. */
  blockedShare?: number[];
  /** People who have left the city by road. */
  fled: number;
  /** Capacity factor per district: police checkpoints slow every street. */
  slow?: number[];
}

export interface Supply {
  /** Rations waiting at the rail yard for trucks. */
  yard: number;
  trucks: Truck[];
  trains: Train[];
  seq: number;
  /** Game minute the next train is due to set off. */
  nextTrain: number;
  /** The railway has stopped running (infection at the yard). */
  railHalted: boolean;
}

/** A forward refuelling point the player set up in the city. */
export interface Farp {
  id: number;
  district: number;
  x: number;
  z: number;
  /** Litres available. */
  fuel: number;
}

export interface PlayerStats {
  civiliansEvacuated: number;
  scientistsEvacuated: number;
  troopsDeployed: number;
  troopsRelieved: number;
  cratesDelivered: number;
  /** People lost when the helicopter went down. */
  lostInCrashes: number;
  pilotsRecruited: number;
  aiTrips: number;
  /** Evacuees flown out of the city from the airport (or bussed out from Camp Ridgeway). */
  flownOut: number;
  requestsDone: number;
}

export type ResearchId = 'rapidTests' | 'noiseLures' | 'loudspeaker' | 'doorGun' | 'heavySling' | 'vaccine' | 'antiviral';

/** A siren the player dropped, pulling the dead and hordes toward its district until it goes quiet. */
export interface Lure {
  id: number;
  district: number;
  x: number;
  z: number;
  until: number;
}

/** What an army supply truck carries (doses, person-days, rounds). */
export interface ArmyCargo {
  medicine: number;
  rations: number;
  ammo: number;
}

/**
 * An army supply truck's run from the airport to a district and back (see logistics.ts). Its route
 * and timetable are fixed when it sets off each way, like a food truck's.
 */
export interface ArmyRun {
  id: number;
  to: number;
  cargo: ArmyCargo;
  phase: 'out' | 'back';
  /** Street corners along the way, flattened (i0, j0, i1, j1, ...), and minutes to reach each. */
  path: number[];
  times: number[];
  depart: number;
  arrive: number;
}

/** The army's supply chain out of the airport. */
export interface Logistics {
  /** Trucks the army has for it (some are lost on the road). */
  fleet: number;
  runs: ArmyRun[];
  seq: number;
  /** The district the player wants supplied first, if any. */
  priority: number | null;
  /** Districts the trucks can't reach by road: they need supplying by air. */
  cutOff: number[];
}

/** What the city's people may do (see policy.ts). */
export type Policy = 'unrestricted' | 'curfew' | 'quarantine';

export type ConvoyKind = 'engineers' | 'fuel' | 'supply';

/** A military convoy between Camp Ridgeway and the airport (see convoys.ts). */
export interface MilitaryConvoy {
  id: number;
  kind: ConvoyKind;
  depart: number;
  phase: 'outbound' | 'unloading' | 'return';
}

export type RequestKind = 'supply' | 'reinforce' | 'evacuate' | 'extract';

/** What Command sends for a request done (to the base the military works from). */
export interface Reward {
  troops?: number;
  crates?: Partial<Record<CrateKind, number>>;
  research?: number;
  pilot?: boolean;
  /** Order in the district. */
  order?: number;
}

/** A Command request: a job with a deadline and a reward (see requests.ts). */
export interface Request {
  id: number;
  kind: RequestKind;
  district: number;
  site: number | null;
  crate: CrateKind | null;
  /** Crates, troops or people. */
  needed: number;
  progress: number;
  title: string;
  issued: number;
  deadline: number;
  reward: Reward;
  status: 'open' | 'done' | 'failed';
  closedAt: number | null;
  /** The player has taken it on (shown on the HUD and in the world). */
  tracked: boolean;
  /** The AI pilot it was handed to. */
  assigned: number | null;
}

export type CampaignOutcome = 'running' | 'sealed' | 'fallen' | 'grounded';

/** The campaign: a deadline to get people out by, and how it went (see campaign.ts). */
export interface Campaign {
  /** When Command seals the city (absolute game minute), once announced. */
  deadline: number | null;
  outcome: CampaignOutcome;
  endedAt: number | null;
  /** One per day (and one for the last part-day at the end). */
  reports: DayReport[];
  /** People in the city when it began. */
  startPopulation: number;
  /** Warnings already given (minutes before the seal). */
  warned: number[];
}

/** A day as it went, and what the player's own actions changed (against a replay without them). */
export interface DayReport {
  day: number;
  from: number;
  to: number;
  flownOut: number;
  /** Escaped by road. */
  fled: number;
  /** Civilians the player brought in. */
  evacuated: number;
  scientists: number;
  troops: number;
  crates: number;
  lostInCrashes: number;
  /** People alive in the city at the end of the day. */
  alive: number;
  /** Districts not overrun. */
  held: number;
  /** Districts that fell that day. */
  fell: string[];
  /** More people alive or out of the city than without the player. */
  saved: number;
  /** Districts that would have fallen without the player. */
  heldBecause: string[];
  /** Districts that fell that would have held without the player. */
  lostAnyway: string[];
}

export interface HistorySample {
  t: number;
  population: number;
  infected: number;
  zombies: number;
  troops: number;
  dead: number;
  grid: number;
}

export interface SimEvent {
  id: number;
  t: number;
  district: number | null;
  severity: Severity;
  text: string;
  /** Routine news worth hearing on the radio anyway (the player's and pilots' own actions). */
  radio?: boolean;
}

export interface CityState {
  seed: number | string;
  /** Absolute game minute (see clock.ts). */
  t: number;
  rng: number;
  /** City grid integrity 0..1. */
  grid: number;
  districts: DistrictState[];
  history: HistorySample[];
  /** Most recent events, newest last. */
  log: SimEvent[];
  eventSeq: number;
  collapsed: boolean;
  collapsedAt: number | null;
  cargo: Cargo;
  farps: Farp[];
  farpSeq: number;
  pilots: Pilot[];
  airframes: Airframe[];
  hordes: Horde[];
  hordeSeq: number;
  sites: Site[];
  supply: Supply;
  /** Camp Ridgeway: the military's base outside the city (not in `districts`). */
  army: DistrictState;
  traffic: Traffic;
  pilotSeq: number;
  airframeSeq: number;
  /** Research points earned by scientists at the base. */
  research: number;
  stats: PlayerStats;
  campaign: Campaign;
  requests: Request[];
  requestSeq: number;
  /** Where the next army platoon goes, if the player has chosen (else Command chooses). */
  platoonTarget: number | null;
  /** Research done, and the points spent on it (of `research` earned). */
  unlocked: ResearchId[];
  researchSpent: number;
  lures: Lure[];
  lureSeq: number;
  /** Military convoys on the road between Camp Ridgeway and the airport, and when the next one leaves. */
  convoys: MilitaryConvoy[];
  convoySeq: number;
  nextConvoy: number;
  /** Fortification stages the engineers have finished at the airport (0..5). */
  airportWorks: number;
  /** Army supply trucks carrying the airport's stock out to the districts. */
  logistics: Logistics;
  /** Movement restrictions in force, and since when. */
  policy: Policy;
  policySince: number;
  flags: Record<string, boolean>;
}
