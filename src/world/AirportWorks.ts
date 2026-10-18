// The airport being turned into a fortress, stage by stage as the engineers' convoys arrive:
//  1. concrete barriers in a chicane at the west gate and around the JOC compound,
//  2. a line of concrete barriers around the whole airport, inside its fence,
//  3. coils of razor wire in front of it,
//  4. guard towers at the corners, the gate and along each side,
//  5. HESCO bastion walls at the gate and the JOC, and floodlight masts.
// A new stage is built out over a few seconds (the barrier line goes up from the gate round), rather
// than appearing all at once.

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { airportGate } from '../sim/convoys';
import { districtCenter, DISTRICT_SIZE } from '../sim/layout';
import { cityLight, Glow } from './CityLight';

/** Seconds a stage takes to go up on screen. */
const BUILD_SECONDS = 25;
/** The barrier line, this far inside the district's edge (the fence is at 20 m). */
const LINE_INSET = 34;
const BARRIER_LENGTH = 3.4;
/** Half the width of the gap left in the line for the road at the gate. */
const GATE_GAP = 16;

const CONCRETE = 0xbdb9ad;

function tint(g: THREE.BufferGeometry, color: number): THREE.BufferGeometry {
  const c = new THREE.Color(color);
  const n = g.getAttribute('position').count;
  g.setAttribute('color', new THREE.Float32BufferAttribute(Array.from({ length: n }, () => [c.r, c.g, c.b]).flat(), 3));
  return g;
}

function box(w: number, h: number, d: number, x: number, y: number, z: number, color: number): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d);
  g.translate(x, y + h / 2, z);
  return tint(g, color);
}

interface Placed {
  x: number;
  z: number;
  yaw: number;
}

export class AirportWorks {
  readonly group = new THREE.Group();
  /** One instanced mesh per stage element, filled in build order. */
  private parts: { stage: number; mesh: THREE.InstancedMesh | THREE.LineSegments; total: number }[] = [];
  private stage = 0;
  /** How far each stage has been built on screen (0..1). */
  private built = [0, 0, 0, 0, 0];
  private masts: Placed[] = [];

  constructor() {
    const c = districtCenter(0, 2);
    const half = DISTRICT_SIZE / 2 - LINE_INSET;
    const gate = airportGate();
    const joc = { x: c.x - 210, z: c.z + 152 };

    // Stage 1: a chicane of barriers at the gate, and a ring round the JOC compound.
    const gateBarriers: Placed[] = [];
    for (let k = 0; k < 4; k++) {
      const side = k % 2 === 0 ? 1 : -1;
      gateBarriers.push({ x: gate.x + 30 + k * 14, z: gate.z + side * 4, yaw: 0 });
      gateBarriers.push({ x: gate.x + 30 + k * 14, z: gate.z + side * 7.5, yaw: 0 });
    }
    const jocRing = this.ring(joc.x, joc.z, 70, 36, 0);
    this.addBarriers(1, [...gateBarriers, ...jocRing]);

    // Stage 2: the line round the airport, built out from the gate.
    const line = this.ring(c.x, c.z, half, half, GATE_GAP, gate.z);
    this.addBarriers(2, line);

    // Stage 3: razor wire coils in front of the line: a helix drawn as lines (one draw call).
    this.addWire(3, c.x, c.z, half + 3, gate.z);

    // Stage 4: guard towers.
    const towers: Placed[] = [
      { x: c.x - half, z: c.z - half, yaw: 0 }, { x: c.x + half, z: c.z - half, yaw: 0 },
      { x: c.x - half, z: c.z + half, yaw: 0 }, { x: c.x + half, z: c.z + half, yaw: 0 },
      { x: gate.x + 22, z: gate.z - 20, yaw: 0 }, { x: gate.x + 22, z: gate.z + 20, yaw: 0 },
      { x: c.x, z: c.z - half, yaw: 0 }, { x: c.x, z: c.z + half, yaw: 0 }, { x: c.x + half, z: c.z, yaw: 0 },
    ];
    this.addTowers(4, towers);

    // Stage 5: HESCO walls flanking the gate road and round the JOC, and floodlight masts.
    const hesco: Placed[] = [];
    for (let k = 0; k < 18; k++) {
      hesco.push({ x: gate.x + 28 + k * 1.6, z: gate.z - 12, yaw: 0 });
      hesco.push({ x: gate.x + 28 + k * 1.6, z: gate.z + 12, yaw: 0 });
    }
    for (const p of this.ring(joc.x, joc.z, 76, 42, 10)) hesco.push(p);
    this.addHesco(5, hesco);
    this.masts = [
      { x: gate.x + 45, z: gate.z - 16, yaw: 0 }, { x: gate.x + 45, z: gate.z + 16, yaw: 0 },
      { x: joc.x - 76, z: joc.z - 42, yaw: 0 }, { x: joc.x + 76, z: joc.z - 42, yaw: 0 },
      { x: joc.x - 76, z: joc.z + 42, yaw: 0 }, { x: joc.x + 76, z: joc.z + 42, yaw: 0 },
    ];
    // Each lamp aims inward: across the gate road, or into the JOC compound.
    for (const m of this.masts) {
      const near = m.x < gate.x + 100 ? { x: gate.x + 45, z: gate.z } : joc;
      m.yaw = Math.atan2(m.x - near.x, m.z - near.z);
    }
    this.addMasts(5, this.masts);
    this.apply();
  }

  /**
   * Places along a rectangle's edge, a barrier length apart, starting at its west side's middle (or at
   * `gateZ` there) and going round; with a gap of `gap` either side of the start.
   */
  private ring(cx: number, cz: number, hx: number, hz: number, gap: number, gateZ = cz): Placed[] {
    const corners: [number, number][] = [[cx - hx, gateZ], [cx - hx, cz + hz], [cx + hx, cz + hz], [cx + hx, cz - hz], [cx - hx, cz - hz], [cx - hx, gateZ]];
    const out: Placed[] = [];
    let run = 0;
    for (let k = 1; k < corners.length; k++) {
      const [ax, az] = corners[k - 1];
      const [bx, bz] = corners[k];
      const len = Math.hypot(bx - ax, bz - az);
      const yaw = Math.atan2(bx - ax, bz - az);
      for (let d = BARRIER_LENGTH / 2; d < len; d += BARRIER_LENGTH) {
        const total = run + d;
        const perimeter = 2 * (2 * hx + 2 * hz);
        if (gap > 0 && (total < gap || total > perimeter - gap)) continue;
        out.push({ x: ax + ((bx - ax) * d) / len, z: az + ((bz - az) * d) / len, yaw });
      }
      run += len;
    }
    return out;
  }

  private instanced(stage: number, geometry: THREE.BufferGeometry, places: Placed[]): void {
    const material = new THREE.MeshLambertMaterial({ vertexColors: true });
    cityLight.patch(material);
    const mesh = new THREE.InstancedMesh(geometry, material, places.length);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    const one = new THREE.Vector3(1, 1, 1);
    places.forEach((p, i) => {
      q.setFromAxisAngle(up, p.yaw);
      m.compose(new THREE.Vector3(p.x, 0, p.z), q, one);
      mesh.setMatrixAt(i, m);
    });
    mesh.count = 0;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    this.group.add(mesh);
    this.parts.push({ stage, mesh, total: places.length });
  }

  /** Jersey barriers, lengthwise along z: a wide foot, a narrower top. */
  private addBarriers(stage: number, places: Placed[]): void {
    const geo = mergeGeometries([box(0.65, 0.35, BARRIER_LENGTH - 0.15, 0, 0, 0, CONCRETE), box(0.3, 0.55, BARRIER_LENGTH - 0.15, 0, 0.35, 0, CONCRETE)]);
    this.instanced(stage, geo, places);
  }

  private addHesco(stage: number, places: Placed[]): void {
    const geo = mergeGeometries([box(1.5, 1.4, 1.5, 0, 0, 0, 0x9c8a64), box(1.52, 0.05, 1.52, 0, 1.4, 0, 0x6f6246)]);
    this.instanced(stage, geo, places);
  }

  private addTowers(stage: number, places: Placed[]): void {
    const legs = [-1.3, 1.3].flatMap((x) => [-1.3, 1.3].map((z) => box(0.2, 6, 0.2, x, 0, z, 0x4a4436)));
    const geo = mergeGeometries([
      ...legs, box(3.4, 0.25, 3.4, 0, 6, 0, 0x5c5442), box(3.4, 1.1, 0.25, 0, 6.25, -1.6, 0x8b7d5a), box(3.4, 1.1, 0.25, 0, 6.25, 1.6, 0x8b7d5a),
      box(0.25, 1.1, 3.4, -1.6, 6.25, 0, 0x8b7d5a), box(0.25, 1.1, 3.4, 1.6, 6.25, 0, 0x8b7d5a), box(3.8, 0.2, 3.8, 0, 8.4, 0, 0x3f4530),
      ...[-1.6, 1.6].flatMap((x) => [-1.6, 1.6].map((z) => box(0.12, 1.1, 0.12, x, 7.3, z, 0x4a4436))),
    ]);
    this.instanced(stage, geo, places);
  }

  private addMasts(stage: number, places: Placed[]): void {
    const pole = new THREE.CylinderGeometry(0.12, 0.18, 12, 6);
    pole.translate(0, 6, 0);
    const geo = mergeGeometries([tint(pole, 0x8a8d90), box(1.6, 0.5, 0.6, 0, 12, 0, 0xfff4d6)]);
    this.instanced(stage, geo, places);
  }

  /** Concertina wire round the airport: loops a metre wide every half metre, as lines. */
  private addWire(stage: number, cx: number, cz: number, half: number, gateZ: number): void {
    const loops: number[] = [];
    const corners: [number, number][] = [[cx - half, gateZ], [cx - half, cz + half], [cx + half, cz + half], [cx + half, cz - half], [cx - half, cz - half], [cx - half, gateZ]];
    const perimeter = 8 * half;
    let run = 0;
    for (let k = 1; k < corners.length; k++) {
      const [ax, az] = corners[k - 1];
      const [bx, bz] = corners[k];
      const len = Math.hypot(bx - ax, bz - az);
      const dx = (bx - ax) / len;
      const dz = (bz - az) / len;
      for (let d = 0; d < len; d += 0.5) {
        if (run + d < GATE_GAP || run + d > perimeter - GATE_GAP) continue;
        const x = ax + dx * d;
        const z = az + dz * d;
        // A loop across the line: points round a circle in the plane across it.
        const n = 8;
        for (let i = 0; i < n; i++) {
          const a0 = (i / n) * Math.PI * 2;
          const a1 = ((i + 1) / n) * Math.PI * 2;
          for (const a of [a0, a1]) {
            const across = Math.cos(a) * 0.5;
            loops.push(x - dz * across + dx * (a / (Math.PI * 2)) * 0.5, 0.5 + Math.sin(a) * 0.5, z + dx * across + dz * (a / (Math.PI * 2)) * 0.5);
          }
        }
      }
      run += len;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(loops, 3));
    const wire = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: 0x9a9c9e }));
    wire.frustumCulled = false;
    this.group.add(wire);
    this.parts.push({ stage, mesh: wire, total: loops.length / 3 });
  }

  /** Engineers have finished up to this stage (from the simulation). */
  sync(stage: number): void {
    // Arriving in a game already under way: what's done is simply there.
    if (this.stage === 0 && stage > 1) for (let k = 0; k < stage - 1; k++) this.built[k] = 1;
    this.stage = stage;
  }

  update(dt: number): void {
    let changed = false;
    for (let k = 0; k < this.stage; k++) {
      if (this.built[k] >= 1) continue;
      this.built[k] = Math.min(1, this.built[k] + dt / BUILD_SECONDS);
      changed = true;
    }
    if (changed) this.apply();
    // Floodlights at night.
    if (this.built[4] >= 1 && cityLight.night > 0.15) {
      for (const m of this.masts) cityLight.add(Glow.Headlight, m.x, m.z, m.yaw, 34, 30, 0.8);
    }
  }

  private apply(): void {
    for (const p of this.parts) {
      const n = Math.floor(p.total * this.built[p.stage - 1]);
      if (p.mesh instanceof THREE.InstancedMesh) p.mesh.count = n;
      else p.mesh.geometry.setDrawRange(0, n - (n % 2));
      p.mesh.visible = n > 0;
    }
  }
}
