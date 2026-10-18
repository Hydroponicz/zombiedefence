// Command requests arrive as radio traffic: a transmission card styled as a cockpit radio, with a
// squelch and a call tone, the message typing out as it's read. The game holds while it's up, until
// the pilot answers: take it on, open it in Flight Command (to hand it to a pilot), or dismiss it.
// The answers are a row: the D-pad, right stick, A / D or the arrow keys move along it (or the mouse,
// hovering), A or Enter picks one, and B or Backspace turns the call down. More than one queues up.

import { MINUTES_PER_DAY } from '../sim/clock';
import { describeNeed, rewardText } from '../sim/requests';
import type { CityState, Request, RequestKind } from '../sim/types';

/** The player's callsign. */
const CALLSIGN = 'DUSTOFF 1-1';
/** Characters typed a second as the message comes in. */
const TYPE_RATE = 90;

const PRIORITY: Record<RequestKind, { label: string; cls: string }> = {
  extract: { label: 'FLASH', cls: 'flash' },
  evacuate: { label: 'IMMEDIATE', cls: 'immediate' },
  reinforce: { label: 'IMMEDIATE', cls: 'immediate' },
  overwatch: { label: 'PRIORITY', cls: 'priority' },
  supply: { label: 'ROUTINE', cls: 'routine' },
};

/** A frequency per kind of traffic, for the radio's display. */
const FREQ: Record<RequestKind, string> = {
  extract: '243.000', evacuate: '251.900', reinforce: '262.450', overwatch: '279.625', supply: '305.150',
};

export type Answer = 'take' | 'open' | 'dismiss';
const ANSWERS: Answer[] = ['take', 'open', 'dismiss'];
/** The right stick moves the choice once it's pushed this far, and again once it's back near centre. */
const STICK_PUSH = 0.6;
const STICK_REST = 0.3;

export class Transmission {
  private el = document.getElementById('radio-call')!;
  private queue: number[] = [];
  private seen = new Set<number>();
  private primed = false;
  private shown: number | null = null;
  private typed = 0;
  private message = '';
  private audio: AudioContext | null = null;
  /** The highlighted answer. */
  private choice = 0;
  private stickArmed = true;

  /** @param answer what the pilot said to a call (the caller acts on it) */
  constructor(private answer: (request: Request, how: Answer) => void) {
    // Hovering an answer highlights it.
    this.el.addEventListener('mouseover', (e) => {
      const button = (e.target as HTMLElement).closest<HTMLElement>('[data-answer]');
      if (!button) return;
      const i = ANSWERS.indexOf(button.dataset.answer as Answer);
      if (i === this.choice) return;
      this.choice = i;
      this.highlight();
      this.blip(1400, 0.025);
    });
    this.el.addEventListener('click', (e) => {
      const button = (e.target as HTMLElement).closest<HTMLElement>('[data-answer]');
      if (!button) return;
      this.choice = ANSWERS.indexOf(button.dataset.answer as Answer);
      this.highlight();
      this.respond(button.dataset.answer as Answer);
    });
  }

  get visible(): boolean {
    return this.shown !== null;
  }

  private state: CityState | null = null;

  /**
   * @param heli where the helicopter is, for the distance and bearing to the job
   * @param target where a request's job is
   */
  update(dt: number, s: CityState | null, heli: { x: number; z: number }, target: (r: Request) => { x: number; z: number } | null): void {
    this.state = s;
    if (!s) return;
    // New requests join the queue (not the ones already there when the game loads).
    for (const r of s.requests) {
      if (r.status !== 'open' || this.seen.has(r.id)) continue;
      this.seen.add(r.id);
      if (this.primed) this.queue.push(r.id);
    }
    this.primed = true;
    // Calls for requests that have closed in the meantime are dropped.
    this.queue = this.queue.filter((id) => s.requests.some((r) => r.id === id && r.status === 'open'));
    const current = this.shown === null ? undefined : s.requests.find((r) => r.id === this.shown && r.status === 'open');
    if (this.shown !== null && !current) this.close();
    if (this.shown === null && this.queue.length) this.open(s, this.queue.shift()!);

    const r = this.shown === null ? undefined : s.requests.find((x) => x.id === this.shown);
    if (!r) return;
    // The message types out; the rest of the card keeps time.
    if (this.typed < this.message.length) {
      this.typed = Math.min(this.message.length, this.typed + dt * TYPE_RATE);
      const text = this.el.querySelector('.rc-text');
      if (text) text.textContent = this.message.slice(0, Math.floor(this.typed));
      if (this.typed >= this.message.length) this.el.querySelector('.rc-over')?.classList.add('on');
    }
    const left = Math.max(0, r.deadline - s.t);
    const at = target(r);
    const where = at ? (() => {
      const dx = at.x - heli.x;
      const dz = at.z - heli.z;
      const d = Math.hypot(dx, dz);
      const bearing = (Math.round((Math.atan2(dx, -dz) * 180) / Math.PI) + 360) % 360;
      return `${d >= 1000 ? `${(d / 1000).toFixed(1)} KM` : `${Math.round(d)} M`} · BRG ${String(bearing).padStart(3, '0')}`;
    })() : '';
    const clock = this.el.querySelector('.rc-window');
    if (clock) clock.textContent = `WINDOW ${Math.floor(left / 60)}H ${String(Math.floor(left % 60)).padStart(2, '0')}M`;
    const pos = this.el.querySelector('.rc-where');
    if (pos) pos.textContent = where;
    const waiting = this.el.querySelector('.rc-queue');
    if (waiting) waiting.textContent = this.queue.length ? `+${this.queue.length} MORE IN QUEUE` : '';
  }

  /**
   * Input while a call is up: move along the answers, pick one, or turn the call down.
   * @param stickX left–right from the right stick, or the A / D keys
   * @returns true if it took the input
   */
  handle(actions: Set<string>, stickX = 0): boolean {
    if (this.shown === null) return false;
    let step = (actions.has('dpadRight') || actions.has('arrowRight') ? 1 : 0) - (actions.has('dpadLeft') || actions.has('arrowLeft') ? 1 : 0);
    if (this.stickArmed && Math.abs(stickX) > STICK_PUSH) {
      step = Math.sign(stickX);
      this.stickArmed = false;
    } else if (Math.abs(stickX) < STICK_REST) {
      this.stickArmed = true;
    }
    if (step) {
      this.choice = Math.max(0, Math.min(ANSWERS.length - 1, this.choice + step));
      this.highlight();
      this.blip(1400, 0.025);
      return true;
    }
    if (actions.has('confirm')) this.respond(ANSWERS[this.choice]);
    else if (actions.has('command')) this.respond('open');
    else if (actions.has('back') || actions.has('radioDismiss')) this.respond('dismiss');
    else return false;
    return true;
  }

  /** Mark the highlighted answer. */
  private highlight(): void {
    this.el.querySelectorAll<HTMLElement>('.rc-btn').forEach((b) => b.classList.toggle('sel', b.dataset.answer === ANSWERS[this.choice]));
  }

  private respond(how: Answer): void {
    const r = this.state?.requests.find((x) => x.id === this.shown);
    if (!r) return;
    // A first press finishes the typing; the next answers.
    if (how !== 'dismiss' && this.typed < this.message.length) {
      this.typed = this.message.length;
      const text = this.el.querySelector('.rc-text');
      if (text) text.textContent = this.message;
      this.el.querySelector('.rc-over')?.classList.add('on');
      return;
    }
    this.answer(r, how);
    this.close();
    this.blip(how === 'dismiss' ? 520 : 880, 0.06);
  }

  private close(): void {
    this.shown = null;
    this.el.hidden = true;
    this.el.innerHTML = '';
  }

  private open(s: CityState, id: number): void {
    const r = s.requests.find((x) => x.id === id)!;
    const d = s.districts[r.district];
    const command = s.flags.joc ? 'KESSLER ACTUAL' : 'RIDGEWAY ACTUAL';
    const minutes = Math.max(0, r.deadline - s.t);
    const window = minutes >= 120 ? `${Math.round(minutes / 60)} hours` : `${Math.round(minutes)} minutes`;
    const p = PRIORITY[r.kind];
    this.message = `${CALLSIGN}, ${command}. ${r.title}. ${describeNeed(r)}. You have ${window}. ` +
      `On completion: ${rewardText(r.reward)}. How copy? Over.`;
    this.typed = 0;
    this.shown = id;
    const day = Math.floor(s.t / MINUTES_PER_DAY) + 1;
    const hhmm = `${String(Math.floor((s.t % MINUTES_PER_DAY) / 60)).padStart(2, '0')}${String(Math.floor(s.t % 60)).padStart(2, '0')}`;
    this.el.innerHTML = `
      <div class="rc-radio">
        <div class="rc-rivet tl"></div><div class="rc-rivet tr"></div><div class="rc-rivet bl"></div><div class="rc-rivet br"></div>
        <div class="rc-top">
          <span class="rc-model">AN/ARC-201 · SINCGARS</span>
          <span class="rc-led"></span><span class="rc-led-label">RX</span>
        </div>
        <div class="rc-face">
          <div class="rc-lcd">
            <div class="rc-freq">${FREQ[r.kind]}<small>MHz</small></div>
            <div class="rc-bars"><i></i><i></i><i></i><i></i><i></i></div>
            <div class="rc-meta">D${day} ${hhmm}Z · ${d.name.toUpperCase()}</div>
          </div>
          <div class="rc-grille"></div>
          <svg class="rc-wave" viewBox="0 0 120 30" preserveAspectRatio="none" aria-hidden="true">
            <polyline points="0,15 8,15 12,6 16,24 20,9 24,21 28,13 34,17 40,15 46,4 50,26 54,11 58,19 62,15 70,15 74,8 78,22 82,15 90,15 94,10 98,20 102,15 120,15" />
          </svg>
        </div>
        <div class="rc-paper">
          <div class="rc-head"><span class="rc-prio ${p.cls}">${p.label}</span><span>INCOMING TRANSMISSION · ${command}</span></div>
          <div class="rc-text"></div><span class="rc-over">▌</span>
          <div class="rc-foot"><span class="rc-window"></span><span class="rc-where"></span><span class="rc-queue"></span></div>
        </div>
        <div class="rc-buttons">
          <span class="rc-btn take" data-answer="take">ROGER, TAKING IT</span>
          <span class="rc-btn" data-answer="open">HAND OFF</span>
          <span class="rc-btn" data-answer="dismiss">NEGATIVE</span>
        </div>
        <div class="rc-hint"><span>◀ ▶ / <kbd>A</kbd> <kbd>D</kbd> choose</span><span>Ⓐ / <kbd>Enter</kbd> / click select</span>
          <span>Ⓑ / <kbd>⌫</kbd> negative</span><span class="rc-held">⏸ GAME HELD</span></div>
        <div class="rc-static"></div>
      </div>`;
    this.el.hidden = false;
    this.choice = 0;
    this.highlight();
    this.squelch(p.cls === 'flash' ? 3 : p.cls === 'immediate' ? 2 : 1);
  }

  /** Radio squelch: a burst of static, then call tones. */
  private squelch(tones: number): void {
    try {
      const ctx = (this.audio ??= new AudioContext());
      if (ctx.state === 'suspended') void ctx.resume();
      const t0 = ctx.currentTime;
      const length = Math.floor(ctx.sampleRate * 0.18);
      const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / length);
      const noise = ctx.createBufferSource();
      noise.buffer = buffer;
      const band = ctx.createBiquadFilter();
      band.type = 'bandpass';
      band.frequency.value = 1800;
      band.Q.value = 0.7;
      const gain = ctx.createGain();
      gain.gain.value = 0.12;
      noise.connect(band).connect(gain).connect(ctx.destination);
      noise.start(t0);
      for (let k = 0; k < tones; k++) this.blip(1050, 0.08, t0 + 0.22 + k * 0.14);
    } catch {
      // No audio: the card is enough.
    }
  }

  private blip(freq: number, seconds: number, at?: number): void {
    try {
      const ctx = (this.audio ??= new AudioContext());
      const t = at ?? ctx.currentTime;
      const osc = ctx.createOscillator();
      osc.type = 'square';
      osc.frequency.value = freq;
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.05, t + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + seconds);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t);
      osc.stop(t + seconds + 0.02);
    } catch {
      // No audio.
    }
  }
}
