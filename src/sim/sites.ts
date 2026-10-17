// Strategic sites: the buildings the military holds in each district. Police stations keep an
// armoury, supermarkets and pharmacies hold the district's food and medicine, and schools, halls and
// arenas shelter civilians. Held sites hand their stock out to the district; the military posts
// soldiers at them; the dead (above all a settled horde) besiege them, and a site whose barricades
// give way falls with everyone inside.
//
// Where the sites are is planned from the seed alone, so the 3D city and the simulation agree.

import { DISTRICT_TEMPLATES, type DistrictKind } from './layout';
import { totalZombies } from './hordes';
import { makeRandom } from './rng';
import { BLOCKS_PER_DISTRICT, blockLot } from './streets';
import type { CityState, DistrictState, Severity, Site, SiteKind } from './types';

type Emit = (district: number | null, severity: Severity, text: string, radio?: boolean) => void;

/** How a site is built: decides its footprint, its landing zone and how many it can shelter. */
export type SiteVariant = 'station' | 'hq' | 'store' | 'school' | 'hall' | 'arena' | 'pharmacy';

export interface SitePlan {
  id: number;
  district: number;
  kind: SiteKind;
  variant: SiteVariant;
  name: string;
  /** Global block indices. */
  i: number;
  j: number;
  /** Landing zone: the parking lot, playing field or plaza. */
  x: number;
  z: number;
  capacity: number;
}

export const SITE_LABELS: Record<SiteKind, string> = {
  police: 'police station',
  supermarket: 'supermarket',
  shelter: 'shelter',
  pharmacy: 'pharmacy',
};

/** Sites per district kind. */
const COUNTS: Record<DistrictKind, Partial<Record<SiteKind, number>>> = {
  residential: { police: 1, supermarket: 2, shelter: 2, pharmacy: 1 },
  apartments: { police: 1, supermarket: 2, shelter: 2, pharmacy: 1 },
  downtown: { police: 1, supermarket: 1, shelter: 1, pharmacy: 2 },
  commercial: { police: 1, supermarket: 3, shelter: 1, pharmacy: 1 },
  university: { police: 1, supermarket: 1, shelter: 1, pharmacy: 1 },
  harbor: { police: 1, supermarket: 1, shelter: 1 },
  industrial: { supermarket: 1, shelter: 1 },
  hospital: { police: 1, supermarket: 1, shelter: 1, pharmacy: 1 },
  airbase: {},
};

/** Landing zone offset from the block centre, by variant (the 3D city builds around it). */
export const LZ_OFFSET: Record<SiteVariant, [number, number]> = {
  station: [0, 26],
  hq: [0, 26],
  store: [0, 26],
  school: [22, 10],
  hall: [14, 22],
  arena: [0, 32],
  pharmacy: [12, 20],
};

const CAPACITY: Record<SiteVariant, number> = {
  station: 300,
  hq: 600,
  store: 0,
  school: 1500,
  hall: 800,
  arena: 6000,
  pharmacy: 0,
};

const SCHOOLS = ['Lincoln', 'Roosevelt', 'Oakwood', 'Maple Grove', 'Jefferson', 'Hillcrest', 'Washington', 'Kennedy',
  'Lakeview', 'Pinecrest', 'Franklin', 'Cedar Park', 'Brookside', 'Madison', 'Harborview', 'Elmwood'];
const SCHOOL_TYPES = ['Elementary', 'Middle School', 'High School'];
const HALLS = ['Grace Church', "St. Anne's Parish Hall", 'Community Center', 'Union Hall', 'First Baptist Church', 'Veterans Hall'];
const STORES = ['FreshMart', 'ValuSave', 'Greenway Grocers', 'MegaMart', 'Harvest Market', 'Corner Foods', 'SaveRite'];
const PHARMACIES = ['CareRx', 'Wellness Pharmacy', 'MediPlus', 'QuickDrug'];
const STREETS = ['Elm Street', 'Oak Avenue', 'Bay Road', 'Mill Street', 'Park Avenue', 'King Street', 'Front Street',
  'Cedar Lane', 'Station Road', 'High Street', 'Market Street', 'Bridge Road', 'Church Street', 'Lake Drive'];

const plans = new Map<string, SitePlan[]>();

/** Where every site is, for a seed. The same seed always gives the same sites. */
export function planSites(seed: number | string): SitePlan[] {
  const key = String(seed);
  const cached = plans.get(key);
  if (cached) return cached;
  const rand = makeRandom(`sites-${seed}`);
  const pick = <T>(list: T[]): T => list[Math.floor(rand() * list.length)];
  const schools = [...SCHOOLS].sort(() => rand() - 0.5);
  const halls = [...HALLS].sort(() => rand() - 0.5);
  const streets = [...STREETS].sort(() => rand() - 0.5);
  const street = () => {
    const name = streets.shift()!;
    streets.push(name);
    return name;
  };
  const out: SitePlan[] = [];

  DISTRICT_TEMPLATES.forEach((tpl, district) => {
    // The district's defensible core: blocks ranked by distance from its central intersection
    // (with a little jitter per seed), skipping the landmark block beside it.
    const centre = BLOCKS_PER_DISTRICT / 2;
    const core: { bi: number; bj: number; score: number }[] = [];
    for (let bi = 1; bi < BLOCKS_PER_DISTRICT - 1; bi++) {
      for (let bj = 1; bj < BLOCKS_PER_DISTRICT - 1; bj++) {
        if (bi === 5 && bj === 5) continue;
        core.push({ bi, bj, score: Math.hypot(bi + 0.5 - centre, bj + 0.5 - centre) + rand() * 1.2 });
      }
    }
    core.sort((a, b) => a.score - b.score);
    const counts = COUNTS[tpl.kind];
    // The police and the shelters take the most central blocks.
    for (const kind of ['police', 'shelter', 'supermarket', 'pharmacy'] as SiteKind[]) {
      for (let n = 0; n < (counts[kind] ?? 0); n++) {
        const block = core.shift();
        if (!block) continue;
        const { bi, bj } = block;
        let variant: SiteVariant;
        let name: string;
        switch (kind) {
          case 'police':
            variant = tpl.kind === 'downtown' ? 'hq' : 'station';
            name = tpl.kind === 'downtown' ? 'Central Police HQ' : tpl.kind === 'university' ? 'Campus Police' : `${tpl.name} Police Station`;
            break;
          case 'shelter':
            if (tpl.kind === 'downtown') {
              variant = 'arena';
              name = 'Civic Convention Center';
            } else if (tpl.kind === 'university') {
              variant = 'arena';
              name = 'University Arena';
            } else if (n === 1 || tpl.kind === 'harbor' || tpl.kind === 'industrial') {
              variant = 'hall';
              name = halls.pop() ?? 'Community Center';
            } else {
              variant = 'school';
              name = `${schools.pop() ?? tpl.name} ${pick(SCHOOL_TYPES)}`;
            }
            break;
          case 'supermarket':
            variant = 'store';
            name = `${pick(STORES)}, ${street()}`;
            break;
          case 'pharmacy':
            variant = 'pharmacy';
            name = `${pick(PHARMACIES)}, ${street()}`;
            break;
        }
        const i = tpl.col * BLOCKS_PER_DISTRICT + bi;
        const j = tpl.row * BLOCKS_PER_DISTRICT + bj;
        const lot = blockLot(i, j);
        const [ox, oz] = LZ_OFFSET[variant];
        out.push({ id: out.length + 1, district, kind, variant, name, i, j, x: lot.cx + ox, z: lot.cz + oz, capacity: CAPACITY[variant] });
      }
    }
  });
  plans.set(key, out);
  return out;
}

/** Sites with their starting stock, taken out of the district's own (food and medicine move into
 * supermarkets, pharmacies and shelters; police armouries are extra). */
export function createSites(s: CityState): void {
  s.sites = planSites(s.seed).map((p) => ({
    id: p.id, district: p.district, kind: p.kind, name: p.name, x: p.x, z: p.z,
    status: 'held', integrity: 100, guards: 0, pinned: 0, sheltered: 0, capacity: p.capacity,
    rations: 0, medicine: 0, ammo: p.kind === 'police' ? (p.capacity >= 600 ? 50000 : 20000) : 0, looted: false,
  }));
  for (const d of s.districts) {
    const here = s.sites.filter((x) => x.district === d.id);
    const stores = here.filter((x) => x.kind === 'supermarket');
    const shelters = here.filter((x) => x.kind === 'shelter');
    const pharmacies = here.filter((x) => x.kind === 'pharmacy');
    // The district's own food, not the city stock in the Market District warehouse.
    const own = Math.min(d.rations, (d.population + d.troops.strength) * 2.5);
    const food = own * (stores.length ? 0.5 : 0) + own * (shelters.length ? 0.1 : 0);
    for (const x of stores) x.rations = (own * 0.5) / stores.length;
    for (const x of shelters) x.rations = (own * 0.1) / shelters.length;
    d.rations -= food;
    if (pharmacies.length && !d.features.hospital) {
      for (const x of pharmacies) x.medicine = (d.medicine * 0.6) / pharmacies.length;
      d.medicine *= 0.4;
    }
  }
}

/** "Lincoln Elementary in Westfield", but just "Westfield Police Station". */
export function siteName(site: Site, d: DistrictState): string {
  return site.name.includes(d.name) ? site.name : `${site.name} in ${d.name}`;
}

export function siteNear(s: CityState, x: number, z: number, radius: number): Site | undefined {
  let best: Site | undefined;
  let bestD = radius;
  for (const site of s.sites) {
    const d = Math.hypot(site.x - x, site.z - z);
    if (d < bestD) {
      bestD = d;
      best = site;
    }
  }
  return best;
}

/** Soldiers a site wants posted. */
export function guardsNeeded(site: Site): number {
  return NEED[site.kind] + (site.kind === 'shelter' ? site.sheltered / 150 : 0);
}

const NEED: Record<SiteKind, number> = { police: 12, supermarket: 10, shelter: 8, pharmacy: 5 };
const PRIORITY: Record<SiteKind, number> = { police: 3, shelter: 3, supermarket: 2, pharmacy: 1 };
/** How strongly each kind draws the dead (people and the smell of food). */
const DRAW: Record<SiteKind, number> = { police: 0.8, shelter: 1.4, supermarket: 1.1, pharmacy: 0.7 };
/** The military posts at most this share of a district's soldiers at its sites. */
const POSTED_SHARE = 0.6;
/** A horde within this distance of a site throws itself at it. */
const HORDE_REACH = 450;

const clamp = (v: number, lo = 0, hi = 1) => (v < lo ? lo : v > hi ? hi : v);

/**
 * Hourly: post guards, fight sieges, fill shelters, hand out stock, and recount each district's
 * sheltered civilians and held outposts.
 * @param effectiveness how well the district's troops fight right now (0..1)
 */
export function updateSites(s: CityState, night: boolean, emit: Emit, effectiveness: (d: DistrictState) => number): void {
  for (const d of s.districts) {
    const here = s.sites.filter((x) => x.district === d.id);
    if (!here.length) {
      d.sheltered = 0;
      d.outposts = 0;
      continue;
    }
    postGuards(d, here);
    const e = effectiveness(d);
    for (const site of here) siege(s, d, site, e, night, emit);
    fillShelters(d, here, night);
    handOut(d, here, emit);
    recount(d, here);
  }
}

function postGuards(d: DistrictState, here: Site[]): void {
  const T = d.troops.strength;
  // The player's reinforcements stay where they were landed, as long as they live.
  const pinned = here.reduce((n, x) => n + x.pinned, 0);
  if (pinned > T) for (const x of here) x.pinned *= T / pinned;
  for (const x of here) x.guards = x.pinned;
  let budget = Math.max(0, Math.min(T - Math.min(pinned, T), T * POSTED_SHARE - pinned));
  // Sites under siege first, then by importance; fallen sites are retaken only while the district holds.
  const order = here
    .filter((x) => x.status !== 'fallen' || d.status !== 'overrun')
    .sort((a, b) => score(b) - score(a));
  for (const x of order) {
    const g = Math.min(Math.max(0, guardsNeeded(x) - x.guards), budget);
    x.guards += g;
    budget -= g;
  }
}

function score(x: Site): number {
  return PRIORITY[x.kind] * (x.status === 'besieged' ? 2 : x.status === 'fallen' ? 0.5 : 1);
}

function siege(s: CityState, d: DistrictState, site: Site, e: number, night: boolean, emit: Emit): void {
  const draw = DRAW[site.kind] + site.sheltered / 2000;
  let localZ = d.zombies * 0.03 * draw * (night && d.power !== 'dark' ? 1.3 : 1);
  for (const h of s.hordes) {
    // Hardest on the sites nearest where the horde stands.
    const near = 1 - Math.hypot(h.x - site.x, h.z - site.z) / HORDE_REACH;
    if (near > 0) localZ += h.size * (h.settle > 0 ? 0.2 : 0.05) * draw * near;
  }
  const fort = site.kind === 'police' ? 1.5 : 1;
  const barricade = site.status === 'fallen' ? 0 : site.integrity * 0.3;
  const pressure = localZ / (site.guards * e * 15 * fort + barricade + 1);

  // Guards fall, and the bitten among them rise.
  if (site.guards > 0 && localZ > 1) {
    const lost = Math.min(site.guards * 0.2, localZ * 0.003 * (1 - 0.6 * e));
    site.pinned = Math.max(0, site.pinned - lost * (site.pinned / site.guards));
    site.guards -= lost;
    d.troops.strength = Math.max(0, d.troops.strength - lost);
    d.dead += lost * 0.5;
    d.infected += lost * 0.5;
  }

  const name = siteName(site, d);
  if (site.status === 'fallen') {
    // Retaking needs a real garrison and a lull.
    if (site.guards >= NEED[site.kind] * 0.5 && pressure < 0.4) {
      site.integrity += 8;
      if (site.integrity >= 40) {
        site.status = 'besieged';
        site.looted = false;
        emit(d.id, 'info', `Troops have retaken ${name}.`, true);
      }
    }
    return;
  }

  // Barricades hold for hours against a crowd and for half a day or so against a horde, so
  // there's time to fly in help.
  if (pressure > 0.6) site.integrity -= Math.min(3, pressure - 0.6) * 4;
  else if (pressure < 0.3 && (site.guards >= 1 || localZ < 5)) site.integrity += 5;
  site.integrity = clamp(site.integrity, 0, 100);

  // A siege gets inside now and then.
  if (site.status === 'besieged' && site.sheltered > 0) {
    const bitten = Math.min(site.sheltered, site.sheltered * 0.01 * Math.min(3, pressure));
    site.sheltered -= bitten;
    d.population = Math.max(0, d.population - bitten);
    d.infected += bitten;
  }

  if (site.integrity <= 0) {
    site.status = 'fallen';
    const inside = site.sheltered;
    const bitten = inside * 0.3;
    const killed = inside * 0.1;
    d.population = Math.max(0, d.population - bitten - killed);
    d.infected += bitten;
    d.dead += killed;
    site.sheltered = 0;
    const lost = site.guards * 0.4;
    d.troops.strength = Math.max(0, d.troops.strength - lost);
    d.dead += lost;
    site.guards -= lost;
    site.pinned = Math.min(site.pinned, site.guards);
    const who = inside >= 10 ? ` ${Math.round(inside).toLocaleString('en-US')} civilians were sheltering inside.` : '';
    emit(d.id, 'critical', `${name} has fallen.${who}`);
  } else if (site.status === 'held' && site.integrity < 60) {
    site.status = 'besieged';
    emit(d.id, site.sheltered >= 100 ? 'critical' : 'warn', `${name} is under siege${site.sheltered >= 100 ? ` with ${Math.round(site.sheltered).toLocaleString('en-US')} civilians inside` : ''}.`);
  } else if (site.status === 'besieged' && site.integrity >= 80) {
    site.status = 'held';
    emit(d.id, 'info', `The siege at ${name} has been broken.`);
  }
}

/** Civilians make for the shelters as the danger grows. */
function fillShelters(d: DistrictState, here: Site[], night: boolean): void {
  // Nobody moves into a school gym until the dead are in the streets.
  if (!d.flags.outbreak) return;
  const threat = clamp(totalZombies(d) / (d.population * 0.01 + d.troops.strength * 2 + 20));
  let outside = d.population - here.reduce((n, x) => n + (x.status === 'fallen' ? 0 : x.sheltered), 0);
  for (const x of here) {
    if (x.capacity <= 0 || x.status !== 'held' || outside <= 0) continue;
    const inflow = Math.min(x.capacity - x.sheltered, outside * (0.001 + 0.05 * threat + (night ? 0.002 : 0)));
    if (inflow <= 0) continue;
    x.sheltered += inflow;
    outside -= inflow;
  }
}

/** Staffed sites hand out food, medicine and ammunition; unguarded ones are looted in a riot. */
function handOut(d: DistrictState, here: Site[], emit: Emit): void {
  const people = d.population + d.troops.strength + d.infected;
  for (const x of here) {
    if (x.status === 'fallen') continue;
    const stock = x.rations + x.medicine + x.ammo;
    // Police stations have their own officers: only an abandoned one is looted.
    const exposed = x.kind === 'police' ? x.guards < 1 : x.guards < NEED[x.kind] * 0.5;
    if (d.rioting && exposed && stock > 100) {
      x.rations *= 0.85;
      x.medicine *= 0.85;
      x.ammo *= 0.9;
      if (!x.looted) {
        x.looted = true;
        emit(d.id, 'warn', `Looters are stripping ${siteName(x, d)}.`);
      }
      continue;
    }
    if (!d.rioting) x.looted = false;
    const staffed = x.guards >= 1 || (!d.rioting && d.order > 40);
    if (!staffed) continue;
    // Food goes out once the district runs short; a shelter's only feeds the people inside.
    if (x.rations > 0 && d.rations < people * 0.5) {
      const give = Math.min(x.rations, ((x.kind === 'shelter' ? x.sheltered : people) / 24) * 1.2);
      x.rations -= give;
      d.rations += give;
    }
    if (x.medicine > 0 && d.medicine < people * 0.05) {
      const give = Math.min(x.medicine, people * 0.004);
      x.medicine -= give;
      d.medicine += give;
    }
    if (x.ammo > 0 && d.troops.strength >= 1 && d.troops.ammo < d.troops.strength * 150) {
      const give = Math.min(x.ammo, d.troops.strength * 100);
      x.ammo -= give;
      d.troops.ammo += give;
    }
  }
}

function recount(d: DistrictState, here: Site[]): void {
  let sheltered = 0;
  for (const x of here) if (x.status !== 'fallen') sheltered += x.sheltered;
  // People leave a district (fleeing, evacuated, dying) faster than the hourly count.
  if (sheltered > d.population && sheltered > 0) {
    const k = d.population / sheltered;
    for (const x of here) x.sheltered *= k;
    sheltered = d.population;
  }
  d.sheltered = sheltered;
  d.outposts = here.filter((x) => x.status === 'held' && x.guards >= 1).length;
}
