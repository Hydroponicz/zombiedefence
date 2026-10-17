// Smoke, fire, tracers and muzzle flashes. Smoke and fire come from emitters driven by the
// simulation (riots, overrun districts, depot fires) so the collapse is visible from far away.

import * as THREE from 'three';
import { DISTRICT_TEMPLATES } from '../sim/layout';
import { makeRandom } from '../sim/rng';
import type { CityState } from '../sim/types';
import { nodeX, nodeZ, NODES_X, NODES_Z } from './streets';

const WIND = new THREE.Vector3(0.7, 0, 0.35).normalize();

class ParticleField {
  readonly mesh: THREE.Mesh;
  private geometry = new THREE.InstancedBufferGeometry();
  private pos: Float32Array;
  private size: Float32Array;
  private alpha: Float32Array;
  private tint: Float32Array;
  count = 0;

  constructor(private capacity: number, additive: boolean) {
    const plane = new THREE.PlaneGeometry(1, 1);
    this.geometry.index = plane.index;
    this.geometry.setAttribute('position', plane.getAttribute('position'));
    this.geometry.setAttribute('uv', plane.getAttribute('uv'));
    this.pos = new Float32Array(capacity * 3);
    this.size = new Float32Array(capacity);
    this.alpha = new Float32Array(capacity);
    this.tint = new Float32Array(capacity * 3);
    this.geometry.setAttribute('aPos', new THREE.InstancedBufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.geometry.setAttribute('aSize', new THREE.InstancedBufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    this.geometry.setAttribute('aAlpha', new THREE.InstancedBufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage));
    this.geometry.setAttribute('aTint', new THREE.InstancedBufferAttribute(this.tint, 3).setUsage(THREE.DynamicDrawUsage));

    const uniforms = THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uMap: { value: null } }]);
    uniforms.uMap.value = puffTexture();
    const material = new THREE.ShaderMaterial({
      uniforms,
      fog: true,
      transparent: true,
      depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      vertexShader: `
        attribute vec3 aPos;
        attribute float aSize;
        attribute float aAlpha;
        attribute vec3 aTint;
        varying vec2 vUv;
        varying float vAlpha;
        varying vec3 vTint;
        #include <fog_pars_vertex>
        void main() {
          vUv = uv;
          vAlpha = aAlpha;
          vTint = aTint;
          vec4 mvPosition = viewMatrix * vec4(aPos, 1.0);
          mvPosition.xy += position.xy * aSize;
          gl_Position = projectionMatrix * mvPosition;
          #include <fog_vertex>
        }`,
      fragmentShader: `
        uniform sampler2D uMap;
        varying vec2 vUv;
        varying float vAlpha;
        varying vec3 vTint;
        #include <fog_pars_fragment>
        void main() {
          vec4 t = texture2D(uMap, vUv);
          gl_FragColor = vec4(vTint, t.a * vAlpha);
          #include <fog_fragment>
        }`,
    });
    this.mesh = new THREE.Mesh(this.geometry, material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = additive ? 3 : 2;
  }

  push(x: number, y: number, z: number, size: number, alpha: number, r: number, g: number, b: number): void {
    if (this.count >= this.capacity) return;
    const i = this.count++;
    this.pos.set([x, y, z], i * 3);
    this.size[i] = size;
    this.alpha[i] = alpha;
    this.tint.set([r, g, b], i * 3);
  }

  commit(): void {
    this.geometry.instanceCount = this.count;
    for (const name of ['aPos', 'aSize', 'aAlpha', 'aTint']) {
      (this.geometry.getAttribute(name) as THREE.InstancedBufferAttribute).needsUpdate = true;
    }
  }
}

interface Emitter {
  kind: 'smoke' | 'fire' | 'blaze';
  x: number;
  z: number;
  strength: number;
  target: number;
  seed: number;
}

const MAX_TRACERS = 160;

export class Effects {
  readonly group = new THREE.Group();
  private smoke = new ParticleField(2400, false);
  private fire = new ParticleField(1400, true);
  private emitters = new Map<string, Emitter>();
  private flashes: { x: number; y: number; z: number; ttl: number }[] = [];
  private tracerPositions = new Float32Array(MAX_TRACERS * 6);
  private tracerColors = new Float32Array(MAX_TRACERS * 6);
  private tracerTtl = new Float32Array(MAX_TRACERS);
  private tracerNext = 0;
  private tracerGeometry = new THREE.BufferGeometry();
  private time = 0;
  /** Street spots for each district's fires, chosen once. */
  private spots: { x: number; z: number }[][];

  constructor(seed: number | string, private fuelSites: { district: number; x: number; z: number }[]) {
    this.tracerGeometry.setAttribute('position', new THREE.BufferAttribute(this.tracerPositions, 3).setUsage(THREE.DynamicDrawUsage));
    this.tracerGeometry.setAttribute('color', new THREE.BufferAttribute(this.tracerColors, 3).setUsage(THREE.DynamicDrawUsage));
    const tracers = new THREE.LineSegments(
      this.tracerGeometry,
      new THREE.LineBasicMaterial({ vertexColors: true, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false }),
    );
    tracers.frustumCulled = false;
    this.group.add(this.smoke.mesh, this.fire.mesh, tracers);

    this.spots = DISTRICT_TEMPLATES.map((tpl, d) => {
      const rand = makeRandom(`fx-${seed}-${d}`);
      const out: { x: number; z: number }[] = [];
      for (let k = 0; k < 4; k++) {
        const i = Math.min(NODES_X - 1, tpl.col * 8 + 1 + Math.floor(rand() * 7));
        const j = Math.min(NODES_Z - 1, tpl.row * 8 + 1 + Math.floor(rand() * 7));
        out.push({ x: nodeX(i) + (rand() - 0.5) * 30, z: nodeZ(j) + (rand() - 0.5) * 10 });
      }
      return out;
    });
  }

  tracer(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): void {
    const i = this.tracerNext;
    this.tracerNext = (i + 1) % MAX_TRACERS;
    this.tracerPositions.set([x0, y0, z0, x1, y1, z1], i * 6);
    this.tracerTtl[i] = 0.07;
    this.flashes.push({ x: x0, y: y0, z: z0, ttl: 0.05 });
  }

  /** Point emitters at what the simulation says is happening in each district. */
  syncWithSim(state: CityState): void {
    for (const e of this.emitters.values()) e.target = 0;
    const want = (key: string, kind: Emitter['kind'], x: number, z: number) => {
      const e = this.emitters.get(key);
      if (e) e.target = 1;
      else this.emitters.set(key, { kind, x, z, strength: 0, target: 1, seed: this.emitters.size * 7.13 });
    };
    for (const d of state.districts) {
      const spots = this.spots[d.id];
      const fires = d.status === 'overrun' ? 3 : d.rioting ? 2 : d.status === 'contested' ? 1 : 0;
      for (let k = 0; k < fires; k++) {
        want(`smoke-${d.id}-${k}`, 'smoke', spots[k].x, spots[k].z);
        want(`fire-${d.id}-${k}`, 'fire', spots[k].x, spots[k].z);
      }
      if (d.burning > 0) {
        for (const site of this.fuelSites.filter((s) => s.district === d.id)) {
          want(`blaze-${site.x}-${site.z}`, 'blaze', site.x, site.z);
          want(`blazesmoke-${site.x}-${site.z}`, 'smoke', site.x, site.z);
        }
      }
    }
  }

  update(dt: number, night: number): void {
    this.time += dt;
    this.smoke.count = 0;
    this.fire.count = 0;
    const t = this.time;

    for (const [key, e] of this.emitters) {
      e.strength += Math.sign(e.target - e.strength) * Math.min(Math.abs(e.target - e.strength), dt / 8);
      if (e.strength <= 0 && e.target === 0) {
        this.emitters.delete(key);
        continue;
      }
      if (e.kind === 'smoke') {
        const big = key.startsWith('blazesmoke');
        const puffs = big ? 44 : 30;
        const height = big ? 300 : 210;
        const life = big ? 26 : 22;
        const shade = (big ? 0.1 : 0.2) * (1 - night * 0.6);
        for (let k = 0; k < puffs; k++) {
          const age = fract(t / life + k / puffs + e.seed);
          const jx = hash(k, e.seed) - 0.5;
          const jz = hash(k + 17, e.seed) - 0.5;
          const rise = age * height;
          const drift = age * age * height * 0.8;
          const size = (big ? 16 : 11) + age * (big ? 80 : 60);
          const alpha = Math.sin(Math.PI * Math.min(1, age * 1.15)) * 0.8 * e.strength;
          this.smoke.push(e.x + WIND.x * drift + jx * size * 0.4, 4 + rise, e.z + WIND.z * drift + jz * size * 0.4, size, alpha, shade, shade, shade * 1.05);
        }
      } else {
        const blaze = e.kind === 'blaze';
        const flames = blaze ? 36 : 16;
        const height = blaze ? 22 : 9;
        const glow = 0.55 + night * 0.45;
        for (let k = 0; k < flames; k++) {
          const age = fract(t / (blaze ? 1.6 : 1.1) + k / flames + e.seed);
          const jx = (hash(k, e.seed) - 0.5) * (blaze ? 30 : 6);
          const jz = (hash(k + 5, e.seed) - 0.5) * (blaze ? 30 : 6);
          const size = (blaze ? 12 : 6) * (1 - age * 0.7);
          const flicker = 0.75 + 0.25 * Math.sin(t * 23 + k * 3.1);
          this.fire.push(e.x + jx, 0.5 + age * height, e.z + jz, size, (1 - age) * e.strength * flicker * glow, 1.0, 0.45 + 0.25 * (1 - age), 0.12);
        }
      }
    }

    this.flashes = this.flashes.filter((f) => (f.ttl -= dt) > 0);
    for (const f of this.flashes) this.fire.push(f.x, f.y, f.z, 1.6, 1, 1, 0.85, 0.5);

    for (let i = 0; i < MAX_TRACERS; i++) {
      this.tracerTtl[i] = Math.max(0, this.tracerTtl[i] - dt);
      const b = this.tracerTtl[i] > 0 ? 1 : 0;
      this.tracerColors.set([b, b * 0.85, b * 0.45, b * 0.6, b * 0.4, b * 0.15], i * 6);
    }
    this.tracerGeometry.getAttribute('position').needsUpdate = true;
    this.tracerGeometry.getAttribute('color').needsUpdate = true;

    this.smoke.commit();
    this.fire.commit();
  }
}

const fract = (x: number) => x - Math.floor(x);
const hash = (k: number, s: number) => fract(Math.sin(k * 127.1 + s * 311.7) * 43758.5453);

function puffTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.5, 'rgba(255,255,255,0.55)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}
