// The AI pilots' helicopters, flying the trips the simulation plans: off a base pad, up to
// cruise, down at the landing zone, and home again.

import * as THREE from 'three';
import { Helicopter } from '../heli/Helicopter';
import { ARMY_BASE, districtCenter, DISTRICT_TEMPLATES } from '../sim/layout';
import type { CityState, Pilot } from '../sim/types';
import type { Helipad } from './City';

/** Cruise above the 470 m supertall so routes never pass through the skyline. */
const CRUISE = 520;
/** Share of a flight spent climbing out and descending in. */
const CLIMB = 0.18;

export interface AiMarker {
  x: number;
  z: number;
  yaw: number;
  name: string;
}

const smooth = (u: number) => u * u * (3 - 2 * u);
const clamp01 = (u: number) => Math.max(0, Math.min(1, u));

export class AiFleet {
  readonly group = new THREE.Group();
  /** Positions for the map. */
  markers: AiMarker[] = [];
  private helis = new Map<number, Helicopter>();

  constructor(private pads: Helipad[]) {}

  update(dt: number, state: CityState | null, time: number): void {
    this.markers = [];
    const flying = new Set<number>();
    for (const p of state?.pilots ?? []) {
      if (p.status !== 'flying' || !p.trip) continue;
      flying.add(p.id);
      let heli = this.helis.get(p.id);
      if (!heli) {
        heli = new Helicopter();
        // A searchlight per AI helicopter would cost a light each; they fly without.
        heli.object.remove(heli.searchlight, heli.searchlight.target);
        this.helis.set(p.id, heli);
        this.group.add(heli.object);
      }
      const pose = this.poseFor(p, time, this.home(p, state!));
      heli.pose(pose.x, pose.y, pose.z, pose.yaw, pose.noseDown, 0, dt);
      this.markers.push({ x: pose.x, z: pose.z, yaw: pose.yaw, name: p.name });
    }
    for (const [id, heli] of this.helis) {
      if (flying.has(id)) continue;
      this.group.remove(heli.object);
      this.helis.delete(id);
    }
  }

  private landingZone(p: Pilot, district: number): { x: number; z: number } {
    const tpl = DISTRICT_TEMPLATES[district];
    if (tpl.kind === 'airbase') {
      const pads = this.pads.filter((pad) => pad.name.startsWith(tpl.name) && !pad.name.endsWith('pad 1'));
      const pad = pads[p.id % pads.length] ?? this.pads[0];
      return { x: pad.x, z: pad.z };
    }
    // District centres are intersections; spread several helicopters along the street.
    const c = districtCenter(tpl.col, tpl.row);
    return { x: c.x + ((p.id % 3) - 1) * 22, z: c.z };
  }

  /** Home pads: Camp Ridgeway, or the airport once the JOC is there (never pad 1, the player's). */
  private home(p: Pilot, state: CityState): { x: number; z: number } {
    const name = state.flags.joc ? DISTRICT_TEMPLATES.find((d) => d.kind === 'airbase')!.name : ARMY_BASE.name;
    const pads = this.pads.filter((pad) => pad.name.startsWith(name) && !pad.name.endsWith('pad 1'));
    const pad = pads[p.id % pads.length] ?? this.pads[0];
    return { x: pad.x, z: pad.z };
  }

  private poseFor(p: Pilot, time: number, home: { x: number; z: number }) {
    const trip = p.trip!;
    const away = this.landingZone(p, trip.district);
    if (trip.phase === 'ground') {
      return { x: away.x, y: 0, z: away.z, yaw: Math.atan2(-(away.x - home.x), -(away.z - home.z)), noseDown: 0 };
    }
    const [from, to] = trip.phase === 'outbound' ? [home, away] : [away, home];
    const u = clamp01((time - trip.start) / Math.max(1e-6, trip.end - trip.start));
    const along = smooth(u);
    const height = CRUISE * Math.min(smooth(clamp01(u / CLIMB)), smooth(clamp01((1 - u) / CLIMB)));
    return {
      x: from.x + (to.x - from.x) * along,
      y: height,
      z: from.z + (to.z - from.z) * along,
      yaw: Math.atan2(-(to.x - from.x), -(to.z - from.z)),
      noseDown: u > CLIMB && u < 1 - CLIMB ? 0.15 : 0.04,
    };
  }
}
