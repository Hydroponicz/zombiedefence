// The Joint Operations Command at the airport: command tents behind sandbags on the apron beside
// the helicopter pads, antenna masts, generators, army trucks and a flag. It appears once the JOC
// is established.

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { districtCenter, DISTRICT_TEMPLATES } from '../sim/layout';
import type { CityState } from '../sim/types';

function box(w: number, h: number, d: number, x: number, y: number, z: number, color: number): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d);
  g.translate(x, y + h / 2, z);
  const c = new THREE.Color(color);
  const n = g.getAttribute('position').count;
  g.setAttribute('color', new THREE.Float32BufferAttribute(Array.from({ length: n }, () => [c.r, c.g, c.b]).flat(), 3));
  return g;
}

function mast(h: number, x: number, z: number): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(0.15, 0.25, h, 6);
  g.translate(x, h / 2, z);
  const c = new THREE.Color(0xb8bcc0);
  const n = g.getAttribute('position').count;
  g.setAttribute('color', new THREE.Float32BufferAttribute(Array.from({ length: n }, () => [c.r, c.g, c.b]).flat(), 3));
  return g;
}

export class Joc {
  readonly group = new THREE.Group();

  constructor() {
    const tpl = DISTRICT_TEMPLATES.find((d) => d.kind === 'airbase')!;
    const c = districtCenter(tpl.col, tpl.row);
    // On the apron behind the helicopter pads.
    const x0 = c.x - 210;
    const z0 = c.z + 140;
    const parts: THREE.BufferGeometry[] = [];
    const OLIVE = 0x5b6347;
    const TAN = 0x9c8c66;
    // Command tents and their ridges.
    for (let k = 0; k < 4; k++) {
      parts.push(box(16, 3.2, 8, x0 - 45 + k * 22, 0, z0, k % 2 ? TAN : OLIVE));
      parts.push(box(16.4, 0.6, 3, x0 - 45 + k * 22, 3.2, z0, 0x4a5138));
    }
    // A bigger operations tent with a red cross tent beside it.
    parts.push(box(26, 4, 12, x0 + 10, 0, z0 + 22, OLIVE));
    parts.push(box(10, 3, 8, x0 - 30, 0, z0 + 22, 0xd8d4c8));
    parts.push(box(3, 0.2, 3, x0 - 30, 3, z0 + 22, 0xc02020));
    // Sandbag walls around the compound.
    for (const [w, d, dx, dz] of [[120, 1.2, 0, -14], [120, 1.2, 0, 38], [1.2, 52, -60, 12], [1.2, 52, 60, 12]] as const) {
      parts.push(box(w, 1.3, d, x0 + dx, 0, z0 + dz, 0x8b7d5a));
    }
    // Generators and army trucks.
    for (let k = 0; k < 3; k++) parts.push(box(2.4, 1.8, 3.6, x0 + 40 + k * 5, 0, z0 + 2, 0x3f4530));
    for (let k = 0; k < 5; k++) {
      parts.push(box(2.5, 2.4, 3, x0 - 50 + k * 12, 0.5, z0 + 48, OLIVE));
      parts.push(box(2.5, 3, 5.5, x0 - 50 + k * 12, 0.5, z0 + 52.5, 0x4a5138));
    }
    // Antenna masts and a flagpole.
    for (const [dx, dz, h] of [[48, 30, 24], [52, 24, 18], [-56, -8, 20]] as const) parts.push(mast(h, x0 + dx, z0 + dz));
    parts.push(mast(12, x0, z0 - 10));
    parts.push(box(3.2, 1.9, 0.08, x0 + 1.6, 9.8, z0 - 10, 0x3f6b35));
    const mesh = new THREE.Mesh(mergeGeometries(parts), new THREE.MeshLambertMaterial({ vertexColors: true }));
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    this.group.add(mesh);
    this.group.visible = false;
  }

  sync(state: CityState): void {
    this.group.visible = !!state.flags.joc;
  }
}
