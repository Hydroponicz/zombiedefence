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
import { planSites, type SitePlan } from '../sim/sites';
import { RAIL } from '../sim/supply';
import { BLOCKS_PER_DISTRICT, blockLot, NODES_X, NODES_Z, nodeX, nodeZ, roadWidth, SIDEWALK, STREET_SPACING } from '../sim/streets';

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
  /** Windows: true for punched windows, or a WINDOW style; none if omitted. */
  windows?: boolean | number;
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

/** Where people and zombies can walk: a 4 m raster of the city, 0 inside buildings. */
export interface WalkGrid {
  cell: number;
  x0: number;
  z0: number;
  cols: number;
  rows: number;
  data: Uint8Array;
}

/** True if (x, z) is open ground (streets, sidewalks, lawns, outside the city). */
export function walkable(grid: WalkGrid | null, x: number, z: number): boolean {
  if (!grid) return true;
  const c = Math.floor((x - grid.x0) / grid.cell);
  const r = Math.floor((z - grid.z0) / grid.cell);
  if (c < 0 || r < 0 || c >= grid.cols || r >= grid.rows) return true;
  return grid.data[r * grid.cols + c] === 1;
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

/** Facade styles the window shader draws. */
const WINDOW = { punched: 1, glass: 2, residential: 3, stone: 4 } as const;

const POLICE_CARS = [0xf2f2f2, 0x16181c];
const SHOPPER_CARS = [0x7d2a24, 0x2b4a72, 0xb9b9b4, 0x3c3c3c, 0x6d6f4a];

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
  readonly walk: WalkGrid;
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
  /** Strategic sites by block, built in place of ordinary buildings. */
  private sitePlans = new Map<string, SitePlan>();

  constructor(seed: number | string) {
    const rand = makeRandom(`city-${seed}`);
    for (const p of planSites(seed)) this.sitePlans.set(`${p.i},${p.j}`, p);
    DISTRICT_TEMPLATES.forEach((tpl, i) => this.buildDistrict(i, tpl.kind, rand));
    this.buildWaterfront(rand);
    this.buildRailLine();
    this.placeStreetFurniture(rand);
    this.buildGround();
    this.buildInstances();
    this.buildRoadMarkings();
    this.buildColliders();
    this.walk = this.buildWalkGrid();
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
    const lot = blockLot(i, j);
    return { ...lot, ox: lot.cx - c.x, oz: lot.cz - c.z };
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
        // Sidewalk around every block; houses sit on lawns inside it. Sites lay their own grounds.
        this.pad(lot, CONCRETE, district, 0.18);
        if (RAIL.blocks.some(([a, b]) => a === i && b === j)) {
          this.buildRailYard(district, lot);
          continue;
        }
        const site = this.sitePlans.get(`${i},${j}`);
        if (site) {
          this.buildSite(district, site, lot, rand);
          continue;
        }
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

  private building(district: number, x: number, z: number, w: number, d: number, h: number, color: number, windows: boolean | number = true, y = 0): void {
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

  /** The freight line: ballast and rails from the yard south, out past the city edge. */
  private buildRailLine(): void {
    const z0 = RAIL.stopZ - 8;
    const z1 = RAIL.farZ + 300;
    const district = DISTRICT_TEMPLATES.findIndex((d) => d.kind === 'industrial');
    const len = z1 - z0;
    this.boxes.push({ x: RAIL.x, z: z0 + len / 2, w: 4.2, d: len, h: 0.9, y: -0.6, color: 0x7a7468, district });
    for (const off of [-0.72, 0.72]) {
      this.boxes.push({ x: RAIL.x + off, z: z0 + len / 2, w: 0.14, d: len, h: 0.18, y: 0.3, color: 0x5e5a55, district });
    }
  }

  /** The rail yard: gravel, two sidings beside the main line, a goods shed and a gantry. */
  private buildRailYard(district: number, lot: Lot): void {
    this.pad(lot, 0x8a8477, district, 0.24, SIDEWALK);
    for (const off of [-7, 7]) {
      for (const r of [-0.72, 0.72]) {
        this.boxes.push({ x: RAIL.x + off + r, z: lot.cz, w: 0.14, d: lot.d - 2 * SIDEWALK, h: 0.18, y: 0.24, color: 0x5e5a55, district });
      }
    }
    this.building(district, RAIL.x - 26, lot.cz, 16, lot.d - 20, 9, 0x8d7f6a, false);
    // Gantry crane straddling the tracks.
    for (const dx of [-12, 12]) this.cylinders.push({ x: RAIL.x + dx, z: lot.cz, r: 0.6, h: 14, color: 0xd09a2a });
    this.boxes.push({ x: RAIL.x, z: lot.cz, w: 26, d: 2, h: 1.6, y: 14, color: 0xd09a2a, district });
  }

  /**
   * A police station, supermarket, shelter or pharmacy, built around its landing zone (the car
   * park, playing field or plaza the simulation puts at LZ_OFFSET from the block centre).
   */
  private buildSite(district: number, site: SitePlan, lot: Lot, rand: () => number): void {
    const { cx, cz } = lot;
    const asphalt = 0x45474a;
    const lz = (color: number) => this.boxes.push({ x: site.x, z: site.z, w: 18, d: 18, h: 0.3, color, district });
    const parked = (n: number, z: number, colors: number[]) => {
      for (let k = 0; k < n; k++) {
        const x = cx + (k % 2 === 0 ? -1 : 1) * (16 + Math.floor(k / 2) * 6);
        if (Math.abs(x - cx) > lot.w / 2 - 8) break;
        this.cars.push({ x, z: z + (rand() - 0.5) * 2, yaw: Math.PI / 2, color: colors[Math.floor(rand() * colors.length)] });
      }
    };
    switch (site.variant) {
      case 'station': {
        // Suburban station: a low block with a car park.
        this.boxes.push({ x: cx, z: cz + 24, w: lot.w - 2 * SIDEWALK, d: 40, h: 0.22, color: asphalt, district });
        this.building(district, cx, cz - 18, 56, 34, 11, 0x46566e);
        // White band under the roofline and a radio mast.
        this.building(district, cx, cz - 18, 57, 35, 1.4, 0xe6e6e0, false, 8);
        this.cylinders.push({ x: cx + 23, z: cz - 30, r: 0.5, h: 34, y: 11, color: 0xb8bcc0 });
        parked(6, cz + 8, POLICE_CARS);
        lz(0xd7d2c4);
        break;
      }
      case 'precinct': {
        // Urban precinct: five storeys of brick, a blue canopy, and a walled vehicle yard.
        this.building(district, cx, cz - 18, 66, 34, 18, 0x8a4b3a);
        this.building(district, cx, cz - 0.4, 16, 3, 0.6, 0x2a4f8a, false, 4);
        this.cylinders.push({ x: cx + 26, z: cz - 28, r: 0.5, h: 26, y: 18, color: 0xb8bcc0 });
        this.boxes.push({ x: cx, z: cz + 26, w: lot.w - 2 * SIDEWALK, d: 38, h: 0.22, color: asphalt, district });
        for (const [x, z, w, d] of [[cx - 38, cz + 26, 0.6, 36], [cx + 38, cz + 26, 0.6, 36], [cx - 24, cz + 44, 28, 0.6], [cx + 24, cz + 44, 28, 0.6]]) {
          this.building(district, x, z, w, d, 3, 0x9a948a, false);
        }
        parked(6, cz + 10, POLICE_CARS);
        lz(0xd7d2c4);
        break;
      }
      case 'hq': {
        // Police headquarters: a stone podium, a sixteen-storey tower and a plaza.
        this.building(district, cx, cz - 16, 72, 38, 12, 0xa79f90, 4);
        this.building(district, cx - 8, cz - 20, 36, 26, 64, 0x46566e, 4, 12);
        this.building(district, cx - 8, cz - 20, 37, 27, 2, 0x2a4f8a, false, 70);
        this.cylinders.push({ x: cx - 8, z: cz - 20, r: 0.6, h: 30, y: 76, color: 0xb8bcc0 });
        this.boxes.push({ x: cx, z: cz + 26, w: lot.w - 2 * SIDEWALK, d: 40, h: 0.24, color: 0xbdb8ac, district });
        parked(8, cz + 8, POLICE_CARS);
        lz(0xd7d2c4);
        break;
      }
      case 'market': {
        // Corner supermarket under four floors of flats, with a loading yard.
        this.building(district, cx, cz - 16, lot.w - 16, 40, 6, 0xcfc6b2, false);
        this.building(district, cx, cz - 16, lot.w - 16, 40, 16, 0xc4b19a, 3, 6);
        this.building(district, cx, cz + 4.3, 34, 0.8, 2.2, 0xc23b2e, false, 3.4);
        this.boxes.push({ x: cx, z: cz + 26, w: lot.w - 2 * SIDEWALK, d: 40, h: 0.22, color: asphalt, district });
        this.building(district, cx + 30, cz + 24, 2.5, 12, 3.6, 0xe9e7e0, false, 1);
        parked(6, cz + 12, SHOPPER_CARS);
        lz(0xd7d2c4);
        break;
      }
      case 'mall': {
        // Downtown mall: a big box with a glass atrium, banners and a plaza.
        this.building(district, cx, cz - 14, lot.w - 14, 48, 18, 0xbcb3a3, 2);
        this.building(district, cx, cz - 14, 26, 26, 7, 0x5b7488, 2, 18);
        this.building(district, cx, cz + 10.4, 40, 0.8, 3, 0xc23b2e, false, 12);
        this.boxes.push({ x: cx, z: cz + 30, w: lot.w - 2 * SIDEWALK, d: 30, h: 0.24, color: 0xbdb8ac, district });
        for (let k = 0; k < 6; k++) this.trees.push({ x: cx - 36 + k * 14.4, z: cz + 42, s: 0.8 });
        lz(0xd7d2c4);
        break;
      }
      case 'clinic': {
        // Walk-in clinic: three white storeys, a green cross, an ambulance bay.
        this.boxes.push({ x: cx, z: cz + 14, w: lot.w - 2 * SIDEWALK, d: 56, h: 0.22, color: asphalt, district });
        this.building(district, cx - 16, cz - 18, 46, 34, 12, 0xe9e7e2);
        this.building(district, cx - 16, cz - 0.6, 4, 0.8, 4, 0x2e9e5b, false, 6);
        this.building(district, cx - 30, cz + 4, 12, 8, 0.6, 0xd0d0cc, false, 4);
        this.building(district, cx + 26, cz - 26, 26, 22, 10 + rand() * 8, 0xb0a58f);
        this.cars.push({ x: cx - 30, z: cz + 6, yaw: 0, color: 0xf2f2f2 });
        lz(0xd7d2c4);
        break;
      }
      case 'highschool': {
        // City high school: four storeys of brick in an L round a paved yard.
        this.building(district, cx - 24, cz - 8, 34, 70, 16, 0x9a5a44);
        this.building(district, cx + 8, cz - 32, 52, 18, 16, 0x9a5a44);
        this.boxes.push({ x: site.x, z: site.z, w: 46, d: 46, h: 0.24, color: 0x6b6d70, district });
        this.boxes.push({ x: site.x, z: site.z, w: 24, d: 14, h: 0.28, color: 0xa65a3c, district });
        lz(0x8a8d90);
        break;
      }
      case 'depot': {
        // Food distribution depot: a long warehouse, loading docks, trailers waiting.
        this.building(district, cx, cz - 16, lot.w - 14, 40, 12, 0xa9a294, false);
        this.boxes.push({ x: cx, z: cz + 6, w: lot.w - 20, d: 4, h: 0.6, y: 5, color: 0x6b6d70, district });
        for (let k = 0; k < 8; k++) {
          this.boxes.push({ x: cx - 36 + k * 10.3, z: cz + 4.2, w: 4, d: 0.3, h: 4, color: 0x3b3d40, district });
        }
        this.boxes.push({ x: cx, z: cz + 26, w: lot.w - 2 * SIDEWALK, d: 40, h: 0.22, color: asphalt, district });
        for (const dx of [-30, -20, 22, 32]) this.building(district, cx + dx, cz + 16, 2.6, 12, 3.6, 0xe9e7e0, false, 1);
        lz(0xd7d2c4);
        break;
      }
      case 'factory': {
        // Ration plant: saw-tooth production halls, silos and a stack.
        const hallW = lot.w - 14;
        this.building(district, cx, cz - 14, hallW, 46, 10, 0x8d8a82, false);
        for (let k = 0; k < 5; k++) {
          this.roofs.push({ x: cx, z: cz - 32 + k * 9, w: hallW, d: 9, h: 4, y: 10, yaw: 0, color: 0x6a6e72 });
        }
        for (let k = 0; k < 3; k++) this.cylinders.push({ x: cx + 26 + k * 9, z: cz + 14, r: 4, h: 18, color: 0xc9c7c0 });
        this.cylinders.push({ x: cx - 34, z: cz - 34, r: 1.6, h: 42, color: 0x8a5a44 });
        this.boxes.push({ x: cx, z: cz + 30, w: lot.w - 2 * SIDEWALK, d: 32, h: 0.22, color: asphalt, district });
        lz(0xd7d2c4);
        break;
      }
      case 'waterworks': {
        // Treatment basins, a pump house and a water tower.
        this.pad(lot, GRASS, district, 0.22, SIDEWALK);
        for (const [dx, dz] of [[12, -24], [34, -24], [12, 2], [34, 2]]) {
          this.cylinders.push({ x: cx + dx, z: cz + dz, r: 10, h: 1.6, color: 0x9a9a94 });
          this.cylinders.push({ x: cx + dx, z: cz + dz, r: 9.2, h: 1.7, color: 0x3d6f8a });
        }
        this.building(district, cx - 22, cz - 6, 22, 14, 7, 0x8a4b3a, true);
        for (const [dx, dz] of [[-4, -4], [4, -4], [-4, 4], [4, 4]]) {
          this.cylinders.push({ x: cx - 30 + dx, z: cz - 30 + dz, r: 0.4, h: 22, color: 0x8f9396 });
        }
        this.cylinders.push({ x: cx - 30, z: cz - 30, r: 6.5, h: 8, y: 22, color: 0xcfd3d6 });
        lz(0x9aa58e);
        break;
      }
      case 'fuelTerminal': {
        // Fuel terminal: storage tanks, a pipe rack and a tanker loading rack.
        this.pad(lot, 0x8a8477, district, 0.22, SIDEWALK);
        for (const [dx, dz] of [[-26, -26], [-4, -26], [-26, -2], [-4, -2]]) {
          this.cylinders.push({ x: cx + dx, z: cz + dz, r: 9, h: 14, color: 0xdcd9d2 });
        }
        this.fuelSites.push({ district, x: cx - 15, z: cz - 14 });
        this.boxes.push({ x: cx + 14, z: cz - 14, w: 1.2, d: 50, h: 1.2, y: 3, color: 0x8f9396, district });
        this.building(district, cx + 28, cz - 12, 14, 22, 0.6, 0xd09a2a, false, 6);
        for (const dz of [-18, -6]) this.building(district, cx + 28, cz + dz, 2.6, 11, 3, 0xd8d8d2, false, 1);
        lz(0xd7d2c4);
        break;
      }
      case 'store': {
        this.boxes.push({ x: cx, z: cz + 22, w: lot.w - 2 * SIDEWALK, d: 44, h: 0.22, color: asphalt, district });
        this.building(district, cx, cz - 20, lot.w - 18, 42, 9, 0xcfc6b2, false);
        // Shopfront sign.
        this.building(district, cx, cz + 1.3, 30, 1, 3, 0xc23b2e, false, 5.5);
        parked(10, cz + 8, [0x7d2a24, 0x2b4a72, 0xb9b9b4, 0x3c3c3c, 0x6d6f4a]);
        lz(0xd7d2c4);
        break;
      }
      case 'pharmacy': {
        this.boxes.push({ x: cx, z: cz + 14, w: lot.w - 2 * SIDEWALK, d: 56, h: 0.22, color: asphalt, district });
        this.building(district, cx - 20, cz - 24, 32, 24, 6, 0xe9e4da, false);
        this.building(district, cx - 20, cz - 11.6, 12, 0.8, 2.4, 0x2e9e5b, false, 3.4);
        // Shops sharing the block.
        this.building(district, cx + 22, cz - 26, 30, 20, 8 + rand() * 6, 0xb0a58f);
        lz(0xd7d2c4);
        break;
      }
      case 'school': {
        this.pad(lot, GRASS, district, 0.22, SIDEWALK);
        this.building(district, cx - 24, cz - 8, 36, 64, 10, 0xa8604a);
        this.building(district, cx + 6, cz - 32, 48, 18, 10, 0xa8604a);
        // Playing field with its track.
        this.boxes.push({ x: site.x, z: site.z, w: 44, d: 54, h: 0.26, color: 0xa65a3c, district });
        this.boxes.push({ x: site.x, z: site.z, w: 38, d: 48, h: 0.3, color: 0x5d8a3e, district });
        break;
      }
      case 'hall': {
        this.pad(lot, GRASS, district, 0.22, SIDEWALK);
        this.building(district, cx - 16, cz - 12, 28, 46, 11, 0xd9d2c3);
        this.roofs.push({ x: cx - 16, z: cz - 12, w: 46, d: 28, h: 7, y: 11, yaw: Math.PI / 2, color: 0x5b4a3f });
        this.building(district, cx - 16, cz - 39, 9, 9, 30, 0xd9d2c3, false);
        this.cylinders.push({ x: cx - 16, z: cz - 39, r: 3.2, h: 10, y: 30, color: 0x5b4a3f });
        lz(0x9aa58e);
        break;
      }
      case 'arena': {
        this.boxes.push({ x: cx, z: cz + 30, w: lot.w - 2 * SIDEWALK, d: 30, h: 0.24, color: 0xb9b6ac, district });
        this.building(district, cx, cz - 14, lot.w - 16, 52, 22, 0x8c97a3);
        this.building(district, cx, cz - 14, lot.w - 24, 44, 4, 0xc9ced3, false, 22);
        lz(0xd7d2c4);
        break;
      }
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

  /**
   * Downtown, block by block. A lumpy height field (the main financial core, a second business
   * cluster, and block-to-block noise) picks what goes up: glass office towers with crowns and
   * spires, stone corporate headquarters, slender apartment towers, mid-rise apartment blocks over
   * shops, retail streets, department stores, parking garages and plazas.
   */
  private buildDowntownBlock(district: number, lot: Lot, inner: { x0: number; z0: number; x1: number; z1: number }, rand: () => number): void {
    const pick = <T>(list: T[]): T => list[Math.floor(rand() * list.length)];
    const iw = inner.x1 - inner.x0;
    const id = inner.z1 - inner.z0;
    const core = Math.exp(-((lot.ox * lot.ox + lot.oz * lot.oz) / (430 * 430)));
    const second = 0.75 * Math.exp(-(((lot.ox - 420) ** 2 + (lot.oz + 300) ** 2) / (240 * 240)));
    const noise = Math.sin(lot.ox * 0.013 + 1.7) * Math.cos(lot.oz * 0.011 - 0.6) * 0.18 + (rand() - 0.5) * 0.2;
    const intensity = Math.max(0, Math.min(1, Math.max(core, second) + noise));

    const GLASS = [0x3f5f78, 0x2f4a5c, 0x5b7488, 0x6d7f8c, 0x3c6a6e, 0x8a99a6, 0x2b3440, 0x6b5a45, 0x4a6b8a];
    const STONE = [0xb9b2a3, 0x8e8a83, 0xa58f74, 0x6f6a66, 0xc9c1b0, 0x7d7368];
    const HOMES = [0xd8cfc0, 0xc4b19a, 0xa88f7d, 0xe2e0d8, 0x9fa6a8, 0xb7a48c, 0x8f6f5c];
    const SHOPS = [0xb0a58f, 0x9e9a90, 0xc2b8a3, 0x8d8679, 0xa59a86, 0xd0c4ae];
    const AWNINGS = [0xa83a32, 0x2f5f9a, 0x3d6b45, 0xc98f2b, 0x2c2c2c, 0x7a4f8c];

    /** Plant, ventilation and a water tank on a roof. */
    const rooftop = (x: number, z: number, w: number, d: number, top: number, tank: boolean) => {
      this.building(district, x + (rand() - 0.5) * w * 0.3, z + (rand() - 0.5) * d * 0.3, w * 0.35, d * 0.3, 3 + rand() * 3, 0x8c8c88, false, top);
      if (tank) this.cylinders.push({ x: x + w * 0.25, z: z - d * 0.25, r: 2.2, h: 4, y: top + 2, color: 0x6b5644 });
    };

    /** A glass office tower on a podium, with one of several tops. */
    const officeTower = (x: number, z: number, w: number, d: number, h: number) => {
      const podium = 8 + rand() * 10;
      this.building(district, x, z, w * 0.98, d * 0.98, podium, pick(STONE), WINDOW.stone);
      const color = pick(GLASS);
      const tw = Math.min(w * (0.6 + rand() * 0.3), 60);
      const td = Math.min(d * (0.6 + rand() * 0.3), 60);
      const top = podium + h;
      switch (Math.floor(rand() * 4)) {
        case 0: {
          // Wedding cake: three setbacks.
          this.building(district, x, z, tw, td, h * 0.55, color, WINDOW.glass, podium);
          this.building(district, x, z, tw * 0.8, td * 0.8, h * 0.28, color, WINDOW.glass, podium + h * 0.55);
          this.building(district, x, z, tw * 0.58, td * 0.58, h * 0.17, color, WINDOW.glass, podium + h * 0.83);
          break;
        }
        case 1: {
          // Slim shaft with a spire.
          this.building(district, x, z, tw, td, h, color, WINDOW.glass, podium);
          this.building(district, x, z, tw * 0.5, td * 0.5, 8, 0xb8bcc0, false, top);
          this.cylinders.push({ x, z, r: 0.9, h: 25 + h * 0.2, y: top + 8, color: 0xc4c8cc });
          break;
        }
        case 2: {
          // Offset twin slabs, like a split tower.
          const off = tw * 0.22;
          this.building(district, x - off, z, tw * 0.56, td, h, color, WINDOW.glass, podium);
          this.building(district, x + off, z, tw * 0.56, td * 0.8, h * (0.7 + rand() * 0.2), pick(GLASS), WINDOW.glass, podium);
          break;
        }
        default: {
          // Box tower with a lit crown band and roof plant.
          this.building(district, x, z, tw, td, h, color, WINDOW.glass, podium);
          this.building(district, x, z, tw * 1.02, td * 1.02, 4, 0xd6d9dc, false, top - 6);
          rooftop(x, z, tw, td, top, false);
        }
      }
    };

    /** A stone headquarters or law firm: a solid slab with a setback top. */
    const stoneOffice = (x: number, z: number, w: number, d: number, h: number) => {
      const color = pick(STONE);
      this.building(district, x, z, w * 0.95, d * 0.95, h * 0.75, color, WINDOW.stone);
      this.building(district, x, z, w * 0.75, d * 0.75, h * 0.25, color, WINDOW.stone, h * 0.75);
      rooftop(x, z, w * 0.7, d * 0.7, h, false);
    };

    /** A slender apartment tower (sometimes a pair) over a podium of shops. */
    const apartmentTower = (x: number, z: number, w: number, d: number, h: number) => {
      const podium = 6 + rand() * 6;
      shopsAt(x, z, w, d, podium);
      const color = pick(HOMES);
      const size = Math.min(w, d);
      if (rand() < 0.35 && Math.max(w, d) > 60) {
        const along = w > d;
        const off = (along ? w : d) * 0.24;
        for (const sgn of [-1, 1]) {
          const tx = x + (along ? sgn * off : 0);
          const tz = z + (along ? 0 : sgn * off);
          const th = h * (0.8 + rand() * 0.3);
          this.building(district, tx, tz, size * 0.42, size * 0.42, th, color, WINDOW.residential, podium);
          rooftop(tx, tz, size * 0.42, size * 0.42, podium + th, true);
        }
      } else {
        const tw = Math.min(size * 0.55, 32);
        this.building(district, x, z, tw, tw * (0.8 + rand() * 0.4), h, color, WINDOW.residential, podium);
        rooftop(x, z, tw, tw, podium + h, true);
      }
    };

    /** A mid-rise apartment block around a courtyard, shops on the street. */
    const apartmentBlock = (x: number, z: number, w: number, d: number) => {
      const h = 18 + rand() * 30;
      const color = pick(HOMES);
      const depth = 14;
      shopsAt(x, z - d / 2 + depth / 2, w, depth, 5);
      this.building(district, x, z - d / 2 + depth / 2, w, depth, h, color, WINDOW.residential, 5);
      this.building(district, x, z + d / 2 - depth / 2, w, depth, h * (0.8 + rand() * 0.3), color, WINDOW.residential);
      this.building(district, x - w / 2 + depth / 2, z, depth, d - depth * 2, h * 0.9, color, WINDOW.residential);
    };

    /** A row of shops: storefronts with awnings and signs. */
    const shopsAt = (x: number, z: number, w: number, d: number, h: number) => {
      this.building(district, x, z, w, d, h, pick(SHOPS), WINDOW.punched);
      // Awnings along the long sides.
      const n = Math.max(1, Math.floor(w / 12));
      for (let k = 0; k < n; k++) {
        const ax = x - w / 2 + (k + 0.5) * (w / n);
        this.boxes.push({ x: ax, z: z + d / 2 + 0.8, w: (w / n) * 0.8, d: 1.6, h: 0.4, y: 3.2, color: pick(AWNINGS), district });
      }
    };

    const retail = (x: number, z: number, w: number, d: number) => {
      if (rand() < 0.3) {
        // A department store: a big box with a sign.
        const h = 14 + rand() * 12;
        this.building(district, x, z, w * 0.95, d * 0.95, h, pick(SHOPS), false);
        this.boxes.push({ x, z: z + d * 0.475 + 0.4, w: w * 0.4, d: 0.6, h: 3, y: h - 5, color: pick(AWNINGS), district });
        return;
      }
      const shops = 2 + Math.floor(rand() * 3);
      for (let k = 0; k < shops; k++) {
        const sw = w / shops;
        shopsAt(x - w / 2 + (k + 0.5) * sw, z, sw * 0.95, d * 0.9, 8 + rand() * 14);
      }
    };

    const garage = (x: number, z: number, w: number, d: number) => {
      const levels = 4 + Math.floor(rand() * 4);
      const h = levels * 3.2;
      this.building(district, x, z, w * 0.9, d * 0.9, h, 0x8f8f8a, false);
      // Dark open floors between the slabs.
      for (let k = 0; k < levels; k++) {
        this.boxes.push({ x, z, w: w * 0.91, d: d * 0.91, h: 1.4, y: k * 3.2 + 1.2, color: 0x2e2f31, district });
      }
    };

    const plaza = () => {
      this.pad(lot, 0xb9b6ac, district, 0.24, SIDEWALK);
      for (let k = 0; k < 10; k++) {
        this.trees.push({ x: lot.cx + (rand() - 0.5) * (iw - 12), z: lot.cz + (rand() - 0.5) * (id - 12), s: 0.9 + rand() * 0.5 });
      }
      this.building(district, lot.cx, lot.cz, 14, 14, 5, 0x7f8a92, WINDOW.glass);
    };

    /** Split the block into n x m parcels. */
    const parcels = (n: number, m: number, gap: number, fn: (x: number, z: number, w: number, d: number) => void) => {
      const w = (iw - gap * (n - 1)) / n;
      const d = (id - gap * (m - 1)) / m;
      for (let a = 0; a < n; a++) {
        for (let b = 0; b < m; b++) fn(inner.x0 + a * (w + gap) + w / 2, inner.z0 + b * (d + gap) + d / 2, w, d);
      }
    };

    const r = rand();
    if (intensity > 0.62) {
      // The financial core: office towers, the odd stone HQ and luxury apartments.
      const tall = () => 140 + intensity * 230 * (0.55 + rand() * 0.45);
      if (r < 0.45) officeTower(lot.cx, lot.cz, iw, id, tall());
      else if (r < 0.65) parcels(2, 1, 6, (x, z, w, d) => (rand() < 0.6 ? officeTower(x, z, w, d, tall() * 0.6) : stoneOffice(x, z, w, d, 60 + rand() * 80)));
      else if (r < 0.82) stoneOffice(lot.cx, lot.cz, iw, id, 80 + rand() * 90);
      else apartmentTower(lot.cx, lot.cz, iw, id, 120 + rand() * 120);
    } else if (intensity > 0.3) {
      // The mixed middle: offices and apartment towers, shops, garages and the odd plaza.
      if (r < 0.28) parcels(2, 1, 6, (x, z, w, d) => officeTower(x, z, w, d, 60 + intensity * 160 * rand()));
      else if (r < 0.55) apartmentTower(lot.cx, lot.cz, iw, id, 70 + rand() * 110);
      else if (r < 0.7) parcels(2, 2, 6, (x, z, w, d) => stoneOffice(x, z, w, d, 30 + rand() * 50));
      else if (r < 0.82) parcels(1, 2, 6, retail);
      else if (r < 0.92) garage(lot.cx, lot.cz, iw, id);
      else plaza();
    } else {
      // The edges: apartment blocks over shops, retail streets, garages, small offices.
      if (r < 0.4) apartmentBlock(lot.cx, lot.cz, iw, id);
      else if (r < 0.55) apartmentTower(lot.cx, lot.cz, iw, id, 45 + rand() * 60);
      else if (r < 0.8) parcels(1, 2, 6, retail);
      else if (r < 0.9) parcels(2, 2, 6, (x, z, w, d) => stoneOffice(x, z, w, d, 20 + rand() * 30));
      else garage(lot.cx, lot.cz, iw, id);
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
      case 'downtown':
        this.buildDowntownBlock(district, lot, inner, rand);
        break;
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
      lit[i] = b.windows === true ? WINDOW.punched : typeof b.windows === 'number' ? b.windows : 0;
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
          vWinLight = step(0.5, aLit) * uDistrictLight[int(aDistrict + 0.5)];`,
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
          // Styles: 1 punched windows, 2 glass curtain wall, 3 apartments with balconies, 4 stone offices.
          if (vWinLit > 0.5 && abs(vWinNormal.y) < 0.5 && vWinPos.y > 1.2) {
            float style = floor(vWinLit + 0.5);
            // Bay width, storey height, pane extents (x0, x1, y0, y1), how dark panes are by day,
            // how many are lit at night, and how warm the light is.
            vec2 bay = vec2(3.0, 3.5);
            vec4 pane4 = vec4(0.22, 0.78, 0.28, 0.78);
            float dark = 0.35;
            float rate = 0.55;
            float warmth = 0.8;
            if (style > 1.5 && style < 2.5) { bay = vec2(1.5, 4.0); pane4 = vec4(0.04, 0.96, 0.1, 0.94); dark = 0.5; rate = 0.42; warmth = 0.15; }
            else if (style > 2.5 && style < 3.5) { bay = vec2(2.6, 3.0); pane4 = vec4(0.25, 0.75, 0.3, 0.78); dark = 0.4; rate = 0.65; warmth = 0.95; }
            else if (style > 3.5) { bay = vec2(1.8, 3.8); pane4 = vec4(0.3, 0.7, 0.18, 0.85); dark = 0.45; rate = 0.45; warmth = 0.5; }
            float along = abs(vWinNormal.x) > 0.5 ? vWinPos.z : vWinPos.x;
            vec2 uv = vec2(along / bay.x, vWinPos.y / bay.y);
            vec2 cell = floor(uv);
            vec2 f = fract(uv);
            // Soft pane edges a pixel wide, fading to the average once a window is only a few
            // pixels across, so distant facades don't shimmer as the camera moves.
            vec2 px = max(fwidth(uv), vec2(1e-4));
            float far = smoothstep(0.15, 0.4, max(px.x, px.y));
            float pane = (smoothstep(pane4.x - px.x, pane4.x + px.x, f.x) - smoothstep(pane4.y - px.x, pane4.y + px.x, f.x)) *
              (smoothstep(pane4.z - px.y, pane4.z + px.y, f.y) - smoothstep(pane4.w - px.y, pane4.w + px.y, f.y));
            pane = mix(pane, (pane4.y - pane4.x) * (pane4.w - pane4.z), far);
            // Offices light whole stretches of a floor; homes window by window.
            vec2 lightCell = style > 1.5 && style < 2.5 ? vec2(floor(along / 12.0), cell.y) : cell;
            float h = winHash(lightCell + floor(vWinPos.xz / 97.0));
            float on = mix(step(1.0 - rate * vWinLight, h), rate * vWinLight, far);
            vec3 cool = mix(vec3(0.85, 0.92, 1.0), vec3(0.75, 0.85, 1.0), step(0.85, h));
            vec3 glow = mix(cool, vec3(1.0, 0.78, 0.45), warmth);
            // In the distance, the averaged glow is dimmed so a lit tower doesn't read as a lamp.
            totalEmissiveRadiance += glow * pane * on * uNight * 1.1 * mix(1.0, 0.45, far);
            diffuseColor.rgb *= 1.0 - pane * dark;
            if (style > 1.5 && style < 2.5) {
              // Glass reflects the sky by day.
              diffuseColor.rgb += vec3(0.05, 0.08, 0.12) * pane * (1.0 - uNight);
            } else if (style > 2.5 && style < 3.5) {
              // Balcony slab edges along every floor.
              float slab = 1.0 - smoothstep(0.08, 0.08 + px.y, f.y);
              diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * 1.3 + 0.05, slab * (1.0 - far));
            }
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

  /** Rasterise every solid footprint taller than a kerb into the walk grid. */
  private buildWalkGrid(): WalkGrid {
    const cell = 4;
    const margin = 200;
    const x0 = -CITY_WIDTH / 2 - margin;
    const z0 = -CITY_DEPTH / 2 - margin;
    const cols = Math.ceil((CITY_WIDTH + margin * 2) / cell);
    const rows = Math.ceil((CITY_DEPTH + margin * 2) / cell);
    const data = new Uint8Array(cols * rows).fill(1);
    for (const c of this.colliders) {
      if (c.floor || c.top < 1.5) continue;
      // Inset slightly so a footprint only blocks the cells it really covers.
      const ca = Math.max(0, Math.floor((c.minX + 0.5 - x0) / cell));
      const cb = Math.min(cols - 1, Math.floor((c.maxX - 0.5 - x0) / cell));
      const ra = Math.max(0, Math.floor((c.minZ + 0.5 - z0) / cell));
      const rb = Math.min(rows - 1, Math.floor((c.maxZ - 0.5 - z0) / cell));
      for (let r = ra; r <= rb; r++) data.fill(0, r * cols + ca, r * cols + cb + 1);
    }
    // The sea north of the city isn't walkable either.
    const shore = Math.floor((-CITY_DEPTH / 2 - 60 - z0) / cell);
    for (let r = 0; r < shore; r++) data.fill(0, r * cols, (r + 1) * cols);
    return { cell, x0, z0, cols, rows, data };
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
