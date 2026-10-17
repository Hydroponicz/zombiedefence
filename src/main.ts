import * as THREE from 'three';
import { ChaseCamera } from './heli/ChaseCamera';
import { Helicopter } from './heli/Helicopter';
import { Input, type FrameInput } from './input/Input';
import { districtAt } from './sim/layout';
import { SimClient } from './sim/SimClient';
import { DebugMap } from './ui/DebugMap';
import { Hud } from './ui/Hud';
import { City } from './world/City';
import { Environment } from './world/Environment';

const params = new URLSearchParams(location.search);
const seed = params.get('seed') ?? String(Math.floor(Math.random() * 1e6));

const PHYSICS_STEP = 1 / 120;
const RESPAWN_SECONDS = 4;
const MAP_REFRESH = 1 / 15;
const POWER_LIGHT = { on: 1, backup: 0.35, dark: 0 } as const;

const canvas = document.getElementById('game') as HTMLCanvasElement;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(62, window.innerWidth / window.innerHeight, 0.5, 6000);
const environment = new Environment(scene);
const city = new City(seed);
scene.add(city.group);

const heli = new Helicopter();
scene.add(heli.object);
const spawn = city.helipads.find((p) => p.name.startsWith('Fort Kessler')) ?? { x: 0, y: 0, z: 0, name: 'base' };
heli.reset(spawn.x, spawn.y, spawn.z, 0);

const chase = new ChaseCamera(camera);
const input = new Input(canvas);
const hud = new Hud();
const map = new DebugMap(document.getElementById('map') as HTMLCanvasElement);
const pauseEl = document.getElementById('pause')!;

const sim = new SimClient(seed);
sim.onEvents = (events) => hud.addEvents(events);

input.onGamepadChange = (name) => hud.toast(name ? 'Controller connected' : 'Controller disconnected', 2);

let paused = false;
let respawnTimer = 0;
let accumulator = 0;
let mapTimer = 0;
let firstInput = false;
const NEUTRAL = { collective: 0, yaw: 0, pitch: 0, roll: 0 };

function setPaused(value: boolean): void {
  paused = value;
  pauseEl.hidden = !value;
  sim.paused = value;
  if (value) input.releasePointer();
}

function handleActions(frame: FrameInput): void {
  const a = frame.actions;
  if (map.visible) {
    if (a.has('map') || a.has('back')) {
      map.toggle();
      return;
    }
    if (a.has('next')) map.cycleOverlay(1);
    if (a.has('prev')) map.cycleOverlay(-1);
    if (a.has('dpadLeft') || a.has('arrowLeft')) map.moveSelection(-1, 0);
    if (a.has('dpadRight') || a.has('arrowRight')) map.moveSelection(1, 0);
    if (a.has('dpadUp') || a.has('arrowUp')) map.moveSelection(0, -1);
    if (a.has('dpadDown') || a.has('arrowDown')) map.moveSelection(0, 1);
    if (a.has('rtPress')) sim.changeTimeScale(1);
    if (a.has('ltPress')) sim.changeTimeScale(-1);
    for (let i = 1; i <= 6; i++) if (a.has(`overlay${i}`)) map.setOverlay(i - 1);
  } else {
    if (a.has('pause')) setPaused(!paused);
    if (paused) return;
    if (a.has('map')) {
      map.toggle();
      input.releasePointer();
    }
  }
  if (paused) return;
  if (a.has('help')) hud.toggleHelp();
  if (a.has('padDebug')) hud.togglePadReadout();
  if (a.has('camera')) chase.cycleDistance();
  if (a.has('searchlight')) hud.toast(heli.toggleSearchlight() ? 'Searchlight on' : 'Searchlight off', 1.2);
  if (a.has('timeFaster') || (!map.visible && a.has('dpadRight'))) sim.changeTimeScale(1);
  if (a.has('timeSlower') || (!map.visible && a.has('dpadLeft'))) sim.changeTimeScale(-1);
}

function update(dt: number): void {
  const frame = input.poll();
  handleActions(frame);
  const controllerStatus = input.controllerStatus();
  hud.setControllerStatus(controllerStatus, input.lastPad !== null);
  hud.showPad(input.lastPad, controllerStatus);
  if (!firstInput && (frame.collective || frame.pitch || frame.roll || frame.yaw)) {
    firstInput = true;
    setTimeout(() => hud.hideHelp(), 6000);
  }
  if (paused) return;

  sim.update(dt);

  // While the map is open the helicopter hovers on its own.
  const flight = map.visible ? NEUTRAL : frame;
  accumulator = Math.min(accumulator + dt, 0.25);
  while (accumulator >= PHYSICS_STEP) {
    heli.update(PHYSICS_STEP, flight, city);
    accumulator -= PHYSICS_STEP;
  }

  if (heli.destroyed) {
    if (respawnTimer === 0) hud.toast('Helicopter destroyed', RESPAWN_SECONDS);
    respawnTimer += dt;
    if (respawnTimer > RESPAWN_SECONDS) {
      respawnTimer = 0;
      heli.reset(spawn.x, spawn.y, spawn.z, 0);
      hud.toast(`Replacement helicopter ready at ${spawn.name}`, 3);
    }
  }

  chase.update(dt, heli, map.visible ? { ...frame, lookX: 0, lookY: 0, mouseX: 0, mouseY: 0, zoom: 0 } : frame, (x, z) => city.surfaceHeight(x, z));
  const night = environment.update(sim.time, heli.position);
  city.setNight(night);

  const state = sim.state;
  if (state) {
    state.districts.forEach((d, i) => city.setDistrictLight(i, POWER_LIGHT[d.power]));
  }

  const districtIndex = districtAt(heli.position.x, heli.position.z);
  const forward = (-heli.yaw * 180) / Math.PI;
  hud.update(dt, sim.time, sim.timeScale, state && districtIndex >= 0 ? state.districts[districtIndex] : null, {
    altitude: heli.position.y - 1.9 - city.surfaceHeight(heli.position.x, heli.position.z),
    speed: heli.speed,
    verticalSpeed: heli.velocity.y,
    heading: ((forward % 360) + 360) % 360,
    health: heli.health,
    landed: heli.landed,
    destroyed: heli.destroyed,
    searchlight: heli.searchlight.intensity > 0,
  });

  if (map.visible) {
    mapTimer -= dt;
    if (mapTimer <= 0) {
      mapTimer = MAP_REFRESH;
      map.draw(state, { heliX: heli.position.x, heliZ: heli.position.z, heliYaw: heli.yaw, timeScale: sim.timeScale });
    }
  }
}

const timer = new THREE.Timer();
renderer.setAnimationLoop((time) => {
  timer.update(time);
  update(Math.min(timer.getDelta(), 0.1));
  renderer.render(scene, camera);
});

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// Handy for debugging from the console.
Object.assign(window, { game: { sim, heli, city, seed, input, map } });
