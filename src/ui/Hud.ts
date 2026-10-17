// DOM heads-up display: clock, district under the helicopter, flight instruments, radio log.

import { formatClock, isDaytime } from '../sim/clock';
import type { PadReading } from '../input/Input';
import type { DistrictState, SimEvent } from '../sim/types';

const RADIO_LIMIT = 6;
const RADIO_SECONDS = 25;

export const CONTROLS_HTML = `
<table class="controls">
  <tr><th></th><th>Controller</th><th>Keyboard / mouse</th></tr>
  <tr><td>Throttle up / down</td><td>RT / LT</td><td><kbd>W</kbd> / <kbd>S</kbd></td></tr>
  <tr><td>Yaw left / right</td><td>LB / RB</td><td><kbd>A</kbd> / <kbd>D</kbd></td></tr>
  <tr><td>Pitch / roll</td><td>Left stick</td><td>Arrows or Numpad 8 5 4 6</td></tr>
  <tr><td>Camera</td><td>Right stick</td><td>Mouse (click to capture), wheel zooms</td></tr>
  <tr><td>Camera distance</td><td>R3</td><td><kbd>C</kbd></td></tr>
  <tr><td>Searchlight</td><td>Y</td><td><kbd>L</kbd></td></tr>
  <tr><td>City map (debug)</td><td>View</td><td><kbd>M</kbd></td></tr>
  <tr><td>Time speed</td><td>D-pad ◀ ▶</td><td><kbd>[</kbd> / <kbd>]</kbd></td></tr>
  <tr><td>Pause</td><td>Menu</td><td><kbd>Esc</kbd></td></tr>
  <tr><td>Show / hide controls</td><td></td><td><kbd>H</kbd></td></tr>
  <tr><td>Controller readout</td><td></td><td><kbd>G</kbd></td></tr>
</table>
<div class="controller-status"></div>`;

const POWER_LABEL = { on: 'Grid power', backup: 'On generators', dark: 'No power' } as const;

export interface FlightReadout {
  altitude: number;
  speed: number;
  verticalSpeed: number;
  heading: number;
  health: number;
  landed: boolean;
  destroyed: boolean;
  searchlight: boolean;
}

export class Hud {
  private clock = el('hud-clock');
  private district = el('hud-district');
  private flight = el('hud-flight');
  private radioList = el('hud-radio');
  private toastEl = el('hud-toast');
  private help = el('hud-help');
  private toastTimer = 0;
  private radio: { li: HTMLLIElement; age: number }[] = [];
  private lastDistrictKey = '';
  private pad = el('hud-pad');
  private lastStatus = '';

  constructor() {
    this.help.innerHTML = CONTROLS_HTML;
    el('pause-controls').innerHTML = CONTROLS_HTML;
  }

  setControllerStatus(text: string, ok: boolean): void {
    if (text === this.lastStatus) return;
    this.lastStatus = text;
    for (const s of document.querySelectorAll<HTMLElement>('.controller-status')) {
      s.textContent = text;
      s.classList.toggle('ok', ok);
    }
  }

  togglePadReadout(): void {
    this.pad.hidden = !this.pad.hidden;
  }

  /** Live raw controller values, to check what the browser reports. */
  showPad(reading: PadReading | null, status: string): void {
    if (this.pad.hidden) return;
    if (!reading) {
      this.pad.textContent = `Controller readout (G to hide)\n\n${status}`;
      return;
    }
    const axes = reading.axes.map((v, i) => `  axis ${i}: ${v >= 0 ? ' ' : ''}${v.toFixed(2)}`).join('\n');
    this.pad.textContent = `Controller readout (G to hide)\n\n${reading.id}\nlayout: ${reading.layout}\n\n${axes}\n\n  buttons held: ${reading.pressed.join(', ') || 'none'}`;
  }

  toggleHelp(): void {
    this.help.hidden = !this.help.hidden;
  }

  hideHelp(): void {
    this.help.hidden = true;
  }

  toast(text: string, seconds = 3): void {
    this.toastEl.textContent = text;
    this.toastEl.classList.add('show');
    this.toastTimer = seconds;
  }

  addEvents(events: SimEvent[]): void {
    for (const e of events) {
      // The info-level chatter is visible on the map; the radio carries what matters.
      if (e.severity === 'info' && !e.text.startsWith('Day')) continue;
      const li = document.createElement('li');
      li.className = e.severity;
      const time = document.createElement('time');
      time.textContent = formatClock(e.t).split('· ')[1];
      li.append(time, e.text);
      this.radioList.append(li);
      this.radio.push({ li, age: 0 });
    }
    while (this.radio.length > RADIO_LIMIT) this.radio.shift()!.li.remove();
  }

  update(dt: number, t: number, timeScale: number, district: DistrictState | null, flight: FlightReadout): void {
    const scale = timeScale > 1 ? ` <small>Time ×${timeScale}</small>` : '';
    this.clock.innerHTML = `${isDaytime(t) ? '☀' : '☾'} ${formatClock(t)}${scale}`;

    const key = district
      ? `${district.id}|${district.status}|${district.power}|${Math.round(district.order)}|${district.rioting}`
      : 'none';
    if (key !== this.lastDistrictKey) {
      this.lastDistrictKey = key;
      this.district.innerHTML = district
        ? `<div class="name">${district.name}</div>
           <span class="chip ${district.status}">${district.status}</span>
           <div class="meta">${POWER_LABEL[district.power]} · Order ${Math.round(district.order)}${district.rioting ? ' · Rioting' : ''}</div>`
        : `<div class="name">Outside the city</div>`;
    }

    const state = flight.destroyed ? 'DESTROYED' : flight.landed ? 'LANDED' : flight.searchlight ? 'SEARCHLIGHT ON' : '';
    const hp = Math.round(flight.health);
    this.flight.innerHTML = `
      <span class="label">ALT</span><span>${Math.round(flight.altitude)} m</span>
      <span class="label">SPD</span><span>${Math.round(flight.speed * 3.6)} km/h</span>
      <span class="label">V/S</span><span>${flight.verticalSpeed >= 0 ? '+' : ''}${flight.verticalSpeed.toFixed(1)} m/s</span>
      <span class="label">HDG</span><span>${String(Math.round(flight.heading)).padStart(3, '0')}°</span>
      <div class="bar"><div style="width:${hp}%;background:${hp > 50 ? 'var(--held)' : hp > 25 ? 'var(--warn)' : 'var(--critical)'}"></div></div>
      <span class="state">${state}</span>`;

    for (const r of this.radio) {
      r.age += dt;
      if (r.age > RADIO_SECONDS) r.li.classList.add('fade');
    }

    if (this.toastTimer > 0) {
      this.toastTimer -= dt;
      if (this.toastTimer <= 0) this.toastEl.classList.remove('show');
    }
  }
}

function el(id: string): HTMLElement {
  const e = document.getElementById(id);
  if (!e) throw new Error(`Missing #${id}`);
  return e;
}
