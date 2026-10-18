// Military convoys on the road between Camp Ridgeway and the airport: Humvees front and back, with
// fuel tankers, canvas-topped cargo trucks, or flatbeds of concrete barriers and an engineers' crane
// truck between them. Their headlights light the road at night.

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { CONVOY_VEHICLES, convoyDistance, convoyRoute } from '../sim/convoys';
import type { MilitaryConvoy } from '../sim/types';
import { cityLight, Glow } from './CityLight';

type Vehicle = (typeof CONVOY_VEHICLES)['fuel'][number];
const KINDS: Vehicle[] = ['humvee', 'tanker', 'cargo', 'flatbed', 'crane'];
/** Vehicles of each kind drawn at most. */
const CAPACITY = 48;
/** Metres between vehicles, nose to nose. */
const SPACING = 22;
/** Driving on the right, this far from the road's centre. */
const LANE = 3;

const OLIVE = 0x4f5636;
const DARK = 0x2b2f1f;
const TAN = 0x8c7f5c;
const CONCRETE = 0xb8b5aa;

function box(w: number, h: number, d: number, x: number, y: number, z: number, color: number): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d);
  g.translate(x, y + h / 2, z);
  return tint(g, color);
}

function tint(g: THREE.BufferGeometry, color: number): THREE.BufferGeometry {
  const c = new THREE.Color(color);
  const n = g.getAttribute('position').count;
  g.setAttribute('color', new THREE.Float32BufferAttribute(Array.from({ length: n }, () => [c.r, c.g, c.b]).flat(), 3));
  return g;
}

/** Each vehicle faces -Z (its front), centred on its middle. */
function vehicleGeometry(kind: Vehicle): THREE.BufferGeometry {
  const wheels = (length: number) => [-length / 2 + 1.2, length / 2 - 1.2].map((z) => box(2.5, 0.9, 1.1, 0, 0, z, 0x181818));
  switch (kind) {
    case 'humvee':
      return mergeGeometries([
        ...wheels(4.6), box(2.2, 0.9, 4.6, 0, 0.5, 0, OLIVE), box(2.0, 0.7, 2.2, 0, 1.4, 0.4, OLIVE),
        box(0.7, 0.4, 0.7, 0, 2.1, 0.4, DARK), box(0.1, 0.1, 1.2, 0, 2.35, -0.2, 0x111111),
      ]);
    case 'tanker': {
      const tank = new THREE.CylinderGeometry(1.15, 1.15, 6.2, 12);
      tank.rotateX(Math.PI / 2);
      tank.translate(0, 2.1, 1.6);
      return mergeGeometries([...wheels(9), box(2.5, 1.0, 9, 0, 0.5, 0, DARK), box(2.5, 1.8, 2.4, 0, 1.0, -3.2, OLIVE), tint(tank, OLIVE)]);
    }
    case 'cargo':
      return mergeGeometries([...wheels(8), box(2.5, 1.0, 8, 0, 0.5, 0, DARK), box(2.5, 1.8, 2.3, 0, 1.0, -2.8, OLIVE), box(2.5, 2.3, 5.2, 0, 1.0, 1.3, TAN)]);
    case 'flatbed':
      return mergeGeometries([
        ...wheels(9), box(2.5, 1.0, 9, 0, 0.5, 0, DARK), box(2.5, 1.8, 2.4, 0, 1.0, -3.3, OLIVE),
        ...[-0.3, 1.9, 4.1].map((z) => box(0.7, 0.9, 1.9, 0, 1.5, z - 0.2, CONCRETE)),
        ...[-0.3, 1.9, 4.1].map((z) => box(0.7, 0.9, 1.9, 0.9, 1.5, z - 0.2, CONCRETE)),
      ]);
    case 'crane': {
      const arm = new THREE.BoxGeometry(0.4, 0.4, 7);
      arm.rotateX(-0.45);
      arm.translate(0, 3.6, 1.6);
      return mergeGeometries([...wheels(8.5), box(2.5, 1.0, 8.5, 0, 0.5, 0, DARK), box(2.5, 1.8, 2.4, 0, 1.0, -3.0, OLIVE), box(1.6, 1.0, 1.6, 0, 1.5, 0.6, 0xc9a227), tint(arm, 0xc9a227)]);
    }
  }
}

export class MilitaryConvoys {
  readonly group = new THREE.Group();
  private meshes = new Map<Vehicle, THREE.InstancedMesh>();
  private convoys: MilitaryConvoy[] = [];
  private route = convoyRoute();
  private lengths: number[] = [0];
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private v = new THREE.Vector3();
  private up = new THREE.Vector3(0, 1, 0);
  private one = new THREE.Vector3(1, 1, 1);

  constructor() {
    for (let k = 1; k < this.route.length; k++) {
      const [ax, az] = this.route[k - 1];
      const [bx, bz] = this.route[k];
      this.lengths.push(this.lengths[k - 1] + Math.hypot(bx - ax, bz - az));
    }
    const material = new THREE.MeshLambertMaterial({ vertexColors: true });
    cityLight.patch(material);
    for (const kind of KINDS) {
      const mesh = new THREE.InstancedMesh(vehicleGeometry(kind), material, CAPACITY);
      mesh.count = 0;
      mesh.frustumCulled = false;
      mesh.castShadow = true;
      this.meshes.set(kind, mesh);
      this.group.add(mesh);
    }
  }

  sync(convoys: MilitaryConvoy[]): void {
    this.convoys = convoys;
  }

  /** A point `s` metres along the road, and the way it runs there. */
  private at(s: number): { x: number; z: number; dx: number; dz: number } {
    const total = this.lengths[this.lengths.length - 1];
    const d = Math.max(0, Math.min(total, s));
    let k = 1;
    while (k < this.lengths.length - 1 && this.lengths[k] < d) k++;
    const [ax, az] = this.route[k - 1];
    const [bx, bz] = this.route[k];
    const span = this.lengths[k] - this.lengths[k - 1] || 1;
    const u = (d - this.lengths[k - 1]) / span;
    return { x: ax + (bx - ax) * u, z: az + (bz - az) * u, dx: (bx - ax) / span, dz: (bz - az) / span };
  }

  update(time: number): void {
    const total = this.lengths[this.lengths.length - 1];
    const counts = new Map<Vehicle, number>(KINDS.map((k) => [k, 0]));
    const lit = cityLight.night > 0.15;
    for (const c of this.convoys) {
      const lead = convoyDistance(c, time, total);
      const back = c.phase === 'return';
      CONVOY_VEHICLES[c.kind].forEach((kind, i) => {
        // Outbound the column trails behind the lead; parked at the JOC it's lined up; heading home
        // the order is reversed.
        const s = back ? lead + i * SPACING : lead - i * SPACING;
        if (s < 0 || s > total) return;
        const p = this.at(s);
        const dx = back ? -p.dx : p.dx;
        const dz = back ? -p.dz : p.dz;
        const x = p.x - dz * LANE;
        const z = p.z + dx * LANE;
        const heading = Math.atan2(-dx, -dz);
        const n = counts.get(kind)!;
        if (n >= CAPACITY) return;
        counts.set(kind, n + 1);
        this.q.setFromAxisAngle(this.up, heading);
        this.m.compose(this.v.set(x, 0, z), this.q, this.one);
        this.meshes.get(kind)!.setMatrixAt(n, this.m);
        if (lit && c.phase !== 'unloading') cityLight.add(Glow.Headlight, x + dx * 4, z + dz * 4, heading, 28, 11, 0.9);
      });
    }
    for (const [kind, mesh] of this.meshes) {
      mesh.count = counts.get(kind)!;
      mesh.instanceMatrix.needsUpdate = true;
    }
  }
}
