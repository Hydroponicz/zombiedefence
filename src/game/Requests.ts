// Command requests on the player's side: the request taken on shows under the clock with how far
// and which way it is, a beam of light marks the place in the world (new requests come in over the
// radio: see Transmission), and hovering over a food truck that needs overwatch reports it to the simulation.

import * as THREE from 'three';
import { districtCenter } from '../sim/layout';
import type { PlayerCommand } from '../sim/operations';
import { describeNeed, OVERWATCH_ALTITUDE, OVERWATCH_RANGE } from '../sim/requests';
import { truckPose } from '../sim/supply';
import type { CityState, Request } from '../sim/types';

/** Where a request's job is in the world. */
export function requestTarget(s: CityState, r: Request, time: number): { x: number; z: number } | null {
  if (r.kind === 'overwatch') {
    const tr = s.supply.trucks.find((t) => t.id === r.truck);
    return tr ? truckPose(tr, time) : null;
  }
  const site = r.site === null ? undefined : s.sites.find((x) => x.id === r.site);
  if (site) return { x: site.x, z: site.z };
  const d = s.districts[r.district];
  return districtCenter(d.col, d.row);
}

export class RequestTracker {
  readonly marker = new THREE.Group();
  private beam: THREE.Mesh;
  private el = document.getElementById('hud-request')!;
  private reported = new Map<number, number>();
  private time = 0;
  private lastHtml = '';

  /** @param send issue a command to the simulation */
  constructor(private send: (cmd: PlayerCommand) => void) {
    const geo = new THREE.CylinderGeometry(2.5, 2.5, 600, 12, 1, true);
    geo.translate(0, 300, 0);
    this.beam = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
      color: 0xffc94a, transparent: true, opacity: 0.35, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false,
    }));
    this.beam.frustumCulled = false;
    this.marker.add(this.beam);
    this.marker.visible = false;
  }

  /**
   * @param altitude the helicopter's height above whatever is below it
   * @returns whether the helicopter is giving overwatch right now
   */
  update(dt: number, s: CityState | null, time: number, heli: THREE.Vector3, altitude: number): boolean {
    this.time += dt;
    if (!s) return false;
    const open = s.requests.filter((r) => r.status === 'open');

    // Overwatch: low over a truck that needs it, once a game minute.
    let watching = false;
    for (const r of open) {
      if (r.kind !== 'overwatch') continue;
      const at = requestTarget(s, r, time);
      if (!at || altitude > OVERWATCH_ALTITUDE || Math.hypot(at.x - heli.x, at.z - heli.z) > OVERWATCH_RANGE) continue;
      watching = true;
      const minute = Math.floor(time);
      if (this.reported.get(r.id) !== minute) {
        this.reported.set(r.id, minute);
        this.send({ type: 'overwatch', request: r.id });
      }
    }

    // The request taken on: under the clock, and a beam where it is.
    const tracked = open.find((r) => r.tracked);
    const at = tracked ? requestTarget(s, tracked, time) : null;
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
      const watch = tracked.kind === 'overwatch' && watching ? ' · <span class="watch">OVERWATCH</span>' : '';
      html = `<div class="what">▶ ${tracked.title}</div>
        <div class="meta">${describeNeed(tracked)} · ${Math.floor(tracked.progress)} of ${tracked.needed} · ${leftText} left</div>
        <div class="meta">${where}${watch}</div>`;
    }
    if (html !== this.lastHtml) {
      this.lastHtml = html;
      this.el.innerHTML = html;
      this.el.hidden = !html;
    }
    return watching;
  }
}
