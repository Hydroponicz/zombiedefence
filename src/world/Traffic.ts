// Civilian food trucks driving their routes and freight trains running into the rail yard, placed
// from the simulation's timetables at the smooth game time.

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { RAIL, TRAIN_LENGTH, trainPose, truckPose } from '../sim/supply';
import type { CityState } from '../sim/types';

const MAX_TRUCKS = 120;
const MAX_TRAINS = 4;
const WAGONS = 12;
const LOCO_LENGTH = 20;
const WAGON_LENGTH = 15;
const COUPLING = 1.2;
/** Trucks keep to the right of the road's centre line. */
const LANE = 4;

function coloredBox(w: number, h: number, d: number, x: number, y: number, z: number, color: number): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d);
  g.translate(x, y, z);
  const c = new THREE.Color(color);
  const n = g.getAttribute('position').count;
  g.setAttribute('color', new THREE.Float32BufferAttribute(Array.from({ length: n }, () => [c.r, c.g, c.b]).flat(), 3));
  return g;
}

export class Traffic {
  readonly group = new THREE.Group();
  private trucks: THREE.InstancedMesh;
  private locos: THREE.InstancedMesh;
  private wagons: THREE.InstancedMesh;
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private v = new THREE.Vector3();
  private up = new THREE.Vector3(0, 1, 0);
  private one = new THREE.Vector3(1, 1, 1);

  constructor() {
    const material = new THREE.MeshLambertMaterial({ vertexColors: true });
    // A semi: red cab at the front (-Z), white box trailer with a green band.
    const truck = mergeGeometries([
      coloredBox(2.5, 2.9, 2.6, 0, 1.85, -6.2, 0xb0362a),
      coloredBox(2.5, 3.6, 11.5, 0, 2.3, 1.0, 0xe9e7e0),
      coloredBox(2.52, 0.5, 11.52, 0, 2.0, 1.0, 0x2e8b57),
      coloredBox(2.3, 0.9, 14, 0, 0.45, -0.6, 0x1c1c1c),
    ]);
    const loco = mergeGeometries([
      coloredBox(3.1, 3.6, LOCO_LENGTH, 0, 2.6, 0, 0x2f4f7a),
      coloredBox(3.12, 0.6, LOCO_LENGTH + 0.02, 0, 3.0, 0, 0xe0b23a),
      coloredBox(2.8, 0.9, LOCO_LENGTH - 2, 0, 0.45, 0, 0x1c1c1c),
    ]);
    const wagon = mergeGeometries([
      coloredBox(3.0, 3.4, WAGON_LENGTH, 0, 2.5, 0, 0x8a4b32),
      coloredBox(2.8, 0.9, WAGON_LENGTH - 2, 0, 0.45, 0, 0x1c1c1c),
    ]);
    this.trucks = new THREE.InstancedMesh(truck, material, MAX_TRUCKS);
    this.locos = new THREE.InstancedMesh(loco, material, MAX_TRAINS);
    this.wagons = new THREE.InstancedMesh(wagon, material, MAX_TRAINS * WAGONS);
    for (const mesh of [this.trucks, this.locos, this.wagons]) {
      mesh.count = 0;
      mesh.frustumCulled = false;
      mesh.castShadow = true;
      this.group.add(mesh);
    }
  }

  update(state: CityState | null, time: number): void {
    let n = 0;
    for (const tr of state?.supply.trucks ?? []) {
      if (n >= MAX_TRUCKS) break;
      const p = truckPose(tr, time);
      // Right-hand lane: offset to the right of the direction of travel.
      const rx = Math.cos(p.heading);
      const rz = -Math.sin(p.heading);
      this.q.setFromAxisAngle(this.up, p.heading);
      this.m.compose(this.v.set(p.x + rx * LANE, 0, p.z + rz * LANE), this.q, this.one);
      this.trucks.setMatrixAt(n++, this.m);
    }
    this.trucks.count = n;
    this.trucks.instanceMatrix.needsUpdate = true;

    let locos = 0;
    let wagons = 0;
    for (const tr of state?.supply.trains ?? []) {
      if (locos >= MAX_TRAINS || time < tr.depart || time >= tr.gone) continue;
      const head = trainPose(tr, time).z;
      // The locomotive leads into the yard, northward; the wagons trail behind it to the south.
      this.q.identity();
      this.m.compose(this.v.set(RAIL.x, 0.3, head + LOCO_LENGTH / 2), this.q, this.one);
      this.locos.setMatrixAt(locos++, this.m);
      for (let k = 0; k < WAGONS; k++) {
        const z = head + LOCO_LENGTH + COUPLING + k * (WAGON_LENGTH + COUPLING) + WAGON_LENGTH / 2;
        if (z > RAIL.farZ + TRAIN_LENGTH) break;
        this.m.compose(this.v.set(RAIL.x, 0.3, z), this.q, this.one);
        this.wagons.setMatrixAt(wagons++, this.m);
      }
    }
    this.locos.count = locos;
    this.wagons.count = wagons;
    this.locos.instanceMatrix.needsUpdate = true;
    this.wagons.instanceMatrix.needsUpdate = true;
  }
}
