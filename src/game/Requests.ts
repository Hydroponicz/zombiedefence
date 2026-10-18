// Command requests on the player's side: the request taken on shows under the clock with how far
// and which way it is, a beam of light marks the place in the world (new requests come in over the
// radio: see Transmission).

import * as THREE from 'three';
import { districtCenter } from '../sim/layout';
import { describeNeed } from '../sim/requests';
import type { CityState, Request } from '../sim/types';

/** Where a request's job is in the world. */
export function requestTarget(s: CityState, r: Request): { x: number; z: number } | null {
  const site = r.site === null ? undefined : s.sites.find((x) => x.id === r.site);
  if (site) return { x: site.x, z: site.z };
  const d = s.districts[r.district];
  return districtCenter(d.col, d.row);
}

export class RequestTracker {
  readonly marker = new THREE.Group();
  private beam: THREE.Mesh;
  private el = document.getElementById('hud-request')!;
  private time = 0;
  private lastHtml = '';

  constructor() {
    const geo = new THREE.CylinderGeometry(2.5, 2.5, 600, 12, 1, true);
    geo.translate(0, 300, 0);
    this.beam = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
      color: 0xffc94a, transparent: true, opacity: 0.35, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false,
    }));
    this.beam.frustumCulled = false;
    this.marker.add(this.beam);
    this.marker.visible = false;
  }

  update(dt: number, s: CityState | null, heli: THREE.Vector3): void {
    this.time += dt;
    if (!s) return;
    const open = s.requests.filter((r) => r.status === 'open');

    // The request taken on: under the clock, and a beam where it is.
    const tracked = open.find((r) => r.tracked);
    const at = tracked ? requestTarget(s, tracked) : null;
    this.marker.visible = !!at;
    if (at) {
      this.marker.position.set(at.x, 0, at.z);
      (this.beam.material as THREE.MeshBasicMaterial).opacity = 0.25 + 0.15 * Math.sin(this.time * 3);
    }
    let html = '';
    if (tracked) {
      const left = Math.max(0, tracked.deadline - s.t);
      const leftText = left >= 60 ? `${Math.floor(left / 60)}h ${String(Math.floor(left % 60)).padStart(2, '0')}m` : `${Math.floor(left)} min`;
      const where = at ? (() => {
        const dx = at.x - heli.x;
        const dz = at.z - heli.z;
        const d = Math.hypot(dx, dz);
        const bearing = (Math.round((Math.atan2(dx, -dz) * 180) / Math.PI) + 360) % 360;
        return `${d >= 1000 ? `${(d / 1000).toFixed(1)} km` : `${Math.round(d)} m`} · ${String(bearing).padStart(3, '0')}°`;
      })() : '';
      html = `<div class="what">▶ ${tracked.title}</div>
        <div class="meta">${describeNeed(tracked)} · ${Math.floor(tracked.progress)} of ${tracked.needed} · ${leftText} left</div>
        <div class="meta">${where}</div>`;
    }
    if (html !== this.lastHtml) {
      this.lastHtml = html;
      this.el.innerHTML = html;
      this.el.hidden = !html;
    }
  }
}
