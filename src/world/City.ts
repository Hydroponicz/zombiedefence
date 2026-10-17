// Procedural city at real-world scale, generated from the shared district layout: 120 m blocks
// between 18 m streets and 30 m avenues, houses on lots with gable roofs, apartment slabs,
// downtown towers rising to 470 m supertalls, a container port, a power plant and an airbase.
//
// Buildings are one instanced box mesh with a window shader whose night glow is switched per
// district, and streetlights follow the grid, so blackouts show district by district.

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import {
  CITY_DEPTH,
  CITY_WIDTH,
  DISTRICT_SIZE,
  DISTRICT_TEMPLATES,
  districtAt,
  districtCenter,
  type DistrictKind,
} from '../sim/layout';
import { makeRandom } from '../sim/rng';
import { BLOCKS_PER_DISTRICT, NODES_X, NODES_Z, nodeX, nodeZ, roadWidth, SIDEWALK, STREET_SPACING } from './streets';

interface Box {
  x: number;
  z: number;
  w: number;
  d: number;
  h: number;
  y?: number;
  /** Rotation about the vertical axis. Only used for decoration (colliders ignore it). */
  yaw?: number;
  color: number;
  /** Lit windows at night. */
  windows?: boolean;
  district: number;
  /** Solid for collision (flat pads and lawns are not). */
  solid?: boolean;
}

interface Cylinder {
  x: number;
  z: number;
  r: number;
  h: number;
  y?: number;
  color: number;
}

/** A gable roof on top of a house: the ridge runs along x unless rotated. */
interface Roof {
  x: number;
  z: number;
  w: number;
  d: number;
  h: number;
  y: number;
  yaw: number;
  color: number;
}

interface Lamp {
  x: number;
  z: number;
  /** Direction the arm reaches out over the road. */
  yaw: number;
  district: number;
}

interface Collider {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  top: number;
  /** Flat surfaces (pads, lawns, runways) can be landed on but never push sideways. */
  floor: boolean;
}

export interface Helipad {
  x: number;
  z: number;
  y: number;
  name: string;
}

/** A block's buildable area, inside its sidewalks. */
interface Lot {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
  cx: number;
  cz: number;
  w: number;
  d: number;
  /** Offset of the block centre from its district centre. */
  ox: number;
  oz: number;
}

const COLLISION_CELL = 40;
const LAMP_SPACING = 32;
const LAMP_HEIGHT = 8.5;

const CONCRETE = 0x9a9a95;
const GRASS = 0x4a6e3c;
const PARK = 0x3f6b35;

export class City {
  readonly group = new THREE.Group();
  readonly helipads: Helipad[] = [];
  /** Fuel tank farms, where depot fires burn. */
  readonly fuelSites: { district: number; x: number; z: number }[] = [];
  private boxes: Box[] = [];
  private cylinders: Cylinder[] = [];
  private roofs: Roof[] = [];
  private trees: { x: number; z: number; s: number }[] = [];
  private cars: { x: number; z: number; yaw: number; color: number }[] = [];
  private lamps: Lamp[] = [];
  private colliders: Collider[] = [];
  private grid = new Map<number, number[]>();
  private districtLight = new Float32Array(DISTRICT_TEMPLATES.length).fill(1);
  private windowUniforms = {
    uNight: { value: 0 },
    uDistrictLight: { value: this.districtLight },
  };
  private lampHeads!: THREE.InstancedMesh;
  private lampPools!: THREE.InstancedMesh;
  private lampsOn: boolean[] = DISTRICT_TEMPLATES.map(() => false);
  private night = 0;

  constructor(seed: number | string) {
    const rand = makeRandom(`city-${seed}`);
    DISTRICT_TEMPLATES.forEach((tpl, i) => this.buildDistrict(i, tpl.kind, rand));
    this.buildWaterfront(rand);
    this.placeStreetFurniture(rand);
    this.buildGround();
    this.buildInstances();
    this.buildRoadMarkings();
    this.buildColliders();
  }

  /** 0 = day, 1 = full night. */
  setNight(amount: number): void {
    this.windowUniforms.uNight.value = amount;
    this.night = amount;
    this.refreshLamps();
  }

  /** Window light level per district (1 = grid power, ~0.35 = generators, 0 = dark). */
  setDistrictLight(index: number, level: number): void {
    this.districtLight[index] = level;
    this.refreshLamps();
  }

  /** Highest solid surface under (x, z): ground is 0. */
  surfaceHeight(x: number, z: number): number {
    let top = 0;
    for (const i of this.grid.get(this.cellKey(x, z)) ?? []) {
      const c = this.colliders[i];
      if (x >= c.minX && x <= c.maxX && z >= c.minZ && z <= c.maxZ && c.top > top) top = c.top;
    }
    return top;
  }

  /**
   * Push a sphere (centre p, radius r) out of any building it is inside, sideways.
   * Returns the push applied (zero when there was no contact).
   */
  collide(p: THREE.Vector3, r: number, bottom: number): THREE.Vector3 {
    const push = new THREE.Vector3();
    const seen = new Set<number>();
    for (let gx = Math.floor((p.x - r) / COLLISION_CELL); gx <= Math.floor((p.x + r) / COLLISION_CELL); gx++) {
      for (let gz = Math.floor((p.z - r) / COLLISION_CELL); gz <= Math.floor((p.z + r) / COLLISION_CELL); gz++) {
        for (const i of this.grid.get(this.key(gx, gz)) ?? []) {
          if (seen.has(i)) continue;
          seen.add(i);
          const c = this.colliders[i];
          // Above the roof: the landing code handles it.
          if (c.floor || p.y - bottom >= c.top - 0.25) continue;
          const cx = Math.max(c.minX, Math.min(p.x, c.maxX));
          const cz = Math.max(c.minZ, Math.min(p.z, c.maxZ));
          const dx = p.x - cx;
          const dz = p.z - cz;
          const dist = Math.hypot(dx, dz);
          if (dist >= r) continue;
          if (dist > 1e-4) {
            push.x += (dx / dist) * (r - dist);
            push.z += (dz / dist) * (r - dist);
          } else {
            // Centre is inside the box: leave by the nearest face.
            const exits = [p.x - c.minX, c.maxX - p.x, p.z - c.minZ, c.maxZ - p.z];
            const m = Math.min(...exits);
            if (m === exits[0]) push.x -= m + r;
            else if (m === exits[1]) push.x += m + r;
            else if (m === exits[2]) push.z -= m + r;
            else push.z += m + r;
          }
        }
      }
    }
    return push;
  }

  // --- Districts ------------------------------------------------------------------------

  private lotAt(i: number, j: number, district: number): Lot {
    const tpl = DISTRICT_TEMPLATES[district];
    const c = districtCenter(tpl.col, tpl.row);
    const x0 = nodeX(i) + roadWidth(i) / 2;
    const x1 = nodeX(i + 1) - roadWidth(i + 1) / 2;
    const z0 = nodeZ(j) + roadWidth(j) / 2;
    const z1 = nodeZ(j + 1) - roadWidth(j + 1) / 2;
    const cx = (x0 + x1) / 2;
    const cz = (z0 + z1) / 2;
    return { x0, z0, x1, z1, cx, cz, w: x1 - x0, d: z1 - z0, ox: cx - c.x, oz: cz - c.z };
  }

  private buildDistrict(district: number, kind: DistrictKind, rand: () => number): void {
    const tpl = DISTRICT_TEMPLATES[district];
    if (kind === 'airbase') {
      this.buildAirbase(district);
      return;
    }
    const i0 = tpl.col * BLOCKS_PER_DISTRICT;
    const j0 = tpl.row * BLOCKS_PER_DISTRICT;
    // The landmark sits on a block next to the district's central intersection.
    const landmark = { i: i0 + 5, j: j0 + 5 };
    for (let bi = 0; bi < BLOCKS_PER_DISTRICT; bi++) {
      for (let bj = 0; bj < BLOCKS_PER_DISTRICT; bj++) {
        const i = i0 + bi;
        const j = j0 + bj;
        const lot = this.lotAt(i, j, district);
        // Sidewalk around every block; houses sit on lawns inside it.
        this.pad(lot, CONCRETE, district, 0.18);
        if (kind === 'residential') this.pad(lot, GRASS, district, 0.22, SIDEWALK);
        if (i === landmark.i && j === landmark.j && this.buildLandmark(district, kind, lot)) continue;
        const parkChance = kind === 'harbor' || kind === 'industrial' ? 0 : kind === 'downtown' ? 0.04 : 0.07;
        if (rand() < parkChance) {
          this.buildPark(district, lot, rand);
          continue;
        }
        this.fillBlock(district, kind, lot, rand);
      }
    }
  }

  /** A flat surface over a whole lot (sidewalk, lawn, parking). */
  private pad(lot: Lot, color: number, district: number, h: number, inset = 0): void {
    this.boxes.push({ x: lot.cx, z: lot.cz, w: lot.w - inset * 2, d: lot.d - inset * 2, h, color, district });
  }

  private building(district: number, x: number, z: number, w: number, d: number, h: number, color: number, windows = true, y = 0): void {
    this.boxes.push({ x, z, w, d, h, y, color, windows, district, solid: true });
  }

  private buildPark(district: number, lot: Lot, rand: () => number): void {
    this.pad(lot, PARK, district, 0.25, SIDEWALK);
    const n = 18 + Math.floor(rand() * 18);
    for (let k = 0; k < n; k++) {
      this.trees.push({
        x: lot.cx + (rand() - 0.5) * (lot.w - 14),
        z: lot.cz + (rand() - 0.5) * (lot.d - 14),
        s: 1.2 + rand() * 0.8,
      });
    }
  }

  /** Returns true if the block was used for a landmark. */
  private buildLandmark(district: number, kind: DistrictKind, lot: Lot): boolean {
    const name = DISTRICT_TEMPLATES[district].name;
    const { cx, cz } = lot;
    switch (kind) {
      case 'downtown': {
        // The city's supertall: podium, shaft, setback crown, rooftop helipad.
        this.building(district, cx, cz, lot.w - 10, lot.d - 10, 32, 0x5f6b74);
        this.building(district, cx, cz, 54, 54, 360, 0x4f6476, true, 32);
        this.building(district, cx, cz, 40, 40, 78, 0x5a7186, true, 392);
        this.addHelipad(cx, cz, 470, `${name} tower`);
        return true;
      }
      case 'hospital': {
        this.building(district, cx, cz + 12, lot.w - 12, 30, 26, 0xdcd6cc);
        this.building(district, cx, cz - 14, 52, 40, 62, 0xe8e4dc);
        this.addHelipad(cx, cz - 14, 62, `${name} rooftop`);
        return true;
      }
      case 'university': {
        this.pad(lot, GRASS, district, 0.25, SIDEWALK);
        this.building(district, cx, cz, 62, 40, 32, 0xb9b4a8);
        this.addHelipad(cx, cz, 32, `${name} research lab`);
        return true;
      }
      case 'commercial': {
        // The food warehouse the city's trucks run from.
        this.building(district, cx, cz, lot.w - 10, lot.d - 14, 16, 0x9a8f7c, false);
        return true;
      }
      case 'industrial': {
        // Power plant: turbine hall, boiler house and two tall stacks.
        this.building(district, cx - 8, cz + 18, 76, 40, 32, 0x7d7a74, false);
        this.building(district, cx + 26, cz - 18, 32, 28, 56, 0x6f6c66, false);
        this.cylinders.push({ x: cx - 30, z: cz - 24, r: 4.5, h: 150, color: 0x9b958c });
        this.cylinders.push({ x: cx - 12, z: cz - 24, r: 4.5, h: 150, color: 0x9b958c });
        return true;
      }
      case 'harbor':
        this.buildTankFarm(district, lot, 3, 2, 17, 19);
        return true;
      default:
        return false;
    }
  }

  private buildTankFarm(district: number, lot: Lot, cols: number, rows: number, r: number, h: number): void {
    this.fuelSites.push({ district, x: lot.cx, z: lot.cz });
    const sx = lot.w / cols;
    const sz = lot.d / rows;
    for (let a = 0; a < cols; a++) {
      for (let b = 0; b < rows; b++) {
        this.cylinders.push({ x: lot.x0 + sx * (a + 0.5), z: lot.z0 + sz * (b + 0.5), r: Math.min(r, sx / 2 - 3, sz / 2 - 3), h, color: 0xd9d6cf });
      }
    }
  }

  private fillBlock(district: number, kind: DistrictKind, lot: Lot, rand: () => number): void {
    const pick = (colors: number[]) => colors[Math.floor(rand() * colors.length)];
    const inner = { x0: lot.x0 + SIDEWALK, z0: lot.z0 + SIDEWALK, x1: lot.x1 - SIDEWALK, z1: lot.z1 - SIDEWALK };
    const iw = inner.x1 - inner.x0;
    const id = inner.z1 - inner.z0;
    /** Split the block into n x m parcels and call fn for each centre and size. */
    const parcels = (n: number, m: number, gap: number, fn: (x: number, z: number, w: number, d: number) => void) => {
      const w = (iw - gap * (n - 1)) / n;
      const d = (id - gap * (m - 1)) / m;
      for (let a = 0; a < n; a++) {
        for (let b = 0; b < m; b++) fn(inner.x0 + a * (w + gap) + w / 2, inner.z0 + b * (d + gap) + d / 2, w, d);
      }
    };

    switch (kind) {
      case 'downtown': {
        // Taller toward the centre: a few supertalls, a forest of towers, midrise at the edges.
        const f = Math.min(1, Math.hypot(lot.ox, lot.oz) / (DISTRICT_SIZE * 0.55));
        const towerness = Math.pow(1 - f, 1.6);
        const glass = [0x4f6476, 0x5d6c7a, 0x6b7884, 0x3f5566, 0x7f8a92, 0x55707f, 0x8c96a0];
        const tower = (x: number, z: number, w: number, d: number) => {
          const podium = 10 + rand() * 14;
          this.building(district, x, z, w * 0.96, d * 0.96, podium, pick([0x8a8478, 0x6f6c66, 0x7a7f84]));
          const h = 50 + towerness * (0.45 + rand() * 0.55) * 360 + rand() * 30;
          const tw = w * (0.55 + rand() * 0.25);
          const td = d * (0.55 + rand() * 0.25);
          const color = pick(glass);
          if (h > 160 && rand() < 0.5) {
            // Setback: the top third steps in.
            this.building(district, x, z, tw, td, h * 0.68, color, true, podium);
            this.building(district, x, z, tw * 0.72, td * 0.72, h * 0.32, color, true, podium + h * 0.68);
          } else {
            this.building(district, x, z, tw, td, h, color, true, podium);
          }
          if (h > 240) this.cylinders.push({ x, z, r: 0.8, h: 25 + rand() * 40, y: podium + h, color: 0xb0b4b8 });
        };
        if (towerness > 0.45 && rand() < 0.45) tower(lot.cx, lot.cz, iw, id);
        else parcels(2, 2, 6, tower);
        break;
      }
      case 'commercial': {
        if (rand() < 0.12) {
          // Big-box store with a car park.
          this.pad(lot, 0x55575a, district, 0.22, SIDEWALK);
          this.building(district, lot.cx, inner.z0 + 22, iw * 0.8, 40, 10, 0xb8ad98, false);
          break;
        }
        parcels(2 + Math.floor(rand() * 2), 2, 4, (x, z, w, d) =>
          this.building(district, x, z, w * (0.8 + rand() * 0.2), d * (0.8 + rand() * 0.2), 10 + rand() * 45, pick([0xb0a58f, 0x9e9a90, 0xc2b8a3, 0x8d8679, 0xa59a86])),
        );
        break;
      }
      case 'apartments': {
        this.pad(lot, GRASS, district, 0.22, SIDEWALK + 2);
        const color = pick([0xa89f91, 0x9c8f80, 0xb5aa98, 0x8f8a84, 0xb39b82]);
        if (rand() < 0.25) {
          // A tower block on a lawn.
          this.building(district, lot.cx, lot.cz, 26, 26, 60 + rand() * 30, color);
        } else {
          // Slabs along the two long sides with a courtyard between.
          const h = 20 + rand() * 40;
          this.building(district, lot.cx, inner.z0 + 11, iw - 8, 18, h, color);
          this.building(district, lot.cx, inner.z1 - 11, iw - 8, 18, h * (0.8 + rand() * 0.4), color);
        }
        break;
      }
      case 'university': {
        this.pad(lot, GRASS, district, 0.22, SIDEWALK);
        const brick = [0xa0705a, 0xb07e63, 0x9a8a78, 0x8f6a55];
        if (rand() < 0.65) {
          this.building(district, lot.cx, inner.z0 + 14, 40 + rand() * 30, 22, 14 + rand() * 14, pick(brick));
          if (rand() < 0.6) this.building(district, inner.x0 + 14, lot.cz + 10, 22, 34 + rand() * 20, 12 + rand() * 10, pick(brick));
        }
        for (let k = 0; k < 8; k++) this.trees.push({ x: lot.cx + (rand() - 0.5) * (iw - 10), z: lot.cz + 10 + rand() * (id / 2 - 10), s: 1 + rand() * 0.6 });
        break;
      }
      case 'hospital': {
        if (rand() < 0.2) {
          // Parking structure.
          this.building(district, lot.cx, lot.cz, iw * 0.85, id * 0.7, 15, 0x8f8f8a, false);
          break;
        }
        parcels(2, 2, 6, (x, z, w, d) => this.building(district, x, z, w * 0.85, d * 0.85, 12 + rand() * 30, pick([0xd2cbc0, 0xbfb8ad, 0xa79f94])));
        break;
      }
      case 'industrial': {
        if (rand() < 0.12) {
          this.buildTankFarm(district, lot, 2, 2, 16, 16);
          break;
        }
        this.building(district, lot.cx, lot.cz, iw * (0.6 + rand() * 0.35), id * (0.5 + rand() * 0.4), 9 + rand() * 8, pick([0x8b8478, 0x7a776f, 0x948d7e, 0x6f747a]), false);
        break;
      }
      case 'harbor': {
        if (rand() < 0.45) this.buildContainerYard(district, inner, rand);
        else this.building(district, lot.cx, lot.cz, iw * 0.9, id * 0.55, 11 + rand() * 5, pick([0x7b8288, 0x8a7d6c, 0x6c7378]), false);
        break;
      }
      case 'residential':
      default:
        this.buildHouses(district, inner, rand);
    }
  }

  /** Detached houses on lots facing the two long streets, with back gardens and trees. */
  private buildHouses(district: number, inner: { x0: number; z0: number; x1: number; z1: number }, rand: () => number): void {
    const walls = [0xd8cdb8, 0xc9b79c, 0xb8a58c, 0xe2ddd0, 0x9fa7a0, 0xa65d48, 0xc4c9cf];
    const roofs = [0x4a4a4e, 0x5b4a3c, 0x7a3b2e, 0x3d4247, 0x6b5a48];
    const frontage = 16;
    const n = Math.floor((inner.x1 - inner.x0) / frontage);
    const start = inner.x0 + ((inner.x1 - inner.x0) - n * frontage) / 2;
    for (const side of [-1, 1]) {
      for (let k = 0; k < n; k++) {
        if (rand() < 0.08) continue;
        const w = 9 + rand() * 3;
        const d = 9 + rand() * 4;
        const x = start + (k + 0.5) * frontage;
        // Set back 6 m from the sidewalk, facing the street.
        const z = side < 0 ? inner.z0 + 6 + d / 2 : inner.z1 - 6 - d / 2;
        const wall = 3 + (rand() < 0.6 ? 3 : 0) + rand() * 0.4;
        const roof = 2.4 + rand() * 1.2;
        const color = walls[Math.floor(rand() * walls.length)];
        this.boxes.push({ x, z, w, d, h: wall, color, windows: true, district, solid: true });
        this.roofs.push({ x, z, w: w + 0.6, d: d + 0.6, h: roof, y: wall, yaw: 0, color: roofs[Math.floor(rand() * roofs.length)] });
        // A tree in most back gardens.
        if (rand() < 0.6) this.trees.push({ x: x + (rand() - 0.5) * 8, z: (inner.z0 + inner.z1) / 2 + side * (4 + rand() * 6), s: 0.9 + rand() * 0.6 });
      }
    }
  }

  /** Stacks of real 40 ft containers (12.2 x 2.44 x 2.6 m) in rows. */
  private buildContainerYard(district: number, inner: { x0: number; z0: number; x1: number; z1: number }, rand: () => number): void {
    const colors = [0xa8412f, 0x2f6a8a, 0x3e7a3a, 0xc59a2b, 0x7a3f7a, 0x8a8f94, 0xb35d22];
    const lane = 2.44 + 0.3;
    for (let x = inner.x0 + 8; x + 12.2 < inner.x1 - 4; x += 12.2 + 6) {
      for (let z = inner.z0 + 4; z + lane < inner.z1 - 4; z += lane) {
        const stack = Math.floor(rand() * 5);
        for (let k = 0; k < stack; k++) {
          this.boxes.push({ x: x + 6.1, z: z + 1.22, w: 12.2, d: 2.44, h: 2.6, y: k * 2.6, color: colors[Math.floor(rand() * colors.length)], district, solid: k === stack - 1 });
        }
      }
    }
  }

  private buildAirbase(district: number): void {
    const tpl = DISTRICT_TEMPLATES[district];
    const { x: cx, z: cz } = districtCenter(tpl.col, tpl.row);
    const name = tpl.name;
    const half = DISTRICT_SIZE / 2;
    this.boxes.push({ x: cx, z: cz, w: DISTRICT_SIZE - 40, d: DISTRICT_SIZE - 40, h: 0.15, color: 0x5d6a4e, district });
    // A 1,400 m runway, a parallel taxiway and the apron.
    this.boxes.push({ x: cx, z: cz + 420, w: 1360, d: 45, h: 0.3, color: 0x3a3a3c, district });
    this.boxes.push({ x: cx, z: cz + 330, w: 1100, d: 23, h: 0.3, color: 0x46464a, district });
    for (const dx of [-450, 0, 450]) this.boxes.push({ x: cx + dx, z: cz + 375, w: 23, d: 90, h: 0.3, color: 0x46464a, district });
    this.boxes.push({ x: cx - 80, z: cz + 60, w: 720, d: 260, h: 0.3, color: 0x6c6c6c, district });
    for (let i = 0; i < 6; i++) this.building(district, cx - 380 + i * 90, cz - 160, 64, 46, 18, 0x6e7562, false);
    for (let i = 0; i < 4; i++) this.building(district, cx + 420, cz - 300 + i * 40, 70, 16, 10, 0x8a8576);
    // Control tower and its cab.
    this.building(district, cx + 340, cz + 80, 9, 9, 36, 0xb8b2a4);
    this.building(district, cx + 340, cz + 80, 15, 15, 6, 0x2f3d44, true, 36);
    // Fuel farm.
    for (let i = 0; i < 3; i++) this.cylinders.push({ x: cx + 520, z: cz - 40 + i * 30, r: 11, h: 13, color: 0xcfcbc2 });
    this.fuelSites.push({ district, x: cx + 520, z: cz - 10 });
    // Perimeter fence.
    for (const [w, d, dx, dz] of [[DISTRICT_SIZE - 40, 0.4, 0, -half + 20], [DISTRICT_SIZE - 40, 0.4, 0, half - 20], [0.4, DISTRICT_SIZE - 40, -half + 20, 0], [0.4, DISTRICT_SIZE - 40, half - 20, 0]]) {
      this.boxes.push({ x: cx + dx, z: cz + dz, w, d, h: 3, color: 0x55584f, district, solid: true });
    }
    // Helicopter pads along the apron: pad 1 is the player's.
    for (let i = 0; i < 6; i++) this.addHelipad(cx - 360 + i * 60, cz + 20, 0.3, `${name} pad ${i + 1}`);
  }

  /** Quay, piers and gantry cranes along the harbour's sea edge. */
  private buildWaterfront(rand: () => number): void {
    const harbor = DISTRICT_TEMPLATES.findIndex((d) => d.kind === 'harbor');
    if (harbor < 0) return;
    const tpl = DISTRICT_TEMPLATES[harbor];
    const c = districtCenter(tpl.col, tpl.row);
    const edge = -CITY_DEPTH / 2;
    this.boxes.push({ x: c.x, z: edge - 30, w: DISTRICT_SIZE, d: 60, h: 1.5, color: 0x6f6a60, district: harbor });
    for (let i = 0; i < 4; i++) this.boxes.push({ x: c.x - 540 + i * 360, z: edge - 200, w: 40, d: 300, h: 1.5, color: 0x6f6a60, district: harbor });
    // Ship-to-shore cranes: four legs, a girder and a boom over the water.
    for (let k = 0; k < 6; k++) {
      const x = c.x - 600 + k * 220 + rand() * 40;
      const z = edge - 30;
      for (const [lx, lz] of [[-9, -12], [9, -12], [-9, 12], [9, 12]]) {
        this.boxes.push({ x: x + lx, z: z + lz, w: 1.6, d: 1.6, h: 48, color: 0xc4602a, district: harbor, solid: true });
      }
      this.boxes.push({ x, z: z - 20, w: 22, d: 70, h: 4, y: 48, color: 0xc4602a, district: harbor, solid: true });
    }
  }

  private addHelipad(x: number, z: number, y: number, name: string): void {
    this.helipads.push({ x, z, y, name });
  }

  // --- Streets ---------------------------------------------------------------------------

  /** Streetlights on alternating sides and parked or abandoned cars along every block. */
  private placeStreetFurniture(rand: () => number): void {
    const colors = [0x8c1d1d, 0x1d3f8c, 0xd8d8d0, 0x2a2a2a, 0x6b6f72, 0x9c7a2b, 0x2f5f3a, 0xb0b4b8, 0x5a1f2f];
    for (let i = 0; i < NODES_X; i++) {
      for (let j = 0; j < NODES_Z; j++) {
        for (const horizontal of [true, false]) {
          if (horizontal ? i === NODES_X - 1 : j === NODES_Z - 1) continue;
          const line = horizontal ? j : i;
          const width = roadWidth(line);
          const ax = nodeX(i);
          const az = nodeZ(j);
          const start = (horizontal ? roadWidth(i) : roadWidth(j)) / 2;
          const end = STREET_SPACING - (horizontal ? roadWidth(i + 1) : roadWidth(j + 1)) / 2;
          const at = (t: number, offset: number) =>
            horizontal ? { x: ax + t, z: az + offset } : { x: ax + offset, z: az + t };
          const mid = at(STREET_SPACING / 2, 0);
          const district = districtAt(mid.x, mid.z);
          if (district < 0 || DISTRICT_TEMPLATES[district].kind === 'airbase') continue;

          for (let t = start + 10, k = 0; t < end - 5; t += LAMP_SPACING, k++) {
            const side = k % 2 === 0 ? 1 : -1;
            const p = at(t, side * (width / 2 + 0.8));
            this.lamps.push({ ...p, yaw: (horizontal ? 0 : Math.PI / 2) + (side > 0 ? Math.PI : 0), district });
          }

          const n = rand() < 0.6 ? 1 + Math.floor(rand() * 4) : 0;
          for (let k = 0; k < n; k++) {
            const t = start + 6 + rand() * (end - start - 12);
            const side = rand() < 0.5 ? -1 : 1;
            const abandoned = rand() < 0.12;
            const offset = abandoned ? (rand() - 0.5) * (width - 6) : side * (width / 2 - 1.3);
            const p = at(t, offset);
            const yaw = (horizontal ? 0 : Math.PI / 2) + (abandoned ? (rand() - 0.5) * 1.4 : 0);
            this.cars.push({ ...p, yaw, color: colors[Math.floor(rand() * colors.length)] });
          }
        }
      }
    }
  }

  /** Lane markings: a dashed centre line on streets, double yellow and lane lines on avenues. */
  private buildRoadMarkings(): void {
    const dashed: number[] = [];
    const solid: number[] = [];
    const dashedUv: number[] = [];
    const quad = (out: number[], uvs: number[] | null, x0: number, z0: number, x1: number, z1: number, width: number) => {
      const horizontal = z0 === z1;
      const hx = horizontal ? 0 : width / 2;
      const hz = horizontal ? width / 2 : 0;
      const y = 0.04;
      out.push(x0 - hx, y, z0 - hz, x1 - hx, y, z1 - hz, x1 + hx, y, z1 + hz, x0 - hx, y, z0 - hz, x1 + hx, y, z1 + hz, x0 + hx, y, z0 + hz);
      if (uvs) {
        const len = Math.hypot(x1 - x0, z1 - z0) / 6;
        uvs.push(0, 0, 0, len, 1, len, 0, 0, 1, len, 1, 0);
      }
    };
    for (let i = 0; i < NODES_X; i++) {
      for (let j = 0; j < NODES_Z; j++) {
        for (const horizontal of [true, false]) {
          if (horizontal ? i === NODES_X - 1 : j === NODES_Z - 1) continue;
          const line = horizontal ? j : i;
          const a = horizontal ? nodeX(i) + roadWidth(i) / 2 : nodeZ(j) + roadWidth(j) / 2;
          const b = horizontal ? nodeX(i + 1) - roadWidth(i + 1) / 2 : nodeZ(j + 1) - roadWidth(j + 1) / 2;
          const fixed = horizontal ? nodeZ(j) : nodeX(i);
          const seg = (offset: number, out: number[], uvs: number[] | null, width: number) =>
            horizontal ? quad(out, uvs, a, fixed + offset, b, fixed + offset, width) : quad(out, uvs, fixed + offset, a, fixed + offset, b, width);
          if (roadWidth(line) > 20) {
            seg(-0.25, solid, null, 0.15);
            seg(0.25, solid, null, 0.15);
            seg(-7.5, dashed, dashedUv, 0.15);
            seg(7.5, dashed, dashedUv, 0.15);
          } else {
            seg(0, dashed, dashedUv, 0.15);
          }
        }
      }
    }
    const dashTex = (() => {
      const c = document.createElement('canvas');
      c.width = 4;
      c.height = 32;
      const g = c.getContext('2d')!;
      g.fillStyle = '#e8e4d8';
      g.fillRect(0, 0, 4, 16);
      const t = new THREE.CanvasTexture(c);
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      return t;
    })();
    const make = (positions: number[], uvs: number[] | null, material: THREE.Material) => {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      if (uvs) geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
      geo.computeVertexNormals();
      const mesh = new THREE.Mesh(geo, material);
      mesh.receiveShadow = true;
      this.group.add(mesh);
    };
    const flat = { side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -1 };
    make(dashed, dashedUv, new THREE.MeshLambertMaterial({ map: dashTex, alphaTest: 0.5, ...flat }));
    make(solid, null, new THREE.MeshLambertMaterial({ color: 0xc9a227, ...flat }));
  }

  private buildGround(): void {
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(40000, 40000),
      // Pushed back in depth and kept well below the streets so it can't show through them.
      new THREE.MeshLambertMaterial({ color: 0x55664a, polygonOffset: true, polygonOffsetFactor: 4, polygonOffsetUnits: 4 }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.6;
    ground.receiveShadow = true;
    this.group.add(ground);

    const asphalt = new THREE.Mesh(
      new THREE.PlaneGeometry(CITY_WIDTH + 60, CITY_DEPTH + 60),
      new THREE.MeshLambertMaterial({ color: 0x35373a }),
    );
    asphalt.rotation.x = -Math.PI / 2;
    asphalt.receiveShadow = true;
    this.group.add(asphalt);

    // The sea along the north edge.
    const seaDepth = 16000;
    const sea = new THREE.Mesh(
      new THREE.PlaneGeometry(40000, seaDepth),
      new THREE.MeshPhongMaterial({ color: 0x2d5873, shininess: 80, specular: 0x557788 }),
    );
    sea.rotation.x = -Math.PI / 2;
    sea.position.set(0, 0.02, -CITY_DEPTH / 2 - seaDepth / 2 - 31);
    this.group.add(sea);

    const tex = helipadTexture();
    const padMat = new THREE.MeshLambertMaterial({ map: tex, transparent: true, polygonOffset: true, polygonOffsetFactor: -2 });
    for (const pad of this.helipads) {
      const m = new THREE.Mesh(new THREE.CircleGeometry(10, 32), padMat);
      m.rotation.x = -Math.PI / 2;
      m.position.set(pad.x, pad.y + 0.05, pad.z);
      this.group.add(m);
    }
  }

  // --- Meshes ----------------------------------------------------------------------------

  private buildInstances(): void {
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const v = new THREE.Vector3();
    const s = new THREE.Vector3();
    const up = new THREE.Vector3(0, 1, 0);
    const color = new THREE.Color();

    const geometry = new THREE.BoxGeometry(1, 1, 1);
    geometry.translate(0, 0.5, 0);
    const material = new THREE.MeshLambertMaterial();
    this.applyWindowShader(material);
    const mesh = new THREE.InstancedMesh(geometry, material, this.boxes.length);
    const lit = new Float32Array(this.boxes.length);
    const districtIds = new Float32Array(this.boxes.length);
    this.boxes.forEach((b, i) => {
      m.compose(v.set(b.x, b.y ?? 0, b.z), q.setFromAxisAngle(up, b.yaw ?? 0), s.set(b.w, b.h, b.d));
      mesh.setMatrixAt(i, m);
      mesh.setColorAt(i, color.setHex(b.color));
      lit[i] = b.windows ? 1 : 0;
      districtIds[i] = b.district;
    });
    geometry.setAttribute('aLit', new THREE.InstancedBufferAttribute(lit, 1));
    geometry.setAttribute('aDistrict', new THREE.InstancedBufferAttribute(districtIds, 1));
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    this.group.add(mesh);

    // Gable roofs: a triangular prism, ridge along x.
    const prism = new THREE.BufferGeometry();
    prism.setAttribute('position', new THREE.Float32BufferAttribute([
      -0.5, 0, -0.5, 0.5, 0, -0.5, 0.5, 1, 0, -0.5, 0, -0.5, 0.5, 1, 0, -0.5, 1, 0,
      0.5, 0, 0.5, -0.5, 0, 0.5, -0.5, 1, 0, 0.5, 0, 0.5, -0.5, 1, 0, 0.5, 1, 0,
      -0.5, 0, 0.5, -0.5, 0, -0.5, -0.5, 1, 0,
      0.5, 0, -0.5, 0.5, 0, 0.5, 0.5, 1, 0,
    ], 3));
    prism.computeVertexNormals();
    const roofs = new THREE.InstancedMesh(prism, new THREE.MeshLambertMaterial({ side: THREE.DoubleSide }), this.roofs.length);
    this.roofs.forEach((r, i) => {
      m.compose(v.set(r.x, r.y, r.z), q.setFromAxisAngle(up, r.yaw), s.set(r.w, r.h, r.d));
      roofs.setMatrixAt(i, m);
      roofs.setColorAt(i, color.setHex(r.color));
    });
    roofs.castShadow = true;
    roofs.receiveShadow = true;
    this.group.add(roofs);

    const cylGeo = new THREE.CylinderGeometry(1, 1, 1, 20);
    cylGeo.translate(0, 0.5, 0);
    const cyl = new THREE.InstancedMesh(cylGeo, new THREE.MeshLambertMaterial(), this.cylinders.length);
    this.cylinders.forEach((c, i) => {
      m.makeScale(c.r, c.h, c.r).setPosition(c.x, c.y ?? 0, c.z);
      cyl.setMatrixAt(i, m);
      cyl.setColorAt(i, color.setHex(c.color));
    });
    cyl.castShadow = true;
    cyl.receiveShadow = true;
    this.group.add(cyl);

    // Trees: a trunk and a crown, 9–16 m tall.
    const trunk = new THREE.CylinderGeometry(0.25, 0.35, 3, 6);
    trunk.translate(0, 1.5, 0);
    const crown = new THREE.ConeGeometry(3.2, 8, 7);
    crown.translate(0, 6.5, 0);
    const treeColors = [0x2f5a2a, 0x3a6a30, 0x2b4f2a, 0x456f34];
    const trees = new THREE.InstancedMesh(mergeGeometries([trunk, crown]), new THREE.MeshLambertMaterial(), this.trees.length);
    this.trees.forEach((t, i) => {
      m.makeScale(t.s, t.s, t.s).setPosition(t.x, 0, t.z);
      trees.setMatrixAt(i, m);
      trees.setColorAt(i, color.setHex(treeColors[i % treeColors.length]));
    });
    trees.castShadow = true;
    this.group.add(trees);

    // Cars at real size: 4.5 x 1.8 x 1.45 m.
    const body = new THREE.BoxGeometry(4.5, 0.75, 1.8);
    body.translate(0, 0.55, 0);
    const cabin = new THREE.BoxGeometry(2.4, 0.6, 1.6);
    cabin.translate(-0.25, 1.2, 0);
    const cars = new THREE.InstancedMesh(mergeGeometries([body, cabin]), new THREE.MeshLambertMaterial(), this.cars.length);
    this.cars.forEach((c, i) => {
      m.compose(v.set(c.x, 0, c.z), q.setFromAxisAngle(up, c.yaw), s.set(1, 1, 1));
      cars.setMatrixAt(i, m);
      cars.setColorAt(i, color.setHex(c.color));
    });
    cars.castShadow = true;
    this.group.add(cars);

    this.buildLamps();
  }

  /** Streetlight poles, heads that glow at night while the district has grid power, and pools of light on the road. */
  private buildLamps(): void {
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const v = new THREE.Vector3();
    const s = new THREE.Vector3(1, 1, 1);
    const up = new THREE.Vector3(0, 1, 0);
    // Lamps sorted by district so a district's lamps can be switched together.
    this.lamps.sort((a, b) => a.district - b.district);

    const pole = new THREE.CylinderGeometry(0.09, 0.13, LAMP_HEIGHT, 5);
    pole.translate(0, LAMP_HEIGHT / 2, 0);
    const arm = new THREE.BoxGeometry(0.1, 0.1, 2.2);
    arm.translate(0, LAMP_HEIGHT - 0.1, 1.1);
    const poles = new THREE.InstancedMesh(mergeGeometries([pole, arm]), new THREE.MeshLambertMaterial({ color: 0x4a4d50 }), this.lamps.length);

    const headGeo = new THREE.BoxGeometry(0.5, 0.18, 0.9);
    headGeo.translate(0, LAMP_HEIGHT - 0.25, 2.1);
    this.lampHeads = new THREE.InstancedMesh(headGeo, new THREE.MeshBasicMaterial(), this.lamps.length);

    const poolGeo = new THREE.CircleGeometry(9, 20);
    poolGeo.rotateX(-Math.PI / 2);
    poolGeo.translate(0, 0.06, 2.6);
    this.lampPools = new THREE.InstancedMesh(poolGeo, new THREE.MeshBasicMaterial({
      map: poolTexture(), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
    }), this.lamps.length);

    this.lamps.forEach((l, i) => {
      m.compose(v.set(l.x, 0, l.z), q.setFromAxisAngle(up, l.yaw), s);
      poles.setMatrixAt(i, m);
      this.lampHeads.setMatrixAt(i, m);
      this.lampPools.setMatrixAt(i, m);
    });
    this.group.add(poles, this.lampHeads, this.lampPools);
    this.lamps.forEach((_, i) => this.colorLamp(i, false));
  }

  private colorLamp(i: number, on: boolean): void {
    const c = new THREE.Color(on ? 0xffd9a0 : 0x2a2c2e);
    this.lampHeads.setColorAt(i, c);
    this.lampPools.setColorAt(i, on ? c.setRGB(0.55, 0.42, 0.22) : c.setRGB(0, 0, 0));
  }

  /** Streetlights burn at night while the grid powers the district (generators don't run them). */
  private refreshLamps(): void {
    if (!this.lampHeads) return;
    let changed = false;
    for (let d = 0; d < this.lampsOn.length; d++) {
      const on = this.night > 0.45 && this.districtLight[d] >= 0.99;
      if (on === this.lampsOn[d]) continue;
      this.lampsOn[d] = on;
      changed = true;
      this.lamps.forEach((l, i) => {
        if (l.district === d) this.colorLamp(i, on);
      });
    }
    if (changed) {
      this.lampHeads.instanceColor!.needsUpdate = true;
      this.lampPools.instanceColor!.needsUpdate = true;
    }
  }

  /** Procedural windows from world position, lit at night per district power level. */
  private applyWindowShader(material: THREE.MeshLambertMaterial): void {
    const count = DISTRICT_TEMPLATES.length;
    material.onBeforeCompile = (shader) => {
      shader.uniforms.uNight = this.windowUniforms.uNight;
      shader.uniforms.uDistrictLight = this.windowUniforms.uDistrictLight;
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          `#include <common>
          attribute float aLit;
          attribute float aDistrict;
          uniform float uDistrictLight[${count}];
          varying vec3 vWinPos;
          varying vec3 vWinNormal;
          varying float vWinLit;
          varying float vWinLight;`,
        )
        .replace(
          '#include <project_vertex>',
          `#include <project_vertex>
          vec4 winPos = vec4(transformed, 1.0);
          vec3 winNormal = objectNormal;
          #ifdef USE_INSTANCING
            winPos = instanceMatrix * winPos;
            winNormal = mat3(instanceMatrix) * winNormal;
          #endif
          vWinPos = (modelMatrix * winPos).xyz;
          vWinNormal = normalize(mat3(modelMatrix) * winNormal);
          vWinLit = aLit;
          vWinLight = aLit * uDistrictLight[int(aDistrict + 0.5)];`,
        );
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>
          uniform float uNight;
          varying vec3 vWinPos;
          varying vec3 vWinNormal;
          varying float vWinLit;
          varying float vWinLight;
          float winHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }`,
        )
        .replace(
          '#include <emissivemap_fragment>',
          `#include <emissivemap_fragment>
          // Windows are always drawn; only their night glow depends on the district's power.
          // Real storeys are about 3.5 m; windows about 1.5 m wide on a 3 m rhythm.
          if (vWinLit > 0.5 && abs(vWinNormal.y) < 0.5 && vWinPos.y > 1.2) {
            float along = abs(vWinNormal.x) > 0.5 ? vWinPos.z : vWinPos.x;
            vec2 cell = vec2(floor(along / 3.0), floor(vWinPos.y / 3.5));
            vec2 f = vec2(fract(along / 3.0), fract(vWinPos.y / 3.5));
            float pane = step(0.22, f.x) * step(f.x, 0.78) * step(0.28, f.y) * step(f.y, 0.78);
            float h = winHash(cell + floor(vWinPos.xz / 97.0));
            float on = step(1.0 - 0.55 * vWinLight, h);
            vec3 warm = mix(vec3(1.0, 0.78, 0.45), vec3(0.75, 0.85, 1.0), step(0.8, h));
            totalEmissiveRadiance += warm * pane * on * uNight * 1.1;
            diffuseColor.rgb *= 1.0 - pane * 0.35;
          }`,
        );
    };
  }

  private buildColliders(): void {
    const add = (minX: number, maxX: number, minZ: number, maxZ: number, top: number, floor = false) => {
      const index = this.colliders.push({ minX, maxX, minZ, maxZ, top, floor }) - 1;
      for (let gx = Math.floor(minX / COLLISION_CELL); gx <= Math.floor(maxX / COLLISION_CELL); gx++) {
        for (let gz = Math.floor(minZ / COLLISION_CELL); gz <= Math.floor(maxZ / COLLISION_CELL); gz++) {
          const k = this.key(gx, gz);
          const list = this.grid.get(k);
          if (list) list.push(index);
          else this.grid.set(k, [index]);
        }
      }
    };
    for (const b of this.boxes) {
      if (!b.solid && b.h > 2) continue;
      add(b.x - b.w / 2, b.x + b.w / 2, b.z - b.d / 2, b.z + b.d / 2, (b.y ?? 0) + b.h, !b.solid);
    }
    // Roofs count to their ridge so a helicopter rests on top, not inside.
    for (const r of this.roofs) add(r.x - r.w / 2, r.x + r.w / 2, r.z - r.d / 2, r.z + r.d / 2, r.y + r.h);
    for (const c of this.cylinders) add(c.x - c.r, c.x + c.r, c.z - c.r, c.z + c.r, (c.y ?? 0) + c.h);
  }

  private key(gx: number, gz: number): number {
    return (gx + 1000) * 4096 + (gz + 1000);
  }

  private cellKey(x: number, z: number): number {
    return this.key(Math.floor(x / COLLISION_CELL), Math.floor(z / COLLISION_CELL));
  }
}

function helipadTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  g.fillStyle = '#2b2f33';
  g.beginPath();
  g.arc(64, 64, 63, 0, Math.PI * 2);
  g.fill();
  g.strokeStyle = '#e8e3d0';
  g.lineWidth = 6;
  g.beginPath();
  g.arc(64, 64, 52, 0, Math.PI * 2);
  g.stroke();
  g.fillStyle = '#e8e3d0';
  g.font = 'bold 72px sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText('H', 64, 68);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function poolTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}
