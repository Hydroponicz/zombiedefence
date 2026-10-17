// Procedural city generated from the shared district layout. Buildings are a single instanced
// box mesh with a window shader whose lights are switched per district, so the 3D city can
// show the simulation's power state (lights going out district by district).

import * as THREE from 'three';
import {
  CITY_DEPTH,
  CITY_WIDTH,
  DISTRICT_SIZE,
  DISTRICT_TEMPLATES,
  districtCenter,
  type DistrictKind,
} from '../sim/layout';
import { makeRandom } from '../sim/rng';

const BLOCKS = 8;
const CELL = DISTRICT_SIZE / BLOCKS; // 80 m
const ROAD = 14;
const LOT = CELL - ROAD; // 66 m buildable square per block

interface Box {
  x: number;
  z: number;
  w: number;
  d: number;
  h: number;
  y?: number;
  color: number;
  /** Lit windows at night. */
  windows?: boolean;
  district: number;
  /** Solid for collision (flat pads and lawns are not). */
  solid?: boolean;
}

interface Cylinder {
  x: number;
  z: number;
  r: number;
  h: number;
  color: number;
  district: number;
}

interface Collider {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  top: number;
  /** Flat surfaces (pads, lawns, runways) can be landed on but never push sideways. */
  floor: boolean;
}

export interface Helipad {
  x: number;
  z: number;
  y: number;
  name: string;
}

const COLLISION_CELL = 40;

export class City {
  readonly group = new THREE.Group();
  readonly helipads: Helipad[] = [];
  private boxes: Box[] = [];
  private cylinders: Cylinder[] = [];
  private trees: { x: number; z: number; s: number }[] = [];
  private colliders: Collider[] = [];
  private grid = new Map<number, number[]>();
  private districtLight = new Float32Array(DISTRICT_TEMPLATES.length).fill(1);
  private windowUniforms = {
    uNight: { value: 0 },
    uDistrictLight: { value: this.districtLight },
  };

  constructor(seed: number | string) {
    const rand = makeRandom(`city-${seed}`);
    DISTRICT_TEMPLATES.forEach((tpl, i) => this.buildDistrict(i, tpl.kind, rand));
    this.buildGround();
    this.buildInstances();
    this.buildColliders();
  }

  /** 0 = day, 1 = full night. */
  setNight(amount: number): void {
    this.windowUniforms.uNight.value = amount;
  }

  /** Window light level per district (1 = grid power, ~0.35 = generators, 0 = dark). */
  setDistrictLight(index: number, level: number): void {
    this.districtLight[index] = level;
  }

  /** Highest solid surface under (x, z): ground is 0. */
  surfaceHeight(x: number, z: number): number {
    let top = 0;
    for (const i of this.grid.get(this.cellKey(x, z)) ?? []) {
      const c = this.colliders[i];
      if (x >= c.minX && x <= c.maxX && z >= c.minZ && z <= c.maxZ && c.top > top) top = c.top;
    }
    return top;
  }

  /**
   * Push a sphere (centre p, radius r) out of any building it is inside, sideways.
   * Returns the push applied (zero when there was no contact).
   */
  collide(p: THREE.Vector3, r: number, bottom: number): THREE.Vector3 {
    const push = new THREE.Vector3();
    const seen = new Set<number>();
    for (let gx = Math.floor((p.x - r) / COLLISION_CELL); gx <= Math.floor((p.x + r) / COLLISION_CELL); gx++) {
      for (let gz = Math.floor((p.z - r) / COLLISION_CELL); gz <= Math.floor((p.z + r) / COLLISION_CELL); gz++) {
        for (const i of this.grid.get(this.key(gx, gz)) ?? []) {
          if (seen.has(i)) continue;
          seen.add(i);
          const c = this.colliders[i];
          // Above the roof: the landing code handles it.
          if (c.floor || p.y - bottom >= c.top - 0.25) continue;
          const cx = Math.max(c.minX, Math.min(p.x, c.maxX));
          const cz = Math.max(c.minZ, Math.min(p.z, c.maxZ));
          const dx = p.x - cx;
          const dz = p.z - cz;
          const dist = Math.hypot(dx, dz);
          if (dist >= r) continue;
          if (dist > 1e-4) {
            push.x += (dx / dist) * (r - dist);
            push.z += (dz / dist) * (r - dist);
          } else {
            // Centre is inside the box: leave by the nearest face.
            const exits = [p.x - c.minX, c.maxX - p.x, p.z - c.minZ, c.maxZ - p.z];
            const m = Math.min(...exits);
            if (m === exits[0]) push.x -= m + r;
            else if (m === exits[1]) push.x += m + r;
            else if (m === exits[2]) push.z -= m + r;
            else push.z += m + r;
          }
        }
      }
    }
    return push;
  }

  // --- Generation -----------------------------------------------------------------------

  private buildDistrict(district: number, kind: DistrictKind, rand: () => number): void {
    const tpl = DISTRICT_TEMPLATES[district];
    const center = districtCenter(tpl.col, tpl.row);
    const x0 = center.x - DISTRICT_SIZE / 2;
    const z0 = center.z - DISTRICT_SIZE / 2;
    const special = { bx: 3 + Math.floor(rand() * 2), bz: 3 + Math.floor(rand() * 2) };

    if (kind === 'airbase') {
      this.buildAirbase(district, x0, z0);
      return;
    }

    for (let bx = 0; bx < BLOCKS; bx++) {
      for (let bz = 0; bz < BLOCKS; bz++) {
        const lx = x0 + bx * CELL + ROAD / 2;
        const lz = z0 + bz * CELL + ROAD / 2;
        const cx = lx + LOT / 2;
        const cz = lz + LOT / 2;
        const isSpecial = bx === special.bx && bz === special.bz;
        // Sidewalk pad under every block.
        this.boxes.push({ x: cx, z: cz, w: LOT, d: LOT, h: 0.3, color: 0x8a8a86, district });

        if (isSpecial && this.buildLandmark(district, kind, cx, cz)) continue;
        if (kind !== 'harbor' && kind !== 'industrial' && rand() < 0.07) {
          this.buildPark(district, cx, cz, rand);
          continue;
        }
        this.fillBlock(district, kind, lx, lz, cx - center.x, cz - center.z, rand);
      }
    }
  }

  private buildPark(district: number, cx: number, cz: number, rand: () => number): void {
    this.boxes.push({ x: cx, z: cz, w: LOT - 4, d: LOT - 4, h: 0.4, color: 0x3f6b35, district });
    const n = 6 + Math.floor(rand() * 8);
    for (let i = 0; i < n; i++) {
      this.trees.push({ x: cx + (rand() - 0.5) * (LOT - 10), z: cz + (rand() - 0.5) * (LOT - 10), s: 0.8 + rand() * 0.6 });
    }
  }

  /** Returns true if the block was used for a landmark. */
  private buildLandmark(district: number, kind: DistrictKind, cx: number, cz: number): boolean {
    const name = DISTRICT_TEMPLATES[district].name;
    switch (kind) {
      case 'hospital': {
        this.boxes.push({ x: cx, z: cz, w: 50, d: 40, h: 34, color: 0xe8e4dc, windows: true, district, solid: true });
        this.boxes.push({ x: cx - 18, z: cz + 22, w: 26, d: 18, h: 16, color: 0xdcd6cc, windows: true, district, solid: true });
        this.addHelipad(cx, cz, 34, `${name} rooftop`);
        return true;
      }
      case 'university': {
        this.boxes.push({ x: cx, z: cz, w: 44, d: 30, h: 22, color: 0xb9b4a8, windows: true, district, solid: true });
        this.addHelipad(cx, cz, 22, `${name} research lab`);
        return true;
      }
      case 'downtown': {
        this.boxes.push({ x: cx, z: cz, w: 40, d: 40, h: 210, color: 0x5d6c7a, windows: true, district, solid: true });
        this.addHelipad(cx, cz, 210, `${name} tower`);
        return true;
      }
      case 'commercial': {
        this.boxes.push({ x: cx, z: cz, w: 62, d: 50, h: 14, color: 0x9a8f7c, district, solid: true });
        return true;
      }
      case 'industrial': {
        // Power plant: turbine hall and chimneys.
        this.boxes.push({ x: cx, z: cz + 8, w: 56, d: 30, h: 26, color: 0x7d7a74, district, solid: true });
        for (let i = 0; i < 3; i++) this.cylinders.push({ x: cx - 18 + i * 18, z: cz - 18, r: 3.5, h: 75, color: 0x9b958c, district });
        return true;
      }
      case 'harbor': {
        this.buildTankFarm(district, cx, cz);
        return true;
      }
      default:
        return false;
    }
  }

  private buildTankFarm(district: number, cx: number, cz: number): void {
    for (let i = 0; i < 2; i++) {
      for (let j = 0; j < 2; j++) {
        this.cylinders.push({ x: cx - 15 + i * 30, z: cz - 15 + j * 30, r: 11, h: 14, color: 0xd9d6cf, district });
      }
    }
  }

  private fillBlock(district: number, kind: DistrictKind, lx: number, lz: number, ox: number, oz: number, rand: () => number): void {
    const add = (x: number, z: number, w: number, d: number, h: number, color: number, windows = true) =>
      this.boxes.push({ x, z, w, d, h, color, windows, district, solid: true });
    const pick = (colors: number[]) => colors[Math.floor(rand() * colors.length)];

    const grid = (n: number, margin: number, fn: (x: number, z: number, size: number) => void) => {
      const size = (LOT - margin * (n + 1)) / n;
      for (let i = 0; i < n; i++) {
        for (let j = 0; j < n; j++) {
          fn(lx + margin + i * (size + margin) + size / 2, lz + margin + j * (size + margin) + size / 2, size);
        }
      }
    };

    switch (kind) {
      case 'downtown': {
        const falloff = 1 - Math.min(1, Math.hypot(ox, oz) / (DISTRICT_SIZE * 0.6));
        grid(2, 4, (x, z, s) => {
          const h = 25 + rand() * (40 + 140 * falloff * falloff);
          add(x, z, s * (0.8 + rand() * 0.2), s * (0.8 + rand() * 0.2), h, pick([0x55606b, 0x6b7884, 0x7f8a92, 0x4a5560, 0x8c96a0]));
        });
        break;
      }
      case 'apartments':
        grid(2, 6, (x, z, s) => add(x, z, s * 0.9, s * 0.7, 18 + rand() * 30, pick([0xa89f91, 0x9c8f80, 0xb5aa98, 0x8f8a84])));
        break;
      case 'commercial':
        grid(2, 5, (x, z, s) => add(x, z, s * (0.7 + rand() * 0.3), s * (0.7 + rand() * 0.3), 10 + rand() * 25, pick([0xb0a58f, 0x9e9a90, 0xc2b8a3, 0x8d8679])));
        break;
      case 'university':
        this.boxes.push({ x: lx + LOT / 2, z: lz + LOT / 2, w: LOT - 4, d: LOT - 4, h: 0.4, color: 0x4d7a3f, district });
        if (rand() < 0.6) add(lx + LOT / 2, lz + LOT / 2, 20 + rand() * 25, 14 + rand() * 12, 12 + rand() * 12, pick([0xa0705a, 0xb07e63, 0x9a8a78]));
        else this.buildPark(district, lx + LOT / 2, lz + LOT / 2, rand);
        break;
      case 'hospital':
        grid(2, 6, (x, z, s) => add(x, z, s * 0.85, s * 0.85, 9 + rand() * 18, pick([0xd2cbc0, 0xbfb8ad, 0xa79f94])));
        break;
      case 'industrial':
        if (rand() < 0.2) this.buildTankFarm(district, lx + LOT / 2, lz + LOT / 2);
        else add(lx + LOT / 2, lz + LOT / 2, LOT * (0.6 + rand() * 0.3), LOT * (0.5 + rand() * 0.4), 8 + rand() * 7, pick([0x8b8478, 0x7a776f, 0x948d7e]), false);
        break;
      case 'harbor': {
        // Warehouses and container stacks.
        if (rand() < 0.5) {
          add(lx + LOT / 2, lz + LOT / 2, LOT * 0.85, LOT * 0.55, 10 + rand() * 4, pick([0x7b8288, 0x8a7d6c]), false);
        } else {
          for (let i = 0; i < 6; i++) {
            for (let j = 0; j < 3; j++) {
              const stack = 1 + Math.floor(rand() * 3);
              this.boxes.push({
                x: lx + 8 + i * 9.5, z: lz + 12 + j * 18, w: 6, d: 12, h: 2.6 * stack,
                color: pick([0xa8412f, 0x2f6a8a, 0x3e7a3a, 0xc59a2b, 0x7a3f7a]), district, solid: true,
              });
            }
          }
        }
        break;
      }
      case 'residential':
      default:
        grid(3, 4, (x, z, s) => {
          if (rand() < 0.15) return;
          add(x, z, s * (0.6 + rand() * 0.3), s * (0.6 + rand() * 0.3), 6 + rand() * 6, pick([0xc9b79c, 0xb8a58c, 0xd8cdb8, 0xa6957e, 0x9fa7a0]));
        });
    }
  }

  private buildAirbase(district: number, x0: number, z0: number): void {
    const cx = x0 + DISTRICT_SIZE / 2;
    const cz = z0 + DISTRICT_SIZE / 2;
    const name = DISTRICT_TEMPLATES[district].name;
    // Apron, runway and taxiway.
    this.boxes.push({ x: cx, z: cz, w: DISTRICT_SIZE - 20, d: DISTRICT_SIZE - 20, h: 0.2, color: 0x5d6a4e, district });
    this.boxes.push({ x: cx, z: cz + 150, w: 560, d: 45, h: 0.35, color: 0x3a3a3c, district });
    this.boxes.push({ x: cx, z: cz + 60, w: 420, d: 18, h: 0.35, color: 0x46464a, district });
    this.boxes.push({ x: cx - 40, z: cz - 70, w: 360, d: 130, h: 0.35, color: 0x6c6c6c, district });
    for (let i = 0; i < 4; i++) {
      this.boxes.push({ x: cx - 200 + i * 60, z: cz - 210, w: 48, d: 36, h: 14, color: 0x6e7562, district, solid: true });
    }
    this.boxes.push({ x: cx + 180, z: cz - 120, w: 10, d: 10, h: 26, color: 0xb8b2a4, windows: true, district, solid: true });
    this.boxes.push({ x: cx + 180, z: cz - 120, w: 15, d: 15, h: 5, y: 26, color: 0x2f3d44, district, solid: true });
    this.boxes.push({ x: cx + 230, z: cz - 220, w: 60, d: 40, h: 10, color: 0x8a8576, windows: true, district, solid: true });
    // Perimeter fence (thin walls).
    const half = DISTRICT_SIZE / 2 - 12;
    for (const [w, d, dx, dz] of [[DISTRICT_SIZE - 24, 1, 0, -half], [DISTRICT_SIZE - 24, 1, 0, half], [1, DISTRICT_SIZE - 24, -half, 0], [1, DISTRICT_SIZE - 24, half, 0]]) {
      this.boxes.push({ x: cx + dx, z: cz + dz, w, d, h: 3, color: 0x55584f, district, solid: true });
    }
    this.cylinders.push({ x: cx + 240, z: cz - 40, r: 8, h: 10, color: 0xcfcbc2, district });
    this.cylinders.push({ x: cx + 240, z: cz - 10, r: 8, h: 10, color: 0xcfcbc2, district });
    for (let i = 0; i < 4; i++) this.addHelipad(cx - 160 + i * 50, cz - 70, 0.35, i === 0 ? `${name} pad 1` : `${name} pad ${i + 1}`);
  }

  private addHelipad(x: number, z: number, y: number, name: string): void {
    this.helipads.push({ x, z, y, name });
  }

  private buildGround(): void {
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(9000, 9000),
      new THREE.MeshLambertMaterial({ color: 0x55664a }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.05;
    ground.receiveShadow = true;
    this.group.add(ground);

    const asphalt = new THREE.Mesh(
      new THREE.PlaneGeometry(CITY_WIDTH, CITY_DEPTH),
      new THREE.MeshLambertMaterial({ color: 0x3b3d40 }),
    );
    asphalt.rotation.x = -Math.PI / 2;
    asphalt.position.y = 0;
    asphalt.receiveShadow = true;
    this.group.add(asphalt);

    // The sea along the north edge.
    const seaDepth = 4000;
    const sea = new THREE.Mesh(
      new THREE.PlaneGeometry(9000, seaDepth),
      new THREE.MeshPhongMaterial({ color: 0x2d5873, shininess: 80, specular: 0x557788 }),
    );
    sea.rotation.x = -Math.PI / 2;
    sea.position.set(0, 0.02, -CITY_DEPTH / 2 - seaDepth / 2 - 30);
    this.group.add(sea);

    // Harbor piers.
    const harbor = DISTRICT_TEMPLATES.findIndex((d) => d.kind === 'harbor');
    if (harbor >= 0) {
      const c = districtCenter(DISTRICT_TEMPLATES[harbor].col, DISTRICT_TEMPLATES[harbor].row);
      for (let i = 0; i < 4; i++) {
        this.boxes.push({ x: c.x - 220 + i * 140, z: -CITY_DEPTH / 2 - 90, w: 24, d: 160, h: 1.2, color: 0x6f6a60, district: harbor });
      }
    }

    // Helipad markings.
    const tex = helipadTexture();
    const padMat = new THREE.MeshLambertMaterial({ map: tex, transparent: true, polygonOffset: true, polygonOffsetFactor: -2 });
    for (const pad of this.helipads) {
      const m = new THREE.Mesh(new THREE.CircleGeometry(9, 32), padMat);
      m.rotation.x = -Math.PI / 2;
      m.position.set(pad.x, pad.y + 0.05, pad.z);
      this.group.add(m);
    }
  }

  private buildInstances(): void {
    const geometry = new THREE.BoxGeometry(1, 1, 1);
    geometry.translate(0, 0.5, 0);
    const material = new THREE.MeshLambertMaterial();
    this.applyWindowShader(material);

    const mesh = new THREE.InstancedMesh(geometry, material, this.boxes.length);
    const lit = new Float32Array(this.boxes.length);
    const districtIds = new Float32Array(this.boxes.length);
    const m = new THREE.Matrix4();
    const color = new THREE.Color();
    this.boxes.forEach((b, i) => {
      m.makeScale(b.w, b.h, b.d).setPosition(b.x, b.y ?? 0, b.z);
      mesh.setMatrixAt(i, m);
      mesh.setColorAt(i, color.setHex(b.color));
      lit[i] = b.windows ? 1 : 0;
      districtIds[i] = b.district;
    });
    geometry.setAttribute('aLit', new THREE.InstancedBufferAttribute(lit, 1));
    geometry.setAttribute('aDistrict', new THREE.InstancedBufferAttribute(districtIds, 1));
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    this.group.add(mesh);

    const cylGeo = new THREE.CylinderGeometry(1, 1, 1, 18);
    cylGeo.translate(0, 0.5, 0);
    const cyl = new THREE.InstancedMesh(cylGeo, new THREE.MeshLambertMaterial(), this.cylinders.length);
    this.cylinders.forEach((c, i) => {
      m.makeScale(c.r, c.h, c.r).setPosition(c.x, 0, c.z);
      cyl.setMatrixAt(i, m);
      cyl.setColorAt(i, color.setHex(c.color));
    });
    cyl.castShadow = true;
    cyl.receiveShadow = true;
    this.group.add(cyl);

    const treeGeo = new THREE.ConeGeometry(3.2, 9, 7);
    treeGeo.translate(0, 6, 0);
    const trees = new THREE.InstancedMesh(treeGeo, new THREE.MeshLambertMaterial({ color: 0x2f5a2a }), this.trees.length);
    this.trees.forEach((t, i) => {
      m.makeScale(t.s, t.s, t.s).setPosition(t.x, 0, t.z);
      trees.setMatrixAt(i, m);
    });
    trees.castShadow = true;
    this.group.add(trees);
  }

  /** Procedural windows from world position, lit at night per district power level. */
  private applyWindowShader(material: THREE.MeshLambertMaterial): void {
    const count = DISTRICT_TEMPLATES.length;
    material.onBeforeCompile = (shader) => {
      shader.uniforms.uNight = this.windowUniforms.uNight;
      shader.uniforms.uDistrictLight = this.windowUniforms.uDistrictLight;
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          `#include <common>
          attribute float aLit;
          attribute float aDistrict;
          uniform float uDistrictLight[${count}];
          varying vec3 vWinPos;
          varying vec3 vWinNormal;
          varying float vWinLight;`,
        )
        .replace(
          '#include <project_vertex>',
          `#include <project_vertex>
          vec4 winPos = vec4(transformed, 1.0);
          vec3 winNormal = objectNormal;
          #ifdef USE_INSTANCING
            winPos = instanceMatrix * winPos;
            winNormal = mat3(instanceMatrix) * winNormal;
          #endif
          vWinPos = (modelMatrix * winPos).xyz;
          vWinNormal = normalize(mat3(modelMatrix) * winNormal);
          vWinLight = aLit * uDistrictLight[int(aDistrict + 0.5)];`,
        );
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>
          uniform float uNight;
          varying vec3 vWinPos;
          varying vec3 vWinNormal;
          varying float vWinLight;
          float winHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }`,
        )
        .replace(
          '#include <emissivemap_fragment>',
          `#include <emissivemap_fragment>
          if (vWinLight > 0.001 && abs(vWinNormal.y) < 0.5 && vWinPos.y > 1.5) {
            float along = abs(vWinNormal.x) > 0.5 ? vWinPos.z : vWinPos.x;
            vec2 cell = vec2(floor(along / 3.2), floor(vWinPos.y / 3.4));
            vec2 f = vec2(fract(along / 3.2), fract(vWinPos.y / 3.4));
            float pane = step(0.2, f.x) * step(f.x, 0.8) * step(0.25, f.y) * step(f.y, 0.75);
            float h = winHash(cell + floor(vWinPos.xz / 97.0));
            float on = step(1.0 - 0.55 * vWinLight, h);
            vec3 warm = mix(vec3(1.0, 0.78, 0.45), vec3(0.75, 0.85, 1.0), step(0.8, h));
            totalEmissiveRadiance += warm * pane * on * uNight * 1.1;
            diffuseColor.rgb *= 1.0 - pane * 0.35;
          }`,
        );
    };
  }

  private buildColliders(): void {
    const add = (minX: number, maxX: number, minZ: number, maxZ: number, top: number, floor = false) => {
      const index = this.colliders.push({ minX, maxX, minZ, maxZ, top, floor }) - 1;
      for (let gx = Math.floor(minX / COLLISION_CELL); gx <= Math.floor(maxX / COLLISION_CELL); gx++) {
        for (let gz = Math.floor(minZ / COLLISION_CELL); gz <= Math.floor(maxZ / COLLISION_CELL); gz++) {
          const k = this.key(gx, gz);
          const list = this.grid.get(k);
          if (list) list.push(index);
          else this.grid.set(k, [index]);
        }
      }
    };
    for (const b of this.boxes) {
      if (!b.solid && b.h > 2) continue;
      add(b.x - b.w / 2, b.x + b.w / 2, b.z - b.d / 2, b.z + b.d / 2, (b.y ?? 0) + b.h, !b.solid);
    }
    for (const c of this.cylinders) add(c.x - c.r, c.x + c.r, c.z - c.r, c.z + c.r, c.h);
  }

  private key(gx: number, gz: number): number {
    return (gx + 1000) * 4096 + (gz + 1000);
  }

  private cellKey(x: number, z: number): number {
    return this.key(Math.floor(x / COLLISION_CELL), Math.floor(z / COLLISION_CELL));
  }
}

function helipadTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  g.fillStyle = '#2b2f33';
  g.beginPath();
  g.arc(64, 64, 63, 0, Math.PI * 2);
  g.fill();
  g.strokeStyle = '#e8e3d0';
  g.lineWidth = 6;
  g.beginPath();
  g.arc(64, 64, 52, 0, Math.PI * 2);
  g.stroke();
  g.fillStyle = '#e8e3d0';
  g.font = 'bold 72px sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText('H', 64, 68);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
