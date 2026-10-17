// GTA-style chase camera: trails behind the helicopter's heading with a little lag, can be
// orbited with the right stick or mouse, and drifts back behind the aircraft when released.

import * as THREE from 'three';
import type { FrameInput } from '../input/Input';
import type { Helicopter } from './Helicopter';

const DISTANCES = [22, 34, 55];
const RECENTER_DELAY = 1.4;
const STICK_RATE = 2.6;
const MOUSE_RATE = 0.0028;

export class ChaseCamera {
  private distanceIndex = 1;
  private distance = DISTANCES[1];
  private zoomOffset = 0;
  private heading = 0;
  private orbitYaw = 0;
  private orbitPitch = 0.22;
  private sinceLook = 99;
  private position = new THREE.Vector3();
  private target = new THREE.Vector3();
  private initialised = false;

  constructor(readonly camera: THREE.PerspectiveCamera) {}

  cycleDistance(): void {
    this.distanceIndex = (this.distanceIndex + 1) % DISTANCES.length;
  }

  update(dt: number, heli: Helicopter, input: FrameInput, surfaceHeight: (x: number, z: number) => number): void {
    const look = Math.abs(input.lookX) + Math.abs(input.lookY) > 0 || input.mouseX !== 0 || input.mouseY !== 0;
    this.orbitYaw -= input.lookX * STICK_RATE * dt + input.mouseX * MOUSE_RATE;
    this.orbitPitch += input.lookY * STICK_RATE * 0.6 * dt + input.mouseY * MOUSE_RATE;
    this.orbitPitch = THREE.MathUtils.clamp(this.orbitPitch, -0.35, 1.3);
    this.sinceLook = look ? 0 : this.sinceLook + dt;
    if (this.sinceLook > RECENTER_DELAY) {
      const k = 1 - Math.exp(-2.5 * dt);
      this.orbitYaw += (wrapAngle(0 - this.orbitYaw)) * k;
      this.orbitPitch += (0.22 - this.orbitPitch) * k;
    }
    this.zoomOffset = THREE.MathUtils.clamp(this.zoomOffset + input.zoom * 4, -12, 40);

    // Follow the heading with lag so turns swing the view.
    const turn = 1 - Math.exp(-3.5 * dt);
    this.heading += wrapAngle(heli.yaw - this.heading) * turn;

    const speedPull = Math.min(12, heli.speed * 0.15);
    const wanted = DISTANCES[this.distanceIndex] + this.zoomOffset + speedPull;
    this.distance += (wanted - this.distance) * (1 - Math.exp(-3 * dt));

    const yaw = this.heading + this.orbitYaw;
    const pitch = this.orbitPitch;
    const offset = new THREE.Vector3(
      Math.sin(yaw) * Math.cos(pitch),
      Math.sin(pitch),
      Math.cos(yaw) * Math.cos(pitch),
    ).multiplyScalar(this.distance);

    const desired = heli.position.clone().add(offset);
    desired.y += 3;
    const ground = surfaceHeight(desired.x, desired.z);
    desired.y = Math.max(desired.y, ground + 2.5);

    const lookAt = heli.position.clone().add(new THREE.Vector3(-Math.sin(heli.yaw), 0, -Math.cos(heli.yaw)).multiplyScalar(6));
    lookAt.y += 2;

    if (!this.initialised) {
      this.position.copy(desired);
      this.target.copy(lookAt);
      this.heading = heli.yaw;
      this.initialised = true;
    }
    const follow = 1 - Math.exp(-8 * dt);
    this.position.lerp(desired, follow);
    this.target.lerp(lookAt, 1 - Math.exp(-12 * dt));
    this.camera.position.copy(this.position);
    this.camera.lookAt(this.target);

    // A touch of extra field of view at speed.
    const fov = 62 + Math.min(10, heli.speed * 0.15);
    if (Math.abs(this.camera.fov - fov) > 0.05) {
      this.camera.fov += (fov - this.camera.fov) * (1 - Math.exp(-2 * dt));
      this.camera.updateProjectionMatrix();
    }
  }
}

function wrapAngle(a: number): number {
  return Math.atan2(Math.sin(a), Math.cos(a));
}
