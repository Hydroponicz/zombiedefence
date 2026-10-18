// The campaign: the city can't be saved, only emptied. Once Command authorizes the Joint
// Operations Command it sets a deadline: at 06:00 nine days on the city is sealed and sterilized.
// The last day is the final evacuation, with flights out every hour and the airport's gates open
// to refugees. The campaign ends at the deadline, or early if Kessler Airport falls or the player
// runs out of helicopters.
//
// Every morning the day is reported, with what the player's own actions changed: the day is
// replayed from its start without them (see CitySim) and the two are compared.

import { DAY_START, dayNumber, MINUTES_PER_DAY } from './clock';
import type { Campaign, CampaignOutcome, CityState, DayReport, Severity } from './types';
import { notable } from './daystats';

type Emit = (district: number | null, severity: Severity, text: string, radio?: boolean) => void;

/** Days from Command's authorization to the seal. */
export const SEAL_DAYS = 9;
/** The final evacuation: the last day before the seal. */
export const FINAL_EVAC_MINUTES = MINUTES_PER_DAY;
/** Warnings before the seal, in minutes. */
const WARNINGS = [3 * MINUTES_PER_DAY, 6 * 60, 60];

/** Ratings by the lives the player's own actions saved. */
export const RATINGS: [number, string][] = [
  [20000, 'Guardian angel'],
  [8000, 'Lifeline'],
  [3000, 'Steady hands'],
  [800, 'Doing what you can'],
  [0, 'Too little, too late'],
];

export function createCampaign(population: number): Campaign {
  return { deadline: null, outcome: 'running', endedAt: null, reports: [], startPopulation: population, warned: [] };
}

/** People alive in the city or waiting at the bases. */
export function living(s: CityState): number {
  return s.districts.reduce((n, d) => n + d.population, 0) + s.army.population + s.cargo.civilians;
}

/** People out of the city: flown out, or away by road. */
export function escaped(s: CityState): number {
  return s.stats.flownOut + s.traffic.fled;
}

export function minutesLeft(s: CityState): number | null {
  return s.campaign.deadline === null ? null : Math.max(0, s.campaign.deadline - s.t);
}

export function finalEvacuation(s: CityState): boolean {
  const left = minutesLeft(s);
  return left !== null && left <= FINAL_EVAC_MINUTES && s.campaign.outcome === 'running';
}

export function savedByPlayer(s: CityState): number {
  return s.campaign.reports.reduce((n, r) => n + r.saved, 0);
}

export function rating(saved: number): string {
  return RATINGS.find(([at]) => saved >= at)![1];
}

/** Once a minute: set the deadline, warn as it nears, open the final evacuation, and end the campaign. */
export function updateCampaign(s: CityState, emit: Emit): CampaignOutcome | null {
  const c = s.campaign;
  if (c.outcome !== 'running') return null;
  if (c.deadline === null && s.flags.jocAuthorized) {
    const day = dayNumber(s.t) + SEAL_DAYS;
    c.deadline = (day - 1) * MINUTES_PER_DAY + DAY_START;
    emit(null, 'critical', `Command: the city cannot be held. At 06:00 on day ${day} it will be sealed and sterilized. ` +
      'Get as many people out as you can.', true);
  }
  if (c.deadline !== null) {
    const left = c.deadline - s.t;
    for (const w of WARNINGS) {
      if (left <= w && !c.warned.includes(w)) {
        c.warned.push(w);
        emit(null, 'critical', `Command: ${w >= MINUTES_PER_DAY ? `${w / MINUTES_PER_DAY} days` : w >= 120 ? `${w / 60} hours` : 'one hour'} until the city is sealed.`, true);
      }
    }
    if (left <= FINAL_EVAC_MINUTES && !s.flags.finalEvac) {
      s.flags.finalEvac = true;
      emit(null, 'critical', 'Command: the final evacuation has begun. Flights leave Kessler Airport every hour, and its gates are ' +
        'open to everyone who can reach them. Bring in everyone you can.', true);
    }
    if (left <= 0) return end(s, 'sealed', emit);
  }
  if (s.collapsed) return end(s, 'fallen', emit);
  // A helicopter the player was waiting for has come back.
  if (s.flags.awaitingAirframe) {
    const spare = s.airframes.find((a) => a.status === 'ready');
    if (spare) {
      spare.status = 'lost';
      s.flags.awaitingAirframe = false;
      emit(null, 'info', `${spare.name} is back at base: it's your replacement.`, true);
    } else if (!s.airframes.some((a) => a.status === 'flying')) {
      s.flags.grounded = true;
    }
  }
  if (s.flags.grounded) return end(s, 'grounded', emit);
  return null;
}

/**
 * The player's helicopter is lost: a spare at the base becomes the replacement. With none ready,
 * the player waits for one to come back; with none at all, the player is grounded for good.
 */
export function replaceHelicopter(s: CityState, emit: Emit): void {
  const spare = s.airframes.find((a) => a.status === 'ready');
  if (spare) {
    spare.status = 'lost';
    const left = s.airframes.filter((a) => a.status !== 'lost').length;
    emit(null, 'warn', `${spare.name} is your replacement. ${left ? `${left} helicopter${left > 1 ? 's' : ''} left in the fleet.` : 'It is the last one.'}`, true);
  } else if (s.airframes.some((a) => a.status === 'flying')) {
    s.flags.awaitingAirframe = true;
    emit(null, 'warn', 'No spare helicopter at base: you will take the next one back.', true);
  } else {
    s.flags.grounded = true;
  }
}

function end(s: CityState, outcome: CampaignOutcome, emit: Emit): CampaignOutcome {
  const c = s.campaign;
  c.outcome = outcome;
  c.endedAt = s.t;
  const text = outcome === 'sealed'
    ? 'The city is sealed. The last flight has left Kessler Airport.'
    : outcome === 'fallen'
      ? 'Kessler Airport has fallen. The evacuation is over.'
      : 'There are no helicopters left to fly. The evacuation goes on without you.';
  emit(null, 'critical', text, true);
  return outcome;
}

/**
 * Compare a day as it went with the same day replayed from its start without the player.
 * @param before the state at the start of the day
 * @param after the state now
 * @param without the state now had the player done nothing
 */
export function compareDay(before: CityState, after: CityState, without: CityState): DayReport {
  const lost = (a: CityState, b: CityState) =>
    b.districts.filter((d, i) => d.status === 'overrun' && a.districts[i].status !== 'overrun').map((d) => d.name);
  const held = (s: CityState) => s.districts.filter((d) => d.status !== 'overrun').length;
  const fell = lost(before, after);
  const fellWithout = lost(before, without);
  const d = (k: keyof CityState['stats']) => after.stats[k] - before.stats[k];
  return {
    day: dayNumber(before.t),
    from: before.t,
    to: after.t,
    flownOut: d('flownOut'),
    fled: after.traffic.fled - before.traffic.fled,
    evacuated: d('civiliansEvacuated'),
    scientists: d('scientistsEvacuated'),
    troops: d('troopsDeployed'),
    crates: d('cratesDelivered'),
    lostInCrashes: d('lostInCrashes'),
    alive: living(after),
    held: held(after),
    fell,
    // To the nearest ten: the replay drifts by a handful of people from things like rotor noise
    // while parked, which aren't the player's doing.
    saved: Math.round((living(after) + escaped(after) - (living(without) + escaped(without))) / 10) * 10 || 0,
    heldBecause: fellWithout.filter((n) => !fell.includes(n)),
    lostAnyway: fell.filter((n) => !fellWithout.includes(n)),
    districts: (after.today ?? []).filter(notable).map((day) => ({
      ...structuredClone(day),
      isolatedWithout: without.today?.[day.district]?.isolated ?? 0,
      untreatedWithout: without.today?.[day.district]?.untreated ?? 0,
    })),
  };
}

/** The day's report in a sentence or two, for the radio. */
export function describeReport(r: DayReport): string {
  const parts = [`Day ${r.day} report: ${Math.round(r.flownOut).toLocaleString('en-US')} flown out`];
  if (r.evacuated) parts.push(`${r.evacuated} brought in by you`);
  if (r.fell.length) parts.push(`${r.fell.join(', ')} fell`);
  let text = parts.join(', ') + '.';
  if (r.saved > 0) text += ` Because of you, ${r.saved.toLocaleString('en-US')} more people are alive or out of the city.`;
  if (r.heldBecause.length) text += ` ${r.heldBecause.join(' and ')} held because of you.`;
  const isolated = Math.round((r.districts ?? []).reduce((n, d) => n + d.isolated - d.isolatedWithout, 0));
  if (isolated >= 10) text += ` Your deliveries meant ${isolated.toLocaleString('en-US')} more of the bitten were found and isolated.`;
  const worst = (r.districts ?? []).filter((d) => d.untreated >= 20).sort((a, b) => b.untreated - a.untreated)[0];
  if (worst) text += ` With no medicine, ${Math.round(worst.untreated).toLocaleString('en-US')} turned untreated in the worst-hit district.`;
  return text;
}
