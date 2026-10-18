// Night lighting without lights. A forward renderer pays for every real light on every fragment, so
// the city's thousands of lamps, shop fronts and headlights are done another way:
//
// - Baked light: streetlights, shop fronts, neon and floodlights are splatted once, when the city
//   is built, into a top-down texture over the whole city (4 m a texel): red is streetlight, green
//   is light spilling from buildings, blue is neon. Each district's share is switched by its power
//   in the shader, so a blackout still goes dark district by district.
// - A light buffer: each frame the moving lights near the helicopter (headlights, police lights,
//   weapon flashlights) are drawn as soft additive shapes into a small top-down render target that
//   follows the helicopter, a few thousand quads in one draw call.
//
// Every lit material samples both with a couple of texture reads and adds the light to its diffuse
// lighting, falling off with height above the street, so the dead walking into a car's headlights
// or a soldier's flashlight are lit by it, and so are the walls and the street.

import * as THREE from 'three';
import { CITY_DEPTH, CITY_WIDTH, DISTRICT_SIZE, DISTRICT_TEMPLATES, GRID_COLS, GRID_ROWS } from '../sim/layout';

/** Metres per texel of the baked light. */
const BAKE_TEXEL = 4;
const BAKE_MARGIN = 60;
/** The light buffer: texels across and metres per texel. */
const BUFFER_SIZE = 512;
const BUFFER_TEXEL = 1.5;
const BUFFER_SPAN = BUFFER_SIZE * BUFFER_TEXEL;
/** Moving lights drawn at most each frame. */
const MAX_LIGHTS = 4096;

/** Kinds of moving light. */
export const enum Glow {
  Headlight = 0,
  Flashlight = 1,
  /** Police light bar: a pool flashing red and blue. */
  Police = 2,
}

export const enum Bake {
  Street = 0,
  Spill = 1,
  Neon = 2,
}

class CityLight {
  readonly bounds = new THREE.Vector4();
  private bakeW: number;
  private bakeH: number;
  private acc: Float32Array;
  private texture: THREE.DataTexture;
  /** Per district cell: (streetlights on, building light level). */
  private cellPower = Array.from({ length: GRID_COLS * GRID_ROWS }, () => new THREE.Vector2(1, 1));

  private target: THREE.WebGLRenderTarget;
  private scene = new THREE.Scene();
  private camera = new THREE.Camera();
  private a: THREE.InstancedBufferAttribute;
  private b: THREE.InstancedBufferAttribute;
  private geometry: THREE.InstancedBufferGeometry;
  private count = 0;
  private origin = new THREE.Vector3(0, 0, 1 / BUFFER_SPAN);

  readonly uniforms: Record<string, THREE.IUniform>;

  constructor() {
    const x0 = -CITY_WIDTH / 2 - BAKE_MARGIN;
    const z0 = -CITY_DEPTH / 2 - BAKE_MARGIN;
    this.bakeW = Math.ceil((CITY_WIDTH + BAKE_MARGIN * 2) / BAKE_TEXEL);
    this.bakeH = Math.ceil((CITY_DEPTH + BAKE_MARGIN * 2) / BAKE_TEXEL);
    this.bounds.set(x0, z0, 1 / (this.bakeW * BAKE_TEXEL), 1 / (this.bakeH * BAKE_TEXEL));
    this.acc = new Float32Array(this.bakeW * this.bakeH * 3);
    this.texture = new THREE.DataTexture(new Uint8Array(this.bakeW * this.bakeH * 4), this.bakeW, this.bakeH, THREE.RGBAFormat);
    this.texture.magFilter = THREE.LinearFilter;
    this.texture.minFilter = THREE.LinearFilter;

    this.target = new THREE.WebGLRenderTarget(BUFFER_SIZE, BUFFER_SIZE, {
      type: THREE.HalfFloatType, depthBuffer: false, magFilter: THREE.LinearFilter, minFilter: THREE.LinearFilter,
    });
    this.uniforms = {
      uCityLight: { value: this.texture },
      uCityBounds: { value: this.bounds },
      uCityPower: { value: this.cellPower },
      uLightBuffer: { value: this.target.texture },
      uLightOrigin: { value: this.origin },
      uCityNight: { value: 0 },
      uCityTime: { value: 0 },
    };

    // One quad per light: x across in [-0.5, 0.5], y along in [0, 1].
    const quad = new THREE.PlaneGeometry(1, 1);
    quad.translate(0, 0.5, 0);
    this.geometry = new THREE.InstancedBufferGeometry();
    this.geometry.index = quad.index;
    this.geometry.setAttribute('position', quad.getAttribute('position'));
    this.a = new THREE.InstancedBufferAttribute(new Float32Array(MAX_LIGHTS * 4), 4).setUsage(THREE.DynamicDrawUsage);
    this.b = new THREE.InstancedBufferAttribute(new Float32Array(MAX_LIGHTS * 4), 4).setUsage(THREE.DynamicDrawUsage);
    this.geometry.setAttribute('aA', this.a);
    this.geometry.setAttribute('aB', this.b);
    this.geometry.instanceCount = 0;
    const mesh = new THREE.Mesh(this.geometry, new THREE.ShaderMaterial({
      uniforms: { uOrigin: { value: this.origin }, uTime: this.uniforms.uCityTime },
      vertexShader: `
        attribute vec4 aA; // x, z, heading, kind
        attribute vec4 aB; // length, width, intensity, phase
        uniform vec3 uOrigin;
        uniform float uTime;
        varying vec2 vUv;
        varying vec3 vColor;
        varying float vKind;
        void main() {
          vUv = position.xy;
          vKind = aA.w;
          vec2 fwd = vec2(-sin(aA.z), -cos(aA.z));
          vec2 right = vec2(-fwd.y, fwd.x);
          vec2 p = aA.xy;
          vec2 world = vKind > 1.5
            ? p + vec2(position.x, position.y - 0.5) * aB.x
            : p + fwd * position.y * aB.x + right * position.x * aB.y;
          if (vKind < 0.5) vColor = vec3(1.0, 0.9, 0.72);
          else if (vKind < 1.5) vColor = vec3(0.82, 0.9, 1.0);
          else {
            // Red and blue in turn, each with a double strobe.
            float t = fract(uTime * 1.6 + aB.w);
            float strobe = step(0.5, fract(t * 4.0));
            vColor = (t < 0.5 ? vec3(1.0, 0.08, 0.05) : vec3(0.1, 0.25, 1.0)) * (0.35 + 0.65 * strobe);
          }
          vColor *= aB.z;
          gl_Position = vec4((world - uOrigin.xy) * uOrigin.z * 2.0 - 1.0, 0.0, 1.0);
        }`,
      fragmentShader: `
        varying vec2 vUv;
        varying vec3 vColor;
        varying float vKind;
        void main() {
          float k;
          if (vKind > 1.5) {
            float r = length(vec2(vUv.x, vUv.y - 0.5)) * 2.0;
            k = (1.0 - r) * (1.0 - r);
          } else {
            // A cone widening down the beam, brightest near the lamp, faded at its end.
            float along = vUv.y;
            float hw = mix(0.16, 0.5, along);
            float across = abs(vUv.x);
            k = (1.0 - smoothstep(hw * 0.5, hw, across)) * pow(1.0 - along, 1.4) * smoothstep(0.0, 0.06, along);
          }
          gl_FragColor = vec4(vColor * max(k, 0.0), 1.0);
        }`,
      blending: THREE.AdditiveBlending,
      depthTest: false,
      depthWrite: false,
      transparent: true,
      side: THREE.DoubleSide,
    }));
    mesh.frustumCulled = false;
    this.scene.add(mesh);
  }

  // --- Baking ----------------------------------------------------------------------------------

  /** Add a soft round splat of light to one channel of the baked light. */
  splat(channel: Bake, x: number, z: number, radius: number, intensity: number): void {
    const cx = (x - this.bounds.x) / BAKE_TEXEL - 0.5;
    const cz = (z - this.bounds.y) / BAKE_TEXEL - 0.5;
    const r = radius / BAKE_TEXEL;
    const i0 = Math.max(0, Math.floor(cx - r));
    const i1 = Math.min(this.bakeW - 1, Math.ceil(cx + r));
    const j0 = Math.max(0, Math.floor(cz - r));
    const j1 = Math.min(this.bakeH - 1, Math.ceil(cz + r));
    const r2 = r * r;
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const d2 = ((i - cx) ** 2 + (j - cz) ** 2) / r2;
        if (d2 >= 1) continue;
        this.acc[(j * this.bakeW + i) * 3 + channel] += intensity * (1 - d2) * (1 - d2);
      }
    }
  }

  /** Light along a straight run (a lit shop front), splatted every few metres. */
  strip(channel: Bake, ax: number, az: number, bx: number, bz: number, radius: number, intensity: number): void {
    const len = Math.hypot(bx - ax, bz - az);
    const n = Math.max(1, Math.round(len / BAKE_TEXEL));
    for (let k = 0; k <= n; k++) this.splat(channel, ax + ((bx - ax) * k) / n, az + ((bz - az) * k) / n, radius, intensity * 0.5);
  }

  /** Squash the splats into the texture (each channel saturating softly) and drop the scratch buffer. */
  finishBake(): void {
    const data = this.texture.image.data as Uint8Array;
    for (let k = 0, n = this.bakeW * this.bakeH; k < n; k++) {
      for (let c = 0; c < 3; c++) data[k * 4 + c] = Math.round(255 * (1 - Math.exp(-this.acc[k * 3 + c] * 1.3)));
      data[k * 4 + 3] = 255;
    }
    this.texture.needsUpdate = true;
    this.acc = new Float32Array(0);
  }

  // --- Each frame --------------------------------------------------------------------------------

  setNight(night: number, time: number): void {
    this.uniforms.uCityNight.value = night;
    this.uniforms.uCityTime.value = time;
  }

  /** A district's power: streetlights burn on the grid alone; buildings at their light level. */
  setDistrictPower(district: number, level: number): void {
    const tpl = DISTRICT_TEMPLATES[district];
    this.cellPower[tpl.row * GRID_COLS + tpl.col].set(level >= 0.99 ? 1 : 0, level);
  }

  /** Moving lights drawn this frame. */
  get lights(): number {
    return this.count;
  }

  get night(): number {
    return this.uniforms.uCityNight.value;
  }

  /** Start a frame's moving lights around (cx, cz). */
  begin(cx: number, cz: number): void {
    this.count = 0;
    this.origin.x = Math.floor((cx - BUFFER_SPAN / 2) / BUFFER_TEXEL) * BUFFER_TEXEL;
    this.origin.y = Math.floor((cz - BUFFER_SPAN / 2) / BUFFER_TEXEL) * BUFFER_TEXEL;
  }

  /**
   * A moving light: a beam from (x, z) along heading (forward is (-sin, -cos)) `length` long and
   * `width` wide at its end, or for the police a pool `length` across.
   */
  add(kind: Glow, x: number, z: number, heading: number, length: number, width: number, intensity: number, phase = 0): void {
    if (this.count >= MAX_LIGHTS) return;
    const dx = x - this.origin.x;
    const dz = z - this.origin.y;
    if (dx < -length || dz < -length || dx > BUFFER_SPAN + length || dz > BUFFER_SPAN + length) return;
    const o = this.count++ * 4;
    const a = this.a.array as Float32Array;
    const b = this.b.array as Float32Array;
    a[o] = x;
    a[o + 1] = z;
    a[o + 2] = heading;
    a[o + 3] = kind;
    b[o] = length;
    b[o + 1] = width;
    b[o + 2] = intensity;
    b[o + 3] = phase;
  }

  /** Draw this frame's moving lights into the light buffer. */
  render(renderer: THREE.WebGLRenderer): void {
    this.geometry.instanceCount = this.count;
    this.a.clearUpdateRanges();
    this.b.clearUpdateRanges();
    this.a.addUpdateRange(0, this.count * 4);
    this.b.addUpdateRange(0, this.count * 4);
    this.a.needsUpdate = true;
    this.b.needsUpdate = true;
    const previous = renderer.getRenderTarget();
    const autoClear = renderer.autoClear;
    renderer.autoClear = true;
    renderer.setRenderTarget(this.target);
    renderer.setClearColor(0x000000, 1);
    renderer.clear(true, false, false);
    if (this.count > 0) renderer.render(this.scene, this.camera);
    renderer.setRenderTarget(previous);
    renderer.autoClear = autoClear;
  }

  /**
   * Light a material by the city at night: its diffuse lighting gains the baked light and the light
   * buffer at its fragment's place, fading with height above the street.
   */
  patch(material: THREE.Material): void {
    if (material.userData.cityLit) return;
    material.userData.cityLit = true;
    const previous = material.onBeforeCompile;
    const previousKey = material.customProgramCacheKey();
    material.onBeforeCompile = (shader, renderer) => {
      previous.call(material, shader, renderer);
      Object.assign(shader.uniforms, this.uniforms);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>
          varying vec3 vCityPos;`)
        .replace('#include <project_vertex>', `#include <project_vertex>
          vec4 cityPos = vec4(transformed, 1.0);
          #ifdef USE_INSTANCING
            cityPos = instanceMatrix * cityPos;
          #endif
          vCityPos = (modelMatrix * cityPos).xyz;`);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>
          ${CITY_LIGHT_GLSL}`)
        .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
          {
            vec3 cityN = normalize((vec4(normal, 0.0) * viewMatrix).xyz);
            // Dark asphalt still shows a sheen under street light.
            reflectedLight.directDiffuse += (diffuseColor.rgb * 0.85 + 0.06) * cityGlow(vCityPos, cityN.y) * (0.55 + 0.45 * max(cityN.y, 0.0));
          }`);
    };
    material.customProgramCacheKey = () => `city-light|${previousKey}|${previous.toString()}`;
    material.needsUpdate = true;
  }
}

/**
 * Lamps on a vehicle that glow at night, marked per vertex by `aGlow`: 1 headlight, 2 tail light,
 * 3 and 4 the red and blue halves of a police light bar, flashing by a per-instance `aPhase`.
 * The material must also be patched by cityLight, which declares the night and time uniforms.
 */
export function vehicleLamps(material: THREE.Material, police: boolean): void {
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        attribute float aGlow;
        ${police ? 'attribute float aPhase;' : ''}
        varying float vGlow;
        varying float vPhase;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vGlow = aGlow;
        vPhase = ${police ? 'aPhase' : '0.0'};`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        varying float vGlow;
        varying float vPhase;`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        if (vGlow > 0.5) {
          float lit = smoothstep(0.15, 0.5, uCityNight);
          if (vGlow < 1.5) totalEmissiveRadiance += vec3(1.0, 0.95, 0.82) * 3.0 * lit;
          else if (vGlow < 2.5) totalEmissiveRadiance += vec3(1.0, 0.06, 0.03) * 1.6 * lit;
          else {
            float t = fract(uCityTime * 1.6 + vPhase);
            float on = (vGlow < 3.5 ? 1.0 - step(0.5, t) : step(0.5, t)) * (0.3 + 0.7 * step(0.5, fract(t * 4.0)));
            totalEmissiveRadiance += (vGlow < 3.5 ? vec3(1.0, 0.1, 0.06) : vec3(0.15, 0.3, 1.0)) * 3.0 * on * max(lit, 0.35);
          }
        }`);
  };
  material.customProgramCacheKey = () => `vehicle-lamps-${police}`;
}

/** Shader code shared by every lit material (and the window shader, for shop fronts). */
const CITY_LIGHT_GLSL = `
  uniform sampler2D uCityLight;
  uniform vec4 uCityBounds;
  uniform vec2 uCityPower[${GRID_COLS * GRID_ROWS}];
  uniform sampler2D uLightBuffer;
  uniform vec3 uLightOrigin;
  uniform float uCityNight;
  uniform float uCityTime;
  varying vec3 vCityPos;
  vec2 cityPowerAt(vec2 xz) {
    ivec2 cell = ivec2(floor(xz / ${DISTRICT_SIZE.toFixed(1)} + vec2(${(GRID_COLS / 2).toFixed(1)}, ${(GRID_ROWS / 2).toFixed(1)})));
    if (cell.x < 0 || cell.y < 0 || cell.x >= ${GRID_COLS} || cell.y >= ${GRID_ROWS}) return vec2(1.0);
    return uCityPower[cell.y * ${GRID_COLS} + cell.x];
  }
  /** Neon colours by block. */
  vec3 cityNeon(vec2 xz) {
    float h = fract(sin(dot(floor(xz / 36.0), vec2(41.3, 289.1))) * 43758.5453);
    return h < 0.25 ? vec3(1.0, 0.15, 0.55) : h < 0.5 ? vec3(0.1, 0.85, 1.0) : h < 0.75 ? vec3(1.0, 0.3, 0.1) : vec3(0.55, 0.25, 1.0);
  }
  /** The baked light at a place: (street, spill, neon). */
  vec3 cityBaked(vec2 xz) {
    vec2 uv = (xz - uCityBounds.xy) * uCityBounds.zw;
    if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) return vec3(0.0);
    return texture2D(uCityLight, uv).rgb;
  }
  /** Light from the streets at a place, for a surface facing up by \`up\` (the normal's y). */
  vec3 cityGlow(vec3 wp, float up) {
    vec3 light = vec3(0.0);
    if (uCityNight > 0.05) {
      // Street-level light climbs the walls a little way; roofs above the lamps stay dark.
      float roof = smoothstep(0.5, 0.9, up);
      float lift = 1.0 - smoothstep(mix(5.0, 1.5, roof), mix(24.0, 9.0, roof), wp.y);
      if (lift > 0.0) {
        vec3 s = cityBaked(wp.xz);
        vec2 power = cityPowerAt(wp.xz);
        float lamps = smoothstep(0.35, 0.6, uCityNight) * power.x;
        light += (s.r * vec3(1.0, 0.7, 0.42) * 3.2 * lamps
          + s.g * vec3(1.0, 0.84, 0.62) * 2.2 * power.y
          + s.b * cityNeon(wp.xz) * 1.8 * lamps) * uCityNight * lift;
      }
      vec2 duv = (wp.xz - uLightOrigin.xy) * uLightOrigin.z;
      if (duv.x > 0.0 && duv.y > 0.0 && duv.x < 1.0 && duv.y < 1.0) {
        float dynLift = 1.0 - smoothstep(mix(2.5, 1.0, roof), mix(12.0, 3.5, roof), wp.y);
        light += texture2D(uLightBuffer, duv).rgb * 3.0 * dynLift * smoothstep(0.15, 0.55, uCityNight);
      }
    }
    return light;
  }
`;

export const cityLight = new CityLight();
