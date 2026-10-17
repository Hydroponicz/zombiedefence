// Arcade helicopter in the spirit of GTA V: stick sets a target attitude and the aircraft
// self-levels when released; neutral throttle holds altitude; banking turns the nose.

import * as THREE from 'three';
import type { FlightInput } from '../input/Input';

export interface CollisionWorld {
  surfaceHeight(x: number, z: number): number;
  collide(p: THREE.Vector3, radius: number, bottom: number): THREE.Vector3;
}

const G = 9.81;
const MAX_PITCH = 0.6; // rad, ~34°
const MAX_ROLL = 0.7; // rad, ~40°
const ATTITUDE_RESPONSE = 3.2;
const MAX_YAW_RATE = 1.5; // rad/s
const BANK_TURN = 0.9;
const CLIMB_ACCEL = 11;
const DESCEND_ACCEL = 9;
// Top speed about 68 m/s (245 km/h) at full forward tilt.
const DRAG_LINEAR = 0.05;
const DRAG_QUAD = 0.0007;
const LATERAL_DRAG = 0.35;
const VERTICAL_DRAG = 0.9;
// Above the 470 m supertall with room to spare.
const CEILING = 1100;
const SKID_DEPTH = 1.9; // body centre to skid bottom
const BODY_RADIUS = 4;
const SAFE_LANDING_SPEED = 6;
const SPOOL_TIME = 4;
/** How much a full load blunts climb, attitude response and yaw. */
const LOAD_CLIMB = 0.45;
const LOAD_RESPONSE = 0.35;
const LOAD_YAW = 0.25;
/**
 * Each zombie on the skids pulls down this hard (m/s²) and does this much damage per second.
 * The pull is capped below a fully loaded climb, so full throttle always escapes, slowly.
 */
const GRAB_PULL = 1.3;
const GRAB_PULL_MAX = 5;
const GRAB_DAMAGE = 1.2;

export const FUEL_CAPACITY = 1360; // litres
/** Fuel burn in litres per real second. */
const BURN_IDLE = 0.35;
const BURN_HOVER = 1.6;
const BURN_CLIMB = 0.7;
const BURN_PER_MS = 0.008;
const BURN_LOAD = 0.6;
/** Engine out: the rotor windmills and gives this fraction of hover lift, plus one flare. */
const AUTOROTATION_LIFT = 0.55;
const FLARE_ACCEL = 8;
const FLARE_SECONDS = 2.5;
/** Sling rope length and bladder size. */
const ROPE = 11;
const BLADDER_HALF_HEIGHT = 0.7;

export class Helicopter {
  readonly object = new THREE.Group();
  readonly velocity = new THREE.Vector3();
  readonly searchlight: THREE.SpotLight;
  /** Heading in radians; 0 faces -Z (north). */
  yaw = 0;
  noseDown = 0;
  bankRight = 0;
  yawRate = 0;
  /** Rotor speed 0..1. */
  rotor = 0;
  health = 100;
  landed = true;
  destroyed = false;
  /** Set for one frame when the helicopter takes damage. */
  lastImpact = 0;
  /** Cargo load 0 (empty) .. 1 (full): heavier handling. */
  load = 0;
  /** Zombies hanging off the skids. */
  grabbers = 0;
  fuel = FUEL_CAPACITY;
  /** Litres per second being burned right now. */
  burnRate = 0;
  /** Litres in a bladder on the sling (set from the simulation's cargo). */
  sling = 0;
  /** Rope and bladder hang in world space, so they're added to the scene separately. */
  readonly slingObject = new THREE.Group();
  /** Height of the slung bladder's underside above whatever is below it. */
  bladderClearance = 0;
  readonly bladder = new THREE.Vector3();
  private bladderVel = new THREE.Vector3();
  private bladderMesh: THREE.Mesh;
  private rope: THREE.Line;
  private flare = FLARE_SECONDS;

  private mainRotor = new THREE.Group();
  private tailRotor = new THREE.Group();
  private rotorDisc: THREE.Mesh;
  private strobe: THREE.Mesh;
  private time = 0;

  constructor() {
    const olive = new THREE.MeshLambertMaterial({ color: 0x4b5a32 });
    const dark = new THREE.MeshLambertMaterial({ color: 0x23271f });
    const glass = new THREE.MeshPhongMaterial({ color: 0x1c2a33, shininess: 90, specular: 0x88aacc });
    const add = (geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number) => {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, y, z);
      m.castShadow = true;
      this.object.add(m);
      return m;
    };

    // Fuselage, nose and cockpit glass.
    add(new THREE.BoxGeometry(2.6, 2.3, 5.2), olive, 0, 0, 0.4);
    add(new THREE.BoxGeometry(2.2, 1.7, 1.8), olive, 0, -0.2, -2.9);
    const nose = add(new THREE.BoxGeometry(2.0, 1.1, 1.3), glass, 0, 0.45, -2.6);
    nose.rotation.x = -0.35;
    add(new THREE.BoxGeometry(2.62, 1.0, 1.6), glass, 0, 0.4, -1.4);
    // Engine housing.
    add(new THREE.BoxGeometry(1.6, 0.8, 3.2), olive, 0, 1.5, 0.6);
    // Tail boom, fin, stabiliser.
    const boom = add(new THREE.CylinderGeometry(0.28, 0.5, 7.2, 8), olive, 0, 0.5, 6.4);
    boom.rotation.x = Math.PI / 2;
    const fin = add(new THREE.BoxGeometry(0.2, 2.0, 1.2), olive, 0, 1.4, 9.8);
    fin.rotation.x = -0.3;
    add(new THREE.BoxGeometry(3.0, 0.12, 0.9), olive, 0, 0.6, 9.0);
    // Skids.
    for (const side of [-1, 1]) {
      const skid = add(new THREE.CylinderGeometry(0.1, 0.1, 6.0, 6), dark, side * 1.4, -SKID_DEPTH + 0.1, -0.2);
      skid.rotation.x = Math.PI / 2;
      for (const z of [-1.6, 1.4]) add(new THREE.BoxGeometry(0.12, 0.9, 0.12), dark, side * 1.3, -1.45, z);
    }

    // Main rotor: hub and four blades.
    this.mainRotor.position.set(0, 2.1, 0.3);
    const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, 0.5, 8), dark);
    this.mainRotor.add(hub);
    for (let i = 0; i < 4; i++) {
      const blade = new THREE.Mesh(new THREE.BoxGeometry(0.45, 0.06, 7.6), dark);
      blade.position.z = 3.8;
      const arm = new THREE.Group();
      arm.rotation.y = (i * Math.PI) / 2;
      arm.add(blade);
      blade.castShadow = true;
      this.mainRotor.add(arm);
    }
    this.rotorDisc = new THREE.Mesh(
      new THREE.CircleGeometry(7.8, 40),
      new THREE.MeshBasicMaterial({ color: 0x1a1d18, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide }),
    );
    this.rotorDisc.rotation.x = -Math.PI / 2;
    this.mainRotor.add(this.rotorDisc);
    this.object.add(this.mainRotor);

    this.tailRotor.position.set(0.35, 1.4, 9.9);
    for (let i = 0; i < 2; i++) {
      const blade = new THREE.Mesh(new THREE.BoxGeometry(0.06, 2.4, 0.25), dark);
      blade.rotation.x = (i * Math.PI) / 2;
      this.tailRotor.add(blade);
    }
    this.object.add(this.tailRotor);

    // Navigation lights: red port, green starboard, white tail strobe.
    const light = (color: number, x: number, y: number, z: number) =>
      add(new THREE.SphereGeometry(0.14, 8, 6), new THREE.MeshBasicMaterial({ color }), x, y, z);
    light(0xff2a2a, -1.35, 0.2, -0.5);
    light(0x2aff4a, 1.35, 0.2, -0.5);
    this.strobe = light(0xffffff, 0, 2.4, 9.9);

    this.searchlight = new THREE.SpotLight(0xfff4dd, 0, 420, 0.32, 0.4, 1.2);
    this.searchlight.position.set(0, -1.1, -3.2);
    this.searchlight.target.position.set(0, -40, -60);
    this.object.add(this.searchlight, this.searchlight.target);

    this.bladderMesh = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 10), new THREE.MeshLambertMaterial({ color: 0x1d1f1c }));
    this.bladderMesh.scale.set(2.4, BLADDER_HALF_HEIGHT, 1.7);
    this.bladderMesh.castShadow = true;
    this.rope = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]),
      new THREE.LineBasicMaterial({ color: 0x222222 }),
    );
    this.rope.frustumCulled = false;
    this.slingObject.add(this.bladderMesh, this.rope);
    this.slingObject.visible = false;
  }

  /** Litres per second in level flight with the current load, for endurance estimates. */
  get flightBurn(): number {
    return BURN_HOVER + BURN_LOAD * this.load;
  }

  /** Place and animate without physics: AI helicopters follow routes planned by the simulation. */
  pose(x: number, y: number, z: number, yaw: number, noseDown: number, bank: number, dt: number): void {
    this.position.set(x, y + SKID_DEPTH, z);
    this.yaw = yaw;
    this.noseDown = noseDown;
    this.bankRight = bank;
    this.rotor = 1;
    this.applyTransform();
    this.animate(dt);
  }

  get engineOut(): boolean {
    return this.fuel <= 0;
  }

  get position(): THREE.Vector3 {
    return this.object.position;
  }

  get speed(): number {
    return this.velocity.length();
  }

  toggleSearchlight(): boolean {
    this.searchlight.intensity = this.searchlight.intensity > 0 ? 0 : 4000;
    return this.searchlight.intensity > 0;
  }

  /** Place the helicopter on a surface, rotors stopped. */
  reset(x: number, y: number, z: number, yaw: number, fuel = FUEL_CAPACITY): void {
    this.fuel = fuel;
    this.flare = FLARE_SECONDS;
    this.position.set(x, y + SKID_DEPTH, z);
    this.velocity.set(0, 0, 0);
    this.yaw = yaw;
    this.noseDown = this.bankRight = this.yawRate = 0;
    this.rotor = 0;
    this.health = 100;
    this.landed = true;
    this.destroyed = false;
    this.applyTransform();
  }

  update(dt: number, input: FlightInput, world: CollisionWorld): void {
    this.time += dt;
    this.lastImpact = 0;
    const live = !this.destroyed;
    const controls = live ? input : { collective: -1, yaw: 0, pitch: 0, roll: 0 };

    const engine = !this.engineOut;
    if (live && engine) this.rotor = Math.min(1, this.rotor + dt / SPOOL_TIME);
    // Out of fuel: the rotor windmills in the descent, and stops once down.
    else if (live && !this.landed) this.rotor = Math.max(Math.min(this.rotor, 0.6), this.rotor - dt / 8);
    else this.rotor = Math.max(0, this.rotor - dt / 6);
    const lift = this.rotor * this.rotor;
    const thrust = engine ? lift : this.landed ? 0 : AUTOROTATION_LIFT;

    // Attitude: approach the stick's target and self-level when it is released.
    const k = 1 - Math.exp(-ATTITUDE_RESPONSE * (1 - LOAD_RESPONSE * this.load) * dt);
    const groundLock = this.landed && controls.collective <= 0.05;
    const targetPitch = groundLock ? 0 : controls.pitch * MAX_PITCH;
    const targetRoll = groundLock ? 0 : controls.roll * MAX_ROLL;
    this.noseDown += (targetPitch - this.noseDown) * k;
    this.bankRight += (targetRoll - this.bankRight) * k;

    // Yaw from the pedals plus a coordinated turn from banking at speed.
    const horizontalSpeed = Math.hypot(this.velocity.x, this.velocity.z);
    const bankTurn = -this.bankRight * BANK_TURN * Math.min(1, horizontalSpeed / 25);
    const targetYawRate = (groundLock ? 0.3 : 1) * -controls.yaw * MAX_YAW_RATE * (1 - LOAD_YAW * this.load) + bankTurn;
    this.yawRate += (targetYawRate - this.yawRate) * (1 - Math.exp(-4 * dt));
    this.yaw += this.yawRate * dt;

    this.applyTransform();

    // Thrust along the rotor axis, scaled so neutral throttle holds altitude at any tilt.
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(this.object.quaternion);
    const hold = (G / Math.max(0.45, up.y)) * thrust;
    const ceilingFade = Math.max(0, Math.min(1, (CEILING - this.position.y) / 80));
    const accel = up.multiplyScalar(hold * (0.6 + 0.4 * ceilingFade));
    const climb = CLIMB_ACCEL * (1 - LOAD_CLIMB * this.load) * ceilingFade;
    let collective: number;
    if (engine) {
      collective = (controls.collective > 0 ? controls.collective * climb : controls.collective * DESCEND_ACCEL) * lift;
    } else if (controls.collective > 0 && this.flare > 0 && !this.landed) {
      // Trade the rotor's stored energy for one flare before touchdown.
      collective = controls.collective * FLARE_ACCEL;
      this.flare -= dt;
    } else {
      collective = Math.min(0, controls.collective) * DESCEND_ACCEL * 0.5;
    }
    accel.y += collective - G;

    if (live && engine) {
      this.burnRate = this.landed && controls.collective <= 0.05
        ? BURN_IDLE
        : BURN_HOVER + BURN_CLIMB * Math.max(0, controls.collective) + BURN_PER_MS * this.speed + BURN_LOAD * this.load;
      this.fuel = Math.max(0, this.fuel - this.burnRate * dt);
    } else {
      this.burnRate = 0;
    }
    if (this.grabbers > 0 && live) {
      accel.y -= Math.min(GRAB_PULL_MAX, this.grabbers * GRAB_PULL);
      this.damage(this.grabbers * GRAB_DAMAGE * dt);
    }

    // Drag: quadratic forward, extra sideways so turns carve, strong vertical damping.
    const v = this.velocity;
    const hv = new THREE.Vector3(v.x, 0, v.z);
    const hs = hv.length();
    accel.addScaledVector(hv, -(DRAG_LINEAR + DRAG_QUAD * hs));
    const right = new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    accel.addScaledVector(right, -right.dot(hv) * LATERAL_DRAG);
    accel.y -= v.y * VERTICAL_DRAG * (engine ? lift : this.landed ? 0 : 0.9);

    v.addScaledVector(accel, dt);
    this.position.addScaledVector(v, dt);

    this.resolveCollisions(dt, world);
    this.updateSling(dt, world);
    this.animate(dt);
  }

  /** The slung bladder swings as a pendulum on its rope and rests on whatever is below. */
  private updateSling(dt: number, world: CollisionWorld): void {
    const hook = this.position.clone();
    hook.y -= SKID_DEPTH;
    if (this.sling <= 0) {
      this.slingObject.visible = false;
      this.bladder.copy(hook).y -= ROPE;
      this.bladderVel.set(0, 0, 0);
      return;
    }
    this.slingObject.visible = true;
    const b = this.bladder;
    this.bladderVel.y -= G * dt;
    this.bladderVel.multiplyScalar(Math.exp(-0.6 * dt));
    b.addScaledVector(this.bladderVel, dt);
    const toBladder = b.clone().sub(hook);
    const len = toBladder.length();
    if (len > ROPE) {
      const dir = toBladder.divideScalar(len);
      b.copy(hook).addScaledVector(dir, ROPE);
      const radial = this.bladderVel.dot(dir);
      if (radial > 0) this.bladderVel.addScaledVector(dir, -radial);
    }
    const ground = world.surfaceHeight(b.x, b.z) + BLADDER_HALF_HEIGHT;
    if (b.y < ground) {
      b.y = ground;
      this.bladderVel.y = Math.max(0, this.bladderVel.y);
      this.bladderVel.x *= Math.exp(-6 * dt);
      this.bladderVel.z *= Math.exp(-6 * dt);
    }
    this.bladderClearance = b.y - ground;
    this.bladderMesh.position.copy(b);
    const pos = this.rope.geometry.getAttribute('position') as THREE.BufferAttribute;
    pos.setXYZ(0, hook.x, hook.y, hook.z);
    pos.setXYZ(1, b.x, b.y + BLADDER_HALF_HEIGHT, b.z);
    pos.needsUpdate = true;
  }

  private resolveCollisions(dt: number, world: CollisionWorld): void {
    const p = this.position;
    const v = this.velocity;

    const push = world.collide(p, BODY_RADIUS, SKID_DEPTH);
    if (push.lengthSq() > 0) {
      const n = push.clone().normalize();
      const into = -v.dot(n);
      if (into > 0) {
        v.addScaledVector(n, into * 1.3);
        if (into > 8) this.damage((into - 8) * 6);
      }
      p.add(push);
    }

    const surface = world.surfaceHeight(p.x, p.z);
    const bottom = p.y - SKID_DEPTH;
    if (bottom <= surface) {
      const impact = -v.y;
      const tilt = Math.max(Math.abs(this.noseDown), Math.abs(this.bankRight));
      if (impact > SAFE_LANDING_SPEED) this.damage((impact - SAFE_LANDING_SPEED) * 14);
      if (tilt > 0.45 && impact > 2) this.damage(25);
      p.y = surface + SKID_DEPTH;
      if (v.y < 0) v.y = 0;
      const friction = Math.exp(-5 * dt);
      v.x *= friction;
      v.z *= friction;
      this.landed = true;
    } else if (bottom > surface + 0.3) {
      this.landed = false;
    }
  }

  private damage(amount: number): void {
    if (this.destroyed) return;
    this.health = Math.max(0, this.health - amount);
    this.lastImpact = amount;
    if (this.health <= 0) this.destroyed = true;
  }

  private applyTransform(): void {
    this.object.quaternion.setFromEuler(new THREE.Euler(-this.noseDown, this.yaw, -this.bankRight, 'YXZ'));
  }

  private animate(dt: number): void {
    this.mainRotor.rotation.y += this.rotor * 42 * dt;
    this.tailRotor.rotation.x += this.rotor * 70 * dt;
    (this.rotorDisc.material as THREE.MeshBasicMaterial).opacity = Math.max(0, this.rotor - 0.5) * 0.35;
    this.strobe.visible = Math.sin(this.time * 6) > 0.85;
  }
}
