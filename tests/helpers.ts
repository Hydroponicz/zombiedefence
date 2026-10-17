import { establishJoc } from '../src/sim/command';
import { DISTRICT_TEMPLATES } from '../src/sim/layout';
import type { CitySim } from '../src/sim/CitySim';
import type { CityState } from '../src/sim/types';

/**
 * Mid-game: the Joint Operations Command is up at the airport and every district has its army
 * platoon (most tests are about what happens once the military is in the city).
 */
export function deployed<T extends CitySim | CityState>(target: T): T {
  const s: CityState = 'state' in target ? (target as CitySim).state : (target as CityState);
  establishJoc(s, () => {}, true);
  for (const d of s.districts) {
    const n = DISTRICT_TEMPLATES[d.id].troops;
    if (n <= 0) continue;
    d.flags.armyDeployed = true;
    d.troops.strength = n;
    d.troops.ammo = n * 300;
  }
  return target;
}
