// Movement restrictions. Soon after the state of emergency, once the infection spreads further,
// Command asks the player what the city's people may do: nothing changes (unrestricted), a curfew
// (out only from early morning to early afternoon), or a strict quarantine (indoors, but for one
// trip a day to the district's food point). People kept in meet fewer of the dead and carry fewer
// of the bitten to other districts, and fewer get out of the city. A quarantine funnels each
// district through its food points once a day: a crowd the dead are drawn to, where the bitten turn
// among the queue, unless soldiers and police screen the line, and then it's where they're caught.
// How well a rule holds depends on the police and soldiers there to enforce it. Either rule keeps
// some of the power grid's staff from work, and wears on people's patience.

import { formatClock, minuteOfDay } from './clock';
import { dayOf } from './daystats';
import { hasResearch } from './research';
import { DOSES_PER_ISOLATION } from './supplies';
import type { CityState, DistrictState, Policy, Severity, Site } from './types';

type Emit = (district: number | null, severity: Severity, text: string, radio?: boolean) => void;

const clamp = (v: number, lo = 0, hi = 1) => (v < lo ? lo : v > hi ? hi : v);

/** Command asks once outbreaks reach this many districts, or this long after the emergency. */
const ASK_OUTBREAKS = 3;
const ASK_AFTER = 180;
/** Put off ("stand by"), Command asks again after this long. */
export const ASK_AGAIN = 120;
/** A curfew lets people out from 05:00 until 14:00. */
export const CURFEW_FROM = 5 * 60;
export const CURFEW_UNTIL = 14 * 60;
/** Each district's food run under quarantine: two hours, starting between 08:00 and 16:00. */
export const FOOD_RUN_MINUTES = 120;
const FOOD_RUN_FIRST = 8 * 60;
/** Those out at once for the food run, against an ordinary day. */
const QUEUE_CROWD = 1.5;
/** The bitten in a food line who turn and bite, an hour (per bitten person in it, unscreened). */
const QUEUE_SPREAD = 0.6;
/** Share of the bitten in a fully screened food line caught an hour. */
const QUEUE_SCREEN = 0.5;
/** Soldiers at a food point to screen its line properly. */
const SCREEN_GUARDS = 8;

export const POLICY_LABELS: Record<Policy, string> = {
  unrestricted: 'Unrestricted',
  curfew: 'Curfew',
  quarantine: 'Quarantine',
};

/** What each rule means, for the radio and Flight Command. */
export const POLICY_TERMS: Record<Policy, string> = {
  unrestricted: 'People come and go as they please',
  curfew: 'People may be out only from 05:00 to 14:00',
  quarantine: 'People stay indoors but for one trip a day to their district\'s food point',
};

/** Whether Command is asking (or has asked) for a decision. */
export function policyAsked(s: CityState): boolean {
  return !!s.flags.policyCall;
}

/** Whether the radio call for a decision should be up now. */
export function policyCallDue(s: CityState): boolean {
  return !!s.flags.policyCall && !s.flags.policyDecided && s.t >= (s.army.cooldowns.policyAsk ?? 0);
}

/**
 * Hourly: Command asks for a decision once the infection spreads after the state of emergency
 * (unless the player has already made one in Flight Command).
 */
export function updatePolicy(s: CityState, emit: Emit): void {
  if (s.flags.policyCall || s.flags.policyDecided || !s.flags.jocAuthorized) return;
  const outbreaks = s.districts.filter((d) => d.flags.outbreak).length;
  if (outbreaks < ASK_OUTBREAKS && s.t - (s.army.cooldowns.jocAuthorized ?? s.t) < ASK_AFTER) return;
  s.flags.policyCall = true;
  s.army.cooldowns.policyAsk = s.t;
  emit(null, 'critical', `The infection is spreading through ${outbreaks} districts. Command wants your call on movement ` +
    'restrictions: a strict quarantine, a curfew, or none.', true);
}

/** Put the rule in force (the player's decision), or put the decision off. */
export function setPolicy(s: CityState, policy: Policy | null, emit: Emit): void {
  if (policy === null) {
    s.army.cooldowns.policyAsk = s.t + ASK_AGAIN;
    emit(null, 'info', 'Command will hold off on movement restrictions for now and ask again in two hours.');
    return;
  }
  const before = s.policy;
  s.flags.policyDecided = true;
  s.policy = policy;
  s.policySince = s.t;
  if (before === policy) return;
  emit(null, policy === 'unrestricted' ? 'info' : 'warn', policy === 'unrestricted'
    ? 'No movement restrictions: people are free to come and go.'
    : policy === 'curfew'
      ? 'A curfew is in force across the city. People may be out only from 05:00 until 14:00.'
      : 'The city is under strict quarantine. People stay indoors, but for one trip a day to their district\'s food point.', true);
}

/** Whether a district is under the rule (the airport and fallen districts aren't). */
function restricted(s: CityState, d: DistrictState): boolean {
  return !!s.policy && s.policy !== 'unrestricted' && d.kind !== 'airbase' && d.kind !== 'army' && d.status !== 'overrun';
}

/** Start of a district's daily food run under quarantine (minute of the day). */
export function foodRunStart(d: DistrictState): number {
  return FOOD_RUN_FIRST + (d.id % 5) * FOOD_RUN_MINUTES;
}

/** Whether a district's food run is under way at game minute t. */
export function foodRunOn(d: DistrictState, t: number): boolean {
  const m = minuteOfDay(t) - foodRunStart(d);
  return m >= 0 && m < FOOD_RUN_MINUTES;
}

/** Whether a curfew lets people out at game minute t. */
export function curfewOpen(t: number): boolean {
  const m = minuteOfDay(t);
  return m >= CURFEW_FROM && m < CURFEW_UNTIL;
}

/** Sites that can serve as an emergency distribution point, staffed by soldiers or the police. */
const EMERGENCY_POINTS = ['depot', 'factory', 'police', 'pharmacy'];

/**
 * A district's own food points: its held supermarkets; with none, its shelters; with none of those,
 * an emergency distribution point at another site that soldiers (or, at the police station, the
 * police) are there to run.
 */
export function foodPoints(s: CityState, d: DistrictState): Site[] {
  const here = s.sites.filter((x) => x.district === d.id && x.status !== 'fallen');
  const stores = here.filter((x) => x.kind === 'supermarket');
  if (stores.length) return stores;
  const shelters = here.filter((x) => x.kind === 'shelter');
  if (shelters.length) return shelters;
  return here.filter((x) => EMERGENCY_POINTS.includes(x.kind) && (x.guards >= 1 || (x.kind === 'police' && d.police.officers >= 3)));
}

/** Where a district gets its food under quarantine. */
export interface FoodSource {
  /** The district whose food points they use: their own, or a neighbour's. */
  district: DistrictState;
  points: Site[];
  /** They walk to a neighbouring district's food points. */
  away: boolean;
}

/**
 * A district's own food points; with none, the nearest neighbouring district's (one that still
 * holds), a long walk away; or nowhere.
 */
export function foodSource(s: CityState, d: DistrictState): FoodSource | null {
  const own = foodPoints(s, d);
  if (own.length) return { district: d, points: own, away: false };
  for (const n of d.neighbors) {
    const next = s.districts[n];
    if (next.kind === 'airbase' || next.status === 'overrun') continue;
    const points = foodPoints(s, next);
    if (points.length) return { district: next, points, away: true };
  }
  return null;
}

/**
 * How well people keep to the rule (0..1): police and soldiers to enforce it, against disorder.
 * A quarantine with nowhere to get food breaks down.
 */
export function compliance(s: CityState, d: DistrictState): number {
  if (!restricted(s, d)) return 0;
  const pol = d.police;
  const enforcers = d.troops.strength + pol.officers * 0.8 * pol.morale + pol.riot * pol.morale;
  const security = clamp(enforcers / Math.max(1, d.population / 500));
  let c = 0.45 + 0.5 * security;
  if (d.rioting) c *= 0.5;
  if (d.flags.anarchy) c *= 0.3;
  if (s.policy === 'quarantine' && !foodSource(s, d)) c *= 0.5;
  return clamp(c);
}

/**
 * People out on the streets at game minute t, against an ordinary day (1). Under a curfew they're
 * out only in its hours; under quarantine, only on the food run, all at once.
 */
export function movement(s: CityState, d: DistrictState, t = s.t): number {
  if (!restricted(s, d)) return 1;
  const c = compliance(s, d);
  if (s.policy === 'curfew') return curfewOpen(t) ? 1 : 1 - 0.9 * c;
  return foodRunOn(d, t) ? 1 - c + c * QUEUE_CROWD : 1 - 0.92 * c;
}

/** People travelling between districts (fleeing, driving, leaving), against no rule (1). */
export function travel(s: CityState, d: DistrictState, t = s.t): number {
  if (!restricted(s, d)) return 1;
  const c = compliance(s, d);
  if (s.policy === 'curfew') return curfewOpen(t) ? 1 - 0.3 * c : 1 - 0.85 * c;
  return 1 - 0.9 * c;
}

/**
 * Order lost to the rule: resentment, cabin fever, a long walk to another district for food, and a
 * quarantine with no food to be had.
 */
export function policyUnrest(s: CityState, d: DistrictState): number {
  if (!restricted(s, d)) return 0;
  if (s.policy === 'curfew') return 3;
  const days = (s.t - (s.policySince ?? s.t)) / 1440;
  const food = foodSource(s, d);
  return 4 + Math.min(5, days) + (!food ? 10 : food.away ? 4 : 0);
}

/** How well a district's food line is screened for the bitten (0..1): the line where it gets its food. */
export function lineScreening(s: CityState, d: DistrictState): number {
  const food = foodSource(s, d);
  if (!food) return 0;
  const { points, district: at } = food;
  const guards = points.reduce((n, x) => n + Math.min(SCREEN_GUARDS, x.guards), 0) / (points.length * SCREEN_GUARDS);
  const police = at.police.stage !== 'patrol' && at.police.officers >= 5 ? 0.3 * at.police.morale : 0;
  const tests = hasResearch(s, 'rapidTests') ? 1.5 : 1;
  return clamp((guards + police) * tests);
}

/**
 * Every minute, under quarantine: the food run. The bitten in the line turn and bite those around
 * them, unless it's screened; screening catches them. Returns the newly bitten.
 */
export function foodRun(s: CityState, d: DistrictState, emit: Emit): number {
  if (s.policy !== 'quarantine' || !restricted(s, d) || !foodRunOn(d, s.t)) return 0;
  const H = 1 / 60;
  const c = compliance(s, d);
  const food = foodSource(s, d);
  if (!food || d.population < 50) return 0;
  const { points } = food;
  const screen = lineScreening(s, d);
  // Most of the district passes through in the two hours, the bitten among them.
  const inLine = d.infected * c;
  const caught = Math.min(inLine, inLine * QUEUE_SCREEN * screen * H);
  const bitten = Math.min(d.population * 0.02, inLine * QUEUE_SPREAD * (1 - screen) * H);
  if (caught > 0) {
    dayOf(s, d.id).isolated += caught;
    d.infected -= caught;
    // Isolated like any other case: cured with the antiviral, else they die in isolation.
    if (hasResearch(s, 'antiviral') && d.medicine >= caught * DOSES_PER_ISOLATION) {
      d.medicine -= caught * DOSES_PER_ISOLATION;
      d.population += caught;
    } else d.dead += caught;
  }
  d.population -= bitten;
  d.infected += bitten;
  // Tallied over the run, and reported as it ends.
  d.cooldowns.lineCaught = (d.cooldowns.lineCaught ?? 0) + caught;
  d.cooldowns.lineBitten = (d.cooldowns.lineBitten ?? 0) + bitten;
  if (minuteOfDay(s.t) - foodRunStart(d) === FOOD_RUN_MINUTES - 1) {
    const at = food.district.name;
    const where = points[0].name.includes(at) ? points[0].name : `${points[0].name} in ${at}`;
    const hurt = Math.round(d.cooldowns.lineBitten);
    const found = Math.round(d.cooldowns.lineCaught);
    if (hurt >= 5) emit(d.id, hurt >= 40 ? 'critical' : 'warn', `The bitten turned in the food line at ${where}: about ${hurt} people were bitten.`);
    if (found >= 3) emit(d.id, 'info', `Screening at the food line at ${where} caught ${found} of the bitten.`);
    d.cooldowns.lineCaught = 0;
    d.cooldowns.lineBitten = 0;
  }
  return bitten;
}

const hhmm = (minute: number) => formatClock(minute).split('· ')[1];

/** "Quarantine · food run 10:00–12:00 (now) · line screened 40%": the rule here, for the HUD. */
export function ruleLine(s: CityState, d: DistrictState, t = s.t): string {
  if (!restricted(s, d)) return '';
  const kept = `keeping to it ${Math.round(compliance(s, d) * 100)}%`;
  if (s.policy === 'curfew') return `Curfew · ${curfewOpen(t) ? `out until ${hhmm(CURFEW_UNTIL)}` : `indoors until ${hhmm(CURFEW_FROM)}`} · ${kept}`;
  const food = foodSource(s, d);
  if (!food) return `Quarantine · no food point · ${kept}`;
  const start = foodRunStart(d);
  return `Quarantine · food run ${hhmm(start)}–${hhmm(start + FOOD_RUN_MINUTES)}${foodRunOn(d, t) ? ' (now)' : ''}` +
    `${food.away ? ` at ${food.district.name}` : food.points[0].kind === 'supermarket' || food.points[0].kind === 'shelter' ? '' : ' (emergency point)'} · ` +
    `line screened ${Math.round(lineScreening(s, d) * 100)}% · ${kept}`;
}
