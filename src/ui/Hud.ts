// DOM heads-up display: clock, district under the helicopter, flight instruments, radio log.

import { formatClock, isDaytime } from '../sim/clock';
import type { OperationsView } from '../game/Operations';
import type { PadReading } from '../input/Input';
import { CRATES, SEATS } from '../sim/operations';
import type { Cargo, DistrictState, PlayerStats, SimEvent } from '../sim/types';

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
  <tr><td>Time speed</td><td>D-pad ◀ ▶ (LT / RT on the map)</td><td><kbd>[</kbd> / <kbd>]</kbd></td></tr>
  <tr><td>Map: select district</td><td>D-pad</td><td>Arrow keys or click</td></tr>
  <tr><td>Map: overlay</td><td>LB / RB</td><td><kbd>1</kbd>–<kbd>7</kbd> or <kbd>Tab</kbd></td></tr>
  <tr><td>Flight command (AI pilots)</td><td>L3, or Y on the map</td><td><kbd>P</kbd></td></tr>
  <tr><td>Pause</td><td>Menu</td><td><kbd>Esc</kbd></td></tr>
  <tr><td>Show / hide controls</td><td></td><td><kbd>H</kbd></td></tr>
  <tr><td>Release slung fuel bladder</td><td>X</td><td><kbd>F</kbd></td></tr>
  <tr><td>Landed: choose operation</td><td>D-pad ▲ ▼</td><td><kbd>↑</kbd> / <kbd>↓</kbd></td></tr>
  <tr><td>Landed: start / stop it</td><td>A</td><td><kbd>E</kbd> or <kbd>Enter</kbd></td></tr>
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
  /** Zombies currently drawn toward the helicopter by rotor noise. */
  drawn: number;
  /** Zombies hanging off the skids. */
  grabbers: number;
  fuel: number;
  fuelCapacity: number;
  /** Litres per second being burned. */
  burnRate: number;
  engineOut: boolean;
  /** Litres slung under the helicopter. */
  sling: number;
}

const LOW_FUEL = 0.2;
const BINGO_FUEL = 0.1;

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
  private ops = el('hud-ops');
  private cargo = el('hud-cargo');
  private lastOpsKey = '';
  private lastCargoKey = '';
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

  /** The ground operations menu, shown while landed. */
  updateOps(view: OperationsView | null, gamepad: boolean): void {
    const key = view ? JSON.stringify(view) + gamepad : '';
    if (key === this.lastOpsKey) return;
    this.lastOpsKey = key;
    this.ops.hidden = !view;
    if (!view) return;
    const rows = view.options
      .map((o) => `<div class="op${o.selected ? ' selected' : ''}${o.enabled ? '' : ' disabled'}${o.active ? ' active' : ''}">
          <span class="label">${o.label}</span><span class="detail">${o.detail}</span>
          ${o.active ? `<div class="progress" style="width:${Math.round(o.progress * 100)}%"></div>` : ''}
        </div>`)
      .join('');
    const hint = gamepad ? 'D-pad ▲▼ select · A start / stop · lift off to leave' : '↑ ↓ select · E or Enter start / stop · lift off to leave';
    this.ops.innerHTML = `<div class="title">${view.title}</div>
      <div class="status${view.warning ? ' warning' : ''}">${view.status}</div>${rows}<div class="hint">${hint}</div>`;
  }

  /** Seats, crates and what the player has achieved so far. */
  updateCargo(cargo: Cargo, stats: PlayerStats, research: number, pilots: number): void {
    const key = JSON.stringify(cargo) + JSON.stringify(stats) + Math.floor(research) + pilots;
    if (key === this.lastCargoKey) return;
    this.lastCargoKey = key;
    const seats: string[] = [];
    const fill = (n: number, cls: string) => { for (let i = 0; i < n; i++) seats.push(cls); };
    fill(cargo.troops, 'troops');
    fill(cargo.civilians + cargo.infected, 'civilians');
    fill(cargo.tired, 'tired');
    fill(cargo.scientists, 'scientists');
    fill(cargo.pilots.length, 'scientists');
    while (seats.length < SEATS) seats.push('');
    const aboard = [
      cargo.troops && `${cargo.troops} troops`,
      cargo.civilians + cargo.infected && `${cargo.civilians + cargo.infected} civilians`,
      cargo.tired && `${cargo.tired} exhausted soldiers`,
      cargo.scientists && `${cargo.scientists} scientists`,
      cargo.pilots.length && `${cargo.pilots.length} rescued pilot${cargo.pilots.length > 1 ? 's' : ''}`,
    ].filter(Boolean).join(' · ') || 'No passengers';
    const crates = cargo.crates.length ? cargo.crates.map((k) => CRATES[k].label).join(', ') : 'none';
    this.cargo.innerHTML = `<div class="seats">${seats.map((c) => `<div class="seat ${c}"></div>`).join('')}</div>
      <div class="line">${aboard}</div>
      <div class="line">Crates: ${crates}</div>
      <div class="stats">Saved ${stats.civiliansEvacuated} · Scientists ${stats.scientistsEvacuated} · Research ${Math.floor(research)}</div>
      <div class="stats">Pilots ${pilots} · P for flight command</div>`;
  }

  addEvents(events: SimEvent[]): void {
    for (const e of events) {
      // The info-level chatter is visible on the map; the radio carries what matters.
      if (e.severity === 'info' && !e.radio && !e.text.startsWith('Day')) continue;
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

    const zombies = district ? approx(district.zombies) : '';
    const troops = district ? Math.round(district.troops.strength) : 0;
    const key = district
      ? `${district.id}|${district.status}|${district.power}|${Math.round(district.order)}|${district.rioting}|${zombies}|${troops}`
      : 'none';
    if (key !== this.lastDistrictKey) {
      this.lastDistrictKey = key;
      this.district.innerHTML = district
        ? `<div class="name">${district.name}</div>
           <span class="chip ${district.status}">${district.status}</span>
           <div class="meta">${POWER_LABEL[district.power]} · Order ${Math.round(district.order)}${district.rioting ? ' · Rioting' : ''}</div>
           <div class="meta">Zombies ${zombies} · Troops ${troops}</div>`
        : `<div class="name">Outside the city</div>`;
    }

    const fuelShare = flight.fuel / flight.fuelCapacity;
    const warn = (text: string, color = 'var(--warn)') => `<span style="color:${color}">${text}</span>`;
    const state = flight.destroyed
      ? 'DESTROYED'
      : flight.grabbers > 0
        ? warn(`${flight.grabbers} ON THE SKIDS · CLIMB!`, 'var(--critical)')
        : flight.engineOut && !flight.landed
          ? warn('FLAMEOUT · AUTOROTATE, THROTTLE UP TO FLARE', 'var(--critical)')
          : flight.engineOut
            ? warn('OUT OF FUEL', 'var(--critical)')
            : flight.drawn > 0
              ? warn(`ROTOR NOISE · ${flight.drawn} drawn in`)
              : flight.sling > 0 && !flight.landed
                ? `SLING ${flight.sling.toLocaleString('en-US')} L · release low (F / X)`
                : fuelShare < BINGO_FUEL
                  ? warn('BINGO FUEL · LAND NOW', 'var(--critical)')
                  : fuelShare < LOW_FUEL
                    ? warn('LOW FUEL')
                    : flight.landed ? 'LANDED' : flight.searchlight ? 'SEARCHLIGHT ON' : '';
    const minutes = flight.burnRate > 0 ? flight.fuel / flight.burnRate / 60 : 0;
    const fuelColor = fuelShare > LOW_FUEL ? 'var(--held)' : fuelShare > BINGO_FUEL ? 'var(--warn)' : 'var(--critical)';
    const hp = Math.round(flight.health);
    this.flight.innerHTML = `
      <span class="label">ALT</span><span>${Math.round(flight.altitude)} m</span>
      <span class="label">SPD</span><span>${Math.round(flight.speed * 3.6)} km/h</span>
      <span class="label">V/S</span><span>${flight.verticalSpeed >= 0 ? '+' : ''}${flight.verticalSpeed.toFixed(1)} m/s</span>
      <span class="label">HDG</span><span>${String(Math.round(flight.heading)).padStart(3, '0')}°</span>
      <span class="label">FUEL</span><span style="color:${fuelColor}">${Math.floor(flight.fuel)} L${minutes ? ` · ${minutes < 1 ? '<1' : Math.floor(minutes)} min` : ''}</span>
      <div class="bar"><div style="width:${Math.round(fuelShare * 100)}%;background:${fuelColor}"></div></div>
      <span class="label">HULL</span><span>${hp}%</span>
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

/** Rough counts read better than exact simulation numbers. */
function approx(n: number): string {
  if (n < 1) return 'none';
  if (n < 20) return String(Math.round(n));
  if (n < 1000) return `~${Math.round(n / 10) * 10}`;
  return `~${(n / 1000).toFixed(1)}k`;
}

function el(id: string): HTMLElement {
  const e = document.getElementById(id);
  if (!e) throw new Error(`Missing #${id}`);
  return e;
}
