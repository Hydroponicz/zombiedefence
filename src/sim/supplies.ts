// Relief crates: where each kind can be delivered, what a delivery does, and what a district needs.
//
// Each crate has its kind of place. Medicine goes to a pharmacy, a shelter or the hospital; food to a
// supermarket, a food depot or a shelter; ammunition anywhere, to the troops (or, with none, to the
// police). A delivery takes effect at once in the district's supplies. A site under siege loses some
// of it in the fighting, and a fallen one can't take it at all.

import type { CityState, CrateKind, DistrictState, Site, SiteKind } from './types';

/** Doses of medicine it takes to find and isolate one of the bitten before they turn. */
export const DOSES_PER_ISOLATION = 10;
/** Of a delivery to a site under siege, how much gets through. */
const BESIEGED_SHARE = 0.7;
/** A crate of ammunition arms a district's police for this long (minutes) when there are no troops. */
export const POLICE_ARMED_MINUTES = 24 * 60;

const PLACES: Record<Exclude<CrateKind, 'ammo'>, SiteKind[]> = {
  medicine: ['pharmacy', 'shelter'],
  rations: ['supermarket', 'depot', 'shelter'],
};

const AMOUNT: Record<CrateKind, number> = { rations: 5000, ammo: 15000, medicine: 3000 };

export type Delivery = { ok: true; share: number } | { ok: false; reason: string };

function people(d: DistrictState): number {
  return d.population + d.troops.strength + d.infected;
}

/** Whether a crate of this kind can be delivered here (the district's street, or a site). */
export function deliveryPlace(s: CityState, kind: CrateKind, district: number, site?: Site): Delivery {
  const d = s.districts[district];
  if (!d) return { ok: false, reason: 'Not in the city' };
  if (site && site.status === 'fallen') return { ok: false, reason: `The ${site.name} has fallen` };
  const share = site?.status === 'besieged' ? BESIEGED_SHARE : 1;
  if (kind === 'ammo') return { ok: true, share };
  // The hospital takes medicine anywhere on its grounds.
  if (kind === 'medicine' && d.features.hospital && !site) return { ok: true, share };
  if (site && PLACES[kind].includes(site.kind)) return { ok: true, share };
  return {
    ok: false,
    reason: kind === 'medicine' ? 'Medicine goes to a pharmacy, a shelter or the hospital' : 'Food goes to a supermarket, a food depot or a shelter',
  };
}

const fmt = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n)));

/** What a crate does here, before and after, in a phrase: "Westfield's medicine 2.1k → 5.1k doses". */
export function deliveryEffect(s: CityState, kind: CrateKind, district: number, share: number): string {
  const d = s.districts[district];
  const amount = AMOUNT[kind] * share;
  const n = Math.max(1, people(d));
  if (kind === 'medicine') {
    return `${d.name}'s medicine ${fmt(d.medicine)} → ${fmt(d.medicine + amount)} doses, enough to isolate about ${fmt(amount / DOSES_PER_ISOLATION)} of the bitten`;
  }
  if (kind === 'rations') {
    return `${d.name}'s food ${(d.rations / n).toFixed(1)} → ${((d.rations + amount) / n).toFixed(1)} days`;
  }
  if (d.troops.strength >= 1) {
    const each = (a: number) => Math.round(a / d.troops.strength);
    return `${d.name}'s troops ${each(d.troops.ammo)} → ${each(d.troops.ammo + amount)} rounds each`;
  }
  return `${d.name}'s police armed up for a day`;
}

/** Put a crate's worth into the district (share of it, if the site was under siege). */
export function deliver(s: CityState, kind: CrateKind, d: DistrictState, share: number): void {
  const amount = AMOUNT[kind] * share;
  if (kind === 'medicine') d.medicine += amount;
  else if (kind === 'rations') d.rations += amount;
  else if (d.troops.strength >= 1) d.troops.ammo += amount;
  else d.cooldowns.policeArmed = s.t;
}

/** Whether the district's police are freshly armed from a delivery. */
export function policeArmed(s: CityState, d: DistrictState): boolean {
  return s.t - (d.cooldowns.policeArmed ?? -Infinity) < POLICE_ARMED_MINUTES;
}

/** Whether the district is short of medicine: an outbreak with more bitten than it can isolate. */
export function needsMedicine(d: DistrictState): boolean {
  return !!d.flags.outbreak && d.infected >= 5 && d.medicine < d.infected * DOSES_PER_ISOLATION;
}

/** Days of food left, counting what the district's sites still hold to hand out. */
export function foodDays(d: DistrictState, sites: Site[]): number {
  const held = sites.reduce((n, x) => n + (x.district === d.id && x.status !== 'fallen' ? x.rations : 0), 0);
  return (d.rations + held) / Math.max(1, people(d));
}

export function needsFood(d: DistrictState, sites: Site[]): boolean {
  return foodDays(d, sites) < 1;
}

export function needsAmmo(d: DistrictState): boolean {
  return d.troops.strength >= 10 && d.troops.ammo / d.troops.strength < 100;
}

/**
 * What a district needs, in words, most pressing first.
 * @param sites the city's sites (food stocked at the district's own count)
 */
export function needs(d: DistrictState, sites: Site[]): string[] {
  if (d.status === 'overrun' || d.kind === 'airbase' || d.kind === 'army') return [];
  return [
    needsMedicine(d) && 'medicine',
    needsFood(d, sites) && `food (${foodDays(d, sites).toFixed(1)} days)`,
    needsAmmo(d) && 'ammunition',
  ].filter((x): x is string => !!x);
}

/** Whether a site takes the kind of crate its district needs (for its beacon). */
export function siteNeed(d: DistrictState, site: Site, sites: Site[]): CrateKind | null {
  if (site.status === 'fallen') return null;
  if (needsMedicine(d) && PLACES.medicine.includes(site.kind)) return 'medicine';
  if (needsFood(d, sites) && PLACES.rations.includes(site.kind)) return 'rations';
  return null;
}
