// Forward refuelling points the player has set up: fuel bladders on a marked pad, a sandbag
// ring and a blinking beacon so they can be found at night. Follows the simulation's list.

import * as THREE from 'three';
import type { Farp } from '../sim/types';

const FULL_BLADDER = 2000;

export class Farps {
  readonly group = new THREE.Group();
  private sites = new Map<number, { root: THREE.Group; bladders: THREE.Mesh[]; beacon: THREE.Mesh }>();
  private time = 0;
  private bladderGeo = new THREE.SphereGeometry(1, 14, 8);
  private bladderMat = new THREE.MeshLambertMaterial({ color: 0x1d1f1c });
  private sandMat = new THREE.MeshLambertMaterial({ color: 0x8b7d5a });
  private padMat = new THREE.MeshLambertMaterial({ color: 0xc9772b, polygonOffset: true, polygonOffsetFactor: -2 });
  private beaconMat = new THREE.MeshBasicMaterial({ color: 0xff3a2a });

  sync(farps: Farp[]): void {
    const live = new Set(farps.map((f) => f.id));
    for (const [id, site] of this.sites) {
      if (live.has(id)) continue;
      this.group.remove(site.root);
      this.sites.delete(id);
    }
    for (const f of farps) {
      const site = this.sites.get(f.id) ?? this.build(f);
      // Bladders sag as the point runs dry.
      const bladders = Math.min(site.bladders.length, Math.ceil(f.fuel / FULL_BLADDER));
      site.bladders.forEach((b, i) => {
        b.visible = i < Math.max(1, bladders);
        b.scale.y = f.fuel <= 0 ? 0.15 : i < bladders - 1 ? 0.7 : 0.25 + 0.45 * ((f.fuel % FULL_BLADDER) / FULL_BLADDER || 1);
      });
    }
  }

  update(dt: number): void {
    this.time += dt;
    const on = Math.sin(this.time * 4) > 0.3;
    for (const site of this.sites.values()) site.beacon.visible = on;
  }

  private build(f: Farp): { root: THREE.Group; bladders: THREE.Mesh[]; beacon: THREE.Mesh } {
    const root = new THREE.Group();
    root.position.set(f.x, 0, f.z);
    const pad = new THREE.Mesh(new THREE.PlaneGeometry(22, 22), this.padMat);
    pad.rotation.x = -Math.PI / 2;
    pad.position.y = 0.06;
    root.add(pad);

    const bladders: THREE.Mesh[] = [];
    for (let i = 0; i < 4; i++) {
      const b = new THREE.Mesh(this.bladderGeo, this.bladderMat);
      b.scale.set(2.4, 0.7, 1.7);
      b.position.set(-14, 0.7, -6 + i * 4);
      b.castShadow = true;
      root.add(b);
      bladders.push(b);
    }
    const sandbag = new THREE.BoxGeometry(2.4, 1, 0.9);
    sandbag.translate(0, 0.5, 0);
    for (let i = 0; i < 12; i++) {
      const ang = (i / 12) * Math.PI * 2;
      const s = new THREE.Mesh(sandbag, this.sandMat);
      s.position.set(Math.cos(ang) * 17, 0, Math.sin(ang) * 17);
      s.rotation.y = -ang + Math.PI / 2;
      s.castShadow = true;
      root.add(s);
    }
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 6, 6), this.sandMat);
    pole.position.set(-14, 3, -11);
    const beacon = new THREE.Mesh(new THREE.SphereGeometry(0.4, 8, 6), this.beaconMat);
    beacon.position.set(-14, 6.2, -11);
    root.add(pole, beacon);

    this.group.add(root);
    const site = { root, bladders, beacon };
    this.sites.set(f.id, site);
    return site;
  }
}
