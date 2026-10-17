// The local scene: the people on the streets around the helicopter, and the dead. Civilians and
// soldiers live here as a few hundred objects; zombies, which can number in the thousands, live
// in the Crowd (typed arrays and a GPU-posed mesh). Every half second both are reconciled with
// the simulation's numbers; in between they behave on their own: zombies shamble, follow their
// hordes, chase and bite; civilians flee; soldiers hold sandbag posts and shoot. Low rotor noise
// draws the dead toward the helicopter.

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { DISTRICT_SIZE, DISTRICT_TEMPLATES, districtAt } from '../sim/layout';
import { makeRandom } from '../sim/rng';
import { planSites } from '../sim/sites';
import { BLOCKS_PER_DISTRICT, nearestNode, neighbors, nodeX, nodeZ, NODES_X, NODES_Z, stepToward } from '../sim/streets';
import type { CityState, DistrictState } from '../sim/types';
import type { WalkGrid } from './City';
import { Crowd, RESIDENT_RADIUS, type HumanRef } from './Crowd';
import type { Effects } from './Effects';

const enum Kind {
  Civilian,
  Soldier,
  /** Patrol officers with pistols. */
  Police,
  /** Riot police with shields and batons. */
  Riot,
}

const KINDS = [Kind.Civilian, Kind.Soldier, Kind.Police, Kind.Riot];

const enum Mode {
  Walk,
  Flee,
  Post,
  Turning,
}

interface Person extends HumanRef {
  kind: Kind;
  mode: Mode;
  district: number;
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
  /** Clothes and skin, fixed for life so the figure keeps its colours. */
  look: number;
}

const CLOTHES = [0x2f5f9a, 0xa83a32, 0xd8c9a8, 0x3d6b45, 0x7a4f8c, 0xc98f2b, 0x2c2c2c, 0xe0e0dc];
const SKINS = [0xe0b48f, 0xb98563, 0x8d5a3b, 0xf1c9a5];

/** Radius around the helicopter that is populated with residents and people. */
export const ACTIVE_RADIUS = RESIDENT_RADIUS;
const DESPAWN_RADIUS = 470;
const RECONCILE_SECONDS = 0.5;
const SPAWNS_PER_RECONCILE = 40;
const CAPACITY = { [Kind.Civilian]: 320, [Kind.Soldier]: 120, [Kind.Police]: 80, [Kind.Riot]: 60 } as const;
/** Police on the street at most per district in view (the rest are elsewhere in the district). */
const POLICE_VISIBLE = 30;
const RIOT_VISIBLE = 20;
const PISTOL_RANGE = 45;
const BATON_RANGE = 2.2;
const RIOT_ADVANCE = 30;

const ATTRACT_ALTITUDE = 70;
const FLEE_RANGE = 26;
const SHOOT_RANGE = 75;
const TURN_SECONDS = 6;
const GRID = 20;
const POSTS_PER_DISTRICT = 3;
const DOOR_GUN_RANGE = 70;
const DOOR_GUN_SHOTS_PER_TROOP = 0.8;

/** Roughly 4% of a district's people are out on the streets by day. */
function visibleCivilians(d: DistrictState, night: boolean): number {
  const base = Math.min(d.population * 0.04, 1600);
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
  readonly crowd: Crowd;
  /** Height of the helicopter's skids above the street. */
  private clearance = 999;
  private heliY = 0;
  private doorGunTimer = 0;
  private people: Person[] = [];
  private rand: () => number;
  private reconcileTimer = 0;
  /** Street posts, and posts at strategic sites (`site` set; their sandbags are drawn by Sites). */
  private posts: { x: number; z: number; district: number; site?: number }[] = [];
  private postSoldiers: number[] = [];
  private postVisible: boolean[] = [];
  private sandbags: THREE.InstancedMesh;
  private bodies: THREE.InstancedMesh[] = [];
  private heads: THREE.InstancedMesh[] = [];
  /** Spatial hash of living people, rebuilt each frame. */
  private humans = new Map<number, Person[]>();
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private e = new THREE.Euler();
  private v = new THREE.Vector3();
  private s = new THREE.Vector3(1, 1, 1);
  private c = new THREE.Color();

  constructor(seed: number | string, private effects: Effects, walk: WalkGrid | null = null) {
    this.rand = makeRandom(`agents-${seed}`);
    this.crowd = new Crowd(walk, makeRandom(`crowd-${seed}`));
    this.group.add(this.crowd.mesh);
    this.buildPosts(seed);
    this.sandbags = this.buildSandbags();
    this.buildMeshes();
  }

  /**
   * @param altitude height above whatever is below (roof or street), for rotor noise
   * @param clearance height of the skids above the street, for grabbing and door threats
   * @param time smooth game time, to move hordes between simulation ticks
   */
  update(
    dt: number, heli: THREE.Vector3, altitude: number, rotor: number, state: CityState | null, night: number,
    clearance = altitude, time = state?.t ?? 0,
  ): void {
    const cx = heli.x;
    const cz = heli.z;
    this.clearance = clearance;
    this.heliY = heli.y;
    const attract = rotor > 0.6 && altitude < ATTRACT_ALTITUDE;
    this.attract.active = attract;
    this.attract.district = districtAt(cx, cz);

    this.reconcileTimer -= dt;
    if (state && this.reconcileTimer <= 0) {
      this.reconcileTimer = RECONCILE_SECONDS;
      const share = this.areaShare(cx, cz);
      this.reconcile(state, cx, cz, night > 0.5, share);
      this.crowd.reconcile(state, cx, cz, share);
    }

    this.rebuildGrid();
    this.crowd.update({
      dt, heliX: cx, heliZ: cz, clearance, attract,
      nearestHuman: (x, z, range) => this.nearestHuman(x, z, range),
      bite: (h) => {
        const p = h as Person;
        if (p.mode === Mode.Turning || p.kind !== Kind.Civilian) return;
        p.mode = Mode.Turning;
        p.timer = TURN_SECONDS;
      },
    }, time);
    this.attract.drawn = this.crowd.drawn;
    this.attract.threat = this.crowd.threat;
    this.attract.grabbers = this.crowd.grabbers;

    for (const p of this.people) {
      if (p.kind === Kind.Civilian) this.updateCivilian(p, dt);
      else if (p.kind === Kind.Soldier) this.updateSoldier(p, dt);
      else if (p.kind === Kind.Police) this.updateOfficer(p, dt);
      else this.updateRiot(p, dt);
    }

    // Bitten civilians rise as zombies; far-away people go.
    this.people = this.people.filter((p) => {
      if (p.mode === Mode.Turning && p.timer <= 0) {
        this.crowd.spawnResident(p.x, p.z);
        return false;
      }
      return Math.hypot(p.x - cx, p.z - cz) <= DESPAWN_RADIUS;
    });

    this.render();
  }

  // --- Reconciliation with the simulation -----------------------------------------------

  private reconcile(state: CityState, cx: number, cz: number, night: boolean, share: Map<number, number>): void {
    const counts = new Map<string, Person[]>();
    for (const p of this.people) {
      if (p.mode === Mode.Turning) continue;
      const key = `${p.kind}-${p.district}`;
      const list = counts.get(key);
      if (list) list.push(p);
      else counts.set(key, [p]);
    }

    // Street posts are manned while the district has troops and hasn't fallen; site posts while the
    // site holds and has guards.
    const sites = new Map(state.sites.map((x) => [x.id, x]));
    this.posts.forEach((p, i) => {
      const d = state.districts[p.district];
      if (p.site !== undefined) {
        const site = sites.get(p.site);
        const guards = site && site.status !== 'fallen' ? site.guards : 0;
        this.postVisible[i] = guards >= 1;
        this.postSoldiers[i] = Math.min(8, guards);
        return;
      }
      this.postVisible[i] = d.troops.strength >= 1 && d.status !== 'overrun';
      const posted = state.sites.reduce((n, x) => n + (x.district === d.id ? x.guards : 0), 0);
      this.postSoldiers[i] = Math.min(Math.max(0, d.troops.strength - posted), 36) / POSTS_PER_DISTRICT;
    });
    this.updateSandbags();

    const targets: [Kind, number, number][] = [];
    for (const [district, frac] of share) {
      const d = state.districts[district];
      targets.push([Kind.Civilian, district, visibleCivilians(d, night) * frac]);
      let soldiers = 0;
      this.posts.forEach((p, i) => {
        if (p.district === district && this.postVisible[i] && Math.hypot(p.x - cx, p.z - cz) < ACTIVE_RADIUS) soldiers += this.postSoldiers[i];
      });
      targets.push([Kind.Soldier, district, soldiers]);
      if (d.status !== 'overrun') {
        targets.push([Kind.Police, district, Math.min(d.police.officers * frac, POLICE_VISIBLE)]);
        targets.push([Kind.Riot, district, Math.min(d.police.riot * frac, RIOT_VISIBLE)]);
      }
    }

    // Respect overall capacity.
    for (const kind of KINDS) {
      const total = targets.filter((t) => t[0] === kind).reduce((s, t) => s + t[2], 0);
      if (total > CAPACITY[kind]) for (const t of targets) if (t[0] === kind) t[2] *= CAPACITY[kind] / total;
    }

    // Each kind gets its own spawn budget so a big crowd can't starve the soldiers.
    const budget = KINDS.map(() => SPAWNS_PER_RECONCILE);
    for (const [kind, district, want] of targets) {
      const have = counts.get(`${kind}-${district}`) ?? [];
      const target = Math.round(want);
      if (have.length > target) {
        // Remove the furthest first, they are least likely to be watched.
        have.sort((a, b) => Math.hypot(b.x - cx, b.z - cz) - Math.hypot(a.x - cx, a.z - cz));
        const remove = new Set(have.slice(0, have.length - target));
        this.people = this.people.filter((p) => !remove.has(p));
      } else {
        for (let n = have.length; n < target && budget[kind] > 0; n++, budget[kind]--) {
          const p = kind === Kind.Soldier ? this.spawnSoldier(district, cx, cz, have) : this.spawnCivilian(district, cx, cz, kind);
          if (p) {
            this.people.push(p);
            have.push(p);
          }
        }
      }
    }
    // Districts out of range keep nobody.
    this.people = this.people.filter((p) => share.has(p.district));
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

  /** Someone walking the streets: a civilian, or a police patrol. */
  private spawnCivilian(district: number, cx: number, cz: number, kind = Kind.Civilian): Person | null {
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
      return {
        kind, civilian: kind === Kind.Civilian, mode: Mode.Walk, district, x, z, heading: 0,
        ni, nj, pi: i, pj: j,
        ox: (this.rand() - 0.5) * 16, oz: (this.rand() - 0.5) * 16,
        speed: 1.2 + this.rand() * 0.5, phase: this.rand() * 10, timer: 0, cooldown: 0, post: -1,
        look: Math.floor(this.rand() * 1024),
      };
    }
    return null;
  }

  private spawnSoldier(district: number, cx: number, cz: number, have: Person[]): Person | null {
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
      kind: Kind.Soldier, civilian: false, mode: Mode.Post, district,
      x: p.x + Math.cos(ang) * r, z: p.z + Math.sin(ang) * r, heading: ang,
      ni: 0, nj: 0, pi: 0, pj: 0, ox: 0, oz: 0, speed: 0,
      phase: 0, timer: 0, cooldown: this.rand() * 2, post: i, look: 0,
    };
  }

  // --- Behaviour ------------------------------------------------------------------------

  private rebuildGrid(): void {
    this.humans.clear();
    for (const p of this.people) {
      if (p.mode === Mode.Turning) continue;
      const k = gridKey(p.x, p.z);
      const list = this.humans.get(k);
      if (list) list.push(p);
      else this.humans.set(k, [p]);
    }
  }

  private nearestHuman(x: number, z: number, range: number): Person | null {
    let best: Person | null = null;
    let bestD = range;
    const r = Math.ceil(range / GRID);
    const gx = Math.floor(x / GRID);
    const gz = Math.floor(z / GRID);
    for (let i = -r; i <= r; i++) {
      for (let j = -r; j <= r; j++) {
        for (const p of this.humans.get(cellKey(gx + i, gz + j)) ?? []) {
          if (p.mode === Mode.Turning) continue;
          const d = Math.hypot(p.x - x, p.z - z);
          if (d < bestD) {
            bestD = d;
            best = p;
          }
        }
      }
    }
    return best;
  }

  private updateCivilian(p: Person, dt: number): void {
    p.timer -= dt;
    if (p.mode === Mode.Turning) return;
    const threat = this.crowd.nearest(p.x, p.z, FLEE_RANGE);
    if (threat >= 0) {
      const tx = this.crowd.posX(threat);
      const tz = this.crowd.posZ(threat);
      if (p.mode !== Mode.Flee) {
        p.mode = Mode.Flee;
        this.retarget(p);
        [p.ni, p.nj] = stepToward(p.pi, p.pj, tx, tz, true);
      }
      if (this.walkStreets(p, 4.2, dt)) [p.ni, p.nj] = stepToward(p.ni, p.nj, tx, tz, true);
      return;
    }
    if (p.mode === Mode.Flee) p.mode = Mode.Walk;
    if (this.walkStreets(p, p.speed, dt)) this.wander(p);
  }

  private updateSoldier(p: Person, dt: number): void {
    p.cooldown -= dt;
    if (p.cooldown > 0) return;
    const target = this.crowd.nearest(p.x, p.z, SHOOT_RANGE);
    if (target < 0) {
      p.cooldown = 0.5;
      return;
    }
    const tx = this.crowd.posX(target);
    const tz = this.crowd.posZ(target);
    p.heading = Math.atan2(-(tx - p.x), -(tz - p.z));
    p.cooldown = 0.5 + this.rand() * 1.2;
    const hit = this.rand() < 0.3;
    const miss = hit ? 0 : 3;
    this.effects.tracer(
      p.x - Math.sin(p.heading) * 0.8, 1.35, p.z - Math.cos(p.heading) * 0.8,
      tx + (this.rand() - 0.5) * miss, 1.0 + this.rand() * 0.8, tz + (this.rand() - 0.5) * miss,
    );
    if (hit) this.crowd.kill(target);
  }

  /** Patrol officers walk their beat and stop to fire their pistols at the dead nearby. */
  private updateOfficer(p: Person, dt: number): void {
    p.cooldown -= dt;
    const target = this.crowd.nearest(p.x, p.z, PISTOL_RANGE);
    if (target < 0) {
      p.mode = Mode.Walk;
      if (this.walkStreets(p, p.speed * 0.8, dt)) this.wander(p);
      return;
    }
    p.mode = Mode.Post;
    const tx = this.crowd.posX(target);
    const tz = this.crowd.posZ(target);
    p.heading = Math.atan2(-(tx - p.x), -(tz - p.z));
    if (p.cooldown > 0) return;
    // Slower and less accurate than a soldier's rifle.
    p.cooldown = 1.2 + this.rand() * 1.6;
    const hit = this.rand() < 0.18;
    const miss = hit ? 0 : 4;
    this.effects.tracer(
      p.x - Math.sin(p.heading) * 0.5, 1.3, p.z - Math.cos(p.heading) * 0.5,
      tx + (this.rand() - 0.5) * miss, 1.0 + this.rand() * 0.8, tz + (this.rand() - 0.5) * miss,
    );
    if (hit) this.crowd.kill(target);
  }

  /** Riot police close on the dead behind their shields and club them down. */
  private updateRiot(p: Person, dt: number): void {
    p.cooldown -= dt;
    const target = this.crowd.nearest(p.x, p.z, RIOT_ADVANCE);
    if (target < 0) {
      p.mode = Mode.Walk;
      if (this.walkStreets(p, p.speed * 0.7, dt)) this.wander(p);
      return;
    }
    const tx = this.crowd.posX(target);
    const tz = this.crowd.posZ(target);
    const dx = tx - p.x;
    const dz = tz - p.z;
    const d = Math.hypot(dx, dz);
    p.heading = Math.atan2(-dx, -dz);
    p.mode = Mode.Flee; // leaning in
    if (d > BATON_RANGE) {
      const step = Math.min(d - BATON_RANGE * 0.8, 1.6 * dt);
      p.x += (dx / d) * step;
      p.z += (dz / d) * step;
      p.phase += step * 2.4;
      return;
    }
    if (p.cooldown > 0) return;
    p.cooldown = 1.2 + this.rand() * 0.8;
    if (this.rand() < 0.35) this.crowd.kill(target);
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
    while (this.doorGunTimer >= interval) {
      this.doorGunTimer -= interval;
      const target = this.crowd.nearest(heli.x, heli.z, DOOR_GUN_RANGE);
      if (target < 0) {
        this.doorGunTimer = 0;
        break;
      }
      const side = this.rand() < 0.5 ? -1.4 : 1.4;
      const hit = this.rand() < 0.4;
      const miss = hit ? 0 : 3;
      this.effects.tracer(
        heli.x + side, this.heliY - 0.4, heli.z,
        this.crowd.posX(target) + (this.rand() - 0.5) * miss, 1 + this.rand() * 0.8, this.crowd.posZ(target) + (this.rand() - 0.5) * miss,
      );
      if (hit) {
        this.crowd.kill(target);
        kills++;
      }
    }
    return kills;
  }

  /** Walk toward the current target intersection. Returns true on arrival. */
  private walkStreets(p: Person, speed: number, dt: number): boolean {
    const tx = nodeX(p.ni) + p.ox;
    const tz = nodeZ(p.nj) + p.oz;
    if (Math.hypot(tx - p.x, tz - p.z) < 1) return true;
    this.moveToward(p, tx, tz, speed, dt);
    return false;
  }

  private moveToward(p: Person, tx: number, tz: number, speed: number, dt: number): void {
    const dx = tx - p.x;
    const dz = tz - p.z;
    const d = Math.hypot(dx, dz);
    if (d < 1e-3) return;
    const stepLen = Math.min(d, speed * dt);
    p.x += (dx / d) * stepLen;
    p.z += (dz / d) * stepLen;
    p.heading = Math.atan2(-dx, -dz);
    p.phase += stepLen * 2.2;
    const district = districtAt(p.x, p.z);
    if (district >= 0) p.district = district;
  }

  /** Pick a new random street to walk, avoiding an immediate U-turn. */
  private wander(p: Person): void {
    const options = neighbors(p.ni, p.nj).filter(([i, j]) => i !== p.pi || j !== p.pj);
    const [ni, nj] = options[Math.floor(this.rand() * options.length)] ?? [p.pi, p.pj];
    p.pi = p.ni;
    p.pj = p.nj;
    p.ni = ni;
    p.nj = nj;
  }

  /** Rejoin the street grid at the nearest intersection. */
  private retarget(p: Person): void {
    const [i, j] = nearestNode(p.x, p.z);
    p.pi = i;
    p.pj = j;
    p.ni = i;
    p.nj = j;
  }

  // --- Posts ----------------------------------------------------------------------------

  private buildPosts(seed: number | string): void {
    DISTRICT_TEMPLATES.forEach((tpl, district) => {
      const rand = makeRandom(`posts-${seed}-${district}`);
      for (let k = 0; k < POSTS_PER_DISTRICT; k++) {
        const i = Math.min(NODES_X - 1, tpl.col * BLOCKS_PER_DISTRICT + 3 + Math.floor(rand() * 7));
        const j = Math.min(NODES_Z - 1, tpl.row * BLOCKS_PER_DISTRICT + 3 + Math.floor(rand() * 7));
        this.posts.push({ x: nodeX(i), z: nodeZ(j), district });
        this.postVisible.push(true);
        this.postSoldiers.push(0);
      }
    });
    // Inside the sandbag ring at each site's landing zone, toward the street.
    for (const p of planSites(seed)) {
      this.posts.push({ x: p.x - 6, z: p.z + 6, district: p.district, site: p.id });
      this.postVisible.push(false);
      this.postSoldiers.push(0);
    }
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
      if (!this.postVisible[i] || p.site !== undefined) return;
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
    const box = (w: number, h: number, d: number, x: number, y: number, z: number, color?: number) => {
      const g = new THREE.BoxGeometry(w, h, d);
      g.translate(x, y, z);
      if (color !== undefined) {
        const c = new THREE.Color(color);
        const n = g.getAttribute('position').count;
        g.setAttribute('color', new THREE.Float32BufferAttribute(Array.from({ length: n }, () => [c.r, c.g, c.b]).flat(), 3));
      }
      return g;
    };
    // Civilians: plain clothes, arms at their sides (colours per instance).
    const civilianBody = mergeGeometries([
      box(0.36, 0.86, 0.2, 0, 0.43, 0), box(0.44, 0.6, 0.25, 0, 1.15, 0),
      box(0.11, 0.6, 0.11, -0.29, 1.12, 0), box(0.11, 0.6, 0.11, 0.29, 1.12, 0),
    ]);
    const civilianHead = box(0.22, 0.25, 0.22, 0, 1.6, 0);
    // Soldiers: olive uniform under a tan plate carrier, pack, boots, a helmet wider than the head,
    // and a rifle carried low at the hip: nothing like the dead's reaching arms.
    const OLIVE = 0x56603d;
    const soldierBody = mergeGeometries([
      box(0.36, 0.74, 0.2, 0, 0.5, 0, OLIVE),
      box(0.38, 0.14, 0.26, 0, 0.07, -0.02, 0x1d1b18),
      box(0.44, 0.6, 0.25, 0, 1.15, 0, OLIVE),
      box(0.48, 0.44, 0.31, 0, 1.2, 0, 0xb5a679),
      box(0.36, 0.42, 0.18, 0, 1.2, 0.24, 0x3d3b2d),
      box(0.12, 0.34, 0.12, -0.3, 1.26, 0, OLIVE),
      box(0.12, 0.34, 0.12, 0.3, 1.26, 0, OLIVE),
      box(0.1, 0.1, 0.34, -0.24, 1.08, -0.16, OLIVE),
      box(0.1, 0.1, 0.34, 0.24, 1.08, -0.16, OLIVE),
      box(0.07, 0.1, 0.95, 0.04, 1.06, -0.36, 0x161616),
    ]);
    const soldierHead = mergeGeometries([
      box(0.2, 0.2, 0.2, 0, 1.6, 0, 0xc49a76),
      box(0.32, 0.15, 0.34, 0, 1.76, 0.01, 0x3b4429),
    ]);
    // Patrol officers: navy uniform under a hi-vis vest, duty belt, peaked cap with a white band.
    const NAVY = 0x1d2840;
    const officerBody = mergeGeometries([
      box(0.36, 0.86, 0.2, 0, 0.43, 0, NAVY),
      box(0.38, 0.12, 0.24, 0, 0.06, -0.02, 0x111111),
      box(0.44, 0.6, 0.25, 0, 1.15, 0, NAVY),
      box(0.47, 0.42, 0.29, 0, 1.2, 0, 0xc9de3a),
      box(0.46, 0.08, 0.28, 0, 0.88, 0, 0x111111),
      box(0.11, 0.6, 0.11, -0.29, 1.12, 0, NAVY),
      box(0.11, 0.6, 0.11, 0.29, 1.12, 0, NAVY),
    ]);
    const officerHead = mergeGeometries([
      box(0.21, 0.23, 0.21, 0, 1.6, 0, 0xd1a684),
      box(0.25, 0.1, 0.25, 0, 1.76, 0, NAVY),
      box(0.26, 0.04, 0.26, 0, 1.72, 0, 0xf2f2f2),
      box(0.22, 0.02, 0.12, 0, 1.71, -0.17, 0x111111),
    ]);
    // Riot police: black kit, a helmet with a visor, and a tall shield carried in front.
    const RIOT = 0x1c2128;
    const riotBody = mergeGeometries([
      box(0.38, 0.86, 0.22, 0, 0.43, 0, RIOT),
      box(0.48, 0.62, 0.3, 0, 1.15, 0, RIOT),
      box(0.13, 0.56, 0.13, -0.3, 1.14, 0, RIOT),
      box(0.13, 0.56, 0.13, 0.3, 1.14, -0.05, RIOT),
      box(0.62, 1.15, 0.06, -0.08, 0.95, -0.36, 0xa9b6c0),
      box(0.06, 0.06, 0.6, 0.3, 1.0, -0.25, 0x111111),
    ]);
    const riotHead = mergeGeometries([
      box(0.3, 0.3, 0.32, 0, 1.66, 0, 0x2f343c),
      box(0.26, 0.14, 0.03, 0, 1.6, -0.17, 0x6f8090),
    ]);
    const geo = {
      [Kind.Civilian]: [civilianBody, civilianHead], [Kind.Soldier]: [soldierBody, soldierHead],
      [Kind.Police]: [officerBody, officerHead], [Kind.Riot]: [riotBody, riotHead],
    };

    for (const kind of KINDS) {
      const capacity = CAPACITY[kind];
      const vertexColors = kind !== Kind.Civilian;
      const body = new THREE.InstancedMesh(geo[kind][0], new THREE.MeshLambertMaterial({ vertexColors }), capacity);
      const head = new THREE.InstancedMesh(geo[kind][1], new THREE.MeshLambertMaterial({ vertexColors }), capacity);
      if (kind === Kind.Civilian) {
        // Allocate the colour buffers; render() fills them from each person's look.
        body.setColorAt(0, new THREE.Color());
        head.setColorAt(0, new THREE.Color());
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
    const counts = KINDS.map(() => 0);
    for (const p of this.people) {
      const kind = p.kind;
      const i = counts[kind]++;
      if (i >= CAPACITY[kind]) continue;
      const lying = p.mode === Mode.Turning;
      const moving = p.mode !== Mode.Post && !lying;
      const bob = moving ? Math.abs(Math.sin(p.phase)) * 0.06 : 0;
      const lean = p.mode === Mode.Flee ? 0.25 : 0;
      this.e.set(lying ? -Math.PI / 2 : -lean, p.heading, 0, 'YXZ');
      this.q.setFromEuler(this.e);
      this.m.compose(this.v.set(p.x, lying ? 0.2 : bob, p.z), this.q, this.s.set(1, 1, 1));
      this.bodies[kind].setMatrixAt(i, this.m);
      this.heads[kind].setMatrixAt(i, this.m);
      // Colours follow the person, not the slot: slots shift as people come and go.
      if (kind === Kind.Civilian) {
        this.bodies[kind].setColorAt(i, this.c.setHex(CLOTHES[p.look % CLOTHES.length]));
        this.heads[kind].setColorAt(i, this.c.setHex(SKINS[(p.look >> 3) % SKINS.length]));
      }
    }
    for (const kind of KINDS) {
      const n = Math.min(counts[kind], CAPACITY[kind]);
      for (const mesh of [this.bodies[kind], this.heads[kind]]) {
        mesh.count = n;
        mesh.instanceMatrix.needsUpdate = true;
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      }
    }
  }

  /** Counts of living figures on screen, for the HUD and tests. */
  census(): { zombies: number; civilians: number; soldiers: number } {
    const live = (k: Kind) => this.people.filter((p) => p.kind === k && p.mode !== Mode.Turning).length;
    return { zombies: this.crowd.living(), civilians: live(Kind.Civilian), soldiers: live(Kind.Soldier) };
  }
}

const cellKey = (gx: number, gz: number) => (gx + 1000) * 4096 + (gz + 1000);
const gridKey = (x: number, z: number) => cellKey(Math.floor(x / GRID), Math.floor(z / GRID));
