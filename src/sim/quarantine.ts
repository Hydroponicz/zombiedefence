// Kessler Airport is sealed: no infection or zombie gets inside until every other district
// has fallen. Hordes are kept outside its perimeter, the dead don't drift in, refugees and evacuees
// are screened at the gate, and the bitten caught there are put down. Once the whole city has been
// overrun the seal is broken for good (`flags.baseOpen`).

import type { CityState, DistrictState } from './types';

export function baseSealed(s: CityState): boolean {
  return !s.flags.baseOpen;
}

export function isBase(d: DistrictState | undefined): boolean {
  return d?.kind === 'airbase';
}

/** Break the seal once every other district is overrun. Returns true on the tick it happens. */
export function checkSeal(s: CityState): boolean {
  if (s.flags.baseOpen) return false;
  if (!s.districts.every((d) => isBase(d) || d.status === 'overrun')) return false;
  s.flags.baseOpen = true;
  return true;
}

/** Bitten people arriving at the sealed base are caught at the checkpoint. Returns how many. */
export function screenAtGate(s: CityState, base: DistrictState, infected: number): number {
  if (infected <= 0) return 0;
  // Camp Ridgeway screens everyone, always.
  if (baseSealed(s) || base.kind === 'army') {
    base.dead += infected;
    return infected;
  }
  base.infected += infected;
  return 0;
}
