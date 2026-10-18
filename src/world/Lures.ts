// Noise lures the player has dropped: a siren on a tripod with a flashing beacon, washing the street
// around it in light at night. Follows the simulation's list.

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Lure } from '../sim/types';
import { cityLight, Glow } from './CityLight';

const MAX_LURES = 16;

export class Lures {
  readonly group = new THREE.Group();
  private body: THREE.InstancedMesh;
  private beacon: THREE.InstancedMesh;
  private beaconMaterial = new THREE.MeshBasicMaterial({ color: 0xff2a1a });
  private lures: Lure[] = [];
  private time = 0;
  private m = new THREE.Matrix4();

  constructor() {
    const leg = (a: number) => {
      const g = new THREE.CylinderGeometry(0.05, 0.05, 1.6, 4);
      g.rotateZ(0.35);
      g.translate(0.3, 0.75, 0);
      g.rotateY(a);
      return g;
    };
    const horn = new THREE.CylinderGeometry(0.35, 0.15, 0.6, 8);
    horn.rotateZ(Math.PI / 2);
    horn.translate(0, 1.6, 0);
    const box = new THREE.BoxGeometry(0.5, 0.4, 0.5);
    box.translate(0, 1.35, 0);
    const geometry = mergeGeometries([leg(0), leg((Math.PI * 2) / 3), leg((Math.PI * 4) / 3), horn, box]);
    const material = new THREE.MeshLambertMaterial({ color: 0x3a3d40 });
    cityLight.patch(material);
    this.body = new THREE.InstancedMesh(geometry, material, MAX_LURES);
    const beacon = new THREE.SphereGeometry(0.22, 8, 6);
    beacon.translate(0, 1.95, 0);
    this.beacon = new THREE.InstancedMesh(beacon, this.beaconMaterial, MAX_LURES);
    for (const mesh of [this.body, this.beacon]) {
      mesh.count = 0;
      mesh.frustumCulled = false;
      this.group.add(mesh);
    }
  }

  sync(lures: Lure[]): void {
    this.lures = lures.slice(0, MAX_LURES);
    this.lures.forEach((l, i) => {
      this.m.makeTranslation(l.x, 0, l.z);
      this.body.setMatrixAt(i, this.m);
      this.beacon.setMatrixAt(i, this.m);
    });
    for (const mesh of [this.body, this.beacon]) {
      mesh.count = this.lures.length;
      mesh.instanceMatrix.needsUpdate = true;
    }
  }

  update(dt: number): void {
    this.time += dt;
    // Flashing twice a second.
    const on = Math.sin(this.time * 12) > 0;
    this.beaconMaterial.color.setHex(on ? 0xff2a1a : 0x401010);
    if (cityLight.night > 0.15) for (const l of this.lures) cityLight.add(Glow.Police, l.x, l.z, 0, 26, 0, 0.8, 0.5);
  }
}
