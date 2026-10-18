// Command requests: what the city needs most right now, as jobs with a deadline and a reward. They
// come from the simulation itself: a shelter out of medicine, a district under attack, a research
// team about to be cut off, a besieged shelter, a food truck crawling through infested streets.
// There are always more than one helicopter can do. The player tracks the ones they take on, hands
// others to AI pilots, and lets the rest go. Deliveries count whoever makes them.

import { MINUTES_PER_DAY } from './clock';
import { hubOf, mergeTroops } from './command';
import { totalZombies } from './hordes';
import { districtAt } from './layout';
import { addAirframe, createPilot } from './pilots';
import { siteName } from './sites';
import { needsMedicine } from './supplies';
import { nodeX, nodeZ, STREET_SPACING } from './streets';
import { truckPose } from './supply';
import type { CityState, CrateKind, DistrictState, Request, RequestKind, Reward, Severity, Site } from './types';

type Emit = (district: number | null, severity: Severity, text: string, radio?: boolean) => void;

/** Open requests at once, at most. */
const MAX_OPEN = 5;
/** Hours before the same request comes up again for the same place, after it was done or failed. */
const REPEAT_AFTER_DONE = 6;
const REPEAT_AFTER_FAILED = 10;
/** Command puts out at most one new request this often (game minutes). */
const ISSUE_EVERY = 120;
/** A truck counts as watched for this many minutes after the last overwatch report. */
export const OVERWATCH_GRACE = 3;
/** Helicopter within this many metres (and this low) of a truck is watching over it. */
export const OVERWATCH_RANGE = 160;
export const OVERWATCH_ALTITUDE = 160;

const CRATE_AMOUNT: Record<CrateKind, number> = { rations: 5000, ammo: 15000, medicine: 3000 };
const CRATE_LABEL: Record<CrateKind, string> = { rations: 'food', ammo: 'ammunition', medicine: 'medicine' };

/** What a deliverer can credit a request with. */
export interface Credit {
  what: 'crate' | 'troops' | 'civilians' | 'scientists';
  district: number;
  site?: number;
  crate?: CrateKind;
  amount: number;
  by: 'player' | 'ai';
}

const ordinal = (n: number) => {
  const s = n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd', 'th', 'th', 'th', 'th', 'th', 'th'][n % 10];
  return `${n}${s}`;
};

/** A street's name: avenues run north–south, streets east–west, numbered from the west and north. */
export function streetName(x: number, z: number, heading: number): string {
  const northSouth = Math.abs(Math.cos(heading)) > Math.abs(Math.sin(heading));
  if (northSouth) return `${ordinal(Math.round((x - nodeX(0)) / STREET_SPACING) + 1)} Avenue`;
  return `${ordinal(Math.round((z - nodeZ(0)) / STREET_SPACING) + 1)} Street`;
}

export function rewardText(r: Reward): string {
  return [
    r.troops && `${r.troops} troops at base`,
    r.crates && Object.entries(r.crates).map(([k, n]) => `${n} ${CRATE_LABEL[k as CrateKind]} crate${n > 1 ? 's' : ''} at base`).join(', '),
    r.research && `${r.research} research`,
    r.airframe && 'a helicopter for the fleet',
    r.pilot && 'a pilot to hire',
    r.order && `order +${r.order}`,
  ].filter(Boolean).join(' · ');
}

export { ISSUE_EVERY };

export function openRequests(s: CityState): Request[] {
  return s.requests.filter((r) => r.status === 'open');
}

/** Which kinds an AI pilot can take on. */
export function assignable(r: Request): boolean {
  return r.kind !== 'overwatch';
}

// --- Issuing ------------------------------------------------------------------------------------

interface Candidate {
  kind: RequestKind;
  district: number;
  site: number | null;
  truck: number | null;
  crate: CrateKind | null;
  needed: number;
  minutes: number;
  title: string;
  reward: Reward;
  /** Higher goes first. */
  urgency: number;
}

function people(d: DistrictState): number {
  return d.population + d.troops.strength + d.infected;
}

function siteFor(s: CityState, d: DistrictState, kinds: Site['kind'][]): Site | undefined {
  return s.sites.find((x) => x.district === d.id && x.status !== 'fallen' && kinds.includes(x.kind));
}

function candidates(s: CityState): Candidate[] {
  const out: Candidate[] = [];
  for (const d of s.districts) {
    if (d.kind === 'airbase' || d.status === 'overrun' || people(d) < 500) continue;
    const n = people(d);
    // Supplies running out where people are still holding on.
    const shortOf = (kind: CrateKind, sites: Site['kind'][], urgency: number, label: (place: string) => string) => {
      const site = siteFor(s, d, sites);
      const place = site ? siteName(site, d) : d.name;
      out.push({
        kind: 'supply', district: d.id, site: site?.id ?? null, truck: null, crate: kind,
        needed: Math.min(2, Math.max(1, Math.ceil((n * (kind === 'medicine' ? 0.15 : 0.5)) / CRATE_AMOUNT[kind]))),
        minutes: 150, title: label(place), reward: { troops: 15, order: 8 }, urgency,
      });
    };
    if (needsMedicine(d)) shortOf('medicine', ['pharmacy', 'shelter'], 3, (p) => `${p} is out of medicine`);
    if (d.rations < n * 0.25) shortOf('rations', ['supermarket', 'depot', 'shelter'], 2, (p) => `${p} is running out of food`);
    if (d.troops.strength >= 10 && d.troops.ammo < d.troops.strength * 60) {
      shortOf('ammo', ['police'], 4, () => `Troops in ${d.name} are low on ammunition`);
    }
    // A district under attack with too few soldiers.
    if (s.flags.joc && d.status === 'contested' && d.troops.strength < 40) {
      out.push({
        kind: 'reinforce', district: d.id, site: null, truck: null, crate: null, needed: 8, minutes: 120,
        title: `${d.name} is under attack: reinforce it`, reward: { troops: 30 }, urgency: 5,
      });
    }
    // A research team about to be cut off.
    if (d.scientists >= 1 && (d.status === 'contested' || d.flags.outbreak)) {
      out.push({
        kind: 'extract', district: d.id, site: null, truck: null, crate: null, needed: Math.ceil(d.scientists), minutes: 180,
        title: `Research team in ${d.name}: extract them before it falls`, reward: { research: 80 }, urgency: 7,
      });
    }
    // People in a shelter under siege.
    for (const x of s.sites) {
      if (x.district !== d.id || x.kind !== 'shelter' || x.status !== 'besieged' || x.sheltered < 8) continue;
      out.push({
        kind: 'evacuate', district: d.id, site: x.id, truck: null, crate: null, needed: Math.min(24, Math.floor(x.sheltered)), minutes: 90,
        title: `${siteName(x, d)} is under siege: bring people out`, reward: { pilot: true, order: 5 }, urgency: 6,
      });
    }
  }
  // Food trucks crawling through dangerous streets.
  for (const tr of s.supply.trucks) {
    if (tr.arrive - s.t < 30) continue;
    const { x, z, heading } = truckPose(tr, s.t);
    const d = s.districts[districtAt(x, z)];
    if (!d || (d.status === 'held' && totalZombies(d) < 40)) continue;
    out.push({
      kind: 'overwatch', district: d.id, site: null, truck: tr.id, crate: null, needed: 15, minutes: Math.floor(tr.arrive - s.t),
      title: `Food truck in gridlock on ${streetName(x, z, heading)} in ${d.name}: needs overwatch`,
      reward: { airframe: true }, urgency: 4.5,
    });
  }
  return out;
}

const keyOf = (c: { kind: RequestKind; district: number; site: number | null; truck: number | null; crate: CrateKind | null }) =>
  `${c.kind}:${c.district}:${c.site}:${c.truck}:${c.crate}`;

/** Every couple of hours: Command puts out the most urgent new request. */
export function issueRequests(s: CityState, emit: Emit): void {
  if (s.campaign.outcome !== 'running' && !s.flags.freePlay) return;
  if (openRequests(s).length >= MAX_OPEN) return;
  const recent = new Set(
    s.requests.filter((r) => r.status === 'open' ||
      s.t - (r.closedAt ?? r.issued) < (r.status === 'failed' ? REPEAT_AFTER_FAILED : REPEAT_AFTER_DONE) * 60).map(keyOf),
  );
  const next = candidates(s)
    .filter((c) => !recent.has(keyOf(c)))
    .sort((a, b) => b.urgency - a.urgency)[0];
  if (!next) return;
  const r: Request = {
    id: ++s.requestSeq, kind: next.kind, district: next.district, site: next.site, truck: next.truck, crate: next.crate,
    needed: next.needed, progress: 0, title: next.title, issued: s.t, deadline: s.t + next.minutes,
    reward: next.reward, status: 'open', closedAt: null, tracked: false, assigned: null, lastWatch: -Infinity,
  };
  s.requests.push(r);
  emit(r.district, 'warn', `Command request: ${r.title}. ${describeNeed(r)} within ${next.minutes >= 120 ? `${Math.round(next.minutes / 60)} hours` : `${next.minutes} minutes`}. ` +
    `Reward: ${rewardText(r.reward)}.`, true);
}

/** What the request needs, in words. */
export function describeNeed(r: Request): string {
  switch (r.kind) {
    case 'supply':
      return `Deliver ${r.needed} crate${r.needed > 1 ? 's' : ''} of ${CRATE_LABEL[r.crate!]}`;
    case 'reinforce':
      return `Land ${r.needed} troops`;
    case 'evacuate':
      return `Bring out ${r.needed} people`;
    case 'extract':
      return `Bring out ${r.needed} scientist${r.needed > 1 ? 's' : ''}`;
    case 'overwatch':
      return `Hover over the truck for ${r.needed} minutes`;
  }
}

// --- Progress -----------------------------------------------------------------------------------

/** A delivery, boarding or landing counts toward any open request it answers. */
export function credit(s: CityState, c: Credit, emit: Emit): void {
  for (const r of openRequests(s)) {
    if (r.district !== c.district) continue;
    const match = (r.kind === 'supply' && c.what === 'crate' && c.crate === r.crate) ||
      (r.kind === 'reinforce' && c.what === 'troops') ||
      (r.kind === 'extract' && c.what === 'scientists') ||
      // People must come out of the shelter itself (an AI pilot always lands at the fullest one).
      (r.kind === 'evacuate' && c.what === 'civilians' && (c.site === r.site || c.by === 'ai'));
    if (!match) continue;
    r.progress += c.amount;
    if (r.progress >= r.needed) complete(s, r, emit);
  }
}

/** The helicopter is watching over a request's truck this minute. */
export function overwatch(s: CityState, id: number, emit: Emit): boolean {
  const r = s.requests.find((x) => x.id === id && x.status === 'open' && x.kind === 'overwatch');
  if (!r || r.lastWatch === s.t) return false;
  r.lastWatch = s.t;
  r.progress += 1;
  if (r.progress >= r.needed) complete(s, r, emit);
  return true;
}

/** Whether a truck has an overwatch request that's being flown right now. */
export function watched(s: CityState, truck: number): boolean {
  return s.requests.some((r) => r.kind === 'overwatch' && r.truck === truck && s.t - r.lastWatch <= OVERWATCH_GRACE);
}

/** Whether a truck has an open overwatch request (its crew is waiting for cover). */
export function waitingForCover(s: CityState, truck: number): boolean {
  return s.requests.some((r) => r.kind === 'overwatch' && r.truck === truck && r.status === 'open');
}

function complete(s: CityState, r: Request, emit: Emit): void {
  r.status = 'done';
  r.closedAt = s.t;
  const hub = hubOf(s);
  const w = r.reward;
  if (w.troops) mergeTroops(hub, w.troops, 0, 0.9, w.troops * 300);
  if (w.crates) {
    for (const [kind, n] of Object.entries(w.crates) as [CrateKind, number][]) {
      const amount = CRATE_AMOUNT[kind] * n;
      if (kind === 'rations') hub.rations += amount;
      else if (kind === 'medicine') hub.medicine += amount;
      else hub.troops.ammo += amount;
    }
  }
  if (w.research) s.research += w.research;
  if (w.airframe) addAirframe(s);
  if (w.pilot) s.pilots.push(createPilot(s));
  if (w.order) {
    const d = s.districts[r.district];
    d.order = Math.min(100, d.order + w.order);
  }
  s.stats.requestsDone += 1;
  emit(r.district, 'info', `Request done: ${r.title}. Command sends ${rewardText(w)}.`, true);
}

function fail(s: CityState, r: Request, why: string, emit: Emit): void {
  r.status = 'failed';
  r.closedAt = s.t;
  emit(r.district, 'warn', `Request failed: ${r.title}. ${why}`, true);
}

/** Every minute: requests run out of time, or out of point. */
export function updateRequests(s: CityState, emit: Emit): void {
  for (const r of openRequests(s)) {
    const d = s.districts[r.district];
    const site = r.site === null ? undefined : s.sites.find((x) => x.id === r.site);
    if (d.status === 'overrun') fail(s, r, `${d.name} has been overrun.`, emit);
    else if (site && site.status === 'fallen') fail(s, r, `${site.name} has fallen.`, emit);
    else if (r.kind === 'extract' && d.scientists < 1) {
      // Brought out (by anyone) or lost.
      if (r.progress > 0) complete(s, r, emit);
      else fail(s, r, 'The research team is gone.', emit);
    } else if (r.kind === 'overwatch' && !s.supply.trucks.some((t) => t.id === r.truck)) {
      // Arrived (its deadline is its arrival), with enough cover; or lost on the way.
      if (s.t >= r.deadline && r.progress >= r.needed / 2) complete(s, r, emit);
      else fail(s, r, s.t >= r.deadline ? 'It got through, but without cover.' : 'The truck didn\'t make it.', emit);
    } else if (s.t >= r.deadline) fail(s, r, 'Out of time.', emit);
  }
  // Closed requests are kept a day for the record (and to hold off repeats).
  s.requests = s.requests.filter((r) => r.status === 'open' || s.t - (r.closedAt ?? s.t) < MINUTES_PER_DAY);
}
