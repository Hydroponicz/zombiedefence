// Status markers at the strategic sites: a flag (green held, amber under siege, black fallen),
// a sandbag ring around the landing zone while soldiers are posted, and a beacon that blinks at
// night over the sites still holding, so they can be found in the dark.

import * as THREE from 'three';
import { planSites, type SitePlan } from '../sim/sites';
import type { Site, SiteStatus } from '../sim/types';

const POLE_HEIGHT = 12;
const BAGS = 12;
const BAG_RING = 12.5;
const FLAG_COLOR: Record<SiteStatus, number> = { held: 0x3fae4f, besieged: 0xe0a030, fallen: 0x1c1c1c };

export class Sites {
  readonly group = new THREE.Group();
  private plans: SitePlan[];
  private flags: THREE.InstancedMesh;
  private beacons: THREE.InstancedMesh;
  private bags: THREE.InstancedMesh;
  private guarded: boolean[];
  private holding: boolean[];
  private time = 0;
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private v = new THREE.Vector3();
  private s = new THREE.Vector3(1, 1, 1);
  private c = new THREE.Color();

  constructor(seed: number | string) {
    this.plans = planSites(seed);
    const n = this.plans.length;
    this.guarded = this.plans.map(() => false);
    this.holding = this.plans.map(() => true);

    const poleGeo = new THREE.CylinderGeometry(0.12, 0.12, POLE_HEIGHT, 6);
    poleGeo.translate(0, POLE_HEIGHT / 2, 0);
    const poles = new THREE.InstancedMesh(poleGeo, new THREE.MeshLambertMaterial({ color: 0xd8d8d8 }), n);
    const flagGeo = new THREE.BoxGeometry(3.2, 2, 0.08);
    flagGeo.translate(1.7, POLE_HEIGHT - 1.2, 0);
    this.flags = new THREE.InstancedMesh(flagGeo, new THREE.MeshLambertMaterial(), n);
    const beaconGeo = new THREE.SphereGeometry(0.45, 8, 6);
    beaconGeo.translate(0, POLE_HEIGHT + 0.4, 0);
    this.beacons = new THREE.InstancedMesh(beaconGeo, new THREE.MeshBasicMaterial({ color: 0x9dff7a }), n);
    const bagGeo = new THREE.BoxGeometry(2.6, 1, 0.9);
    bagGeo.translate(0, 0.5, 0);
    this.bags = new THREE.InstancedMesh(bagGeo, new THREE.MeshLambertMaterial({ color: 0x8b7d5a }), n * BAGS);
    this.bags.castShadow = true;

    this.plans.forEach((p, i) => {
      this.m.makeTranslation(...this.polePos(p));
      poles.setMatrixAt(i, this.m);
      this.flags.setMatrixAt(i, this.m);
      this.beacons.setMatrixAt(i, this.m);
      this.flags.setColorAt(i, this.c.setHex(FLAG_COLOR.held));
    });
    this.beacons.count = 0;
    this.bags.count = 0;
    // They start empty, so their bounds would be empty too: never cull them.
    this.beacons.frustumCulled = false;
    this.bags.frustumCulled = false;
    this.group.add(poles, this.flags, this.beacons, this.bags);
  }

  sync(sites: Site[]): void {
    const byId = new Map(sites.map((x) => [x.id, x]));
    let bag = 0;
    this.plans.forEach((p, i) => {
      const site = byId.get(p.id);
      if (!site) return;
      this.flags.setColorAt(i, this.c.setHex(FLAG_COLOR[site.status]));
      this.guarded[i] = site.status !== 'fallen' && site.guards >= 1;
      this.holding[i] = site.status !== 'fallen';
      if (!this.guarded[i]) return;
      for (let k = 0; k < BAGS; k++) {
        const a = (k / BAGS) * Math.PI * 2;
        // A gap toward the street for the doors.
        if (k === 3) continue;
        this.q.setFromAxisAngle(this.v.set(0, 1, 0), -a + Math.PI / 2);
        this.m.compose(this.v.set(p.x + Math.cos(a) * BAG_RING, 0, p.z + Math.sin(a) * BAG_RING), this.q, this.s);
        this.bags.setMatrixAt(bag++, this.m);
      }
    });
    this.bags.count = bag;
    this.bags.instanceMatrix.needsUpdate = true;
    if (this.flags.instanceColor) this.flags.instanceColor.needsUpdate = true;
  }

  update(dt: number, night: number): void {
    this.time += dt;
    const on = night > 0.3 && Math.sin(this.time * 3) > 0.2;
    let n = 0;
    if (on) {
      this.plans.forEach((p, i) => {
        if (!this.holding[i]) return;
        this.m.makeTranslation(...this.polePos(p));
        this.beacons.setMatrixAt(n++, this.m);
      });
    }
    this.beacons.count = n;
    this.beacons.instanceMatrix.needsUpdate = true;
  }

  private polePos(p: SitePlan): [number, number, number] {
    return [p.x + 10, 0, p.z - 10];
  }
}
