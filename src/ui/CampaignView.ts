// The campaign on screen: the countdown to the seal under the clock, each morning's report card,
// and the end screen with the score.

import { escaped, finalEvacuation, minutesLeft, rating, savedByPlayer } from '../sim/campaign';
import type { ArmyCargo, CityState, DayReport } from '../sim/types';

/** How long a morning report stays up, in real seconds. */
const REPORT_SECONDS = 40;
/** Lines of supply news in a report, at most. */
const SUPPLY_LINES = 5;

const fmt = (n: number) => Math.round(n).toLocaleString('en-US');

const TITLES = {
  sealed: 'The city is sealed',
  fallen: 'Kessler Airport has fallen',
  grounded: 'Grounded',
} as const;

const SUBTITLES = {
  sealed: 'The last flight has left. Whoever is still in the city is on their own.',
  fallen: 'The dead are inside the last stronghold. The evacuation is over.',
  grounded: 'There are no helicopters left to fly. The evacuation goes on without you.',
} as const;

export class CampaignView {
  private countdown = el('hud-countdown');
  private report = el('hud-report');
  private end = el('campaign-end');
  private reportTimer = 0;
  private seenReports = -1;
  private lastCountdown = '';
  private endShown = false;

  /** Whether the end screen is up (it takes the confirm and new-city keys). */
  get endVisible(): boolean {
    return !this.end.hidden;
  }

  update(dt: number, s: CityState | null): void {
    if (!s) return;
    this.updateCountdown(s);

    // A new morning report: show it for a while. (Not the ones already there when the game loads.)
    const n = s.campaign.reports.length;
    if (this.seenReports < 0) this.seenReports = n;
    if (n > this.seenReports) {
      this.seenReports = n;
      this.showReport(s.campaign.reports[n - 1], s);
    }
    if (this.reportTimer > 0) {
      this.reportTimer -= dt;
      if (this.reportTimer <= 0) this.report.hidden = true;
    }

    if (s.campaign.outcome !== 'running' && !s.flags.freePlay && !this.endShown) {
      this.endShown = true;
      this.showEnd(s);
    }
  }

  /** Close the end screen and fly on. */
  hideEnd(): void {
    this.end.hidden = true;
  }

  private updateCountdown(s: CityState): void {
    const left = minutesLeft(s);
    let text = '';
    let cls = '';
    if (s.campaign.outcome !== 'running') {
      text = s.flags.freePlay ? 'Free flight' : TITLES[s.campaign.outcome as keyof typeof TITLES];
    } else if (left !== null) {
      const d = Math.floor(left / 1440);
      const h = Math.floor((left % 1440) / 60);
      const m = Math.floor(left % 60);
      if (finalEvacuation(s)) {
        text = `Final evacuation · seal in ${h}h ${String(m).padStart(2, '0')}m`;
        cls = 'final';
      } else {
        text = `City sealed in ${d}d ${h}h`;
      }
    }
    const key = text + cls;
    if (key === this.lastCountdown) return;
    this.lastCountdown = key;
    this.countdown.hidden = !text;
    this.countdown.textContent = text;
    this.countdown.className = cls;
  }

  private showReport(r: DayReport, s: CityState): void {
    const rows: [string, string][] = [
      ['Flown out of the city', fmt(r.flownOut)],
      ['Escaped by road', fmt(r.fled)],
      ['Brought in by you', fmt(r.evacuated)],
    ];
    if (r.scientists) rows.push(['Scientists extracted', fmt(r.scientists)]);
    if (r.crates) rows.push(['Crates delivered', fmt(r.crates)]);
    if (r.troops) rows.push(['Troops deployed', fmt(r.troops)]);
    if (r.lostInCrashes) rows.push(['Lost in crashes', fmt(r.lostInCrashes)]);
    rows.push(['Districts holding', `${r.held} of 12`]);
    const lines: string[] = [];
    if (r.fell.length) lines.push(`<div class="bad">Fell: ${r.fell.join(', ')}</div>`);
    if (r.heldBecause.length) lines.push(`<div class="good">Held because of you: ${r.heldBecause.join(', ')}</div>`);
    if (r.lostAnyway.length) lines.push(`<div class="bad">Would have held without you: ${r.lostAnyway.join(', ')}</div>`);
    this.report.innerHTML = `<div class="title">Day ${r.day} report</div>
      <table>${rows.map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join('')}</table>
      <div class="impact ${r.saved > 0 ? 'good' : r.saved < 0 ? 'bad' : ''}">${impact(r.saved)}</div>
      ${lines.join('')}${supplies(r, s)}`;
    this.report.hidden = false;
    this.reportTimer = REPORT_SECONDS;
  }

  private showEnd(s: CityState): void {
    const c = s.campaign;
    const outcome = c.outcome as keyof typeof TITLES;
    const out = escaped(s);
    const saved = savedByPlayer(s);
    const days = c.reports
      .map((r) => `<tr><td>Day ${r.day}</td><td>${fmt(r.flownOut + r.fled)}</td><td>${fmt(r.evacuated)}</td>
        <td class="${r.saved > 0 ? 'good' : r.saved < 0 ? 'bad' : ''}">${r.saved > 0 ? '+' : ''}${fmt(r.saved)}</td>
        <td>${r.fell.join(', ') || '—'}</td></tr>`)
      .join('');
    this.end.innerHTML = `<div class="end-card">
      <h1>${TITLES[outcome]}</h1>
      <p class="sub">${SUBTITLES[outcome]}</p>
      <div class="score">
        <div><span>${fmt(out)}</span>people got out of the city (${Math.round((out / Math.max(1, c.startPopulation)) * 100)}%)</div>
        <div><span>${saved > 0 ? '+' : ''}${fmt(saved)}</span>lives saved by your own actions</div>
        <div><span>${rating(saved)}</span>rating</div>
      </div>
      <p class="sub">Flown out ${fmt(s.stats.flownOut)} · by road ${fmt(s.traffic.fled)} · brought in by you ${fmt(s.stats.civiliansEvacuated)} ·
        scientists ${fmt(s.stats.scientistsEvacuated)} · research ${fmt(s.research)} · lost in crashes ${fmt(s.stats.lostInCrashes)}</p>
      <table class="days"><tr><th></th><th>Got out</th><th>You brought in</th><th>Your impact</th><th>Fell</th></tr>${days}</table>
      <p class="hint"><kbd>Enter</kbd> / <kbd>A</kbd> fly on · <kbd>N</kbd> / <kbd>X</kbd> new city</p>
    </div>`;
    this.end.hidden = false;
  }
}

const cargo = (c: ArmyCargo) => [
  c.medicine >= 1 && `${fmt(c.medicine)} medicine`,
  c.rations >= 1 && `food for ${fmt(c.rations)}`,
  c.ammo >= 1 && `${fmt(c.ammo)} rounds`,
].filter(Boolean).join(', ');
const anyOf = (c: ArmyCargo) => c.medicine + c.rations + c.ammo >= 1;

/**
 * The day's supplies: what you and your pilots brought where and what it did (against the day
 * without you), what the army's trucks carried, and where shortages cost the most.
 */
function supplies(r: DayReport, s: CityState): string {
  const days = r.districts ?? [];
  if (!days.length) return '';
  const name = (id: number) => s.districts[id]?.name ?? '?';
  const out: string[] = [];
  for (const d of days) {
    const mine = [anyOf(d.delivered.you) && `you: ${cargo(d.delivered.you)}`, anyOf(d.delivered.pilots) && `pilots: ${cargo(d.delivered.pilots)}`].filter(Boolean);
    if (!mine.length) continue;
    const more = Math.round(d.isolated - d.isolatedWithout);
    const effect = more >= 5 ? ` · <span class="good">${fmt(more)} more bitten isolated because of you</span>` : '';
    out.push(`<div><b>${name(d.district)}</b> · ${mine.join(' · ')}${effect}</div>`);
  }
  const trucks = days.filter((d) => anyOf(d.delivered.trucks));
  if (trucks.length) {
    const total = trucks.reduce((a, d) => ({ medicine: a.medicine + d.delivered.trucks.medicine, rations: a.rations + d.delivered.trucks.rations, ammo: a.ammo + d.delivered.trucks.ammo }),
      { medicine: 0, rations: 0, ammo: 0 });
    out.push(`<div>Army trucks: ${cargo(total)} to ${trucks.length} district${trucks.length > 1 ? 's' : ''}</div>`);
  }
  const short = days
    .filter((d) => d.untreated >= 20 || d.dryHours >= 2)
    .sort((a, b) => b.untreated + b.dryHours * 50 - (a.untreated + a.dryHours * 50));
  for (const d of short) {
    const costs = [
      d.untreated >= 20 && `${fmt(d.untreated)} turned untreated (no medicine for ${Math.round(d.noMedicineHours)} h)`,
      d.dryHours >= 2 && `short of ammunition for ${Math.round(d.dryHours)} h`,
    ].filter(Boolean).join(' · ');
    out.push(`<div class="bad"><b>${name(d.district)}</b> · ${costs}</div>`);
  }
  if (!out.length) return '';
  return `<div class="supplies"><div class="subtitle">Supplies</div>${out.slice(0, SUPPLY_LINES + 1).join('')}</div>`;
}

function impact(saved: number): string {
  if (saved > 0) return `Because of you, ${fmt(saved)} more people are alive or out of the city.`;
  if (saved < 0) return `${fmt(-saved)} fewer people than if you'd stayed on the ground.`;
  return 'Your flights made no difference to the city today.';
}

function el(id: string): HTMLElement {
  const e = document.getElementById(id);
  if (!e) throw new Error(`Missing #${id}`);
  return e;
}
