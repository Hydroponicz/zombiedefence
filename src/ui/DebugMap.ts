// Full-screen 2D debug map of the city simulation: district overlays, a detail panel,
// city-wide history and the event log. Navigable by mouse, keyboard or controller.

import { formatClock, MINUTES_PER_DAY, NIGHT_START, DAY_START } from '../sim/clock';
import { CITY_DEPTH, CITY_WIDTH, DISTRICT_SIZE, DISTRICT_TEMPLATES, GRID_COLS, GRID_ROWS } from '../sim/layout';
import type { CityState, DistrictState } from '../sim/types';

const OVERLAYS = ['Status', 'Infection', 'Power', 'Order', 'Supplies', 'Troops'] as const;
type Overlay = (typeof OVERLAYS)[number];

const STATUS_COLOR = { held: '#3f8f5a', contested: '#c98a2b', overrun: '#a8322d' } as const;
const POWER_COLOR = { on: '#d9b93f', backup: '#9c6a2a', dark: '#1d1f22' } as const;
const SEVERITY_COLOR = { info: '#9fc2e0', warn: '#e2a33a', critical: '#ef5b4f' } as const;

const fmt = (n: number) => (n >= 10000 ? `${(n / 1000).toFixed(0)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : n.toFixed(0));

/** Red → amber → green for v in 0..1. */
function ramp(v: number): string {
  const x = Math.max(0, Math.min(1, v));
  const r = x < 0.5 ? 200 : Math.round(200 - (x - 0.5) * 2 * 140);
  const g = x < 0.5 ? Math.round(60 + x * 2 * 110) : Math.round(170 - (x - 0.5) * 2 * 20);
  return `rgb(${r},${g},60)`;
}

export interface MapContext {
  heliX: number;
  heliZ: number;
  heliYaw: number;
  timeScale: number;
}

export class DebugMap {
  visible = false;
  private ctx: CanvasRenderingContext2D;
  private overlay: Overlay = 'Status';
  private selected = 0;
  private hovered: number | null = null;
  private mapRect = { x: 0, y: 0, w: 0, h: 0 };

  constructor(private canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d')!;
    canvas.addEventListener('mousemove', (e) => {
      this.hovered = this.districtAtScreen(e.clientX, e.clientY);
    });
    canvas.addEventListener('mouseleave', () => (this.hovered = null));
    canvas.addEventListener('click', (e) => {
      const d = this.districtAtScreen(e.clientX, e.clientY);
      if (d !== null) this.selected = d;
    });
  }

  toggle(): boolean {
    this.visible = !this.visible;
    this.canvas.hidden = !this.visible;
    return this.visible;
  }

  cycleOverlay(delta: number): void {
    const i = OVERLAYS.indexOf(this.overlay);
    this.overlay = OVERLAYS[(i + delta + OVERLAYS.length) % OVERLAYS.length];
  }

  setOverlay(index: number): void {
    if (OVERLAYS[index]) this.overlay = OVERLAYS[index];
  }

  /** Step the selection through the grid: +1 next district, ±GRID_COLS a row. */
  moveSelection(delta: number): void {
    const n = GRID_COLS * GRID_ROWS;
    this.selected = (this.selected + delta + n) % n;
  }

  draw(state: CityState | null, info: MapContext): void {
    const dpr = Math.min(window.devicePixelRatio, 2);
    const W = window.innerWidth;
    const H = window.innerHeight;
    if (this.canvas.width !== Math.round(W * dpr) || this.canvas.height !== Math.round(H * dpr)) {
      this.canvas.width = Math.round(W * dpr);
      this.canvas.height = Math.round(H * dpr);
    }
    const g = this.ctx;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = 'rgba(8, 11, 10, 0.94)';
    g.fillRect(0, 0, W, H);
    if (!state) {
      this.text('Starting simulation…', W / 2, H / 2, 18, '#e8ecdf', 'center');
      return;
    }

    const pad = 20;
    const sideW = Math.min(380, W * 0.32);
    const chartH = Math.min(170, H * 0.22);
    const headerH = 64;
    const mapW = W - sideW - pad * 3;
    const mapH = H - headerH - chartH - pad * 3;
    const scale = Math.min(mapW / CITY_WIDTH, mapH / CITY_DEPTH);
    this.mapRect = { x: pad, y: headerH + pad, w: CITY_WIDTH * scale, h: CITY_DEPTH * scale };

    this.drawHeader(state, info, W, pad);
    this.drawDistricts(state, info, scale);
    this.drawChart(state, pad, H - chartH - pad, W - sideW - pad * 3, chartH);
    const detail = state.districts[this.hovered ?? this.selected];
    this.drawSidebar(state, detail, W - sideW - pad, headerH + pad, sideW, H - headerH - pad * 2);
  }

  private drawHeader(s: CityState, info: MapContext, W: number, pad: number): void {
    let pop = 0, inf = 0, z = 0, troops = 0, dead = 0;
    for (const d of s.districts) {
      pop += d.population;
      inf += d.infected;
      z += d.zombies;
      troops += d.troops.strength;
      dead += d.dead;
    }
    this.text(`${formatClock(s.t)}   ·   time ×${info.timeScale}`, pad, 30, 20, '#e8ecdf');
    const status = s.collapsed ? '   ·   CITY COLLAPSED' : '';
    this.text(
      `Civilians ${fmt(pop)}   Infected ${fmt(inf)}   Zombies ${fmt(z)}   Troops ${fmt(troops)}   Dead ${fmt(dead)}   Grid ${(s.grid * 100).toFixed(0)}%${status}`,
      pad, 54, 14, s.collapsed ? '#ef5b4f' : '#a5ad9c',
    );
    const tabs = OVERLAYS.map((o, i) => (o === this.overlay ? `[${i + 1} ${o}]` : `${i + 1} ${o}`)).join('   ');
    this.text(tabs, W - pad, 30, 14, '#e8ecdf', 'right');
    this.text('LB/RB or 1–6: overlay   ·   D-pad/arrows: select   ·   [ ]: time   ·   M / View: close', W - pad, 54, 12, '#a5ad9c', 'right');
  }

  private districtColor(d: DistrictState): string {
    const people = d.population + d.troops.strength + d.infected;
    switch (this.overlay) {
      case 'Status':
        return STATUS_COLOR[d.status];
      case 'Infection':
        return ramp(1 - Math.min(1, (d.zombies + d.infected) / Math.max(1, d.population * 0.05 + d.zombies)));
      case 'Power':
        return POWER_COLOR[d.power];
      case 'Order':
        return ramp(d.order / 100);
      case 'Supplies':
        return ramp(d.rations / Math.max(1, people) / 3);
      case 'Troops':
        return d.troops.strength < 1 ? '#3a3d40' : ramp(d.troops.morale * (1 - d.troops.fatigue * 0.5));
    }
  }

  private overlayValue(d: DistrictState): string {
    const people = d.population + d.troops.strength + d.infected;
    switch (this.overlay) {
      case 'Status':
        return `${d.status}${d.rioting ? ' · riot' : ''}`;
      case 'Infection':
        return `Z ${fmt(d.zombies)} · inf ${fmt(d.infected)}`;
      case 'Power':
        return d.power === 'backup' ? `generators · ${fmt(d.fuel)} L` : d.power;
      case 'Order':
        return `order ${d.order.toFixed(0)}${d.rioting ? ' · riot' : ''}`;
      case 'Supplies':
        return `food ${(d.rations / Math.max(1, people)).toFixed(1)} days`;
      case 'Troops':
        return `${fmt(d.troops.strength)} · fat ${(d.troops.fatigue * 100).toFixed(0)}% · mor ${(d.troops.morale * 100).toFixed(0)}%`;
    }
  }

  private drawDistricts(s: CityState, info: MapContext, scale: number): void {
    const g = this.ctx;
    const { x: mx, y: my } = this.mapRect;
    const cell = DISTRICT_SIZE * scale;
    for (const d of s.districts) {
      const x = mx + d.col * cell;
      const y = my + d.row * cell;
      g.fillStyle = this.districtColor(d);
      g.fillRect(x + 2, y + 2, cell - 4, cell - 4);
      const focus = d.id === this.selected || d.id === this.hovered;
      if (focus) {
        g.strokeStyle = '#ffffff';
        g.lineWidth = 3;
        g.strokeRect(x + 3, y + 3, cell - 6, cell - 6);
      }
      const light = this.overlay === 'Power' && d.power === 'dark' ? '#cfcfcf' : '#0d0f0e';
      const size = Math.max(11, Math.min(15, cell / 14));
      this.text(d.name, x + 10, y + 10 + size, size + 1, light, 'left', true);
      this.text(`pop ${fmt(d.population)}`, x + 10, y + 14 + size * 2.4, size - 1, light);
      this.text(this.overlayValue(d), x + 10, y + 14 + size * 3.6, size - 1, light);
      const icons = [d.features.hospital && '✚', d.features.lab && '⚗', d.features.fuelDepot && '⛽', d.features.warehouse && '▦', d.features.powerPlant && '⚡', d.features.substation && 'ϟ']
        .filter(Boolean)
        .join(' ');
      this.text(icons, x + cell - 10, y + 10 + size, size, light, 'right');
    }

    // Helicopter marker.
    const hx = mx + (info.heliX + CITY_WIDTH / 2) * scale;
    const hy = my + (info.heliZ + CITY_DEPTH / 2) * scale;
    g.save();
    g.translate(hx, hy);
    g.rotate(-info.heliYaw);
    g.fillStyle = '#ffffff';
    g.strokeStyle = '#000';
    g.lineWidth = 1.5;
    g.beginPath();
    g.moveTo(0, -10);
    g.lineTo(7, 8);
    g.lineTo(0, 4);
    g.lineTo(-7, 8);
    g.closePath();
    g.fill();
    g.stroke();
    g.restore();
  }

  private drawSidebar(s: CityState, d: DistrictState, x: number, y: number, w: number, h: number): void {
    const g = this.ctx;
    g.fillStyle = 'rgba(255,255,255,0.04)';
    g.fillRect(x, y, w, h);
    const people = d.population + d.troops.strength + d.infected;
    const rows: [string, string][] = [
      ['Status', `${d.status}${d.rioting ? ' (rioting)' : ''}`],
      ['Power', d.power === 'backup' ? `generators (${fmt(d.fuel)} L fuel)` : d.power],
      ['Civilians', fmt(d.population)],
      ['Infected', fmt(d.infected)],
      ['Zombies', fmt(d.zombies)],
      ['Dead', fmt(d.dead)],
      ['Troops', `${fmt(d.troops.strength)}  ammo ${fmt(d.troops.ammo)}`],
      ['Fatigue / morale', `${(d.troops.fatigue * 100).toFixed(0)}% / ${(d.troops.morale * 100).toFixed(0)}%`],
      ['Order', d.order.toFixed(0)],
      ['Food & water', `${(d.rations / Math.max(1, people)).toFixed(1)} days`],
      ['Medicine', `${(d.medicine / Math.max(1, people)).toFixed(2)} days`],
      ['Fuel', `${fmt(d.fuel)} L`],
    ];
    this.text(d.name, x + 14, y + 28, 18, '#e8ecdf', 'left', true);
    rows.forEach(([k, v], i) => {
      this.text(k, x + 14, y + 54 + i * 20, 13, '#a5ad9c');
      this.text(v, x + w - 14, y + 54 + i * 20, 13, '#e8ecdf', 'right');
    });

    const logTop = y + 54 + rows.length * 20 + 20;
    this.text('Radio log', x + 14, logTop, 14, '#e8ecdf', 'left', true);
    const lines = Math.max(0, Math.floor((y + h - logTop - 16) / 18));
    const recent = s.log.slice(-lines).reverse();
    g.save();
    g.beginPath();
    g.rect(x, logTop + 6, w, h - (logTop - y) - 6);
    g.clip();
    recent.forEach((e, i) => {
      const time = formatClock(e.t).replace('Day ', 'D');
      this.text(`${time}  ${e.text}`, x + 14, logTop + 24 + i * 18, 12, SEVERITY_COLOR[e.severity]);
    });
    g.restore();
  }

  private drawChart(s: CityState, x: number, y: number, w: number, h: number): void {
    const g = this.ctx;
    g.fillStyle = 'rgba(255,255,255,0.04)';
    g.fillRect(x, y, w, h);
    const hist = s.history;
    if (hist.length < 2) return;
    const t0 = hist[0].t;
    const t1 = Math.max(hist[hist.length - 1].t, t0 + MINUTES_PER_DAY);
    const px = (t: number) => x + ((t - t0) / (t1 - t0)) * w;

    // Night shading and day boundaries.
    for (let day = Math.floor(t0 / MINUTES_PER_DAY); day * MINUTES_PER_DAY < t1; day++) {
      const base = day * MINUTES_PER_DAY;
      g.fillStyle = 'rgba(80,100,160,0.12)';
      const a = Math.max(t0, base + NIGHT_START);
      const b = Math.min(t1, base + MINUTES_PER_DAY + DAY_START);
      if (b > a) g.fillRect(px(a), y, px(b) - px(a), h);
    }

    const maxPeople = Math.max(...hist.map((p) => Math.max(p.population, p.zombies)), 1);
    const maxTroops = Math.max(...hist.map((p) => p.troops), 1);
    const series: [string, string, (p: (typeof hist)[number]) => number][] = [
      ['Civilians', '#7fc4ff', (p) => p.population / maxPeople],
      ['Zombies', '#ef5b4f', (p) => p.zombies / maxPeople],
      ['Troops', '#8ad37f', (p) => p.troops / maxTroops],
      ['Grid', '#d9b93f', (p) => p.grid],
    ];
    series.forEach(([label, color, f], i) => {
      g.strokeStyle = color;
      g.lineWidth = 1.6;
      g.beginPath();
      hist.forEach((p, j) => {
        const X = px(p.t);
        const Y = y + h - 6 - f(p) * (h - 24);
        if (j === 0) g.moveTo(X, Y);
        else g.lineTo(X, Y);
      });
      g.stroke();
      this.text(label, x + 10 + i * 90, y + 16, 12, color);
    });
  }

  private districtAtScreen(sx: number, sy: number): number | null {
    const { x, y, w, h } = this.mapRect;
    if (sx < x || sy < y || sx > x + w || sy > y + h) return null;
    const col = Math.min(GRID_COLS - 1, Math.floor(((sx - x) / w) * GRID_COLS));
    const row = Math.min(GRID_ROWS - 1, Math.floor(((sy - y) / h) * GRID_ROWS));
    const index = DISTRICT_TEMPLATES.findIndex((d) => d.col === col && d.row === row);
    return index >= 0 ? index : null;
  }

  private text(s: string, x: number, y: number, size: number, color: string, align: CanvasTextAlign = 'left', bold = false): void {
    const g = this.ctx;
    g.font = `${bold ? '600 ' : ''}${size}px 'Segoe UI', system-ui, sans-serif`;
    g.fillStyle = color;
    g.textAlign = align;
    g.fillText(s, x, y);
  }
}
