// Each district's day, for the morning report: what was delivered there and by whom (you, your AI
// pilots, the army's trucks), and what it did, or what its lack cost: the bitten isolated, those who
// turned with no medicine there to isolate them, the dead killed and the rounds it took, and the
// hours the troops and police were short of ammunition.

import type { ArmyCargo, CityState, CrateKind, Deliverer, DistrictDay } from './types';

const empty = (): ArmyCargo => ({ medicine: 0, rations: 0, ammo: 0 });

function fresh(district: number): DistrictDay {
  return {
    district, delivered: { you: empty(), pilots: empty(), trucks: empty() },
    isolated: 0, turned: 0, untreated: 0, kills: 0, rounds: 0, dryHours: 0, noMedicineHours: 0,
  };
}

/** A new day: every district's tally starts again. */
export function startDay(s: CityState): void {
  s.today = s.districts.map((d) => fresh(d.id));
}

/** The district's tally (made if a state from before tallies has none). */
export function dayOf(s: CityState, district: number): DistrictDay {
  s.today ??= [];
  return (s.today[district] ??= fresh(district));
}

/** Supplies delivered to a district. */
export function recordDelivery(s: CityState, by: Deliverer, district: number, kind: CrateKind, amount: number): void {
  if (amount <= 0 || !s.districts[district]) return;
  dayOf(s, district).delivered[by][kind] += amount;
}

/** A district's day worth reporting: something delivered, or a shortage that cost something. */
export function notable(day: DistrictDay): boolean {
  const any = (c: ArmyCargo) => c.medicine + c.rations + c.ammo > 0;
  return any(day.delivered.you) || any(day.delivered.pilots) || any(day.delivered.trucks) || day.untreated >= 5 || day.dryHours >= 1;
}
