// The local scene: zombies, civilians and soldiers on the streets around the helicopter.
// They are a window onto the city simulation. Every half second the number of each kind in
// each nearby district is reconciled with the simulation's numbers; in between they behave
// on their own: zombies shamble, chase and bite, civilians flee, soldiers hold sandbag posts
// and shoot. Low rotor noise draws the dead toward the helicopter.

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { DISTRICT_SIZE, DISTRICT_TEMPLATES, districtAt } from '../sim/layout';
import { makeRandom } from '../sim/rng';
import type { CityState, DistrictState } from '../sim/types';
import type { Effects } from './Effects';
import { nearestNode, neighbors, nodeX, nodeZ, NODES_X, NODES_Z, stepToward } from './streets';

const enum Kind {
  Zombie,
  Civilian,
  Soldier,
}

const enum Mode {
  Walk,
  Chase,
  Flee,
  Attracted,
  Feed,
  Post,
  Turning,
  Dead,
  /** Hanging off the helicopter's skids. */
  Grab,
}

interface Agent {
  kind: Kind;
  mode: Mode;
  district: number;
  x: number;
  z: number;
  heading: number;
  /** Target intersection and the previous one, for street walking. */
  ni: number;
  nj: number;
  pi: number;
  pj: number;
  /** Fixed offset across the road so a crowd doesn't walk in single file. */
  ox: number;
  oz: number;
  speed: number;
  phase: number;
  timer: number;
  cooldown: number;
  post: number;
}

/** Radius around the helicopter that is populated, and where agents are removed. */
export const ACTIVE_RADIUS = 380;
const DESPAWN_RADIUS = 470;
const RECONCILE_SECONDS = 0.5;
const SPAWNS_PER_RECONCILE = 40;
const CAPACITY = { [Kind.Zombie]: 700, [Kind.Civilian]: 320, [Kind.Soldier]: 120 } as const;

const ATTRACT_RANGE = 170;
const ATTRACT_ALTITUDE = 70;
const BITE_RANGE = 1.1;
const SIGHT_RANGE = 22;
const FLEE_RANGE = 26;
const SHOOT_RANGE = 75;
const CORPSE_SECONDS = 25;
const TURN_SECONDS = 6;
const GRID = 20;
const POSTS_PER_DISTRICT = 3;
/** Skids lower than this above the street can be grabbed; above SHAKE_OFF the dead let go. */
const GRAB_CLEARANCE = 4;
const SHAKE_OFF_CLEARANCE = 6;
const GRAB_RANGE = 3.5;
/** Zombies this close to a helicopter on the street stop people boarding. */
const DOOR_RANGE = 9;
const DOOR_GUN_RANGE = 70;
const DOOR_GUN_SHOTS_PER_TROOP = 0.8;
/** People are drawn larger than life so they read from the air. */
const FIGURE_SCALE = 1.35;

/** Zombies are shown one-for-one while few, then compressed so a horde stays drawable. */
function visibleZombies(z: number): number {
  return z <= 300 ? z : 300 + (z - 300) * 0.12;
}

function visibleCivilians(d: DistrictState, night: boolean): number {
  const base = Math.min(d.population / 100, 380);
  const indoors = d.status === 'overrun' ? 0.04 : night ? (d.power === 'dark' ? 0.3 : 0.55) : 1;
  return base * indoors;
}

export interface AttractInfo {
  active: boolean;
  district: number;
  /** Zombies currently heading for the helicopter. */
  drawn: number;
  /** Zombies at the doors of a helicopter on the street. */
  threat: number;
  /** Zombies hanging off the skids. */
  grabbers: number;
}

export class Agents {
  readonly group = new THREE.Group();
  readonly attract: AttractInfo = { active: false, district: -1, drawn: 0, threat: 0, grabbers: 0 };
  /** Height of the helicopter's skids above the street. */
  private clearance = 999;
  private heliY = 0;
  private doorGunTimer = 0;
  private agents: Agent[] = [];
  private rand: () => number;
  private reconcileTimer = 0;
  private posts: { x: number; z: number; district: number }[] = [];
  private postVisible: boolean[] = [];
  private sandbags: THREE.InstancedMesh;
  private bodies: THREE.InstancedMesh[] = [];
  private heads: THREE.InstancedMesh[] = [];
  /** Spatial hashes rebuilt each frame: living humans, and walking zombies. */
  private humans = new Map<number, Agent[]>();
  private zombies = new Map<number, Agent[]>();
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private e = new THREE.Euler();
  private v = new THREE.Vector3();
  private s = new THREE.Vector3(1, 1, 1);

  constructor(seed: number | string, private effects: Effects) {
    this.rand = makeRandom(`agents-${seed}`);
    this.buildPosts(seed);
    this.sandbags = this.buildSandbags();
    this.buildMeshes();
  }

  /**
   * @param altitude height above whatever is below (roof or street), for rotor noise
   * @param clearance height of the skids above the street, for grabbing and door threats
   */
  update(dt: number, heli: THREE.Vector3, altitude: number, rotor: number, state: CityState | null, night: number, clearance = altitude): void {
    const cx = heli.x;
    const cz = heli.z;
    this.clearance = clearance;
    this.heliY = heli.y;
    this.attract.threat = 0;
    this.attract.grabbers = 0;

    const attractActive = rotor > 0.6 && altitude < ATTRACT_ALTITUDE;
    this.attract.active = attractActive;
    this.attract.district = districtAt(cx, cz);
    this.attract.drawn = 0;

    this.reconcileTimer -= dt;
    if (state && this.reconcileTimer <= 0) {
      this.reconcileTimer = RECONCILE_SECONDS;
      this.reconcile(state, cx, cz, night > 0.5);
    }

    this.rebuildGrid();
    for (const a of this.agents) {
      switch (a.kind) {
        case Kind.Zombie:
          this.updateZombie(a, dt, cx, cz, attractActive);
          break;
        case Kind.Civilian:
          this.updateCivilian(a, dt);
          break;
        case Kind.Soldier:
          this.updateSoldier(a, dt);
          break;
      }
    }

    // Bitten civilians rise as zombies; corpses and far-away agents go.
    const out: Agent[] = [];
    for (const a of this.agents) {
      if (a.mode === Mode.Turning && a.timer <= 0) {
        a.kind = Kind.Zombie;
        a.mode = Mode.Walk;
        a.speed = 0.8 + this.rand() * 0.5;
        this.retarget(a);
      }
      if (a.mode === Mode.Dead && a.timer <= 0) continue;
      if (Math.hypot(a.x - cx, a.z - cz) > DESPAWN_RADIUS) continue;
      out.push(a);
    }
    this.agents = out;

    this.render();
  }

  // --- Reconciliation with the simulation -----------------------------------------------

  private reconcile(state: CityState, cx: number, cz: number, night: boolean): void {
    const share = this.areaShare(cx, cz);
    const counts = new Map<string, Agent[]>();
    for (const a of this.agents) {
      if (a.mode === Mode.Dead || a.mode === Mode.Turning) continue;
      const key = `${a.kind}-${a.district}`;
      const list = counts.get(key);
      if (list) list.push(a);
      else counts.set(key, [a]);
    }

    // Posts are manned while the district has troops and hasn't fallen.
    this.posts.forEach((p, i) => {
      const d = state.districts[p.district];
      this.postVisible[i] = d.troops.strength >= 1 && d.status !== 'overrun';
    });
    this.updateSandbags();

    const targets: [Kind, number, number][] = [];
    for (const [district, frac] of share) {
      const d = state.districts[district];
      targets.push([Kind.Zombie, district, visibleZombies(d.zombies) * frac]);
      targets.push([Kind.Civilian, district, visibleCivilians(d, night) * frac]);
      const postsInRange = this.posts.filter((p, i) => p.district === district && this.postVisible[i] && Math.hypot(p.x - cx, p.z - cz) < ACTIVE_RADIUS).length;
      targets.push([Kind.Soldier, district, (Math.min(d.troops.strength, 36) / POSTS_PER_DISTRICT) * postsInRange]);
    }

    // Respect overall capacity.
    for (const kind of [Kind.Zombie, Kind.Civilian, Kind.Soldier]) {
      const total = targets.filter((t) => t[0] === kind).reduce((s, t) => s + t[2], 0);
      if (total > CAPACITY[kind]) for (const t of targets) if (t[0] === kind) t[2] *= CAPACITY[kind] / total;
    }

    // Each kind gets its own spawn budget so a big crowd can't starve the soldiers.
    const budget = [SPAWNS_PER_RECONCILE, SPAWNS_PER_RECONCILE, SPAWNS_PER_RECONCILE];
    for (const [kind, district, want] of targets) {
      const have = counts.get(`${kind}-${district}`) ?? [];
      const target = Math.round(want);
      if (have.length > target) {
        // Remove the furthest first, they are least likely to be watched.
        have.sort((a, b) => Math.hypot(b.x - cx, b.z - cz) - Math.hypot(a.x - cx, a.z - cz));
        const remove = new Set(have.slice(0, have.length - target));
        this.agents = this.agents.filter((a) => !remove.has(a));
      } else {
        for (let n = have.length; n < target && budget[kind] > 0; n++, budget[kind]--) {
          const a = kind === Kind.Soldier ? this.spawnSoldier(district, cx, cz, have) : this.spawnWalker(kind, district, cx, cz);
          if (a) {
            this.agents.push(a);
            have.push(a);
          }
        }
      }
    }
    // Districts out of range keep nothing.
    this.agents = this.agents.filter((a) => a.mode === Mode.Dead || share.has(a.district));
  }

  /** Fraction of each district's area inside the active circle, by sampling. */
  private areaShare(cx: number, cz: number): Map<number, number> {
    const samples = 16;
    const step = (ACTIVE_RADIUS * 2) / samples;
    const cell = step * step;
    const out = new Map<number, number>();
    for (let i = 0; i < samples; i++) {
      for (let j = 0; j < samples; j++) {
        const x = cx - ACTIVE_RADIUS + (i + 0.5) * step;
        const z = cz - ACTIVE_RADIUS + (j + 0.5) * step;
        if (Math.hypot(x - cx, z - cz) > ACTIVE_RADIUS) continue;
        const d = districtAt(x, z);
        if (d < 0) continue;
        out.set(d, (out.get(d) ?? 0) + cell / (DISTRICT_SIZE * DISTRICT_SIZE));
      }
    }
    return out;
  }

  private spawnWalker(kind: Kind, district: number, cx: number, cz: number): Agent | null {
    for (let attempt = 0; attempt < 20; attempt++) {
      const r = ACTIVE_RADIUS * Math.sqrt(this.rand());
      const ang = this.rand() * Math.PI * 2;
      const [i, j] = nearestNode(cx + Math.cos(ang) * r, cz + Math.sin(ang) * r);
      const options = neighbors(i, j);
      const [ni, nj] = options[Math.floor(this.rand() * options.length)];
      const t = this.rand();
      const x = nodeX(i) + (nodeX(ni) - nodeX(i)) * t;
      const z = nodeZ(j) + (nodeZ(nj) - nodeZ(j)) * t;
      if (districtAt(x, z) !== district || Math.hypot(x - cx, z - cz) > ACTIVE_RADIUS) continue;
      const zombie = kind === Kind.Zombie;
      return {
        kind,
        mode: Mode.Walk,
        district,
        x,
        z,
        heading: 0,
        ni,
        nj,
        pi: i,
        pj: j,
        ox: (this.rand() - 0.5) * 9,
        oz: (this.rand() - 0.5) * 9,
        speed: zombie ? 0.8 + this.rand() * 0.5 : 1.2 + this.rand() * 0.5,
        phase: this.rand() * 10,
        timer: 0,
        cooldown: 0,
        post: -1,
      };
    }
    return null;
  }

  private spawnSoldier(district: number, cx: number, cz: number, have: Agent[]): Agent | null {
    const posts = this.posts
      .map((p, i) => ({ p, i }))
      .filter(({ p, i }) => p.district === district && this.postVisible[i] && Math.hypot(p.x - cx, p.z - cz) < ACTIVE_RADIUS);
    if (!posts.length) return null;
    // Fill the emptiest post.
    posts.sort((a, b) => have.filter((s) => s.post === a.i).length - have.filter((s) => s.post === b.i).length);
    const { p, i } = posts[0];
    const ang = this.rand() * Math.PI * 2;
    const r = 1 + this.rand() * 4;
    return {
      kind: Kind.Soldier, mode: Mode.Post, district,
      x: p.x + Math.cos(ang) * r, z: p.z + Math.sin(ang) * r, heading: ang,
      ni: 0, nj: 0, pi: 0, pj: 0, ox: 0, oz: 0, speed: 0,
      phase: 0, timer: 0, cooldown: this.rand() * 2, post: i,
    };
  }

  // --- Behaviour ------------------------------------------------------------------------

  private rebuildGrid(): void {
    this.humans.clear();
    this.zombies.clear();
    for (const a of this.agents) {
      if (a.mode === Mode.Dead || a.mode === Mode.Turning) continue;
      const grid = a.kind === Kind.Zombie ? this.zombies : this.humans;
      const k = gridKey(a.x, a.z);
      const list = grid.get(k);
      if (list) list.push(a);
      else grid.set(k, [a]);
    }
  }

  /** Nearest agent in a spatial hash within range of a. */
  private nearest(grid: Map<number, Agent[]>, a: Agent, range: number): Agent | null {
    let best: Agent | null = null;
    let bestD = range;
    const r = Math.ceil(range / GRID);
    const gx = Math.floor(a.x / GRID);
    const gz = Math.floor(a.z / GRID);
    for (let i = -r; i <= r; i++) {
      for (let j = -r; j <= r; j++) {
        for (const b of grid.get(cellKey(gx + i, gz + j)) ?? []) {
          if (b.mode === Mode.Dead || b.mode === Mode.Turning) continue;
          const d = Math.hypot(b.x - a.x, b.z - a.z);
          if (d < bestD) {
            bestD = d;
            best = b;
          }
        }
      }
    }
    return best;
  }

  private updateZombie(a: Agent, dt: number, hx: number, hz: number, attract: boolean): void {
    a.timer -= dt;
    if (a.mode === Mode.Dead) return;

    const toHeli = Math.hypot(hx - a.x, hz - a.z);
    if (a.mode === Mode.Grab) {
      if (this.clearance > SHAKE_OFF_CLEARANCE) {
        // Shaken off as the helicopter climbs.
        a.mode = Mode.Walk;
        this.retarget(a);
      } else {
        a.x = hx + a.ox;
        a.z = hz + a.oz;
        a.heading = Math.atan2(a.ox, a.oz);
        this.attract.grabbers++;
        return;
      }
    }
    if (this.clearance < SHAKE_OFF_CLEARANCE && toHeli < DOOR_RANGE) this.attract.threat++;
    if (this.clearance < GRAB_CLEARANCE && toHeli < GRAB_RANGE) {
      const ang = this.rand() * Math.PI * 2;
      a.mode = Mode.Grab;
      a.ox = Math.cos(ang) * 1.9;
      a.oz = Math.sin(ang) * 2.6;
      return;
    }
    if (a.mode === Mode.Feed) {
      if (a.timer <= 0) {
        a.mode = Mode.Walk;
        this.retarget(a);
      }
      return;
    }

    const prey = this.nearest(this.humans, a, SIGHT_RANGE);
    if (prey) {
      a.mode = Mode.Chase;
      const d = Math.hypot(prey.x - a.x, prey.z - a.z);
      if (d < BITE_RANGE && prey.kind === Kind.Civilian) {
        prey.mode = Mode.Turning;
        prey.timer = TURN_SECONDS;
        a.mode = Mode.Feed;
        a.timer = 2.5;
        return;
      }
      this.moveToward(a, prey.x, prey.z, a.speed * 2.2, dt);
      return;
    }

    if (attract && Math.hypot(hx - a.x, hz - a.z) < ATTRACT_RANGE) {
      this.attract.drawn++;
      if (a.mode !== Mode.Attracted) {
        a.mode = Mode.Attracted;
        this.retarget(a);
      }
      // Close in: walk straight for the noise; further out, follow the streets toward it.
      if (Math.hypot(hx - a.x, hz - a.z) < 60) {
        if (Math.hypot(hx - a.x, hz - a.z) > 4) this.moveToward(a, hx, hz, a.speed * 1.8, dt);
        return;
      }
      if (this.walkStreets(a, a.speed * 1.8, dt)) [a.ni, a.nj] = stepToward(a.ni, a.nj, hx, hz);
      return;
    }

    if (a.mode !== Mode.Walk) {
      a.mode = Mode.Walk;
      this.retarget(a);
    }
    if (this.walkStreets(a, a.speed, dt)) this.wander(a);
  }

  private updateCivilian(a: Agent, dt: number): void {
    a.timer -= dt;
    if (a.mode === Mode.Turning || a.mode === Mode.Dead) return;
    const threat = this.nearest(this.zombies, a, FLEE_RANGE);
    if (threat) {
      if (a.mode !== Mode.Flee) {
        a.mode = Mode.Flee;
        this.retarget(a);
        [a.ni, a.nj] = stepToward(a.pi, a.pj, threat.x, threat.z, true);
      }
      if (this.walkStreets(a, 4.2, dt)) [a.ni, a.nj] = stepToward(a.ni, a.nj, threat.x, threat.z, true);
      return;
    }
    if (a.mode === Mode.Flee) a.mode = Mode.Walk;
    if (this.walkStreets(a, a.speed, dt)) this.wander(a);
  }

  private updateSoldier(a: Agent, dt: number): void {
    a.cooldown -= dt;
    if (a.cooldown > 0) return;
    const target = this.nearest(this.zombies, a, SHOOT_RANGE);
    if (!target) {
      a.cooldown = 0.5;
      return;
    }
    a.heading = Math.atan2(-(target.x - a.x), -(target.z - a.z));
    a.cooldown = 0.5 + this.rand() * 1.2;
    const hit = this.rand() < 0.3;
    const miss = hit ? 0 : 3;
    this.effects.tracer(
      a.x - Math.sin(a.heading) * 0.8, 1.35, a.z - Math.cos(a.heading) * 0.8,
      target.x + (this.rand() - 0.5) * miss, 1.0 + this.rand() * 0.8, target.z + (this.rand() - 0.5) * miss,
    );
    if (hit) {
      target.mode = Mode.Dead;
      target.timer = CORPSE_SECONDS;
    }
  }

  /**
   * Troops aboard fire from the doors at zombies near a low helicopter.
   * @param troops soldiers aboard
   */
  doorGunners(dt: number, heli: THREE.Vector3, troops: number): number {
    if (troops < 1 || this.clearance > 12) {
      this.doorGunTimer = 0;
      return 0;
    }
    this.doorGunTimer += dt;
    const interval = 1 / (troops * DOOR_GUN_SHOTS_PER_TROOP);
    let kills = 0;
    const origin = { x: heli.x, z: heli.z } as Agent;
    while (this.doorGunTimer >= interval) {
      this.doorGunTimer -= interval;
      const target = this.nearest(this.zombies, origin, DOOR_GUN_RANGE);
      if (!target) {
        this.doorGunTimer = 0;
        break;
      }
      const side = this.rand() < 0.5 ? -1.4 : 1.4;
      const hit = this.rand() < 0.4;
      const miss = hit ? 0 : 3;
      this.effects.tracer(
        heli.x + side, this.heliY - 0.4, heli.z,
        target.x + (this.rand() - 0.5) * miss, 1 + this.rand() * 0.8, target.z + (this.rand() - 0.5) * miss,
      );
      if (hit) {
        target.mode = Mode.Dead;
        target.timer = CORPSE_SECONDS;
        kills++;
      }
    }
    return kills;
  }

  /** Walk toward the current target intersection. Returns true on arrival. */
  private walkStreets(a: Agent, speed: number, dt: number): boolean {
    const tx = nodeX(a.ni) + a.ox;
    const tz = nodeZ(a.nj) + a.oz;
    if (Math.hypot(tx - a.x, tz - a.z) < 1) return true;
    this.moveToward(a, tx, tz, speed, dt);
    return false;
  }

  private moveToward(a: Agent, tx: number, tz: number, speed: number, dt: number): void {
    const dx = tx - a.x;
    const dz = tz - a.z;
    const d = Math.hypot(dx, dz);
    if (d < 1e-3) return;
    const stepLen = Math.min(d, speed * dt);
    a.x += (dx / d) * stepLen;
    a.z += (dz / d) * stepLen;
    a.heading = Math.atan2(-dx, -dz);
    a.phase += stepLen * 2.2;
    const district = districtAt(a.x, a.z);
    if (district >= 0) a.district = district;
  }

  /** Pick a new random street to walk, avoiding an immediate U-turn. */
  private wander(a: Agent): void {
    const options = neighbors(a.ni, a.nj).filter(([i, j]) => i !== a.pi || j !== a.pj);
    const [ni, nj] = options[Math.floor(this.rand() * options.length)] ?? [a.pi, a.pj];
    a.pi = a.ni;
    a.pj = a.nj;
    a.ni = ni;
    a.nj = nj;
  }

  /** Rejoin the street grid at the nearest intersection. */
  private retarget(a: Agent): void {
    const [i, j] = nearestNode(a.x, a.z);
    a.pi = i;
    a.pj = j;
    a.ni = i;
    a.nj = j;
  }

  // --- Posts ----------------------------------------------------------------------------

  private buildPosts(seed: number | string): void {
    DISTRICT_TEMPLATES.forEach((tpl, district) => {
      const rand = makeRandom(`posts-${seed}-${district}`);
      for (let k = 0; k < POSTS_PER_DISTRICT; k++) {
        const i = Math.min(NODES_X - 1, tpl.col * 8 + 2 + Math.floor(rand() * 5));
        const j = Math.min(NODES_Z - 1, tpl.row * 8 + 2 + Math.floor(rand() * 5));
        this.posts.push({ x: nodeX(i), z: nodeZ(j), district });
        this.postVisible.push(true);
      }
    });
  }

  private buildSandbags(): THREE.InstancedMesh {
    const geo = new THREE.BoxGeometry(2.4, 1.0, 0.9);
    geo.translate(0, 0.5, 0);
    const mesh = new THREE.InstancedMesh(geo, new THREE.MeshLambertMaterial({ color: 0x8b7d5a }), this.posts.length * 8);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    this.group.add(mesh);
    return mesh;
  }

  private updateSandbags(): void {
    let n = 0;
    this.posts.forEach((p, i) => {
      if (!this.postVisible[i]) return;
      for (let k = 0; k < 8; k++) {
        const ang = (k / 8) * Math.PI * 2;
        this.q.setFromAxisAngle(this.v.set(0, 1, 0), -ang);
        this.m.compose(this.v.set(p.x + Math.cos(ang) * 6.5, 0, p.z + Math.sin(ang) * 6.5), this.q, this.s.set(1, 1, 1));
        this.sandbags.setMatrixAt(n++, this.m);
      }
    });
    this.sandbags.count = n;
    this.sandbags.instanceMatrix.needsUpdate = true;
  }

  // --- Rendering ------------------------------------------------------------------------

  private buildMeshes(): void {
    const box = (w: number, h: number, d: number, x: number, y: number, z: number) => {
      const g = new THREE.BoxGeometry(w, h, d);
      g.translate(x, y, z);
      return g;
    };
    const legs = box(0.42, 0.85, 0.22, 0, 0.425, 0);
    const torso = box(0.5, 0.65, 0.28, 0, 1.17, 0);
    const armsDown = [box(0.13, 0.62, 0.13, -0.33, 1.13, 0), box(0.13, 0.62, 0.13, 0.33, 1.13, 0)];
    const armsForward = [box(0.13, 0.13, 0.62, -0.24, 1.38, -0.32), box(0.13, 0.13, 0.62, 0.24, 1.38, -0.32)];
    const rifle = box(0.08, 0.1, 0.9, 0.12, 1.3, -0.4);

    const bodyGeo = {
      [Kind.Zombie]: mergeGeometries([legs, torso, ...armsForward]),
      [Kind.Civilian]: mergeGeometries([legs, torso, ...armsDown]),
      [Kind.Soldier]: mergeGeometries([legs, torso, ...armsForward, rifle]),
    };
    const headGeo = {
      [Kind.Zombie]: box(0.25, 0.27, 0.25, 0, 1.64, 0),
      [Kind.Civilian]: box(0.25, 0.27, 0.25, 0, 1.64, 0),
      [Kind.Soldier]: box(0.32, 0.22, 0.32, 0, 1.7, 0),
    };
    const zombieClothes = [0x4d4a3e, 0x3e4a52, 0x5a3d34, 0x45473f, 0x5b5546];
    const civilianClothes = [0x2f5f9a, 0xa83a32, 0xd8c9a8, 0x3d6b45, 0x7a4f8c, 0xc98f2b, 0x2c2c2c, 0xe0e0dc];
    const skins = [0xe0b48f, 0xb98563, 0x8d5a3b, 0xf1c9a5];

    for (const kind of [Kind.Zombie, Kind.Civilian, Kind.Soldier]) {
      const capacity = CAPACITY[kind];
      const body = new THREE.InstancedMesh(bodyGeo[kind], new THREE.MeshLambertMaterial(), capacity);
      const head = new THREE.InstancedMesh(headGeo[kind], new THREE.MeshLambertMaterial(), capacity);
      const c = new THREE.Color();
      for (let i = 0; i < capacity; i++) {
        if (kind === Kind.Zombie) {
          body.setColorAt(i, c.setHex(zombieClothes[i % zombieClothes.length]));
          head.setColorAt(i, c.setHex(0x7f9470).offsetHSL(0, 0, (Math.sin(i * 12.9) * 0.5) * 0.08));
        } else if (kind === Kind.Civilian) {
          body.setColorAt(i, c.setHex(civilianClothes[(i * 7) % civilianClothes.length]));
          head.setColorAt(i, c.setHex(skins[(i * 3) % skins.length]));
        } else {
          body.setColorAt(i, c.setHex(0x4b5a32));
          head.setColorAt(i, c.setHex(0x3a4428));
        }
      }
      for (const mesh of [body, head]) {
        mesh.count = 0;
        mesh.frustumCulled = false;
        mesh.castShadow = true;
        this.group.add(mesh);
      }
      this.bodies[kind] = body;
      this.heads[kind] = head;
    }
  }

  private render(): void {
    const counts = [0, 0, 0];
    for (const a of this.agents) {
      const kind = a.kind;
      const i = counts[kind]++;
      if (i >= CAPACITY[kind]) continue;
      const lying = a.mode === Mode.Dead || a.mode === Mode.Turning;
      const moving = a.mode !== Mode.Post && a.mode !== Mode.Feed && !lying;
      const bob = moving ? Math.abs(Math.sin(a.phase)) * 0.08 : 0;
      const zombie = kind === Kind.Zombie;
      const sway = zombie && moving ? Math.sin(a.phase * 0.5) * 0.14 : 0;
      const lean = a.mode === Mode.Grab ? -0.35 : zombie && !lying ? 0.18 : a.mode === Mode.Flee ? 0.25 : a.mode === Mode.Feed ? 0.9 : 0;
      this.e.set(lying ? -Math.PI / 2 : -lean, a.heading, sway, 'YXZ');
      this.q.setFromEuler(this.e);
      this.m.compose(this.v.set(a.x, lying ? 0.2 : bob, a.z), this.q, this.s.setScalar(FIGURE_SCALE));
      this.bodies[kind].setMatrixAt(i, this.m);
      this.heads[kind].setMatrixAt(i, this.m);
    }
    for (const kind of [Kind.Zombie, Kind.Civilian, Kind.Soldier]) {
      const n = Math.min(counts[kind], CAPACITY[kind]);
      for (const mesh of [this.bodies[kind], this.heads[kind]]) {
        mesh.count = n;
        mesh.instanceMatrix.needsUpdate = true;
      }
    }
  }

  /** Counts of living agents on screen, for the HUD and tests. */
  census(): { zombies: number; civilians: number; soldiers: number } {
    const live = (k: Kind) => this.agents.filter((a) => a.kind === k && a.mode !== Mode.Dead && a.mode !== Mode.Turning).length;
    return { zombies: live(Kind.Zombie), civilians: live(Kind.Civilian), soldiers: live(Kind.Soldier) };
  }
}

const cellKey = (gx: number, gz: number) => (gx + 1000) * 4096 + (gz + 1000);
const gridKey = (x: number, z: number) => cellKey(Math.floor(x / GRID), Math.floor(z / GRID));
