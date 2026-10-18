// The zombie crowd: thousands of the dead on screen at once.
//
// Simulation is data-oriented: every zombie is an index into flat typed arrays, neighbours are
// found through spatial hashes rebuilt in linear time each frame, and walls come from the city's
// walk grid. Rendering is one draw call: each zombie uploads eight floats (position, heading,
// walk phase, pose, lean, clothing, stride) and the vertex shader builds the body, swings the
// legs and raises the arms. Nothing per zombie is computed as a matrix on the CPU.
//
// Two populations come from the city simulation: residents scattered through the districts near
// the helicopter, and hordes. A horde's members follow the path the horde has walked, so a big
// one streams down the streets as a column hundreds of metres long and spreads out to attack
// when it arrives.

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { districtAt, districtCenter, DISTRICT_SIZE } from '../sim/layout';
import { nodeX, nodeZ, roadWidth, SIDEWALK, STREET_SPACING } from '../sim/streets';
import type { CityState, Horde } from '../sim/types';
import { walkable, type WalkGrid } from './City';

export const CROWD_CAPACITY = 9000;
const RESIDENT_CAP = 1800;
/** Residents are kept within this radius of the helicopter; hordes are drawn from much further. */
export const RESIDENT_RADIUS = 380;
const RESIDENT_DESPAWN = 470;
const HORDE_VIEW = 1200;
const HORDE_MEMBER_CAP = 6000;
const SPAWNS_PER_RECONCILE = 700;

/** Space each zombie takes in a packed horde, m². */
const PACKING = 1.3;
const HORDE_WIDTH = 22;
/** The longest column drawn, metres of street. */
const MAX_COLUMN = 800;

const SIGHT = 18;
const BITE = 1.1;
const CORPSE_SECONDS = 25;
const SEPARATION = 0.75;
/** Update tiers by distance from the helicopter: every frame, every 2nd, every 4th. */
const LOD_NEAR = 120;
const LOD_MID = 350;

export const ATTRACT_RANGE = 220;
const GRAB_CLEARANCE = 4;
const SHAKE_OFF_CLEARANCE = 6;
const GRAB_RANGE = 3.5;
const DOOR_RANGE = 9;

/** Flow field toward the helicopter: 4 m cells over a 640 m window, rebuilt twice a second. */
const FLOW_CELL = 4;
const FLOW_SIZE = 160;
const FLOW_SECONDS = 0.5;

const enum Mode {
  Wander = 0,
  Chase = 1,
  Attract = 2,
  Follow = 3,
  Feed = 4,
  Dead = 5,
  Grab = 6,
  Idle = 7,
}

/** Shader pose codes (aLook.x). */
const POSE_WALK = 0;
const POSE_FEED = 4;
const POSE_DEAD = 5;
const POSE_GRAB = 6;

export interface HumanRef {
  x: number;
  z: number;
  civilian: boolean;
}

export interface CrowdFrame {
  dt: number;
  heliX: number;
  heliZ: number;
  /** Skids above the street. */
  clearance: number;
  /** Rotors loud and low: the dead come. */
  attract: boolean;
  nearestHuman: (x: number, z: number, range: number) => HumanRef | null;
  bite: (h: HumanRef) => void;
}

/** A horde as drawn: where it is, the path behind it, and its formation. */
interface Track {
  id: number;
  /** Members drawn. */
  size: number;
  settled: boolean;
  /** Column length along the streets, metres. */
  length: number;
  /** The column's path, from the head back along the streets it came by (flattened x, z). */
  path: number[];
  /** Cumulative distance along the path to each of its points. */
  arcs: number[];
  /** How far behind the simulation's head the drawn head is, metres: eased to 0 between ticks. */
  lag: number;
  /** Metres per game minute the horde walks. */
  speed: number;
  /** Where it has settled (a street corner). */
  nodeI: number;
  nodeJ: number;
  /** Head now, and the direction it's walking. */
  cx: number;
  cz: number;
  heading: number;
  fixT: number;
  lastTime: number;
  seen: boolean;
}

// Spatial hash over typed arrays: counting sort into buckets, rebuilt every frame in O(n).
class SpatialHash {
  readonly start: Int32Array;
  readonly items: Int32Array;
  constructor(readonly cell: number, readonly size: number, capacity: number) {
    this.start = new Int32Array(size + 1);
    this.items = new Int32Array(capacity);
  }
  key(cx: number, cz: number): number {
    return ((cx * 73856093) ^ (cz * 19349663)) & (this.size - 1);
  }
  build(xs: Float32Array, zs: Float32Array, live: Uint8Array, count: number): void {
    const start = this.start;
    start.fill(0);
    const keys = SpatialHash.scratch.length >= count ? SpatialHash.scratch : (SpatialHash.scratch = new Int32Array(count * 2));
    for (let i = 0; i < count; i++) {
      if (!live[i]) {
        keys[i] = -1;
        continue;
      }
      const k = this.key(Math.floor(xs[i] / this.cell), Math.floor(zs[i] / this.cell));
      keys[i] = k;
      start[k + 1]++;
    }
    for (let k = 0; k < this.size; k++) start[k + 1] += start[k];
    const fill = SpatialHash.fill.length >= this.size ? SpatialHash.fill : (SpatialHash.fill = new Int32Array(this.size));
    fill.set(start.subarray(0, this.size));
    for (let i = 0; i < count; i++) if (keys[i] >= 0) this.items[fill[keys[i]]++] = i;
  }
  static scratch = new Int32Array(0);
  static fill = new Int32Array(0);
}

export class Crowd {
  readonly mesh: THREE.Mesh;
  count = 0;
  /** Zombies heading for the helicopter, at its doors, and on its skids (this frame). */
  drawn = 0;
  threat = 0;
  grabbers = 0;

  private x = new Float32Array(CROWD_CAPACITY);
  private z = new Float32Array(CROWD_CAPACITY);
  private heading = new Float32Array(CROWD_CAPACITY);
  private phase = new Float32Array(CROWD_CAPACITY);
  private speed = new Float32Array(CROWD_CAPACITY);
  private timer = new Float32Array(CROWD_CAPACITY);
  private slotS = new Float32Array(CROWD_CAPACITY);
  private slotA = new Float32Array(CROWD_CAPACITY);
  private mode = new Uint8Array(CROWD_CAPACITY);
  private live = new Uint8Array(CROWD_CAPACITY);
  private tint = new Uint8Array(CROWD_CAPACITY);
  /** Horde id, or 0 for a resident. */
  private horde = new Int32Array(CROWD_CAPACITY);
  private remove = new Uint8Array(CROWD_CAPACITY);
  /** Time owed to an agent skipped by its update tier. */
  private lag = new Float32Array(CROWD_CAPACITY);
  /** The sealed base's ground, a wall to the dead until the city falls (see sim/quarantine.ts). */
  private sealed: { x0: number; x1: number; z0: number; z1: number } | null = null;
  private slotX = 0;
  private slotZ = 0;
  private simTime = 0;

  private near = new SpatialHash(2, 1 << 15, CROWD_CAPACITY);
  private far = new SpatialHash(16, 1 << 12, CROWD_CAPACITY);
  private tracks = new Map<number, Track>();
  private frame = 0;

  private flow = new Float32Array(FLOW_SIZE * FLOW_SIZE);
  private flowQueue = new Int32Array(FLOW_SIZE * FLOW_SIZE);
  private flowX0 = 0;
  private flowZ0 = 0;
  private flowTimer = 0;
  private flowReady = false;

  private pose = new Float32Array(CROWD_CAPACITY * 4);
  private look = new Float32Array(CROWD_CAPACITY * 4);
  private poseAttr: THREE.InstancedBufferAttribute;
  private lookAttr: THREE.InstancedBufferAttribute;
  private geometry: THREE.InstancedBufferGeometry;

  constructor(private walk: WalkGrid | null, private rand: () => number) {
    const { geometry, material } = buildFigure();
    this.geometry = geometry;
    this.poseAttr = new THREE.InstancedBufferAttribute(this.pose, 4).setUsage(THREE.DynamicDrawUsage);
    this.lookAttr = new THREE.InstancedBufferAttribute(this.look, 4).setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute('aPose', this.poseAttr);
    geometry.setAttribute('aLook', this.lookAttr);
    geometry.instanceCount = 0;
    this.mesh = new THREE.Mesh(geometry, material);
    this.mesh.frustumCulled = false;
  }

  /** The helicopter's sensor overlay: the dead glow red so they read at any range and in the dark. */
  setSensor(on: boolean): void {
    sensor.value = on ? 1 : 0;
    (this.mesh.material as THREE.MeshLambertMaterial).emissive.setRGB(on ? 0.55 : 0, on ? 0.04 : 0, on ? 0.03 : 0);
  }

  // --- Queries used by soldiers, civilians and door gunners --------------------------------

  posX(i: number): number {
    return this.x[i];
  }

  posZ(i: number): number {
    return this.z[i];
  }

  /** Nearest living zombie within range of (x, z), or -1. */
  nearest(x: number, z: number, range: number): number {
    const h = this.far;
    const r = Math.ceil(range / h.cell);
    const gx = Math.floor(x / h.cell);
    const gz = Math.floor(z / h.cell);
    let best = -1;
    let bestD = range * range;
    for (let a = -r; a <= r; a++) {
      for (let b = -r; b <= r; b++) {
        const k = h.key(gx + a, gz + b);
        for (let n = h.start[k]; n < h.start[k + 1]; n++) {
          const i = h.items[n];
          if (!this.live[i]) continue;
          const dx = this.x[i] - x;
          const dz = this.z[i] - z;
          const d = dx * dx + dz * dz;
          if (d < bestD) {
            bestD = d;
            best = i;
          }
        }
      }
    }
    return best;
  }

  isLive(i: number): boolean {
    return this.live[i] === 1;
  }

  kill(i: number): void {
    if (!this.live[i]) return;
    this.live[i] = 0;
    this.mode[i] = Mode.Dead;
    this.timer[i] = CORPSE_SECONDS;
  }

  living(): number {
    let n = 0;
    for (let i = 0; i < this.count; i++) n += this.live[i];
    return n;
  }

  /** A bitten civilian rises. */
  spawnResident(x: number, z: number): void {
    // Nobody rises inside the sealed base: the medics there make sure of it.
    if (!this.open(x, z) && this.sealed) return;
    this.add(x, z, 0, Mode.Wander);
  }

  // --- Reconciliation with the simulation ------------------------------------------------

  /**
   * Match the crowd to the simulation: residents per district in proportion to the area in view,
   * and the hordes within sight.
   * @param share fraction of each district's area inside the resident radius
   */
  reconcile(state: CityState, cx: number, cz: number, share: Map<number, number>): void {
    const base = state.districts.find((d) => d.kind === 'airbase');
    if (base && !state.flags.baseOpen) {
      const c = districtCenter(base.col, base.row);
      const h = DISTRICT_SIZE / 2;
      this.sealed = { x0: c.x - h, x1: c.x + h, z0: c.z - h, z1: c.z + h };
    } else {
      this.sealed = null;
    }

    // Residents.
    const residents = new Map<number, number[]>();
    for (let i = 0; i < this.count; i++) {
      if (!this.live[i] || this.horde[i] !== 0) continue;
      const d = districtAt(this.x[i], this.z[i]);
      const list = residents.get(d);
      if (list) list.push(i);
      else residents.set(d, [i]);
    }
    const wants: [number, number][] = [];
    let total = 0;
    for (const [d, frac] of share) {
      const want = visibleResidents(state.districts[d].zombies) * frac;
      wants.push([d, want]);
      total += want;
    }
    const scale = total > RESIDENT_CAP ? RESIDENT_CAP / total : 1;
    let budget = SPAWNS_PER_RECONCILE;
    let residentCount = 0;
    for (const [d, want] of wants) {
      const target = Math.round(want * scale);
      const have = residents.get(d) ?? [];
      residentCount += Math.min(target, have.length);
      if (have.length > target) {
        have.sort((a, b) => dist2(this.x[b], this.z[b], cx, cz) - dist2(this.x[a], this.z[a], cx, cz));
        for (let n = 0; n < have.length - target; n++) this.remove[have[n]] = 1;
      } else {
        for (let n = have.length; n < target && budget > 0; n++, budget--) this.spawnInDistrict(d, cx, cz);
      }
    }
    for (const [d, list] of residents) if (!share.has(d)) for (const i of list) this.remove[i] = 1;

    // Hordes.
    // Nearest first, so the spawn budget fills the horde in front of the player before distant ones.
    const visible = state.hordes
      .filter((h) => Math.hypot(h.x - cx, h.z - cz) < HORDE_VIEW + formationLength(h.size))
      .sort((a, b) => dist2(a.x, a.z, cx, cz) - dist2(b.x, b.z, cx, cz));
    const room = Math.max(0, CROWD_CAPACITY - residentCount - 50);
    const sum = visible.reduce((n, h) => n + h.size, 0);
    for (const t of this.tracks.values()) t.seen = false;
    for (const h of visible) {
      const t = this.track(h, state.t, this.simTime);
      t.seen = true;
      t.size = Math.min(h.size, HORDE_MEMBER_CAP, sum > room ? (room * h.size) / sum : h.size);
    }
    const members = new Map<number, number[]>();
    for (let i = 0; i < this.count; i++) {
      if (!this.live[i] || this.horde[i] === 0) continue;
      const list = members.get(this.horde[i]);
      if (list) list.push(i);
      else members.set(this.horde[i], [i]);
    }
    for (const [id, t] of this.tracks) {
      if (t.seen) continue;
      for (const i of members.get(id) ?? []) this.remove[i] = 1;
      this.tracks.delete(id);
    }
    for (const h of visible) {
      const t = this.tracks.get(h.id)!;
      const have = members.get(h.id) ?? [];
      // Only change the count for a real difference, so members don't flicker in and out.
      const target = Math.round(t.size);
      if (Math.abs(have.length - target) < Math.max(12, target * 0.06)) continue;
      if (have.length > target) {
        // Thin from the tail of the column.
        have.sort((a, b) => this.slotS[b] - this.slotS[a]);
        for (let n = 0; n < have.length - target; n++) this.remove[have[n]] = 1;
      } else {
        for (let n = have.length; n < target && budget > 0; n++, budget--) this.spawnMember(t);
      }
    }
  }

  private track(h: Horde, simT: number, time: number): Track {
    let t = this.tracks.get(h.id);
    const fresh = !t;
    if (!t) {
      t = {
        id: h.id, size: 0, settled: false, length: 0, path: [], arcs: [], lag: 0, speed: 0,
        nodeI: h.ni, nodeJ: h.nj, cx: h.x, cz: h.z, heading: h.heading, fixT: -1, lastTime: time, seen: true,
      };
      this.tracks.set(h.id, t);
    }
    if (simT !== t.fixT) {
      // Where the column's head is drawn now, before the new fix moves it.
      const shownX = t.cx;
      const shownZ = t.cz;
      t.fixT = simT;
      // The path: the head, then the corners it came through, newest first.
      const path = [h.x, h.z];
      const trail = h.trail ?? [];
      for (let k = trail.length - 2; k >= 0; k -= 2) {
        const x = nodeX(trail[k]);
        const z = nodeZ(trail[k + 1]);
        if (Math.hypot(x - path[path.length - 2], z - path[path.length - 1]) > 0.01) path.push(x, z);
      }
      if (path.length < 4) {
        // No history yet: lay it out straight back the way it faces.
        path.push(h.x + Math.sin(h.heading) * MAX_COLUMN, h.z + Math.cos(h.heading) * MAX_COLUMN);
      }
      t.path = path;
      t.arcs = [0];
      for (let k = 2; k < path.length; k += 2) t.arcs.push(t.arcs[t.arcs.length - 1] + Math.hypot(path[k] - path[k - 2], path[k + 1] - path[k - 1]));
      // Ease from where the head was drawn to the new fix along the streets, never jumping.
      t.lag = fresh ? 0 : Math.min(this.arcOf(t, shownX, shownZ), MAX_COLUMN);
      t.nodeI = h.ni;
      t.nodeJ = h.nj;
    }
    t.settled = h.settle > 0;
    t.speed = t.settled ? 0 : h.hunting ? 7 : 3.5;
    t.heading = h.heading;
    t.length = formationLength(Math.min(h.size, HORDE_MEMBER_CAP));
    return t;
  }

  /** Arc distance along a track's path to the point nearest (x, z). */
  private arcOf(t: Track, x: number, z: number): number {
    let best = 0;
    let bestD = Infinity;
    for (let k = 2; k < t.path.length; k += 2) {
      const ax = t.path[k - 2];
      const az = t.path[k - 1];
      const dx = t.path[k] - ax;
      const dz = t.path[k + 1] - az;
      const len2 = dx * dx + dz * dz || 1;
      const u = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / len2));
      const d = dist2(ax + dx * u, az + dz * u, x, z);
      if (d < bestD) {
        bestD = d;
        best = t.arcs[k / 2 - 1] + u * Math.sqrt(len2);
      }
    }
    return best;
  }

  /** The point `arc` metres back along a track's path (past its end, straight on), into slotX/slotZ, with its direction. */
  private pointAt(t: Track, arc: number): { dx: number; dz: number; half: number } {
    const p = t.path;
    const n = t.arcs.length;
    let k = 1;
    while (k < n - 1 && t.arcs[k] < arc) k++;
    const ax = p[(k - 1) * 2];
    const az = p[(k - 1) * 2 + 1];
    const bx = p[k * 2];
    const bz = p[k * 2 + 1];
    const len = t.arcs[k] - t.arcs[k - 1] || 1;
    const u = (arc - t.arcs[k - 1]) / len;
    this.slotX = ax + (bx - ax) * u;
    this.slotZ = az + (bz - az) * u;
    // Direction of travel (toward the head), and how wide the street is here.
    const dx = (ax - bx) / len;
    const dz = (az - bz) / len;
    return { dx, dz, half: streetHalf(ax, az, bx, bz) };
  }

  private spawnInDistrict(district: number, cx: number, cz: number): void {
    for (let attempt = 0; attempt < 8; attempt++) {
      const r = RESIDENT_RADIUS * Math.sqrt(this.rand());
      const a = this.rand() * Math.PI * 2;
      const x = cx + Math.cos(a) * r;
      const z = cz + Math.sin(a) * r;
      if (districtAt(x, z) !== district || !this.open(x, z)) continue;
      this.add(x, z, 0, this.rand() < 0.3 ? Mode.Idle : Mode.Wander);
      return;
    }
  }

  private spawnMember(t: Track): void {
    const i = this.add(t.cx, t.cz, t.id, Mode.Follow);
    if (i < 0) return;
    // Slots fill the formation evenly: s along the path, a across it.
    this.slotS[i] = this.rand();
    this.slotA[i] = this.rand() - 0.5;
    this.slotTarget(i, t);
    this.x[i] = this.slotX + (this.rand() - 0.5) * 2;
    this.z[i] = this.slotZ + (this.rand() - 0.5) * 2;
  }

  private add(x: number, z: number, horde: number, mode: Mode): number {
    if (this.count >= CROWD_CAPACITY) return -1;
    const i = this.count++;
    this.x[i] = x;
    this.z[i] = z;
    this.heading[i] = this.rand() * Math.PI * 2;
    this.phase[i] = this.rand() * 10;
    this.speed[i] = 0.7 + this.rand() * 0.6;
    this.timer[i] = this.rand() * 6;
    this.mode[i] = mode;
    this.live[i] = 1;
    this.tint[i] = Math.floor(this.rand() * 8);
    this.horde[i] = horde;
    this.remove[i] = 0;
    this.lag[i] = 0;
    return i;
  }

  // --- Behaviour -------------------------------------------------------------------------

  update(f: CrowdFrame, time: number): void {
    this.frame++;
    this.drawn = 0;
    this.threat = 0;
    this.grabbers = 0;
    this.near.build(this.x, this.z, this.live, this.count);
    this.far.build(this.x, this.z, this.live, this.count);
    this.simTime = time;
    this.advanceTracks(time, f.dt);

    if (f.attract) {
      this.flowTimer -= f.dt;
      if (this.flowTimer <= 0 || !this.flowReady) {
        this.flowTimer = FLOW_SECONDS;
        this.buildFlow(f.heliX, f.heliZ);
      }
    } else {
      this.flowReady = false;
    }

    const lowForGrab = f.clearance < GRAB_CLEARANCE;
    const atDoors = f.clearance < SHAKE_OFF_CLEARANCE;
    for (let i = 0; i < this.count; i++) {
      const mode = this.mode[i];
      const toHeli = Math.hypot(f.heliX - this.x[i], f.heliZ - this.z[i]);
      // Distant agents update less often, catching up on the time they skipped.
      this.lag[i] += f.dt;
      // Horde followers are cheap and always on the move: every frame, so a column glides.
      const every = mode === Mode.Follow ? 1 : toHeli < LOD_NEAR ? 1 : toHeli < LOD_MID ? 2 : 4;
      if ((i + this.frame) % every !== 0) continue;
      const dt = this.lag[i];
      this.lag[i] = 0;
      if (mode === Mode.Dead) {
        this.timer[i] -= dt;
        if (this.timer[i] <= 0) this.remove[i] = 1;
        continue;
      }

      if (mode === Mode.Grab) {
        if (f.clearance > SHAKE_OFF_CLEARANCE) {
          // Shaken off: back into the crowd, with a fresh place in the formation.
          this.mode[i] = this.horde[i] ? Mode.Follow : Mode.Wander;
          this.slotS[i] = this.rand();
          this.slotA[i] = this.rand() - 0.5;
        } else {
          this.x[i] = f.heliX + this.slotS[i];
          this.z[i] = f.heliZ + this.slotA[i];
          this.heading[i] = Math.atan2(this.slotS[i], this.slotA[i]);
          this.grabbers++;
          continue;
        }
      }
      if (atDoors && toHeli < DOOR_RANGE) this.threat++;
      if (lowForGrab && toHeli < GRAB_RANGE) {
        const a = this.rand() * Math.PI * 2;
        this.mode[i] = Mode.Grab;
        this.slotS[i] = Math.cos(a) * 1.9;
        this.slotA[i] = Math.sin(a) * 2.6;
        continue;
      }
      if (mode === Mode.Feed) {
        this.timer[i] -= dt;
        if (this.timer[i] <= 0) this.mode[i] = this.horde[i] ? Mode.Follow : Mode.Wander;
        continue;
      }

      // Look for prey every fourth frame (staggered), or every frame once chasing.
      if (mode === Mode.Chase || (i + this.frame) % 4 === 0) {
        const prey = f.nearestHuman(this.x[i], this.z[i], SIGHT);
        if (prey) {
          const d = Math.hypot(prey.x - this.x[i], prey.z - this.z[i]);
          if (d < BITE && prey.civilian) {
            f.bite(prey);
            this.mode[i] = Mode.Feed;
            this.timer[i] = 2.5;
            continue;
          }
          this.mode[i] = Mode.Chase;
          this.steer(i, prey.x, prey.z, 2.4, dt);
          continue;
        }
        if (mode === Mode.Chase) this.mode[i] = this.horde[i] ? Mode.Follow : Mode.Wander;
      }

      if (f.attract && toHeli < ATTRACT_RANGE * (this.horde[i] ? 1.5 : 1)) {
        this.mode[i] = Mode.Attract;
        if (toHeli > 3) this.followFlow(i, f.heliX, f.heliZ, 1.8, dt);
        continue;
      }
      if (this.mode[i] === Mode.Attract) this.mode[i] = this.horde[i] ? Mode.Follow : Mode.Wander;

      if (this.horde[i]) {
        const t = this.tracks.get(this.horde[i]);
        if (!t) continue;
        this.follow(i, t, dt);
      } else {
        this.wander(i, dt);
      }
    }

    // Indices moved in compaction: rebuild the search hash so queries until next frame are valid.
    if (this.compact(f.heliX, f.heliZ)) this.far.build(this.x, this.z, this.live, this.count);
    this.render();
  }

  /** Ease each column's head forward along its streets between simulation ticks. */
  private advanceTracks(time: number, dt: number): void {
    for (const t of this.tracks.values()) {
      const minutes = Math.max(0, time - t.lastTime);
      t.lastTime = time;
      // At the horde's own pace, and quicker when far behind (after a time-scale change or a jump).
      t.lag = Math.max(0, t.lag - Math.max(t.speed * minutes, t.lag * Math.min(1, dt * 1.5)));
      this.pointAt(t, t.lag);
      t.cx = this.slotX;
      t.cz = this.slotZ;
    }
  }

  /**
   * Where a horde member belongs (into slotX/slotZ): a place in the column strung out along the
   * streets behind the head, or, once settled, flooding the streets around the corner it holds.
   * Either way it's in the street, never in a building.
   */
  private slotTarget(i: number, t: Track): void {
    if (t.settled) {
      // Four arms out along the streets from the corner, thickest near it.
      const s = this.slotS[i] * 4;
      const arm = Math.floor(s) % 4;
      const reach = Math.max(15, Math.min(MAX_COLUMN * 0.6, (t.size * PACKING) / (4 * HORDE_WIDTH)));
      const r = reach * Math.pow(s - Math.floor(s), 1.4);
      const dx = arm === 0 ? 1 : arm === 1 ? -1 : 0;
      const dz = arm === 2 ? 1 : arm === 3 ? -1 : 0;
      const half = dx !== 0 ? roadWidth(t.nodeJ) / 2 + SIDEWALK - 1 : roadWidth(t.nodeI) / 2 + SIDEWALK - 1;
      const across = this.slotA[i] * 2 * half;
      this.slotX = nodeX(t.nodeI) + dx * r - dz * across;
      this.slotZ = nodeZ(t.nodeJ) + dz * r + dx * across;
      return;
    }
    const { dx, dz, half } = this.pointAt(t, t.lag + this.slotS[i] * t.length);
    const across = this.slotA[i] * 2 * half;
    this.slotX += -dz * across;
    this.slotZ += dx * across;
  }

  /**
   * Keep to a place in the horde. Slots are always out in the street, so members walk straight to
   * them; one pulled off the street (by the rotors, say) finds its way back around buildings, and
   * only cuts through a wall if it's truly stuck.
   */
  private follow(i: number, t: Track, dt: number): void {
    this.slotTarget(i, t);
    // A little sway of its own, so the column isn't drilled.
    const sway = Math.sin(this.phase[i] * 0.37 + i) * 0.5;
    const tx = this.slotX + sway;
    const tz = this.slotZ - sway;
    const dx = tx - this.x[i];
    const dz = tz - this.z[i];
    const d = Math.hypot(dx, dz);
    if (d < 0.2) {
      if (t.speed > 0) this.heading[i] = t.heading;
      return;
    }
    // Shamble at the horde's pace; hurry to catch up when left behind.
    const speed = Math.min(d * 2, d > 20 ? Math.max(6, d * 0.5) : 1.2 + this.speed[i] * 0.8 + (t.speed / 1.43) * 0.5);
    const step = Math.min(d, speed * dt);
    const mx = (dx / d) * step;
    const mz = (dz / d) * step;
    this.heading[i] = Math.atan2(-dx, -dz);
    const x0 = this.x[i];
    const z0 = this.z[i];
    if (d > 6 && this.timer[i] < 1) {
      // Off the street: go round buildings, and note when that gets nowhere.
      this.move(i, mx, mz, false, false);
      const moved = Math.hypot(this.x[i] - x0, this.z[i] - z0);
      this.timer[i] = moved < step * 0.3 ? this.timer[i] + dt : 0;
    } else {
      this.x[i] = x0 + mx;
      this.z[i] = z0 + mz;
      this.phase[i] += step * 2.4;
      if (d < 3) this.timer[i] = 0;
    }
  }

  private wander(i: number, dt: number): void {
    this.timer[i] -= dt;
    if (this.timer[i] <= 0) {
      // Alternate between shuffling somewhere and standing about.
      this.mode[i] = this.rand() < 0.35 ? Mode.Idle : Mode.Wander;
      this.heading[i] += (this.rand() - 0.5) * 2.4;
      this.timer[i] = 3 + this.rand() * 8;
    }
    if (this.mode[i] === Mode.Idle) {
      this.separate(i, dt);
      return;
    }
    const h = this.heading[i];
    const s = this.speed[i] * 0.6;
    this.move(i, -Math.sin(h) * s * dt, -Math.cos(h) * s * dt, true);
  }

  /** Walk toward a point at up to `speed`, keeping clear of neighbours and walls. */
  private steer(i: number, tx: number, tz: number, speed: number, dt: number): void {
    const dx = tx - this.x[i];
    const dz = tz - this.z[i];
    const d = Math.hypot(dx, dz);
    if (d < 0.3) {
      this.separate(i, dt);
      return;
    }
    const step = Math.min(d, speed * dt);
    this.heading[i] = Math.atan2(-dx, -dz);
    this.move(i, (dx / d) * step, (dz / d) * step, false);
  }

  /** Follow the flow field toward the helicopter; straight at it when close or off the field. */
  private followFlow(i: number, hx: number, hz: number, speed: number, dt: number): void {
    const x = this.x[i];
    const z = this.z[i];
    const c = Math.floor((x - this.flowX0) / FLOW_CELL);
    const r = Math.floor((z - this.flowZ0) / FLOW_CELL);
    if (!this.flowReady || Math.hypot(hx - x, hz - z) < 12 || c < 1 || r < 1 || c >= FLOW_SIZE - 1 || r >= FLOW_SIZE - 1) {
      this.steer(i, hx, hz, speed, dt);
      return;
    }
    let best = this.flow[r * FLOW_SIZE + c];
    let bc = c;
    let br = r;
    for (let a = -1; a <= 1; a++) {
      for (let b = -1; b <= 1; b++) {
        const v = this.flow[(r + b) * FLOW_SIZE + (c + a)];
        if (v < best) {
          best = v;
          bc = c + a;
          br = r + b;
        }
      }
    }
    if (!isFinite(best)) {
      this.steer(i, hx, hz, speed, dt);
      return;
    }
    this.steer(i, this.flowX0 + (bc + 0.5) * FLOW_CELL, this.flowZ0 + (br + 0.5) * FLOW_CELL, speed, dt);
  }

  /** Breadth-first distances from the helicopter over walkable cells. */
  private buildFlow(hx: number, hz: number): void {
    const half = (FLOW_SIZE * FLOW_CELL) / 2;
    this.flowX0 = Math.floor((hx - half) / FLOW_CELL) * FLOW_CELL;
    this.flowZ0 = Math.floor((hz - half) / FLOW_CELL) * FLOW_CELL;
    const flow = this.flow;
    flow.fill(Infinity);
    const q = this.flowQueue;
    let head = 0;
    let tail = 0;
    const open = (c: number, r: number) =>
      this.open(this.flowX0 + (c + 0.5) * FLOW_CELL, this.flowZ0 + (r + 0.5) * FLOW_CELL);
    // Goal: open ground under the helicopter, or around the building it sits on.
    const hc = Math.floor((hx - this.flowX0) / FLOW_CELL);
    const hr = Math.floor((hz - this.flowZ0) / FLOW_CELL);
    for (let radius = 1; radius <= 10 && tail === 0; radius += 3) {
      for (let a = -radius; a <= radius; a++) {
        for (let b = -radius; b <= radius; b++) {
          const c = hc + a;
          const r = hr + b;
          if (c < 0 || r < 0 || c >= FLOW_SIZE || r >= FLOW_SIZE || !open(c, r)) continue;
          const k = r * FLOW_SIZE + c;
          if (flow[k] === 0) continue;
          flow[k] = 0;
          q[tail++] = k;
        }
      }
    }
    while (head < tail) {
      const k = q[head++];
      const c = k % FLOW_SIZE;
      const r = (k - c) / FLOW_SIZE;
      const next = flow[k] + 1;
      if (c > 0 && flow[k - 1] > next && open(c - 1, r)) { flow[k - 1] = next; q[tail++] = k - 1; }
      if (c < FLOW_SIZE - 1 && flow[k + 1] > next && open(c + 1, r)) { flow[k + 1] = next; q[tail++] = k + 1; }
      if (r > 0 && flow[k - FLOW_SIZE] > next && open(c, r - 1)) { flow[k - FLOW_SIZE] = next; q[tail++] = k - FLOW_SIZE; }
      if (r < FLOW_SIZE - 1 && flow[k + FLOW_SIZE] > next && open(c, r + 1)) { flow[k + FLOW_SIZE] = next; q[tail++] = k + FLOW_SIZE; }
    }
    this.flowReady = true;
  }

  /** Push apart from the nearest few neighbours. */
  private separate(i: number, dt: number): void {
    // Crowding resolves fine at half rate: alternate agents each frame.
    if (((i + this.frame) & 1) !== 0) return;
    dt *= 2;
    let px = 0;
    let pz = 0;
    const h = this.near;
    const gx = Math.floor(this.x[i] / h.cell);
    const gz = Math.floor(this.z[i] / h.cell);
    let checked = 0;
    for (let a = -1; a <= 1 && checked < 12; a++) {
      for (let b = -1; b <= 1 && checked < 12; b++) {
        const k = h.key(gx + a, gz + b);
        for (let n = h.start[k]; n < h.start[k + 1] && checked < 12; n++) {
          const j = h.items[n];
          if (j === i) continue;
          checked++;
          const dx = this.x[i] - this.x[j];
          const dz = this.z[i] - this.z[j];
          const d2 = dx * dx + dz * dz;
          if (d2 > SEPARATION * SEPARATION || d2 < 1e-6) continue;
          const d = Math.sqrt(d2);
          const push = (SEPARATION - d) / d;
          px += dx * push;
          pz += dz * push;
        }
      }
    }
    if (px || pz) this.move(i, px * Math.min(1, dt * 6), pz * Math.min(1, dt * 6), false, false);
  }

  /** Open ground the dead can walk on: not inside buildings, nor behind a sealed perimeter. */
  private open(x: number, z: number): boolean {
    const b = this.sealed;
    if (b && x > b.x0 && x < b.x1 && z > b.z0 && z < b.z1) return false;
    return walkable(this.walk, x, z);
  }

  /** Move with separation and wall sliding. */
  private move(i: number, dx: number, dz: number, wander: boolean, separate = true): void {
    const x = this.x[i];
    const z = this.z[i];
    let nx = x + dx;
    let nz = z + dz;
    if (!this.open(nx, nz)) {
      if (this.open(nx, z)) nz = z;
      else if (this.open(x, nz)) nx = x;
      else {
        nx = x;
        nz = z;
        // Blocked head-on: a wanderer turns away.
        if (wander) this.heading[i] += Math.PI * (0.5 + this.rand());
      }
    }
    this.x[i] = nx;
    this.z[i] = nz;
    this.phase[i] += Math.hypot(nx - x, nz - z) * 2.4;
    if (separate) this.separate(i, 1 / 30);
  }

  /** Drop corpses that have lain long enough and residents that are out of range; keep arrays dense. */
  private compact(cx: number, cz: number): boolean {
    let w = 0;
    for (let i = 0; i < this.count; i++) {
      if (!this.remove[i] && !this.horde[i] && this.live[i] && dist2(this.x[i], this.z[i], cx, cz) > RESIDENT_DESPAWN * RESIDENT_DESPAWN) {
        this.remove[i] = 1;
      }
      if (this.remove[i]) continue;
      if (w !== i) {
        this.x[w] = this.x[i];
        this.z[w] = this.z[i];
        this.heading[w] = this.heading[i];
        this.phase[w] = this.phase[i];
        this.speed[w] = this.speed[i];
        this.timer[w] = this.timer[i];
        this.slotS[w] = this.slotS[i];
        this.slotA[w] = this.slotA[i];
        this.mode[w] = this.mode[i];
        this.live[w] = this.live[i];
        this.tint[w] = this.tint[i];
        this.horde[w] = this.horde[i];
        this.lag[w] = this.lag[i];
      }
      this.remove[w] = 0;
      w++;
    }
    const changed = w !== this.count;
    this.count = w;
    return changed;
  }

  // --- Rendering -------------------------------------------------------------------------

  private render(): void {
    const n = this.count;
    for (let i = 0; i < n; i++) {
      const mode = this.mode[i];
      const o = i * 4;
      this.pose[o] = this.x[i];
      this.pose[o + 1] = this.z[i];
      this.pose[o + 2] = this.heading[i];
      this.pose[o + 3] = this.phase[i];
      if (mode === Mode.Attract) this.drawn++;
      const moving = mode === Mode.Wander || mode === Mode.Chase || mode === Mode.Attract || mode === Mode.Follow;
      this.look[o] = mode === Mode.Dead ? POSE_DEAD : mode === Mode.Grab ? POSE_GRAB : mode === Mode.Feed ? POSE_FEED : POSE_WALK;
      this.look[o + 1] = mode === Mode.Feed ? 0.9 : mode === Mode.Grab ? -0.35 : mode === Mode.Chase ? 0.32 : 0.18;
      this.look[o + 2] = this.tint[i];
      this.look[o + 3] = moving ? (mode === Mode.Chase ? 1.3 : 1) : 0.1;
    }
    this.geometry.instanceCount = n;
    for (const attr of [this.poseAttr, this.lookAttr]) {
      attr.clearUpdateRanges();
      attr.addUpdateRange(0, n * 4);
      attr.needsUpdate = true;
    }
  }
}

/** Residents shown for a district's zombie count: one-for-one while few, compressed when many. */
function visibleResidents(z: number): number {
  return z <= 400 ? z : 400 + (z - 400) * 0.15;
}

function formationLength(size: number): number {
  return Math.max(20, Math.min(MAX_COLUMN, (Math.min(size, HORDE_MEMBER_CAP) * PACKING) / HORDE_WIDTH));
}

/** Half the usable width of the street between two points (curb to curb plus sidewalks). */
function streetHalf(ax: number, az: number, bx: number, bz: number): number {
  const horizontal = Math.abs(bx - ax) >= Math.abs(bz - az);
  const index = horizontal
    ? Math.round((az - nodeZ(0)) / STREET_SPACING)
    : Math.round((ax - nodeX(0)) / STREET_SPACING);
  return roadWidth(index) / 2 + SIDEWALK - 1;
}

const dist2 = (x: number, z: number, cx: number, cz: number) => (x - cx) * (x - cx) + (z - cz) * (z - cz);

/**
 * A low-poly figure (about 70 triangles) with a body part on every vertex, and a material whose
 * vertex shader poses it from two per-instance vectors:
 *   aPose = (x, z, heading, walk phase)
 *   aLook = (pose code, lean, clothing tint, stride)
 */
/** Shared by the crowd's material: 1 while the helicopter's sensor overlay is on. */
const sensor = { value: 0 };

function buildFigure(): { geometry: THREE.InstancedBufferGeometry; material: THREE.MeshLambertMaterial } {
  // Grey, dead skin: nothing like the living's.
  const SKIN = new THREE.Color(0x9aa08a);
  const BLOOD = new THREE.Color(0x5e0d0b);
  const WHITE = new THREE.Color(1, 1, 1);
  const part = (w: number, h: number, d: number, x: number, y: number, z: number, id: number, skin: boolean) => {
    const g = new THREE.BoxGeometry(w, h, d);
    g.translate(x, y, z);
    const n = g.getAttribute('position').count;
    g.setAttribute('aPart', new THREE.Float32BufferAttribute(new Float32Array(n).fill(id), 1));
    const c = skin ? SKIN : WHITE;
    g.setAttribute('color', new THREE.Float32BufferAttribute(Array.from({ length: n }, () => [c.r, c.g, c.b]).flat(), 3));
    return g;
  };
  /** A blood stain riding on a part: 0.3 on the torso, 5.3 on the head. */
  const stain = (w: number, h: number, d: number, x: number, y: number, z: number, id: number) => {
    const g = new THREE.BoxGeometry(w, h, d);
    g.translate(x, y, z);
    const n = g.getAttribute('position').count;
    g.setAttribute('aPart', new THREE.Float32BufferAttribute(new Float32Array(n).fill(id), 1));
    g.setAttribute('color', new THREE.Float32BufferAttribute(Array.from({ length: n }, () => [BLOOD.r, BLOOD.g, BLOOD.b]).flat(), 3));
    return g;
  };
  // Parts: 0 torso, 1-2 legs (hip pivot 0.88 m), 3-4 arms (shoulder pivot 1.42 m), 5 head.
  const merged = mergeGeometries([
    part(0.42, 0.6, 0.24, 0, 1.15, 0, 0, false),
    part(0.16, 0.86, 0.18, -0.11, 0.45, 0, 1, false),
    part(0.16, 0.86, 0.18, 0.11, 0.45, 0, 2, false),
    part(0.1, 0.6, 0.1, -0.28, 1.12, 0, 3, false),
    part(0.1, 0.6, 0.1, 0.28, 1.12, 0, 4, false),
    part(0.22, 0.25, 0.22, 0, 1.6, 0, 5, true),
    // Blood down the shirt front and round the mouth (never tinted: see the colour step below).
    stain(0.3, 0.32, 0.02, 0, 1.2, -0.13, 0.3),
    stain(0.14, 0.07, 0.02, 0, 1.53, -0.115, 5.3),
  ]);
  const geometry = new THREE.InstancedBufferGeometry();
  geometry.index = merged.index;
  for (const name of ['position', 'normal', 'color', 'aPart']) geometry.setAttribute(name, merged.getAttribute(name));

  // Grimy civilian clothes, bloodied: no olive, so soldiers stand apart.
  const tints = [0x5a4640, 0x3b4658, 0x6e2f2a, 0x7a746a, 0x4a3a36, 0x2e3542, 0x86786a, 0x5c2a2a].map((c) => new THREE.Color(c));
  const material = new THREE.MeshLambertMaterial({ vertexColors: true });
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uTints = { value: tints };
    shader.uniforms.uSensor = sensor;
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
        attribute float aPart;
        attribute vec4 aPose;
        attribute vec4 aLook;
        uniform vec3 uTints[8];
        uniform float uSensor;
        mat3 rotX(float a) { float c = cos(a), s = sin(a); return mat3(1.0, 0.0, 0.0, 0.0, c, s, 0.0, -s, c); }
        mat3 rotY(float a) { float c = cos(a), s = sin(a); return mat3(c, 0.0, -s, 0.0, 1.0, 0.0, s, 0.0, c); }`,
      )
      .replace(
        '#include <beginnormal_vertex>',
        `#include <beginnormal_vertex>
        float poseCode = aLook.x;
        bool dead = poseCode > 4.5 && poseCode < 5.5;
        float swing = sin(aPose.w) * 0.55 * aLook.w;
        vec3 pivot = vec3(0.0);
        mat3 limb = mat3(1.0);
        if (aPart > 0.5 && aPart < 2.5) {
          pivot = vec3(0.0, 0.88, 0.0);
          limb = rotX(dead ? 0.0 : (aPart < 1.5 ? swing : -swing));
        } else if (aPart > 2.5 && aPart < 4.5) {
          // Arms reach forward; up when clawing at the skids; slack when dead.
          pivot = vec3(0.0, 1.42, 0.0);
          float reach = poseCode > 5.5 ? 2.7 : (dead ? 0.3 : 1.35);
          limb = rotX(reach + sin(aPose.w * 0.5 + aPart) * 0.15);
        }
        mat3 body = rotY(aPose.z) * rotX(dead ? -1.5708 : -aLook.y);
        objectNormal = body * limb * objectNormal;`,
      )
      .replace(
        '#include <begin_vertex>',
        `vec3 transformed = body * (limb * (position - pivot) + pivot);
        float bob = dead ? 0.15 : abs(sin(aPose.w)) * 0.05 * aLook.w;
        transformed += vec3(aPose.x, bob, aPose.y);`,
      )
      .replace(
        '#include <color_vertex>',
        `#include <color_vertex>
        bool blood = abs(aPart - 0.3) < 0.05 || aPart > 5.2;
        if (aPart < 4.5 && !blood) vColor.rgb *= uTints[int(aLook.z + 0.5)];
        // Sensor overlay: the dead show red.
        vColor.rgb = mix(vColor.rgb, vec3(1.0, 0.12, 0.08), uSensor * 0.85);`,
      );
  };
  return { geometry, material };
}
