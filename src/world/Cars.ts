// Cars on the streets around the helicopter, drawn from the simulation's traffic. Moving cars are
// tracked one by one: each drives down its lane at the speed the street's congestion allows, keeps
// its distance from the car ahead, waits at the lights where an avenue crosses, and drives on through
// the intersection or turns into the cross street, so a car can be followed across the city. Cars
// join and leave the streets out at the edge of view, as many as each street's flow calls for, and
// queue bumper to bumper in gridlock. Abandoned cars sit where their drivers left them, slewed
// across the lanes and up on the sidewalks, some burnt out, more as a street chokes.

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { NODES_X, NODES_Z, nodeX, nodeZ, roadWidth, STREET_SPACING } from '../sim/streets';
import { DISTRICT_TEMPLATES, districtAt } from '../sim/layout';
import { cityLight, Glow, vehicleLamps } from './CityLight';
import { checkpointNodes, closedEdge, congestion, districtOfEdge, edgeIndex, isAvenue, speedFactor } from '../sim/traffic';
import type { CityState, Traffic } from '../sim/types';

const MOVING = 2600;
const POLICE = 200;
const BARRIERS = 400;
const ABANDONED = 2400;
/** Streets within this distance of the helicopter get cars. */
const RADIUS = 480;
/** Car length plus a gap, bumper to bumper. */
const SPACING = 7;
/** Free-flow speed in real metres per second. */
const CRUISE = 12;
/** Nose to nose in a queue. */
const QUEUE_GAP = 7;
/** Cars join and leave the streets beyond this share of the radius, out of the player's eye. */
const SPAWN_RING = 0.65;
/** A light's cycle in seconds: each street gets most of half of it, then all red for a moment. */
const LIGHT_CYCLE = 36;
const ALL_RED = 3;
/** How quickly a turn's swing into the new lane plays out (per second). */
const TURN_EASE = 2.2;
const PAINT = [0xb03a2e, 0x2b4a72, 0xd8d8d2, 0x2c2c2c, 0x6d6f4a, 0x8a8f96, 0xc98f2b, 0x1d3b2f, 0x7d2a24, 0xe9e7e0];
const DUSTY = [0x6f6a64, 0x5a5f66, 0x7a6a58, 0x4d4f52, 0x8a8178];
const BURNT = 0x1b1a19;

/** A small deterministic hash in [0, 1). */
function hash(a: number, b: number): number {
  const x = Math.sin(a * 127.1 + b * 311.7) * 43758.5453;
  return x - Math.floor(x);
}

/** What a patrol car's crew can do on foot (the people on the street are Agents'). */
export interface Crews {
  zombieNear(x: number, z: number, range: number): boolean;
  dismount(car: number, x: number, z: number, heading: number, district: number): void;
  crewOut(car: number): number;
  recall(car: number, now?: boolean): void;
}

/** Patrol cars pull over for the dead within this range, if the player is close enough to see it. */
const PULL_OVER_RANGE = 40;
const PULL_OVER_VIEW = 360;
/** Quiet seconds before the crew gets back in; seconds before the car will stop again. */
const ALL_CLEAR = 8;
const BACK_ON_PATROL = 25;

const enum Stop {
  Driving,
  PullingOver,
  CrewOut,
  PullingOut,
}

/**
 * A car driving the grid: along an x street (axis 0, at z line `line`) or a z street (axis 1, at x
 * line `line`), at `s` along it, one way or the other, in one of its lanes. `ox`, `oz` and `oh` are
 * what's left of the swing from its old lane into the new one after a turn, easing out.
 */
interface Car {
  axis: 0 | 1;
  line: number;
  dir: 1 | -1;
  lane: number;
  s: number;
  v: number;
  color: number;
  police: boolean;
  /** Light-bar rhythm, for the police. */
  phase: number;
  /** For a patrol car: an id for its crew, whether it's stopped for them, and how far to the curb. */
  id: number;
  stop: Stop;
  curb: number;
  check: number;
  quiet: number;
  cool: number;
  ox: number;
  oz: number;
  oh: number;
}

/** The lanes' offsets from the centre line, one way. */
const lanesOf = (line: number) => (roadWidth(line) > 20 ? [3.2, 6.6] : [3]);
const nodesAlong = (axis: 0 | 1) => (axis === 0 ? NODES_X : NODES_Z);
const nodeAlong = (axis: 0 | 1, k: number) => (axis === 0 ? nodeX(k) : nodeZ(k));
const startAlong = (axis: 0 | 1) => nodeAlong(axis, 0);

/** The edge a street runs along between its nodes k and k + 1. */
function edgeAt(axis: 0 | 1, line: number, k: number): number {
  return axis === 0 ? edgeIndex(k, line, k + 1, line) : edgeIndex(line, k, line, k + 1);
}

/** The edge a car is on. */
function edgeOf(c: Car): number {
  const k = Math.max(0, Math.min(nodesAlong(c.axis) - 2, Math.floor((c.s - startAlong(c.axis)) / STREET_SPACING)));
  return edgeAt(c.axis, c.line, k);
}

const wrap = (a: number) => a - Math.round(a / (Math.PI * 2)) * Math.PI * 2;

export class Cars {
  readonly group = new THREE.Group();
  private moving: THREE.InstancedMesh;
  private abandoned: THREE.InstancedMesh;
  /** Police cruisers on patrol and parked at checkpoints. */
  private police: THREE.InstancedMesh;
  /** Each cruiser's light-bar rhythm. */
  private phase: THREE.InstancedBufferAttribute;
  /** Concrete barriers at checkpoints. */
  private barriers: THREE.InstancedMesh;
  private time = 0;
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private v = new THREE.Vector3();
  private up = new THREE.Vector3(0, 1, 0);
  private one = new THREE.Vector3(1, 1, 1);
  private c = new THREE.Color();
  private cars: Car[] = [];
  private nextId = 1;
  private crews: Crews | null = null;
  private lastCx = NaN;
  private lastCz = NaN;
  private spawnTimer = 0;
  private pos = { x: 0, z: 0, h: 0 };

  constructor() {
    // Lamps are marked per vertex for the night glow: headlights at the front (-z), tail lights behind.
    const glow = (g: THREE.BufferGeometry, kind: number) => {
      g.setAttribute('aGlow', new THREE.Float32BufferAttribute(new Float32Array(g.getAttribute('position').count).fill(kind), 1));
      return g;
    };
    const lamp = (w: number, h: number, d: number, x: number, y: number, z: number, kind: number) => {
      const g = new THREE.BoxGeometry(w, h, d);
      g.translate(x, y, z);
      return glow(g, kind);
    };
    const lamps = (front: number, back: number) => [
      lamp(0.45, 0.18, 0.06, -0.6, 0.72, front, 1), lamp(0.45, 0.18, 0.06, 0.6, 0.72, front, 1),
      lamp(0.4, 0.16, 0.06, -0.62, 0.75, back, 2), lamp(0.4, 0.16, 0.06, 0.62, 0.75, back, 2),
    ];
    const body = new THREE.BoxGeometry(1.9, 0.75, 4.3);
    body.translate(0, 0.6, 0);
    const cabin = new THREE.BoxGeometry(1.7, 0.6, 2.2);
    cabin.translate(0, 1.25, 0.2);
    const geometry = mergeGeometries([glow(body, 0), glow(cabin, 0), ...lamps(-2.16, 2.16)]);
    const make = (count: number, lit: boolean) => {
      const material = new THREE.MeshLambertMaterial();
      if (lit) vehicleLamps(material, false);
      cityLight.patch(material);
      const mesh = new THREE.InstancedMesh(geometry, material, count);
      mesh.setColorAt(0, this.c.setHex(0xffffff));
      mesh.count = 0;
      mesh.frustumCulled = false;
      mesh.castShadow = true;
      this.group.add(mesh);
      return mesh;
    };
    this.moving = make(MOVING, true);
    this.abandoned = make(ABANDONED, false);
    // A cruiser: white body, black bonnet and doors band, and a red-and-blue light bar.
    const tint = (g: THREE.BufferGeometry, color: number) => {
      const c = new THREE.Color(color);
      const n = g.getAttribute('position').count;
      g.setAttribute('color', new THREE.Float32BufferAttribute(Array.from({ length: n }, () => [c.r, c.g, c.b]).flat(), 3));
      return g;
    };
    const part = (w: number, h: number, d: number, x: number, y: number, z: number, color: number, kind = 0) => {
      const g = new THREE.BoxGeometry(w, h, d);
      g.translate(x, y, z);
      return glow(tint(g, color), kind);
    };
    const cruiser = mergeGeometries([
      part(1.9, 0.75, 4.5, 0, 0.6, 0, 0xf2f2f2),
      part(1.92, 0.3, 1.6, 0, 0.75, -1.4, 0x16181c),
      part(1.7, 0.6, 2.2, 0, 1.25, 0.2, 0x16181c),
      part(0.6, 0.15, 0.3, -0.35, 1.62, 0.2, 0xd42020, 3),
      part(0.6, 0.15, 0.3, 0.35, 1.62, 0.2, 0x2040e0, 4),
      ...lamps(-2.26, 2.26).map((g) => tint(g, 0xdddddd)),
    ]);
    // Each cruiser's light bar flashes in its own rhythm.
    this.phase = new THREE.InstancedBufferAttribute(new Float32Array(POLICE), 1).setUsage(THREE.DynamicDrawUsage);
    cruiser.setAttribute('aPhase', this.phase);
    const cruiserMaterial = new THREE.MeshLambertMaterial({ vertexColors: true });
    vehicleLamps(cruiserMaterial, true);
    cityLight.patch(cruiserMaterial);
    this.police = new THREE.InstancedMesh(cruiser, cruiserMaterial, POLICE);
    const barrier = new THREE.BoxGeometry(0.6, 0.9, 3.4);
    barrier.translate(0, 0.45, 0);
    const barrierMaterial = new THREE.MeshLambertMaterial({ color: 0xc9c5ba });
    cityLight.patch(barrierMaterial);
    this.barriers = new THREE.InstancedMesh(barrier, barrierMaterial, BARRIERS);
    for (const mesh of [this.police, this.barriers]) {
      mesh.count = 0;
      mesh.frustumCulled = false;
      mesh.castShadow = true;
      this.group.add(mesh);
    }
  }

  /** Where a car is and which way it faces, before any turn's swing. */
  private place(c: Car): { x: number; z: number; h: number } {
    const lane = lanesOf(c.line)[c.lane];
    // Pulled over: eased across to the curb.
    const off = lane + c.curb * (roadWidth(c.line) / 2 - 1.4 - lane);
    const p = this.pos;
    if (c.axis === 0) {
      p.x = c.s;
      p.z = nodeZ(c.line) + c.dir * off;
      p.h = c.dir > 0 ? -Math.PI / 2 : Math.PI / 2;
    } else {
      p.x = nodeX(c.line) - c.dir * off;
      p.z = c.s;
      p.h = c.dir > 0 ? Math.PI : 0;
    }
    return p;
  }

  /** Whether the lights at a corner let a street through (only avenue crossings have lights; they're out without power). */
  private green(state: CityState, axis: 0 | 1, i: number, j: number, e: number): boolean {
    if (roadWidth(i) < 20 && roadWidth(j) < 20) return true;
    const di = districtOfEdge(e);
    if (di >= 0 && state.districts[di].power === 'dark') return true;
    const u = (this.time + hash(i, j) * LIGHT_CYCLE) % LIGHT_CYCLE;
    const half = LIGHT_CYCLE / 2;
    return axis === 0 ? u < half - ALL_RED : u >= half && u < LIGHT_CYCLE - ALL_RED;
  }

  /** Whether a lane is clear for a car around `s`. */
  private clear(lane: Car[] | undefined, s: number, room: number): boolean {
    if (!lane) return true;
    for (const o of lane) if (Math.abs(o.s - s) < room) return false;
    return true;
  }

  private static laneKey(axis: 0 | 1, line: number, dir: 1 | -1, lane: number): number {
    return ((axis * 64 + line) * 2 + (dir > 0 ? 1 : 0)) * 2 + lane;
  }

  /**
   * At the corner ahead: drive straight on, turn into the cross street (more likely the busier it
   * is) or, if every way on is blocked, turn around. `over` is how far past the corner it's driven.
   */
  private corner(c: Car, t: Traffic, k: number, over: number, lanes: Map<number, Car[]>): void {
    const before = this.place(c);
    const bx = before.x + c.ox;
    const bz = before.z + c.oz;
    const bh = before.h + c.oh;
    const cross: 0 | 1 = c.axis === 0 ? 1 : 0;
    const crossAt = c.line;
    const options: { axis: 0 | 1; line: number; dir: 1 | -1; s: number; w: number }[] = [];
    const weigh = (e: number, straight: boolean) => {
      const b = t.blocked[e];
      // Nobody drives into the airport but by its access road.
      return b > 0.9 || closedEdge(e) ? 0 : (t.load[e] + 30) * (1 - b) ** 2 * (straight ? 5 : 1);
    };
    const n = nodesAlong(c.axis);
    if (k + c.dir >= 0 && k + c.dir < n) {
      options.push({ axis: c.axis, line: c.line, dir: c.dir, s: c.s, w: weigh(edgeAt(c.axis, c.line, c.dir > 0 ? k : k - 1), true) });
    }
    for (const dir of [1, -1] as const) {
      if (crossAt + dir < 0 || crossAt + dir >= nodesAlong(cross)) continue;
      const s = nodeAlong(cross, crossAt) + dir * over;
      // Don't cut into a car already crossing there.
      if (!this.clear(lanes.get(Cars.laneKey(cross, k, dir, 0)), s, QUEUE_GAP + 1)) continue;
      options.push({ axis: cross, line: k, dir, s, w: weigh(edgeAt(cross, k, dir > 0 ? crossAt : crossAt - 1), false) });
    }
    const total = options.reduce((a, o) => a + o.w, 0);
    if (total <= 0) {
      c.dir = c.dir > 0 ? -1 : 1;
      c.s = nodeAlong(c.axis, k) + c.dir * over;
      c.v *= 0.3;
    } else {
      let r = Math.random() * total;
      const o = options.find((x) => (r -= x.w) < 0) ?? options[options.length - 1];
      if (o.axis === c.axis) return;
      c.axis = o.axis;
      c.line = o.line;
      c.dir = o.dir;
      c.s = o.s;
      c.lane = Math.floor(Math.random() * lanesOf(o.line).length);
      c.v *= 0.6;
    }
    // Swing from the old lane into the new one rather than jump.
    const after = this.place(c);
    c.ox = bx - after.x;
    c.oz = bz - after.z;
    c.oh = wrap(bh - after.h);
  }

  /** Drive, add and remove the moving cars, and draw them. Returns how many of each mesh it filled. */
  private drive(dt: number, state: CityState, t: Traffic, cx: number, cz: number, police: number): { moving: number; police: number } {
    // A teleport (or the first frame): fill the streets around the new spot at once.
    const fill = !(Math.hypot(cx - this.lastCx, cz - this.lastCz) < 200);
    if (fill) {
      for (const c of this.cars) if (c.stop !== Stop.Driving) this.crews?.recall(c.id, true);
      this.cars.length = 0;
    }
    this.lastCx = cx;
    this.lastCz = cz;

    // Each lane's cars, front first.
    const lanes = new Map<number, Car[]>();
    for (const c of this.cars) {
      const key = Cars.laneKey(c.axis, c.line, c.dir, c.lane);
      const list = lanes.get(key);
      if (list) list.push(c);
      else lanes.set(key, [c]);
    }
    for (const list of lanes.values()) list.sort((a, b) => b.dir * b.s - a.dir * a.s);

    const ease = Math.exp(-dt * TURN_EASE);
    for (const [key, list] of lanes) {
      for (let n = 0; n < list.length; n++) {
        const c = list[n];
        if (Cars.laneKey(c.axis, c.line, c.dir, c.lane) !== key) continue;
        const e = edgeOf(c);
        const stopping = c.stop === Stop.PullingOver || c.stop === Stop.CrewOut;
        const limitSpeed = stopping ? 0 : CRUISE * speedFactor(t, e) * (c.police ? 1.15 : 1);
        const k0 = (c.s - startAlong(c.axis)) / STREET_SPACING;
        const next = c.dir > 0 ? Math.floor(k0 + 1e-6) + 1 : Math.ceil(k0 - 1e-6) - 1;
        const p = c.dir * c.s;
        let room = Infinity;
        // The car ahead, if it's still in this lane.
        for (let m = n - 1; m >= 0; m--) {
          const a = list[m];
          // A patrol car pulled over at the curb is passed.
          if (Cars.laneKey(a.axis, a.line, a.dir, a.lane) !== key || a.stop === Stop.CrewOut) continue;
          room = a.dir * a.s - QUEUE_GAP - p;
          break;
        }
        if (next >= 0 && next < nodesAlong(c.axis)) {
          const sn = nodeAlong(c.axis, next);
          const [i, j] = c.axis === 0 ? [next, c.line] : [c.line, next];
          const stop = c.dir * sn - (roadWidth(next) / 2 + 3);
          // Stop at a red light if there's room to.
          if (p < stop && stop - p > (c.v * c.v) / 12 - 0.5 && !this.green(state, c.axis, i, j, e)) room = Math.min(room, stop - p);
        }
        const target = Math.min(limitSpeed, Math.max(0, (room - 0.5) * 0.9));
        c.v += Math.max(-9 * dt, Math.min(3 * dt, target - c.v));
        if (c.v < 0) c.v = 0;
        const step = Math.min(c.v * dt, Math.max(0, room));
        if (step < c.v * dt) c.v = step / Math.max(dt, 1e-3);
        c.s += c.dir * step;
        if (next >= 0 && next < nodesAlong(c.axis)) {
          const sn = nodeAlong(c.axis, next);
          const over = c.dir * (c.s - sn);
          if (over >= 0) this.corner(c, t, next, over, lanes);
        } else {
          // The end of the line at the edge of the city: turn around.
          this.corner(c, t, c.dir > 0 ? nodesAlong(c.axis) - 1 : 0, 0, lanes);
        }
        c.ox *= ease;
        c.oz *= ease;
        c.oh *= ease;
        if (c.police && this.crews) this.patrol(c, dt, cx, cz);
      }
    }

    // Out of range: gone (taking any crew with them).
    this.cars = this.cars.filter((c) => {
      const p = this.place(c);
      const keep = Math.hypot(p.x - cx, p.z - cz) < RADIUS + 60;
      if (!keep && c.stop !== Stop.Driving) this.crews?.recall(c.id, true);
      return keep;
    });

    // Join the streets out at the edge of view, as many as each street's flow calls for.
    this.spawnTimer -= dt;
    if (fill || this.spawnTimer <= 0) {
      this.spawnTimer = 0.25;
      this.populate(state, t, cx, cz, fill);
    }

    let moving = 0;
    const lit = cityLight.night > 0.15;
    for (const c of this.cars) {
      const p = this.place(c);
      const h = p.h + c.oh;
      const x = p.x + c.ox;
      const z = p.z + c.oz;
      this.q.setFromAxisAngle(this.up, h);
      this.m.compose(this.v.set(x, 0, z), this.q, this.one);
      // Headlights down the street ahead.
      if (lit) cityLight.add(Glow.Headlight, x - Math.sin(h) * 2.2, z - Math.cos(h) * 2.2, h, 26, 11, 0.85);
      if (c.police && police < POLICE) {
        this.phase.setX(police, c.phase);
        this.police.setMatrixAt(police++, this.m);
        if (lit) cityLight.add(Glow.Police, x, z, 0, 20, 0, 0.8, c.phase);
      } else if (moving < MOVING) {
        this.moving.setMatrixAt(moving, this.m);
        this.moving.setColorAt(moving, this.c.setHex(c.color));
        moving++;
      }
    }
    return { moving, police };
  }

  /**
   * A patrol car keeps order by being seen; it doesn't fight from behind the wheel. With the dead
   * close by it pulls over to the curb and its two officers get out to deal with them, then get
   * back in once it's been quiet a while and drive on.
   */
  private patrol(c: Car, dt: number, cx: number, cz: number): void {
    const crews = this.crews!;
    c.check -= dt;
    const look = c.check <= 0;
    if (look) c.check = 0.5;
    const p = this.place(c);
    switch (c.stop) {
      case Stop.Driving:
        c.cool -= dt;
        if (look && c.cool <= 0 && Math.hypot(p.x - cx, p.z - cz) < PULL_OVER_VIEW && crews.zombieNear(p.x, p.z, PULL_OVER_RANGE)) c.stop = Stop.PullingOver;
        break;
      case Stop.PullingOver:
        c.curb = Math.min(1, c.curb + dt * 0.8);
        if (c.v < 0.2 && c.curb >= 1) {
          const at = this.place(c);
          crews.dismount(c.id, at.x, at.z, at.h, districtAt(at.x, at.z));
          c.stop = Stop.CrewOut;
          c.quiet = 0;
        }
        break;
      case Stop.CrewOut:
        if (look) {
          c.quiet = crews.zombieNear(p.x, p.z, PULL_OVER_RANGE * 1.5) ? 0 : c.quiet + 0.5;
          if (c.quiet > ALL_CLEAR) crews.recall(c.id);
          if (crews.crewOut(c.id) === 0) c.stop = Stop.PullingOut;
        }
        break;
      case Stop.PullingOut:
        c.curb = Math.max(0, c.curb - dt * 0.6);
        if (c.curb <= 0) {
          c.stop = Stop.Driving;
          c.cool = BACK_ON_PATROL;
        }
        break;
    }
  }

  /** Bring each lane in range up to (or down to) its street's share of the traffic. */
  private populate(state: CityState, t: Traffic, cx: number, cz: number, fill: boolean): void {
    const count = new Map<number, Car[]>();
    for (const c of this.cars) {
      const k = Math.max(0, Math.min(nodesAlong(c.axis) - 2, Math.floor((c.s - startAlong(c.axis)) / STREET_SPACING)));
      const key = (edgeAt(c.axis, c.line, k) * 2 + (c.dir > 0 ? 1 : 0)) * 2 + c.lane;
      const list = count.get(key);
      if (list) list.push(c);
      else count.set(key, [c]);
    }
    const ring = RADIUS * SPAWN_RING;
    // Every lane in range with how many cars its street calls for.
    const lanes: { here: Car[]; want: number; hidden: boolean; make: () => Car | null }[] = [];
    let wanted = 0;
    const i0 = Math.max(0, Math.floor((cx - RADIUS - nodeX(0)) / STREET_SPACING));
    const i1 = Math.min(NODES_X - 1, Math.ceil((cx + RADIUS - nodeX(0)) / STREET_SPACING));
    const j0 = Math.max(0, Math.floor((cz - RADIUS - nodeZ(0)) / STREET_SPACING));
    const j1 = Math.min(NODES_Z - 1, Math.ceil((cz + RADIUS - nodeZ(0)) / STREET_SPACING));
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        for (const axis of [0, 1] as const) {
          const [ni, nj] = axis === 0 ? [i + 1, j] : [i, j + 1];
          if (ni >= NODES_X || nj >= NODES_Z) continue;
          const d = Math.hypot((nodeX(i) + nodeX(ni)) / 2 - cx, (nodeZ(j) + nodeZ(nj)) / 2 - cz);
          if (d > RADIUS) continue;
          const e = edgeIndex(i, j, ni, nj);
          if (closedEdge(e)) continue;
          const line = axis === 0 ? j : i;
          const k = axis === 0 ? i : j;
          const inset = roadWidth(axis === 0 ? i : j) / 2 + 2;
          const len = STREET_SPACING - inset * 2;
          const flow = Math.min(1, congestion(t, e)) * (1 - t.blocked[e]);
          const want = Math.min(Math.floor(len / QUEUE_GAP), Math.round((len / QUEUE_GAP) * flow * 0.9 + (t.load[e] > 1 ? 1 : 0)));
          const di = districtOfEdge(e);
          const pol = di >= 0 ? state.districts[di].police : null;
          const patrol = pol && pol.stage !== 'support' && DISTRICT_TEMPLATES[di].kind !== 'airbase' ? Math.min(0.2, pol.officers / 300) : 0;
          for (const dir of [1, -1] as const) {
            for (let lane = 0; lane < lanesOf(line).length; lane++) {
              const here = count.get((e * 2 + (dir > 0 ? 1 : 0)) * 2 + lane) ?? [];
              wanted += want;
              lanes.push({
                here, want, hidden: d > ring,
                make: () => {
                  const s = nodeAlong(axis, k) + inset + Math.random() * len;
                  if (!this.clear(here, s, QUEUE_GAP + 1)) return null;
                  return {
                    axis, line, dir, lane, s, v: CRUISE * speedFactor(t, e),
                    color: PAINT[Math.floor(Math.random() * PAINT.length)],
                    police: Math.random() < patrol, phase: Math.random(), ox: 0, oz: 0, oh: 0,
                    id: this.nextId++, stop: Stop.Driving, curb: 0, check: 0, quiet: 0, cool: 0,
                  };
                },
              });
            }
          }
        }
      }
    }
    const add = (l: (typeof lanes)[number]) => {
      const c = l.make();
      if (!c) return false;
      this.cars.push(c);
      l.here.push(c);
      return true;
    };
    if (fill) {
      for (const l of lanes) for (let tries = l.here.length; tries < l.want; tries++) add(l);
      return;
    }
    // Cars drive in and out across the edge of view and bunch up at the lights, so keep the total
    // in range to what the streets call for: top up the thin lanes out of sight, or thin out the
    // crowded ones.
    const inRange = this.cars.filter((c) => {
      const p = this.place(c);
      return Math.hypot(p.x - cx, p.z - cz) < RADIUS;
    }).length;
    let gap = wanted - inRange;
    const hidden = lanes.filter((l) => l.hidden).sort(() => Math.random() - 0.5);
    if (gap > 0) {
      let budget = Math.min(gap, 60);
      for (const l of hidden) if (l.here.length < l.want && budget > 0 && add(l)) budget--;
    } else if (gap < -wanted * 0.05) {
      const drop = new Set<Car>();
      for (const l of hidden.sort((a, b) => b.here.length - b.want - (a.here.length - a.want))) {
        if (gap >= 0 || drop.size >= 40) break;
        if (l.here.length > Math.max(0, l.want - 1)) {
          drop.add(l.here[l.here.length - 1]);
          gap++;
        }
      }
      if (drop.size) this.cars = this.cars.filter((c) => !drop.has(c));
    }
  }

  update(dt: number, state: CityState | null, cx: number, cz: number, crews: Crews | null = null): void {
    this.crews = crews;
    this.time += dt;
    let moving = 0;
    let abandoned = 0;
    let police = 0;
    let barriers = 0;
    const t = state?.traffic;
    const lit = cityLight.night > 0.15;
    if (t && state) {
      // Checkpoints: barriers across part of each road into the intersection and two cruisers.
      for (const d of state.districts) {
        if (d.police.stage === 'patrol' || d.police.officers < 5 || d.status === 'overrun') continue;
        for (const [i, j] of checkpointNodes(d)) {
          const x = nodeX(i);
          const z = nodeZ(j);
          if (Math.hypot(x - cx, z - cz) > RADIUS + 100) continue;
          for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const w = roadWidth(dx === 0 ? i : j) / 2 + 2;
            for (const lane of [-1, 1]) {
              if (barriers >= BARRIERS) break;
              // Stagger the barriers so cars must slow and weave through.
              const off = lane * (dx === 0 ? 3 : 3);
              this.q.setFromAxisAngle(this.up, dx === 0 ? Math.PI / 2 : 0);
              this.m.compose(this.v.set(x + dx * w + (dx === 0 ? off : 0) + (lane > 0 ? dx * 4 : 0), 0, z + dz * w + (dz === 0 ? off : 0) + (lane > 0 ? dz * 4 : 0)), this.q, this.one);
              this.barriers.setMatrixAt(barriers++, this.m);
            }
          }
          for (const k of [0, 1]) {
            if (police >= POLICE) break;
            this.q.setFromAxisAngle(this.up, 0.6 + k * 2.2);
            this.m.compose(this.v.set(x + (k ? -7 : 7), 0, z + (k ? 6 : -6)), this.q, this.one);
            const phase = hash(i * 2 + k, j);
            this.phase.setX(police, phase);
            this.police.setMatrixAt(police++, this.m);
            if (lit) cityLight.add(Glow.Police, x + (k ? -7 : 7), z + (k ? 6 : -6), 0, 22, 0, 0.9, phase);
          }
        }
      }
      const drawn = this.drive(Math.min(dt, 0.1), state, t, cx, cz, police);
      moving = drawn.moving;
      police = drawn.police;
      const i0 = Math.max(0, Math.floor((cx - RADIUS - nodeX(0)) / STREET_SPACING));
      const i1 = Math.min(NODES_X - 1, Math.ceil((cx + RADIUS - nodeX(0)) / STREET_SPACING));
      const j0 = Math.max(0, Math.floor((cz - RADIUS - nodeZ(0)) / STREET_SPACING));
      const j1 = Math.min(NODES_Z - 1, Math.ceil((cz + RADIUS - nodeZ(0)) / STREET_SPACING));
      for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) {
          for (const [ni, nj] of [[i + 1, j], [i, j + 1]]) {
            if (ni >= NODES_X || nj >= NODES_Z) continue;
            const ax = nodeX(i);
            const az = nodeZ(j);
            const bx = nodeX(ni);
            const bz = nodeZ(nj);
            if (Math.hypot((ax + bx) / 2 - cx, (az + bz) / 2 - cz) > RADIUS) continue;
            const e = edgeIndex(i, j, ni, nj);
            if (closedEdge(e)) continue;
            const blocked = t.blocked[e];
            // Keep clear of the cross streets' intersections.
            const inset = roadWidth(ni === i ? j : i) / 2 + 2;
            const len = STREET_SPACING - inset * 2;
            const dirX = (bx - ax) / STREET_SPACING;
            const dirZ = (bz - az) / STREET_SPACING;
            const heading = Math.atan2(-dirX, -dirZ);
            const rightX = Math.cos(heading);
            const rightZ = -Math.sin(heading);
            const width = roadWidth(ni === i ? i : j);
            const avenue = isAvenue(e);

            // Abandoned cars: fixed places along the street, filled in as it chokes.
            const wrecks = Math.round(blocked * (len / SPACING) * (avenue ? 4 : 2));
            for (let k = 0; k < wrecks && abandoned < ABANDONED; k++) {
              const h1 = hash(e, k * 3 + 1);
              const h2 = hash(e + 0.5, k * 3 + 2);
              const h3 = hash(e + 0.25, k * 3 + 3);
              const along = inset + h1 * len;
              // Mostly in the lanes, some up on the sidewalk.
              const side = (h2 - 0.5) * (width + 5);
              this.q.setFromAxisAngle(this.up, heading + (h3 - 0.5) * 1.6 + (h2 > 0.5 ? Math.PI : 0));
              this.m.compose(this.v.set(ax + dirX * along + rightX * side, 0, az + dirZ * along + rightZ * side), this.q, this.one);
              this.abandoned.setMatrixAt(abandoned, this.m);
              const color = h3 < 0.18 ? BURNT : DUSTY[Math.floor(h1 * DUSTY.length)];
              this.abandoned.setColorAt(abandoned, this.c.setHex(color));
              abandoned++;
            }
          }
        }
      }
    } else {
      this.cars.length = 0;
    }
    for (const [mesh, n] of [[this.moving, moving], [this.abandoned, abandoned], [this.police, police], [this.barriers, barriers]] as const) {
      mesh.count = n;
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh === this.police) this.phase.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
  }
}
