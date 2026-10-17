// Cars on the streets around the helicopter, drawn from the simulation's traffic. Moving cars stream
// along each street in both directions, as many as its flow and as fast as its congestion allows,
// down to a crawl bumper to bumper in gridlock. Abandoned cars sit where their drivers left them,
// slewed across the lanes and up on the sidewalks, some burnt out, more as a street chokes.
//
// No car is tracked: each one's place is a function of the street, its index and the time, so the
// streets fill and empty smoothly as the simulation changes.

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { NODES_X, NODES_Z, nodeX, nodeZ, roadWidth, STREET_SPACING } from '../sim/streets';
import { congestion, edgeIndex, isAvenue, speedFactor } from '../sim/traffic';
import type { CityState } from '../sim/types';

const MOVING = 2600;
const ABANDONED = 2400;
/** Streets within this distance of the helicopter get cars. */
const RADIUS = 480;
/** Car length plus a gap, bumper to bumper. */
const SPACING = 7;
/** Free-flow speed in real metres per second. */
const CRUISE = 12;
const PAINT = [0xb03a2e, 0x2b4a72, 0xd8d8d2, 0x2c2c2c, 0x6d6f4a, 0x8a8f96, 0xc98f2b, 0x1d3b2f, 0x7d2a24, 0xe9e7e0];
const DUSTY = [0x6f6a64, 0x5a5f66, 0x7a6a58, 0x4d4f52, 0x8a8178];
const BURNT = 0x1b1a19;

/** A small deterministic hash in [0, 1). */
function hash(a: number, b: number): number {
  const x = Math.sin(a * 127.1 + b * 311.7) * 43758.5453;
  return x - Math.floor(x);
}

export class Cars {
  readonly group = new THREE.Group();
  private moving: THREE.InstancedMesh;
  private abandoned: THREE.InstancedMesh;
  private time = 0;
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private v = new THREE.Vector3();
  private up = new THREE.Vector3(0, 1, 0);
  private one = new THREE.Vector3(1, 1, 1);
  private c = new THREE.Color();

  constructor() {
    const body = new THREE.BoxGeometry(1.9, 0.75, 4.3);
    body.translate(0, 0.6, 0);
    const cabin = new THREE.BoxGeometry(1.7, 0.6, 2.2);
    cabin.translate(0, 1.25, 0.2);
    const geometry = mergeGeometries([body, cabin]);
    const make = (count: number) => {
      const mesh = new THREE.InstancedMesh(geometry, new THREE.MeshLambertMaterial(), count);
      mesh.setColorAt(0, this.c.setHex(0xffffff));
      mesh.count = 0;
      mesh.frustumCulled = false;
      mesh.castShadow = true;
      this.group.add(mesh);
      return mesh;
    };
    this.moving = make(MOVING);
    this.abandoned = make(ABANDONED);
  }

  update(dt: number, state: CityState | null, cx: number, cz: number): void {
    this.time += dt;
    let moving = 0;
    let abandoned = 0;
    const t = state?.traffic;
    if (t) {
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
            const blocked = t.blocked[e];
            const avenue = isAvenue(e);
            // Keep clear of the cross streets' intersections.
            const inset = roadWidth(ni === i ? j : i) / 2 + 2;
            const len = STREET_SPACING - inset * 2;
            const dirX = (bx - ax) / STREET_SPACING;
            const dirZ = (bz - az) / STREET_SPACING;
            const heading = Math.atan2(-dirX, -dirZ);
            const rightX = Math.cos(heading);
            const rightZ = -Math.sin(heading);
            const width = roadWidth(ni === i ? i : j);

            // Moving traffic, both ways; avenues have two lanes each way.
            const flow = Math.min(1, congestion(t, e)) * (1 - blocked);
            const perLane = Math.min(Math.floor(len / SPACING), Math.round((len / SPACING) * flow * 0.9 + (t.load[e] > 1 ? 1 : 0)));
            const speed = CRUISE * speedFactor(t, e);
            const lanes = avenue ? [3.2, 6.6] : [3];
            for (const sign of [1, -1]) {
              for (let l = 0; l < lanes.length; l++) {
                for (let k = 0; k < perLane && moving < MOVING; k++) {
                  // Evenly spaced and drifting along at the street's speed.
                  const s = (((this.time * speed + (k * len) / Math.max(1, perLane) + hash(e, l + sign) * len) % len) + len) % len;
                  const along = sign > 0 ? inset + s : STREET_SPACING - inset - s;
                  const x = ax + dirX * along + rightX * lanes[l] * sign;
                  const z = az + dirZ * along + rightZ * lanes[l] * sign;
                  this.q.setFromAxisAngle(this.up, sign > 0 ? heading : heading + Math.PI);
                  this.m.compose(this.v.set(x, 0, z), this.q, this.one);
                  this.moving.setMatrixAt(moving, this.m);
                  this.moving.setColorAt(moving, this.c.setHex(PAINT[Math.floor(hash(e * 7 + k, l * 3 + sign) * PAINT.length)]));
                  moving++;
                }
              }
            }

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
    }
    for (const [mesh, n] of [[this.moving, moving], [this.abandoned, abandoned]] as const) {
      mesh.count = n;
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
  }
}
