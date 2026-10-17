// Sky, sun, moon and fog driven by the game clock.

import * as THREE from 'three';
import { daylight, skyProgress } from '../sim/clock';

const DAY_SKY = new THREE.Color(0x9cc3dd);
const DUSK_SKY = new THREE.Color(0xd08a5c);
const NIGHT_SKY = new THREE.Color(0x0a0f1a);
const SHADOW_EXTENT = 260;

export class Environment {
  readonly sun = new THREE.DirectionalLight(0xfff2dd, 2.2);
  readonly hemi = new THREE.HemisphereLight(0xbfd8ff, 0x4a5a3a, 1.1);
  private stars: THREE.Points;
  private sky = new THREE.Color();

  constructor(private scene: THREE.Scene) {
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    const cam = this.sun.shadow.camera;
    cam.left = cam.bottom = -SHADOW_EXTENT;
    cam.right = cam.top = SHADOW_EXTENT;
    cam.near = 10;
    cam.far = 1600;
    this.sun.shadow.bias = -0.0005;
    this.sun.shadow.normalBias = 0.5;
    scene.add(this.sun, this.sun.target, this.hemi);

    scene.fog = new THREE.Fog(DAY_SKY, 500, 3200);
    scene.background = this.sky;

    const starGeo = new THREE.BufferGeometry();
    const positions = new Float32Array(1500 * 3);
    const v = new THREE.Vector3();
    for (let i = 0; i < 1500; i++) {
      v.randomDirection();
      v.y = Math.abs(v.y) * 0.9 + 0.1;
      v.normalize().multiplyScalar(4000);
      positions.set([v.x, v.y, v.z], i * 3);
    }
    starGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    this.stars = new THREE.Points(
      starGeo,
      new THREE.PointsMaterial({ color: 0xffffff, size: 2, sizeAttenuation: false, transparent: true, fog: false, depthWrite: false }),
    );
    scene.add(this.stars);
  }

  /** Returns the night amount (0 day .. 1 night) for other systems. */
  update(t: number, focus: THREE.Vector3): number {
    const light = daylight(t);
    const night = 1 - light;
    const { sun, p } = skyProgress(t);
    const angle = p * Math.PI;
    // Sun travels east to west; the moon follows the same arc at night.
    const dir = new THREE.Vector3(Math.cos(angle), Math.max(0.08, Math.sin(angle)), 0.35).normalize();
    this.sun.position.copy(focus).addScaledVector(dir, 800);
    this.sun.target.position.copy(focus);

    const duskness = sun ? Math.max(0, 1 - Math.sin(angle) * 3) : 0;
    this.sky.copy(DAY_SKY).lerp(DUSK_SKY, duskness * 0.6).lerp(NIGHT_SKY, night);
    (this.scene.fog as THREE.Fog).color.copy(this.sky);
    (this.scene.fog as THREE.Fog).far = 3200 - night * 1200;

    this.sun.intensity = sun ? 0.4 + 1.8 * light : 0.4;
    this.sun.color.setHex(sun ? 0xfff2dd : 0x8fa6d6).lerp(new THREE.Color(0xffb27a), duskness * 0.7);
    this.hemi.intensity = 0.4 + 0.7 * light;
    this.hemi.color.setHex(0xbfd8ff).lerp(new THREE.Color(0x24324f), night);
    this.hemi.groundColor.setHex(0x4a5a3a).lerp(new THREE.Color(0x10141a), night);

    (this.stars.material as THREE.PointsMaterial).opacity = Math.max(0, night - 0.3) / 0.7;
    this.stars.position.copy(focus);
    this.stars.visible = night > 0.3;
    return night;
  }
}
