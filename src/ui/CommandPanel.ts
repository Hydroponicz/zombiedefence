// Flight command: the AI pilot roster and their orders. Controller: D-pad ▲▼ picks a pilot,
// LB/RB moves between fields, D-pad ◀▶ changes a field, A issues (or presses the focused
// button), B closes. Keyboard: arrows, Tab, Enter, Esc. Mouse: click anything.

import type { Action } from '../input/Input';
import { formatClock } from '../sim/clock';
import { baseOf, CRATES, type PlayerCommand } from '../sim/operations';
import { JOB_LABELS, orderSummary, TRIP_FUEL } from '../sim/pilots';
import type { CityState, CrateKind, JobKind, Pilot } from '../sim/types';

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
  private row = 0;
  private field = 0;
  private drafts = new Map<number, Draft>();
  private lastKey = '';
  private state: CityState | null = null;

  constructor(private el: HTMLElement, private send: (cmd: PlayerCommand) => void) {
    el.addEventListener('click', (e) => {
      const target = (e.target as HTMLElement).closest<HTMLElement>('[data-row]');
      if (!target) return;
      if (Number(target.dataset.row) !== this.row) this.field = 0;
      this.row = Number(target.dataset.row);
      if (target.dataset.field) this.field = FIELDS.indexOf(target.dataset.field as Field);
      const step = Number(target.dataset.step ?? 0);
      if (step) this.change(step);
      if (target.dataset.press) this.press();
      this.lastKey = '';
    });
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
    const pilots = this.state.pilots;
    const row = this.row;
    if (actions.has('dpadUp') || actions.has('arrowUp')) this.row = (this.row - 1 + pilots.length) % pilots.length;
    if (actions.has('dpadDown') || actions.has('arrowDown')) this.row = (this.row + 1) % pilots.length;
    // A different pilot starts at the first field (Order, or Hire for a candidate), never on a destructive button.
    if (this.row !== row) this.field = 0;
    if (actions.has('next')) this.field = (this.field + 1) % FIELDS.length;
    if (actions.has('prev')) this.field = (this.field - 1 + FIELDS.length) % FIELDS.length;
    if (actions.has('dpadLeft') || actions.has('arrowLeft')) this.change(-1);
    if (actions.has('dpadRight') || actions.has('arrowRight')) this.change(1);
    if (actions.has('confirm')) this.press();
  }

  render(state: CityState | null): void {
    this.state = state;
    if (!this.visible || !state) return;
    const key = JSON.stringify([state.pilots, state.airframes, Math.floor(state.t), this.row, this.field, [...this.drafts]]);
    if (key === this.lastKey) return;
    this.lastKey = key;
    this.row = Math.min(this.row, Math.max(0, state.pilots.length - 1));

    const base = baseOf(state);
    const crew = state.pilots.filter((p) => p.hired && !['dead', 'deserted'].includes(p.status));
    const candidates = state.pilots.filter((p) => !p.hired && !['dead', 'deserted'].includes(p.status)).length;
    const wages = crew.reduce((s, p) => s + p.wage, 0);
    const ready = state.airframes.filter((a) => a.status === 'ready').length;
    const flying = state.airframes.filter((a) => a.status === 'flying').length;
    const header = `<div class="cmd-head">
        <h2>Flight command</h2>
        <div class="cmd-fleet">
          <span>Pilots <b>${crew.length}</b>${candidates ? ` · <b>${candidates}</b> looking for work` : ''}</span>
          <span>Helicopters <b>${ready}</b> ready · <b>${flying}</b> flying</span>
          <span>Base rations <b>${Math.floor(base.rations).toLocaleString('en-US')}</b> · wages <b>${wages.toLocaleString('en-US')}</b>/day at 06:00</span>
          <span>Base fuel <b>${Math.floor(base.fuel).toLocaleString('en-US')} L</b> · ${TRIP_FUEL} L a trip</span>
        </div>
      </div>`;

    const rows = state.pilots.map((p, i) => this.pilotRow(state, p, i)).join('');
    const hint = `<div class="cmd-hint">D-pad ▲▼ pilot · LB/RB field · D-pad ◀▶ change · A issue · B close &nbsp;|&nbsp; ↑↓ · Tab · ←→ · Enter · Esc/P &nbsp;|&nbsp; or click</div>`;
    this.el.innerHTML = `<div class="cmd-card">${header}<div class="cmd-rows">${rows || '<p>No pilots yet. Evacuees sometimes turn out to be pilots.</p>'}</div>${hint}</div>`;
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
