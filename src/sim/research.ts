// Research: the scientists brought out of the city earn points at the base, spent on things that
// change how the evacuation goes. Keeping the lab districts alive long enough to extract their
// teams is what pays for them.

import type { CityState, Lure, ResearchId, Severity } from './types';

type Emit = (district: number | null, severity: Severity, text: string, radio?: boolean) => void;

export interface Project {
  name: string;
  cost: number;
  requires?: ResearchId;
  /** What it does, for the panel. */
  effect: string;
}

export const RESEARCH: Record<ResearchId, Project> = {
  rapidTests: {
    name: 'Rapid bite tests',
    cost: 120,
    effect: 'Police checkpoints catch twice as many of the bitten, fewer slip through with people fleeing, and the bitten are caught before they board your helicopter.',
  },
  noiseLures: {
    name: 'Noise lures',
    cost: 200,
    effect: 'Load sirens at the base and drop them from the air (F / X). For six hours a lure pulls hordes and the district\'s dead toward it.',
  },
  loudspeaker: {
    name: 'Loudspeaker',
    cost: 150,
    effect: 'People come to the helicopter when called: boarding civilians and shelters takes half the time.',
  },
  doorGun: {
    name: 'Door gun',
    cost: 250,
    effect: 'A mounted door gun fires on the dead near a low helicopter, even with no troops aboard.',
  },
  heavySling: {
    name: 'Heavy sling',
    cost: 150,
    effect: 'Fuel bladders hold 3,000 L instead of 2,000 L.',
  },
  vaccine: {
    name: 'Troop vaccine',
    cost: 600,
    requires: 'rapidTests',
    effect: 'Vaccinated soldiers don\'t turn when bitten, and take fewer losses.',
  },
  antiviral: {
    name: 'Antiviral',
    cost: 1200,
    requires: 'vaccine',
    effect: 'The bitten among your evacuees are treated at the base instead of being turned away at the gate.',
  },
};

export const RESEARCH_ORDER = Object.keys(RESEARCH) as ResearchId[];

/** Hours a noise lure keeps sounding. */
export const LURE_HOURS = 6;
/** Lures the helicopter can carry. */
export const LURE_CAPACITY = 2;

export function hasResearch(s: CityState, id: ResearchId): boolean {
  return s.unlocked.includes(id);
}

/** Points earned and not yet spent. */
export function researchPoints(s: CityState): number {
  return s.research - s.researchSpent;
}

/** Points earned an hour by the scientists at the bases. */
export function researchRate(s: CityState): number {
  const airport = s.districts.find((d) => d.kind === 'airbase');
  return s.army.scientists + (airport?.scientists ?? 0);
}

/** Why a project can't be started now, or null if it can. */
export function researchBlocked(s: CityState, id: ResearchId): string | null {
  const p = RESEARCH[id];
  if (hasResearch(s, id)) return 'Done';
  if (p.requires && !hasResearch(s, p.requires)) return `Needs ${RESEARCH[p.requires].name}`;
  // Points accrue in fractions: a hair short is enough.
  if (researchPoints(s) < p.cost - 1e-6) return `Needs ${Math.ceil(p.cost - researchPoints(s))} more points`;
  return null;
}

export function startResearch(s: CityState, id: ResearchId, emit: Emit): boolean {
  if (researchBlocked(s, id)) return false;
  s.researchSpent += RESEARCH[id].cost;
  s.unlocked.push(id);
  emit(null, 'info', `Research complete: ${RESEARCH[id].name}. ${RESEARCH[id].effect}`, true);
  return true;
}

/** Lures still sounding; each keeps its district loud. */
export function updateLures(s: CityState, emit: Emit): void {
  s.lures = s.lures.filter((l: Lure) => {
    if (s.t < l.until) {
      const d = s.districts[l.district];
      if (d) d.noise = Math.max(d.noise, 3);
      return true;
    }
    emit(l.district, 'info', `A noise lure in ${s.districts[l.district]?.name ?? 'the city'} has gone quiet.`);
    return false;
  });
}
