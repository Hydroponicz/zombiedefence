// Full-screen 2D debug map of the city simulation: district overlays, a detail panel,
// city-wide history and the event log. Navigable by mouse, keyboard or controller.

import { requestTarget } from '../game/Requests';
import { formatClock, MINUTES_PER_DAY, NIGHT_START, DAY_START } from '../sim/clock';
import { ARMY_BASE, CITY_DEPTH, CITY_WIDTH, DISTRICT_SIZE, DISTRICT_TEMPLATES, GRID_COLS, GRID_ROWS } from '../sim/layout';
import { totalZombies } from '../sim/hordes';
import { guardsNeeded } from '../sim/sites';
import { RAIL, trainPose, truckPose } from '../sim/supply';
import { congestion, EDGES, edgeEnds, EXITS, isAvenue, roadStatus } from '../sim/traffic';
import { nodeX, nodeZ } from '../sim/streets';
import type { CityState, DistrictState, SiteKind, SiteStatus } from '../sim/types';

const OVERLAYS = ['Status', 'Infection', 'Power', 'Order', 'Supplies', 'Troops', 'Fuel', 'Traffic'] as const;
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
  /** AI pilots in the air. */
  aiHelis: { x: number; z: number; yaw: number; name: string }[];
}

const SITE_COLOR: Record<SiteStatus, string> = { held: '#5fc46b', besieged: '#e8a83a', fallen: '#5a2a26' };
const SITE_LETTER: Record<SiteKind, string> = {
  police: 'P', supermarket: 'S', shelter: 'H', pharmacy: '+', depot: 'D', factory: 'M', waterworks: 'W', fuelTerminal: 'F',
};

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

  /** Move the selection around the district grid, wrapping at the edges. */
  moveSelection(dCol: number, dRow: number): void {
    const current = DISTRICT_TEMPLATES[this.selected];
    const col = (current.col + dCol + GRID_COLS) % GRID_COLS;
    const row = (current.row + dRow + GRID_ROWS) % GRID_ROWS;
    const index = DISTRICT_TEMPLATES.findIndex((d) => d.col === col && d.row === row);
    if (index >= 0) this.selected = index;
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
      z += totalZombies(d);
      troops += d.troops.strength;
      dead += d.dead;
    }
    const joc = s.flags.joc ? 'JOC at Kessler Airport' : s.flags.jocAuthorized ? 'JOC authorized: fly the team in' : 'Army at Camp Ridgeway';
    this.text(`${formatClock(s.t)}   ·   time ×${info.timeScale}   ·   ${joc}`, pad, 30, 20, '#e8ecdf');
    const status = s.collapsed ? '   ·   CITY COLLAPSED' : '';
    this.text(
      `Civilians ${fmt(pop)}   Infected ${fmt(inf)}   Zombies ${fmt(z)}   Troops ${fmt(troops)}   Dead ${fmt(dead)}   Grid ${(s.grid * 100).toFixed(0)}%${status}`,
      pad, 54, 14, s.collapsed ? '#ef5b4f' : '#a5ad9c',
    );
    const tabs = OVERLAYS.map((o, i) => (o === this.overlay ? `[${i + 1} ${o}]` : `${i + 1} ${o}`)).join('   ');
    this.text(tabs, W - pad, 30, 14, '#e8ecdf', 'right');
    this.text('D-pad/arrows: select   ·   LB/RB or 1–8: overlay   ·   LT/RT or [ ]: time   ·   Y/P: flight command   ·   View/B or M/Esc: close', W - pad, 54, 12, '#a5ad9c', 'right');
  }

  private districtColor(d: DistrictState): string {
    const people = d.population + d.troops.strength + d.infected;
    switch (this.overlay) {
      case 'Status':
        return STATUS_COLOR[d.status];
      case 'Infection':
        return ramp(1 - Math.min(1, (totalZombies(d) + d.infected) / Math.max(1, d.population * 0.05 + totalZombies(d))));
      case 'Power':
        return POWER_COLOR[d.power];
      case 'Order':
        return ramp(d.order / 100);
      case 'Supplies':
        return ramp(d.rations / Math.max(1, people) / 3);
      case 'Troops':
        return d.troops.strength < 1 ? '#3a3d40' : ramp(d.troops.morale * (1 - d.troops.fatigue * 0.5));
      case 'Fuel':
        // Log scale: a few thousand litres at petrol stations up to hundreds of thousands at a depot.
        return ramp(Math.log10(Math.max(1, d.fuel)) / 5.5);
      case 'Traffic':
        return '#2a2e33';
    }
  }

  private overlayValue(d: DistrictState, s: CityState): string {
    const people = d.population + d.troops.strength + d.infected;
    switch (this.overlay) {
      case 'Status':
        return `${d.status}${d.rioting ? ' · riot' : ''}`;
      case 'Infection':
        return `Z ${fmt(totalZombies(d))} · inf ${fmt(d.infected)}`;
      case 'Power':
        return d.power === 'backup' ? `generators · ${fmt(d.fuel)} L` : d.power;
      case 'Order':
        return `order ${d.order.toFixed(0)}${d.rioting ? ' · riot' : ''}`;
      case 'Supplies':
        return `food ${(d.rations / Math.max(1, people)).toFixed(1)} days`;
      case 'Troops':
        return `${fmt(d.troops.strength)} · fat ${(d.troops.fatigue * 100).toFixed(0)}% · mor ${(d.troops.morale * 100).toFixed(0)}%`;
      case 'Traffic':
        return `roads ${roadStatus(s.traffic, d.id)}`;
      case 'Fuel':
        return `${fmt(d.fuel)} L${d.features.fuelDepot && d.kind !== 'airbase' ? (d.flags.convoyStopped ? ' · convoys stopped' : ' · convoys running') : ''}`;
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
      this.text(this.overlayValue(d, s), x + 10, y + 14 + size * 3.6, size - 1, light);
      const icons = [d.features.hospital && '✚', d.features.lab && '⚗', d.features.fuelDepot && '⛽', d.features.warehouse && '▦', d.features.powerPlant && '⚡', d.features.substation && 'ϟ']
        .filter(Boolean)
        .join(' ');
      this.text(icons, x + cell - 10, y + 10 + size, size, light, 'right');
    }

    // Forward refuelling points.
    for (const f of s.farps) {
      const fx = mx + (f.x + CITY_WIDTH / 2) * scale;
      const fy = my + (f.z + CITY_DEPTH / 2) * scale;
      g.fillStyle = '#c9772b';
      g.strokeStyle = '#000';
      g.lineWidth = 1.5;
      g.fillRect(fx - 6, fy - 6, 12, 12);
      g.strokeRect(fx - 6, fy - 6, 12, 12);
      this.text(`FARP ${fmt(f.fuel)} L`, fx + 9, fy + 4, 11, '#f3d2a8');
    }

    // Noise lures: a red ring as wide as the pull.
    for (const l of s.lures) {
      const lx = mx + (l.x + CITY_WIDTH / 2) * scale;
      const ly = my + (l.z + CITY_DEPTH / 2) * scale;
      g.strokeStyle = '#ff4a3a';
      g.lineWidth = 2;
      g.beginPath();
      g.arc(lx, ly, 9, 0, Math.PI * 2);
      g.stroke();
      this.text('LURE', lx + 11, ly + 4, 11, '#ffb0a8');
    }

    // Command requests: a diamond where each one is, gold for the one taken on.
    for (const r of s.requests) {
      if (r.status !== 'open') continue;
      const at = requestTarget(s, r, s.t);
      if (!at) continue;
      const rx = mx + (at.x + CITY_WIDTH / 2) * scale;
      const ry = my + (at.z + CITY_DEPTH / 2) * scale;
      g.fillStyle = r.tracked ? '#ffc94a' : '#e8ecdf';
      g.strokeStyle = '#000';
      g.lineWidth = 1.5;
      g.beginPath();
      g.moveTo(rx, ry - 8);
      g.lineTo(rx + 8, ry);
      g.lineTo(rx, ry + 8);
      g.lineTo(rx - 8, ry);
      g.closePath();
      g.fill();
      g.stroke();
      if (r.tracked) this.text(r.title.length > 40 ? `${r.title.slice(0, 39)}…` : r.title, rx + 11, ry + 4, 11, '#ffe2a0');
    }

    // Traffic overlay: every street by how it flows; wrecked streets dark purple.
    if (this.overlay === 'Traffic') {
      g.lineCap = 'butt';
      for (let e = 0; e < EDGES; e++) {
        const [i, j, ni, nj] = edgeEnds(e);
        const blocked = s.traffic.blocked[e];
        const jam = Math.min(1.5, congestion(s.traffic, e));
        g.strokeStyle = blocked > 0.5 ? `rgba(90,30,110,${0.5 + blocked * 0.5})` : ramp(1 - jam / 1.5);
        g.lineWidth = isAvenue(e) ? 3 : 1.5;
        g.beginPath();
        g.moveTo(mx + (nodeX(i) + CITY_WIDTH / 2) * scale, my + (nodeZ(j) + CITY_DEPTH / 2) * scale);
        g.lineTo(mx + (nodeX(ni) + CITY_WIDTH / 2) * scale, my + (nodeZ(nj) + CITY_DEPTH / 2) * scale);
        g.stroke();
      }
      for (const x of EXITS) {
        const ex = mx + (nodeX(x.node[0]) + CITY_WIDTH / 2) * scale;
        const ey = my + (nodeZ(x.node[1]) + CITY_DEPTH / 2) * scale;
        const east = x.node[0] > 0 && x.node[1] < 30;
        this.text(`⇢ ${x.name}`, east ? ex - 6 : ex + 6, ey - 6, 11, '#e8ecdf', east ? 'right' : 'left', true);
      }
      // District names back on top of the streets.
      for (const d of s.districts) {
        const x = mx + d.col * cell;
        const y = my + d.row * cell;
        g.fillStyle = 'rgba(13,15,14,0.75)';
        g.fillRect(x + 6, y + 6, cell * 0.72, 46);
        this.text(d.name, x + 10, y + 22, 13, '#e8ecdf', 'left', true);
        this.text(this.overlayValue(d, s), x + 10, y + 42, 11, '#c9cfc0');
      }
    }

    // The freight line and the food chain: trains on the rail, trucks on the roads.
    const railX = mx + (RAIL.x + CITY_WIDTH / 2) * scale;
    const railY0 = my + (RAIL.stopZ + CITY_DEPTH / 2) * scale;
    g.strokeStyle = s.supply.railHalted ? '#7a3b35' : '#3b3b3b';
    g.lineWidth = 3;
    g.beginPath();
    g.moveTo(railX, railY0);
    g.lineTo(railX, my + CITY_DEPTH * scale);
    g.stroke();
    this.text(`Rail yard ${fmt(s.supply.yard)}${s.supply.railHalted ? ' · trains stopped' : ''}`, railX + 6, railY0 - 4, 11,
      s.supply.railHalted ? '#ef5b4f' : '#0d0f0e');
    for (const tr of s.supply.trains) {
      const z = trainPose(tr, s.t).z;
      if (z > CITY_DEPTH / 2) continue;
      g.fillStyle = '#2f4f7a';
      g.fillRect(railX - 3, my + (z + CITY_DEPTH / 2) * scale, 6, Math.max(6, 220 * scale));
    }
    g.fillStyle = '#f0f0ea';
    g.strokeStyle = '#000';
    g.lineWidth = 1;
    for (const tr of s.supply.trucks) {
      const p = truckPose(tr, s.t);
      const tx = mx + (p.x + CITY_WIDTH / 2) * scale;
      const ty = my + (p.z + CITY_DEPTH / 2) * scale;
      g.fillRect(tx - 2.5, ty - 2.5, 5, 5);
      g.strokeRect(tx - 2.5, ty - 2.5, 5, 5);
    }

    // Strategic sites: a letter on a square coloured by status.
    for (const site of s.sites) {
      const sx = mx + (site.x + CITY_WIDTH / 2) * scale;
      const sy = my + (site.z + CITY_DEPTH / 2) * scale;
      g.fillStyle = SITE_COLOR[site.status];
      g.strokeStyle = '#000';
      g.lineWidth = 1;
      g.fillRect(sx - 6, sy - 6, 12, 12);
      g.strokeRect(sx - 6, sy - 6, 12, 12);
      this.text(SITE_LETTER[site.kind], sx, sy + 4, 10, site.status === 'fallen' ? '#ddd' : '#000', 'center', true);
    }

    // Hordes: a disc sized by the crowd, with a line toward where they're heading.
    for (const h of s.hordes) {
      const hx = mx + (h.x + CITY_WIDTH / 2) * scale;
      const hy = my + (h.z + CITY_DEPTH / 2) * scale;
      const r = Math.max(4, Math.min(cell * 0.3, Math.sqrt(h.size) * 0.18));
      if (h.settle <= 0) {
        const t = s.districts[h.target];
        const tx = mx + (t.col + 0.5) * cell;
        const ty = my + (t.row + 0.5) * cell;
        g.strokeStyle = 'rgba(160,20,20,0.7)';
        g.lineWidth = 2;
        g.setLineDash([5, 4]);
        g.beginPath();
        g.moveTo(hx, hy);
        g.lineTo(tx, ty);
        g.stroke();
        g.setLineDash([]);
      }
      g.fillStyle = 'rgba(120,10,10,0.75)';
      g.strokeStyle = '#000';
      g.lineWidth = 1.5;
      g.beginPath();
      g.arc(hx, hy, r, 0, Math.PI * 2);
      g.fill();
      g.stroke();
      this.text(`horde ${fmt(h.size)}`, hx + r + 4, hy + 4, 11, '#ffb3ab');
    }

    // AI helicopters.
    for (const ai of info.aiHelis) {
      const ax = mx + (ai.x + CITY_WIDTH / 2) * scale;
      const ay = my + (ai.z + CITY_DEPTH / 2) * scale;
      g.save();
      g.translate(ax, ay);
      g.rotate(-ai.yaw);
      g.fillStyle = '#8fd0ff';
      g.strokeStyle = '#000';
      g.lineWidth = 1.2;
      g.beginPath();
      g.moveTo(0, -7);
      g.lineTo(5, 6);
      g.lineTo(0, 3);
      g.lineTo(-5, 6);
      g.closePath();
      g.fill();
      g.stroke();
      g.restore();
      this.text(ai.name.split(' (')[0], ax + 8, ay - 6, 11, '#bfe3ff');
    }

    // Camp Ridgeway lies off the map to the west of the airport.
    {
      const ay = my + (ARMY_BASE.z + CITY_DEPTH / 2) * scale;
      this.text(`◀ ${ARMY_BASE.name}`, mx + 6, ay + 4, 11, '#e8ecdf', 'left', true);
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
    const atSites = (k: 'rations' | 'medicine', digits: number) => {
      const n = s.sites.reduce((sum, x) => sum + (x.district === d.id && x.status !== 'fallen' ? x[k] : 0), 0);
      return n >= 1 ? ` (+${(n / Math.max(1, people)).toFixed(digits)} at sites)` : '';
    };
    const rows: [string, string][] = [
      ['Status', `${d.status}${d.rioting ? ' (rioting)' : ''}`],
      ['Power', d.power === 'backup' ? `generators (${fmt(d.fuel)} L fuel)` : d.power],
      ['Civilians', fmt(d.population)],
      ['Infected', fmt(d.infected)],
      ['Zombies', d.hordeZombies >= 1 ? `${fmt(totalZombies(d))} (horde ${fmt(d.hordeZombies)})` : fmt(d.zombies)],
      ['Dead', fmt(d.dead)],
      ['Troops', `${fmt(d.troops.strength)}  ammo ${fmt(d.troops.ammo)}`],
      ['Fatigue / morale', `${(d.troops.fatigue * 100).toFixed(0)}% / ${(d.troops.morale * 100).toFixed(0)}%`],
      ['Police', d.police.officers + d.police.riot >= 1
        ? `${fmt(d.police.officers)} + ${fmt(d.police.riot)} riot · ${d.police.stage} · ${(d.police.morale * 100).toFixed(0)}%`
        : 'none'],
      ['Order', d.order.toFixed(0)],
      // Stock held at the district's sites is handed out once the district runs short.
      ['Food & water', `${(d.rations / Math.max(1, people)).toFixed(1)} days${atSites('rations', 1)}`],
      ['Medicine', `${(d.medicine / Math.max(1, people)).toFixed(2)} days${atSites('medicine', 2)}`],
      ['Fuel', `${fmt(d.fuel)} L`],
      ['Roads', roadStatus(s.traffic, d.id)],
    ];
    this.text(d.name, x + 14, y + 28, 18, '#e8ecdf', 'left', true);
    rows.forEach(([k, v], i) => {
      this.text(k, x + 14, y + 54 + i * 20, 13, '#a5ad9c');
      this.text(v, x + w - 14, y + 54 + i * 20, 13, '#e8ecdf', 'right');
    });

    // The district's strategic sites.
    const sites = s.sites.filter((x) => x.district === d.id);
    const sitesTop = y + 54 + rows.length * 20 + 14;
    if (sites.length) this.text('Sites', x + 14, sitesTop, 14, '#e8ecdf', 'left', true);
    sites.forEach((site, i) => {
      const yy = sitesTop + 20 + i * 18;
      g.fillStyle = SITE_COLOR[site.status];
      g.fillRect(x + 14, yy - 9, 9, 9);
      const name = site.name.length > 26 ? `${site.name.slice(0, 25)}…` : site.name;
      this.text(name, x + 28, yy, 12, '#e8ecdf');
      // What it holds: its own line of goods, and anything else delivered to it.
      const held = [
        (site.rations >= 1 || site.kind === 'depot' || site.kind === 'supermarket') && `food ${fmt(site.rations)}`,
        (site.medicine >= 1 || site.kind === 'pharmacy') && `med ${fmt(site.medicine)}`,
        (site.ammo >= 1 || site.kind === 'police') && `ammo ${fmt(site.ammo)}`,
      ].filter(Boolean).join(' · ');
      const kind = site.kind === 'shelter' ? `${fmt(site.sheltered)}/${fmt(site.capacity)} in`
        : site.kind === 'waterworks' ? 'water' : site.kind === 'fuelTerminal' ? 'fuel' : site.kind === 'factory' ? 'packing food' : '';
      const stock = [kind, held].filter(Boolean).join(' · ');
      const info = site.status === 'fallen' ? 'fallen' : `${Math.round(site.guards)}/${Math.ceil(guardsNeeded(site))} gd · ${stock}`;
      this.text(info, x + w - 14, yy, 12, site.status === 'held' ? '#a5ad9c' : SITE_COLOR[site.status], 'right');
    });
    const logTop = (sites.length ? sitesTop + 20 + sites.length * 18 : y + 54 + rows.length * 20) + 20;
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
