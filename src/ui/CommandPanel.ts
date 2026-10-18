// Flight command, in five tabs: Command's requests (take them on, or hand them to a pilot), the AI
// pilot roster and their orders, research, where the army's platoons go, and the city's movement
// restrictions. Controller: LT/RT
// changes tab, D-pad ▲▼ picks a row, LB/RB moves between fields, D-pad ◀▶ changes a field, A
// presses, B closes. Keyboard: [ ] tabs, arrows, Tab, Enter, Esc. Mouse: click anything.

import type { Action } from '../input/Input';
import { formatClock } from '../sim/clock';
import { nextPlatoon, platoonSize } from '../sim/command';
import { baseOf, CRATES, requestOrder, type PlayerCommand } from '../sim/operations';
import { JOB_LABELS, orderSummary, TRIP_FUEL, validOrder } from '../sim/pilots';
import { describeNeed, openRequests, rewardText } from '../sim/requests';
import { RESEARCH, RESEARCH_ORDER, researchBlocked, researchPoints, researchRate } from '../sim/research';
import { compliance, CURFEW_FROM, CURFEW_UNTIL, FOOD_RUN_MINUTES, foodPoints, foodRunStart, lineScreening, policyAsked, POLICY_LABELS, POLICY_TERMS } from '../sim/policy';
import type { CityState, CrateKind, JobKind, Pilot, Policy, Request } from '../sim/types';

type Tab = 'requests' | 'pilots' | 'research' | 'platoons' | 'movement';
const TABS: Tab[] = ['requests', 'pilots', 'research', 'platoons', 'movement'];
const TAB_LABELS: Record<Tab, string> = { requests: 'Requests', pilots: 'Pilots', research: 'Research', platoons: 'Platoons', movement: 'Movement' };
const POLICIES: Policy[] = ['quarantine', 'curfew', 'unrestricted'];
const REQUEST_FIELDS = ['track', 'pilot', 'assign'] as const;
type RequestField = (typeof REQUEST_FIELDS)[number];

type Kind = JobKind | 'none';
interface Draft {
  kind: Kind;
  district: number;
  crate: CrateKind;
  repeat: boolean;
}

const KINDS: Kind[] = ['none', 'reinforce', 'resupply', 'evacuate', 'relieve', 'fuel'];
const CRATE_KINDS: CrateKind[] = ['rations', 'ammo', 'medicine'];
const FIELDS = ['kind', 'district', 'crate', 'repeat', 'issue', 'dismiss'] as const;
/** A candidate's editor has just two buttons. */
const CANDIDATE_FIELDS: readonly Field[] = ['issue', 'dismiss'];
type Field = (typeof FIELDS)[number];

const pct = (v: number) => `${Math.round(v * 100)}%`;
const time = (t: number) => formatClock(t).split('· ')[1];

export class CommandPanel {
  visible = false;
  private tab: Tab = 'requests';
  /** Row and field per tab, so switching tabs keeps your place. */
  private rows: Record<Tab, number> = { requests: 0, pilots: 0, research: 0, platoons: 0, movement: 0 };
  private fields: Record<Tab, number> = { requests: 0, pilots: 0, research: 0, platoons: 0, movement: 0 };
  /** The pilot picked for each request. */
  private picks = new Map<number, number>();
  private drafts = new Map<number, Draft>();
  private lastKey = '';
  private state: CityState | null = null;

  private get row(): number {
    return this.rows[this.tab];
  }

  private set row(v: number) {
    this.rows[this.tab] = v;
  }

  private get field(): number {
    return this.fields[this.tab];
  }

  private set field(v: number) {
    this.fields[this.tab] = v;
  }

  constructor(private el: HTMLElement, private send: (cmd: PlayerCommand) => void) {
    el.addEventListener('click', (e) => {
      const tab = (e.target as HTMLElement).closest<HTMLElement>('[data-tab]');
      if (tab) {
        this.tab = tab.dataset.tab as Tab;
        this.lastKey = '';
        return;
      }
      const target = (e.target as HTMLElement).closest<HTMLElement>('[data-row]');
      if (!target) return;
      if (Number(target.dataset.row) !== this.row) this.field = 0;
      this.row = Number(target.dataset.row);
      if (target.dataset.field) this.field = this.fieldIndex(target.dataset.field);
      const step = Number(target.dataset.step ?? 0);
      if (step) this.change(step);
      if (target.dataset.press) this.press();
      this.lastKey = '';
    });
  }

  private fieldIndex(name: string): number {
    if (this.tab === 'requests') return Math.max(0, REQUEST_FIELDS.indexOf(name as RequestField));
    return Math.max(0, FIELDS.indexOf(name as Field));
  }

  private fieldCount(): number {
    return this.tab === 'requests' ? REQUEST_FIELDS.length : this.tab === 'pilots' ? FIELDS.length : 1;
  }

  /** How many rows the current tab has. */
  private rowCount(): number {
    const s = this.state!;
    switch (this.tab) {
      case 'requests':
        return openRequests(s).length;
      case 'pilots':
        return s.pilots.length;
      case 'research':
        return RESEARCH_ORDER.length;
      case 'platoons':
        return this.platoonRows(s).length;
      case 'movement':
        return POLICIES.length;
    }
  }

  /** Open on the Requests tab with a request selected. */
  showRequest(id: number): void {
    this.tab = 'requests';
    const s = this.state;
    if (s) this.row = Math.max(0, openRequests(s).sort((a, b) => a.deadline - b.deadline).findIndex((r) => r.id === id));
    this.fields.requests = REQUEST_FIELDS.indexOf('pilot');
    if (!this.visible) this.toggle();
    this.lastKey = '';
  }

  toggle(): boolean {
    this.visible = !this.visible;
    this.el.hidden = !this.visible;
    this.lastKey = '';
    return this.visible;
  }

  /** Navigation and edits while the panel is open (closing is handled by the caller). */
  handle(actions: Set<Action>): void {
    if (!this.visible || !this.state) return;
    const step = (actions.has('rtPress') || actions.has('timeFaster') ? 1 : 0) - (actions.has('ltPress') || actions.has('timeSlower') ? 1 : 0);
    if (step) {
      this.tab = TABS[(TABS.indexOf(this.tab) + step + TABS.length) % TABS.length];
      this.lastKey = '';
      return;
    }
    const count = Math.max(1, this.rowCount());
    const row = this.row;
    if (actions.has('dpadUp') || actions.has('arrowUp')) this.row = (this.row - 1 + count) % count;
    if (actions.has('dpadDown') || actions.has('arrowDown')) this.row = (this.row + 1) % count;
    // A different row starts at the first field, never on a destructive button.
    if (this.row !== row) this.field = 0;
    const fields = this.fieldCount();
    if (actions.has('next')) this.field = (this.field + 1) % fields;
    if (actions.has('prev')) this.field = (this.field - 1 + fields) % fields;
    if (actions.has('dpadLeft') || actions.has('arrowLeft')) this.change(-1);
    if (actions.has('dpadRight') || actions.has('arrowRight')) this.change(1);
    if (actions.has('confirm')) this.press();
  }

  render(state: CityState | null): void {
    this.state = state;
    if (!this.visible || !state) return;
    const key = JSON.stringify([this.tab, state.pilots, state.airframes, state.requests, state.unlocked, Math.floor(state.research),
      state.platoonTarget, state.flags.holdPlatoons, state.policy, Math.floor(state.t), this.rows, this.fields, [...this.drafts], [...this.picks]]);
    if (key === this.lastKey) return;
    this.lastKey = key;
    this.row = Math.min(this.row, Math.max(0, this.rowCount() - 1));
    const tabs = `<div class="cmd-tabs">${TABS.map((t) => `<span class="cmd-tab${t === this.tab ? ' on' : ''}" data-tab="${t}">${TAB_LABELS[t]}${
      t === 'requests' && openRequests(state).length ? ` <b>${openRequests(state).length}</b>` : ''}</span>`).join('')}</div>`;
    const hint = `<div class="cmd-hint">LT/RT tab · D-pad ▲▼ row · LB/RB field · D-pad ◀▶ change · A press · B close &nbsp;|&nbsp; [ ] · ↑↓ · Tab · ←→ · Enter · Esc/P &nbsp;|&nbsp; or click</div>`;
    const body = this.tab === 'requests' ? this.requestsTab(state)
      : this.tab === 'research' ? this.researchTab(state)
        : this.tab === 'platoons' ? this.platoonsTab(state)
          : this.tab === 'movement' ? this.movementTab(state)
            : this.pilotsTab(state);
    this.el.innerHTML = `<div class="cmd-card">${tabs}${body}${hint}</div>`;
  }

  // --- Requests -----------------------------------------------------------------------------------

  private requestsTab(s: CityState): string {
    const open = openRequests(s).sort((a, b) => a.deadline - b.deadline);
    const closed = s.requests.filter((r) => r.status !== 'open').slice(-4).reverse();
    const head = `<div class="cmd-head"><h2>Command requests</h2>
      <div class="cmd-fleet"><span>More come in as the city needs them. Take them on yourself, hand them to a pilot, or let them go.</span>
      <span>Done <b>${s.stats.requestsDone}</b></span></div></div>`;
    const rows = open.map((r, i) => this.requestRow(s, r, i)).join('');
    const past = closed.map((r) => `<div class="cmd-row gone"><div class="cmd-line"><span>${r.title}</span>
      <span class="cmd-status">${r.status === 'done' ? '<span class="good">Done</span>' : '<span class="warn">Failed</span>'}</span></div></div>`).join('');
    const none = s.flags.joc ? '<p>No requests right now.</p>'
      : '<p class="warn">Command will start tasking you once the Joint Operations Command is set up at Kessler Airport. ' +
        'Fly the command team in from Camp Ridgeway when it\'s authorized.</p>';
    return `${head}<div class="cmd-rows">${rows || none}${past}</div>`;
  }

  private requestRow(s: CityState, r: Request, i: number): string {
    const selected = i === this.row;
    const left = Math.max(0, r.deadline - s.t);
    const urgent = left < 45;
    const leftText = left >= 60 ? `${Math.floor(left / 60)}h ${String(Math.floor(left % 60)).padStart(2, '0')}m` : `${Math.floor(left)} min`;
    const pilot = r.assigned === null ? null : s.pilots.find((p) => p.id === r.assigned);
    const status = [r.tracked && '<span class="good">Taken on</span>', pilot && `Assigned to ${pilot.name}`].filter(Boolean).join(' · ');
    const editor = selected ? this.requestEditor(s, r, i) : '';
    return `<div class="cmd-row${selected ? ' selected' : ''}" data-row="${i}">
        <div class="cmd-line"><span class="cmd-name">${r.tracked ? '▶ ' : ''}${r.title}</span>
          <span class="cmd-status${urgent ? ' warn' : ''}">${leftText} left</span></div>
        <div class="cmd-line"><span class="cmd-order">${describeNeed(r)} · ${Math.floor(r.progress)} of ${r.needed} done</span>
          <span class="cmd-order">Reward: ${rewardText(r.reward)}${status ? ` · ${status}` : ''}</span></div>
        ${editor}
      </div>`;
  }

  /** Pilots who could take a request on. */
  private crewFor(s: CityState, r: Request): Pilot[] {
    if (!validOrder(s, requestOrder(r))) return [];
    return s.pilots.filter((p) => p.hired && !['dead', 'deserted', 'stranded'].includes(p.status));
  }

  private requestEditor(s: CityState, r: Request, i: number): string {
    const focus = REQUEST_FIELDS[this.field % REQUEST_FIELDS.length];
    const crew = this.crewFor(s, r);
    const pick = crew.find((p) => p.id === this.picks.get(r.id)) ?? crew[0];
    const button = (name: RequestField, label: string, enabled = true) =>
      `<span class="cmd-button${focus === name ? ' focus' : ''}${enabled ? '' : ' off'}" data-row="${i}" data-field="${name}" data-press="1">${label}</span>`;
    const pilotField = crew.length
      ? `<span class="cmd-field${focus === 'pilot' ? ' focus' : ''}" data-row="${i}" data-field="pilot">
          <small>Pilot</small><span data-row="${i}" data-field="pilot" data-step="-1">◀</span> ${pick!.name} (${pick!.status === 'idle' ? 'idle' : pick!.status})
          <span data-row="${i}" data-field="pilot" data-step="1">▶</span></span>`
      : `<span class="cmd-field off" data-row="${i}" data-field="pilot"><small>Pilot</small>${
        !validOrder(s, requestOrder(r)) ? 'Not a job for a pilot yet' : 'No pilots'}</span>`;
    return `<div class="cmd-editor">
        ${button('track', r.tracked ? 'Drop it' : 'Take it on')}
        ${pilotField}
        ${button('assign', 'Hand it to the pilot', crew.length > 0)}
      </div>`;
  }

  // --- Research -----------------------------------------------------------------------------------

  private researchTab(s: CityState): string {
    const head = `<div class="cmd-head"><h2>Research</h2><div class="cmd-fleet">
      <span>Points <b>${Math.floor(researchPoints(s))}</b></span>
      <span>Scientists at base <b>${Math.floor(researchRate(s))}</b> · +${Math.floor(researchRate(s))} an hour</span>
      <span>Extract research teams to earn more</span></div></div>`;
    const rows = RESEARCH_ORDER.map((id, i) => {
      const p = RESEARCH[id];
      const blocked = researchBlocked(s, id);
      const selected = i === this.row;
      const status = blocked === 'Done' ? '<span class="good">Done</span>' : blocked ?? '<span class="good">Ready to research</span>';
      return `<div class="cmd-row${selected ? ' selected' : ''}${blocked === 'Done' ? ' done' : ''}" data-row="${i}">
        <div class="cmd-line"><span class="cmd-name">${p.name}</span><span class="cmd-status">${p.cost} points · ${status}</span></div>
        <div class="cmd-line"><span class="cmd-order">${p.effect}</span></div>
        ${selected && !blocked ? `<div class="cmd-editor"><span class="cmd-button focus" data-row="${i}" data-press="1">Research for ${p.cost} points</span></div>` : ''}
      </div>`;
    }).join('');
    return `${head}<div class="cmd-rows">${rows}</div>`;
  }

  // --- Platoons -----------------------------------------------------------------------------------

  private platoonRows(s: CityState): ('auto' | 'hold' | number)[] {
    return ['auto', 'hold', ...s.districts.filter((d) => d.kind !== 'airbase').map((d) => d.id)];
  }

  private platoonsTab(s: CityState): string {
    const airport = s.districts.find((d) => d.kind === 'airbase')!;
    const plan = nextPlatoon(s);
    const nextHour = (Math.floor(s.t / 60) + 1) * 60;
    const head = `<div class="cmd-head"><h2>Army platoons</h2><div class="cmd-fleet">
      ${!s.flags.joc ? '<span class="warn">Platoons deploy into the city once the JOC is set up at Kessler Airport.</span>' : ''}
      <span>Troops at the airport <b>${Math.floor(airport.troops.strength)}</b></span>
      <span>Next platoon ${s.flags.holdPlatoons ? '<b>held</b>' : plan ? `at <b>${time(nextHour)}</b> → <b>${plan.district.name}</b> (${plan.size}, ${plan.chosenBy === 'you' ? 'your choice' : "Command's choice"})` : '<b>none needed</b>'}</span>
      </div></div>`;
    const rows = this.platoonRows(s).map((row, i) => {
      const selected = i === this.row;
      const chosen = row === 'auto' ? s.platoonTarget === null && !s.flags.holdPlatoons : row === 'hold' ? !!s.flags.holdPlatoons : s.platoonTarget === row && !s.flags.holdPlatoons;
      let name: string;
      let detail: string;
      if (row === 'auto') {
        name = "Command's choice";
        detail = 'Districts without a platoon, the ones under attack first';
      } else if (row === 'hold') {
        name = 'Hold them at the airport';
        detail = 'No platoon goes out until you choose';
      } else {
        const d = s.districts[row];
        name = d.name;
        detail = d.status === 'overrun' ? 'Overrun' : `${d.status} · troops ${Math.floor(d.troops.strength)} · police ${Math.floor(d.police.officers)} · ` +
          `platoon of ${platoonSize(d)}${d.flags.armyDeployed ? ' · has had one' : ''}`;
      }
      const enabled = typeof row !== 'number' || s.districts[row].status !== 'overrun';
      return `<div class="cmd-row${selected ? ' selected' : ''}${enabled ? '' : ' gone'}" data-row="${i}">
        <div class="cmd-line"><span class="cmd-name">${chosen ? '▶ ' : ''}${name}</span><span class="cmd-status">${detail}</span></div>
        ${selected && enabled && !chosen ? `<div class="cmd-editor"><span class="cmd-button focus" data-row="${i}" data-press="1">${
          row === 'auto' ? "Leave it to Command" : row === 'hold' ? 'Hold the platoons' : `Send the next platoon to ${s.districts[row].name}`}</span></div>` : ''}
      </div>`;
    }).join('');
    return `${head}<div class="cmd-rows">${rows}</div>`;
  }

  // --- Movement restrictions ----------------------------------------------------------------------

  private movementTab(s: CityState): string {
    const asked = policyAsked(s);
    const head = `<div class="cmd-head"><h2>Movement restrictions</h2><div class="cmd-fleet">
      ${asked ? `<span>In force: <b>${POLICY_LABELS[s.policy]}</b></span>`
        : '<span class="warn">Command will ask for your call once the infection spreads after the state of emergency.</span>'}
      <span>Kept indoors, people meet fewer of the dead and carry fewer of the bitten across the city, but fewer get out, the power grid's staff can't all get to work, and patience wears thin.</span>
      </div></div>`;
    const effects: Record<Policy, string> = {
      quarantine: 'Each district goes to its food points once a day, all at once. An unscreened line spreads the bite; post soldiers at the supermarkets to screen it and catch the bitten instead.',
      curfew: 'Off the streets at night and in the afternoon, when the dead are about. Fewer drive out of the city.',
      unrestricted: 'Nothing changes: people shop, work, flee and drive out as they please.',
    };
    const rows = POLICIES.map((p, i) => {
      const selected = i === this.row;
      const chosen = asked && s.policy === p;
      return `<div class="cmd-row${selected ? ' selected' : ''}${asked ? '' : ' gone'}" data-row="${i}">
        <div class="cmd-line"><span class="cmd-name">${chosen ? '▶ ' : ''}${POLICY_LABELS[p]}</span><span class="cmd-status">${POLICY_TERMS[p]}</span></div>
        <div class="cmd-line"><span class="cmd-order">${effects[p]}</span></div>
        ${selected && asked && !chosen ? `<div class="cmd-editor"><span class="cmd-button focus" data-row="${i}" data-press="1">Order ${POLICY_LABELS[p].toLowerCase()}</span></div>` : ''}
      </div>`;
    }).join('');
    // How it's holding in each district.
    const live = s.districts.filter((d) => d.kind !== 'airbase' && d.status !== 'overrun');
    const table = asked && s.policy !== 'unrestricted' ? `<div class="cmd-rows">${live.map((d) => {
      const c = compliance(s, d);
      const points = foodPoints(s, d).length;
      const extra = s.policy === 'quarantine'
        ? `food run ${time(foodRunStart(d))}–${time(foodRunStart(d) + FOOD_RUN_MINUTES)} · ${points ? `${points} food point${points > 1 ? 's' : ''} · line screened ${pct(lineScreening(s, d))}` : '<span class="warn">no food point</span>'}`
        : `out ${time(CURFEW_FROM)}–${time(CURFEW_UNTIL)}`;
      return `<div class="cmd-row gone"><div class="cmd-line"><span>${d.name}</span>
        <span class="cmd-status">${c < 0.5 ? '<span class="warn">' : ''}keeping to it ${pct(c)}${c < 0.5 ? '</span>' : ''} · ${extra}</span></div></div>`;
    }).join('')}</div>` : '';
    return `${head}<div class="cmd-rows">${rows}</div>${table}`;
  }

  // --- Pilots -------------------------------------------------------------------------------------

  private pilotsTab(state: CityState): string {
    const base = baseOf(state);
    const crew = state.pilots.filter((p) => p.hired && !['dead', 'deserted'].includes(p.status));
    const candidates = state.pilots.filter((p) => !p.hired && !['dead', 'deserted'].includes(p.status)).length;
    const wages = crew.reduce((s, p) => s + p.wage, 0);
    const ready = state.airframes.filter((a) => a.status === 'ready').length;
    const flying = state.airframes.filter((a) => a.status === 'flying').length;
    const header = `<div class="cmd-head">
        <h2>Pilots</h2>
        <div class="cmd-fleet">
          <span>Pilots <b>${crew.length}</b>${candidates ? ` · <b>${candidates}</b> looking for work` : ''}</span>
          <span>Helicopters <b>${ready}</b> ready · <b>${flying}</b> flying</span>
          <span>Base rations <b>${Math.floor(base.rations).toLocaleString('en-US')}</b> · wages <b>${wages.toLocaleString('en-US')}</b>/day at 06:00</span>
          <span>Base fuel <b>${Math.floor(base.fuel).toLocaleString('en-US')} L</b> · ${TRIP_FUEL} L a trip</span>
        </div>
      </div>`;

    const rows = state.pilots.map((p, i) => this.pilotRow(state, p, i)).join('');
    return `${header}<div class="cmd-rows">${rows || '<p>No pilots yet. Evacuees sometimes turn out to be pilots.</p>'}</div>`;
  }

  private pilotRow(s: CityState, p: Pilot, i: number): string {
    const gone = p.status === 'dead' || p.status === 'deserted';
    const selected = i === this.row;
    const bar = (label: string, v: number, bad = false) =>
      `<span class="trait" title="${label}">${label}<i><b style="width:${pct(v)};background:${(bad ? v > 0.6 : v < 0.35) ? 'var(--critical)' : 'var(--held)'}"></b></i></span>`;
    const editor = selected && !gone && p.status !== 'stranded' ? this.editor(s, p, i) : '';
    return `<div class="cmd-row${selected ? ' selected' : ''}${gone ? ' gone' : ''}" data-row="${i}">
        <div class="cmd-line">
          <span class="cmd-name">${p.name}</span>
          <span class="cmd-status">${this.status(s, p)}</span>
        </div>
        <div class="cmd-line">
          <span class="traits">${bar('Skill', p.skill)}${bar('Nerve', p.nerve)}${bar('Loyalty', p.loyalty)}${bar('Fatigue', p.fatigue, true)}</span>
          <span class="cmd-order">${gone ? '' : p.hired ? `${orderSummary(s, p.order)} · ${p.wage.toLocaleString('en-US')} rations/day` : `Asks ${p.wage.toLocaleString('en-US')} rations/day`}</span>
        </div>
        ${editor}
      </div>`;
  }

  private status(s: CityState, p: Pilot): string {
    const name = (d: number) => s.districts[d]?.name ?? '?';
    switch (p.status) {
      case 'flying': {
        const trip = p.trip!;
        if (trip.phase === 'outbound') return `Flying to ${name(trip.district)} · lands ${time(trip.end)}`;
        if (trip.phase === 'ground') return `On the ground in ${name(trip.district)}`;
        return `Returning from ${name(trip.district)} · back ${time(trip.end)}`;
      }
      case 'resting':
        return `Resting until ${time(p.restUntil)}`;
      case 'idle':
        if (!p.hired) return 'Looking for work';
        return p.blockedReason && s.t - p.blockedAt < 90 ? `<span class="warn">Grounded: ${p.blockedReason}</span>` : 'Idle at base';
      case 'stranded':
        return `<span class="warn">Stranded in ${name(p.district)}: land there to pick them up</span>`;
      case 'dead':
        return 'Killed';
      case 'deserted':
        return 'Deserted';
    }
  }

  private draft(p: Pilot): Draft {
    let d = this.drafts.get(p.id);
    if (!d) {
      const o = p.order;
      d = o ? { kind: o.kind, district: o.district, crate: o.crate, repeat: o.repeat } : { kind: 'none', district: this.targets('reinforce')[0], crate: 'rations', repeat: true };
      this.drafts.set(p.id, d);
    }
    return d;
  }

  private targets(kind: Kind): number[] {
    const s = this.state!;
    return s.districts
      .filter((d) => d.kind !== 'airbase' && (kind !== 'fuel' || d.features.fuelDepot))
      .map((d) => d.id);
  }

  private editor(s: CityState, p: Pilot, i: number): string {
    const d = this.draft(p);
    const focus = this.focusedField(p);
    const field = (name: Field, label: string, value: string, enabled = true) =>
      `<span class="cmd-field${focus === name ? ' focus' : ''}${enabled ? '' : ' off'}" data-row="${i}" data-field="${name}">
        <small>${label}</small>
        <span data-row="${i}" data-field="${name}" data-step="-1">◀</span> ${value} <span data-row="${i}" data-field="${name}" data-step="1">▶</span>
      </span>`;
    const button = (name: Field, label: string) =>
      `<span class="cmd-button${focus === name ? ' focus' : ''}" data-row="${i}" data-field="${name}" data-press="1">${label}</span>`;
    if (!p.hired) {
      return `<div class="cmd-editor">${button('issue', `Hire for ${p.wage.toLocaleString('en-US')} rations/day`)}${button('dismiss', 'Turn away')}</div>`;
    }
    const kindLabel = d.kind === 'none' ? 'No orders' : JOB_LABELS[d.kind];
    return `<div class="cmd-editor">
        ${field('kind', 'Order', kindLabel)}
        ${field('district', 'Where', d.kind === 'none' ? '—' : s.districts[d.district].name, d.kind !== 'none')}
        ${field('crate', 'Cargo', d.kind === 'resupply' ? CRATES[d.crate].label : '—', d.kind === 'resupply')}
        ${field('repeat', 'Repeat', d.repeat ? 'Standing route' : 'Once', d.kind !== 'none')}
        ${button('issue', 'Issue order')}
        ${p.status === 'idle' || p.status === 'resting' ? button('dismiss', 'Dismiss pilot') : ''}
      </div>`;
  }

  private selectedPilot(): Pilot | null {
    const p = this.state?.pilots[this.row];
    return p && !['dead', 'deserted', 'stranded'].includes(p.status) ? p : null;
  }

  /** Candidates only have the hire and turn-away buttons. */
  private focusedField(p: Pilot): Field {
    if (p.hired) return FIELDS[this.field];
    return CANDIDATE_FIELDS[this.field % CANDIDATE_FIELDS.length];
  }

  private change(step: number): void {
    if (this.tab === 'requests') {
      const s = this.state!;
      const r = openRequests(s).sort((a, b) => a.deadline - b.deadline)[this.row];
      if (!r || REQUEST_FIELDS[this.field] !== 'pilot') return;
      const crew = this.crewFor(s, r);
      if (!crew.length) return;
      const at = Math.max(0, crew.findIndex((p) => p.id === this.picks.get(r.id)));
      this.picks.set(r.id, crew[(at + step + crew.length) % crew.length].id);
      this.lastKey = '';
      return;
    }
    if (this.tab !== 'pilots') return;
    const p = this.selectedPilot();
    if (!p || !p.hired) return;
    const d = this.draft(p);
    const cycle = <T>(list: T[], v: T) => list[(list.indexOf(v) + step + list.length) % list.length];
    switch (FIELDS[this.field]) {
      case 'kind': {
        d.kind = cycle(KINDS, d.kind);
        const targets = this.targets(d.kind);
        if (!targets.includes(d.district)) d.district = targets[0];
        break;
      }
      case 'district':
        if (d.kind !== 'none') d.district = cycle(this.targets(d.kind), d.district);
        break;
      case 'crate':
        d.crate = cycle(CRATE_KINDS, d.crate);
        break;
      case 'repeat':
        d.repeat = !d.repeat;
        break;
    }
    this.lastKey = '';
  }

  private press(): void {
    const s = this.state;
    if (!s) return;
    if (this.tab === 'requests') {
      const r = openRequests(s).sort((a, b) => a.deadline - b.deadline)[this.row];
      if (!r) return;
      const field = REQUEST_FIELDS[this.field];
      if (field === 'track') this.send({ type: 'trackRequest', request: r.id });
      else if (field === 'assign') {
        const crew = this.crewFor(s, r);
        const pick = crew.find((p) => p.id === this.picks.get(r.id)) ?? crew[0];
        if (pick) this.send({ type: 'assignRequest', request: r.id, pilot: pick.id });
      }
      return;
    }
    if (this.tab === 'research') {
      this.send({ type: 'research', id: RESEARCH_ORDER[this.row] });
      return;
    }
    if (this.tab === 'movement') {
      if (policyAsked(s)) this.send({ type: 'setPolicy', policy: POLICIES[this.row] });
      return;
    }
    if (this.tab === 'platoons') {
      const row = this.platoonRows(s)[this.row];
      if (row === 'auto') this.send({ type: 'setPlatoon', target: null, hold: false });
      else if (row === 'hold') this.send({ type: 'setPlatoon', target: null, hold: true });
      else this.send({ type: 'setPlatoon', target: row, hold: false });
      return;
    }
    const p = this.selectedPilot();
    if (!p) return;
    if (this.focusedField(p) === 'dismiss') {
      this.send({ type: 'dismissPilot', pilot: p.id });
      this.drafts.delete(p.id);
      return;
    }
    if (!p.hired) {
      this.send({ type: 'hirePilot', pilot: p.id });
      return;
    }
    const d = this.draft(p);
    this.send({
      type: 'setOrder',
      pilot: p.id,
      order: d.kind === 'none' ? null : { kind: d.kind, district: d.district, crate: d.crate, repeat: d.repeat },
    });
  }
}
