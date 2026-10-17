import * as THREE from 'three';
import { FARP_RADIUS, Operations } from './game/Operations';
import { ChaseCamera } from './heli/ChaseCamera';
import { FUEL_CAPACITY, Helicopter } from './heli/Helicopter';
import { Input, type FrameInput } from './input/Input';
import { districtAt } from './sim/layout';
import { baseOf, farpNear, MAX_PAYLOAD_KG, payloadKg } from './sim/operations';
import { SimClient } from './sim/SimClient';
import { CommandPanel } from './ui/CommandPanel';
import { DebugMap } from './ui/DebugMap';
import { Hud } from './ui/Hud';
import { Agents } from './world/Agents';
import { AiFleet } from './world/AiFleet';
import { City } from './world/City';
import { Effects } from './world/Effects';
import { Environment } from './world/Environment';
import { Farps } from './world/Farps';
import { Sites } from './world/Sites';
import { Traffic } from './world/Traffic';
import { siteNear } from './sim/sites';

const params = new URLSearchParams(location.search);
const seed = params.get('seed') ?? String(Math.floor(Math.random() * 1e6));

const PHYSICS_STEP = 1 / 120;
const RESPAWN_SECONDS = 4;
const MAP_REFRESH = 1 / 15;
const POWER_LIGHT = { on: 1, backup: 0.35, dark: 0 } as const;
/** How often rotor noise is reported to the simulation, in real seconds. */
const NOISE_REPORT_SECONDS = 1;
const NOISE_PER_REPORT = 0.15;
/** Below this ground speed (m/s) a landed helicopter counts as parked for ground operations. */
const PARKED_SPEED = 2;
const HELIPAD_RADIUS = 12;
/** The HUD names a strategic site when the helicopter is within this many metres of it. */
const SITE_HUD_RADIUS = 150;
const SKID_DEPTH = 1.9;
/** A slung bladder released lower than this (metres) survives the drop. */
const SLING_SAFE_DROP = 4;

const canvas = document.getElementById('game') as HTMLCanvasElement;
// A logarithmic depth buffer: the city is drawn out to 20 km, and the thin ground layers (sidewalk,
// lawn, car park, landing pad) would otherwise flicker against each other in the distance.
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance', logarithmicDepthBuffer: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(62, window.innerWidth / window.innerHeight, 0.5, 20000);
const environment = new Environment(scene);
const city = new City(seed);
scene.add(city.group);
const effects = new Effects(seed, city.fuelSites);
scene.add(effects.group);
const agents = new Agents(seed, effects, city.walk);
scene.add(agents.group);
const farps = new Farps();
scene.add(farps.group);
const sites = new Sites(seed);
scene.add(sites.group);
const traffic = new Traffic();
scene.add(traffic.group);
const fleet = new AiFleet(city.helipads);
scene.add(fleet.group);

const heli = new Helicopter();
scene.add(heli.object, heli.slingObject);
const spawn = city.helipads.find((p) => p.name.startsWith('Fort Kessler')) ?? { x: 0, y: 0, z: 0, name: 'base' };
heli.reset(spawn.x, spawn.y, spawn.z, 0);

const chase = new ChaseCamera(camera);
const input = new Input(canvas);
const hud = new Hud();
const map = new DebugMap(document.getElementById('map') as HTMLCanvasElement);
const pauseEl = document.getElementById('pause')!;
const command = new CommandPanel(document.getElementById('command')!, (cmd) => sim.command(cmd));

const sim = new SimClient(seed);
sim.onEvents = (events) => hud.addEvents(events);
const ops = new Operations(
  (cmd) => sim.command(cmd),
  (litres) => (heli.fuel = Math.min(FUEL_CAPACITY, heli.fuel + litres)),
  () => {
    hud.toast('Crew recovered. A replacement helicopter is waiting at the base', 4);
    respawn();
  },
);
ops.onToast = (text) => hud.toast(text, 2.5);

input.onGamepadChange = (name) => hud.toast(name ? 'Controller connected' : 'Controller disconnected', 2);

let paused = false;
let respawnTimer = 0;
let accumulator = 0;
let mapTimer = 0;
let firstInput = false;
let noiseTimer = 0;
let lastSyncedState: unknown = null;
const NEUTRAL = { collective: 0, yaw: 0, pitch: 0, roll: 0 };

function setPaused(value: boolean): void {
  paused = value;
  pauseEl.hidden = !value;
  sim.paused = value;
  if (value) input.releasePointer();
}

function handleActions(frame: FrameInput): void {
  const a = frame.actions;
  if (command.visible) {
    if (a.has('command') || a.has('back')) command.toggle();
    else command.handle(a);
    return;
  }
  if (map.visible) {
    if (a.has('map') || a.has('back')) {
      map.toggle();
      return;
    }
    // Y on the map opens flight command.
    if (a.has('searchlight') || a.has('command')) {
      map.toggle();
      command.toggle();
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
    for (let i = 1; i <= 7; i++) if (a.has(`overlay${i}`)) map.setOverlay(i - 1);
  } else {
    if (a.has('pause')) setPaused(!paused);
    if (paused) return;
    if (a.has('map')) {
      map.toggle();
      input.releasePointer();
    }
    if (a.has('command')) {
      command.toggle();
      input.releasePointer();
    }
  }
  if (paused) return;
  if (a.has('help')) hud.toggleHelp();
  if (a.has('padDebug')) hud.togglePadReadout();
  if (a.has('camera')) chase.cycleDistance();
  if (a.has('searchlight')) hud.toast(heli.toggleSearchlight() ? 'Searchlight on' : 'Searchlight off', 1.2);
  if (a.has('sling')) releaseSling();
  if (a.has('timeFaster') || (!map.visible && a.has('dpadRight'))) sim.changeTimeScale(1);
  if (a.has('timeSlower') || (!map.visible && a.has('dpadLeft'))) sim.changeTimeScale(-1);
}

/** A fresh helicopter at the base, fuelled from the base's stores. */
function respawn(): void {
  const stores = sim.state ? baseOf(sim.state).fuel : FUEL_CAPACITY;
  const fuel = Math.min(FUEL_CAPACITY, stores);
  heli.reset(spawn.x, spawn.y, spawn.z, 0, fuel);
  if (sim.state && fuel > 0) sim.command({ type: 'refuel', source: { district: baseOf(sim.state).id }, litres: fuel });
  if (fuel < FUEL_CAPACITY) hud.toast(`Base fuel is low: only ${Math.floor(fuel)} L for the replacement`, 4);
}

/** Let go of the slung bladder: set down gently it delivers its fuel, dropped from height it bursts. */
function releaseSling(): void {
  const state = sim.state;
  if (!state || state.cargo.sling <= 0 || heli.destroyed) return;
  const b = heli.bladder;
  const district = districtAt(b.x, b.z);
  if (heli.bladderClearance < SLING_SAFE_DROP && district >= 0) {
    const farp = farpNear(state, b.x, b.z, FARP_RADIUS + 10);
    sim.command({ type: 'releaseBladder', district, farp: farp?.id });
    hud.toast(farp ? 'Fuel delivered to the refuelling point' : 'Fuel bladder set down', 2);
  } else {
    sim.command({ type: 'burstBladder', district });
    hud.toast('Dropped from too high: the bladder burst', 2.5);
  }
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

  // While the map or flight command is open the helicopter hovers on its own.
  const overlay = map.visible || command.visible;
  const flight = overlay ? NEUTRAL : frame;
  const cargo = sim.state?.cargo;
  heli.load = cargo ? Math.min(1, payloadKg(cargo) / MAX_PAYLOAD_KG) : 0;
  heli.grabbers = agents.attract.grabbers;
  heli.sling = cargo?.sling ?? 0;
  accumulator = Math.min(accumulator + dt, 0.25);
  while (accumulator >= PHYSICS_STEP) {
    heli.update(PHYSICS_STEP, flight, city);
    accumulator -= PHYSICS_STEP;
  }

  if (heli.destroyed) {
    if (respawnTimer === 0) {
      hud.toast('Helicopter destroyed', RESPAWN_SECONDS);
      sim.command({ type: 'crash', district: districtAt(heli.position.x, heli.position.z) });
    }
    respawnTimer += dt;
    if (respawnTimer > RESPAWN_SECONDS) {
      respawnTimer = 0;
      respawn();
      hud.toast(`Replacement helicopter ready at ${spawn.name}`, 3);
    }
  }

  chase.update(dt, heli, overlay ? { ...frame, lookX: 0, lookY: 0, mouseX: 0, mouseY: 0, zoom: 0 } : frame, (x, z) => city.surfaceHeight(x, z));
  const night = environment.update(sim.time, heli.position);
  city.setNight(night);

  const state = sim.state;
  if (state && state !== lastSyncedState) {
    lastSyncedState = state;
    state.districts.forEach((d, i) => city.setDistrictLight(i, POWER_LIGHT[d.power]));
    effects.syncWithSim(state);
    farps.sync(state.farps);
    sites.sync(state.sites);
  }

  const surface = city.surfaceHeight(heli.position.x, heli.position.z);
  const altitude = heli.position.y - SKID_DEPTH - surface;
  const clearance = heli.position.y - SKID_DEPTH;
  agents.update(dt, heli.position, altitude, heli.destroyed ? 0 : heli.rotor, state, night, clearance, sim.time);
  if (!heli.destroyed) agents.doorGunners(dt, heli.position, state?.cargo.troops ?? 0);
  effects.update(dt, night);
  farps.update(dt);
  sites.update(dt, night);
  traffic.update(state, sim.time);
  fleet.update(dt, state, sim.time);

  // Ground operations: loading, deploying, evacuating.
  const atHelipad = city.helipads.some((p) => Math.hypot(p.x - heli.position.x, p.z - heli.position.z) < HELIPAD_RADIUS && Math.abs(p.y - surface) < 1);
  ops.update(dt, {
    landed: heli.landed && heli.speed < PARKED_SPEED && !heli.destroyed,
    district: districtAt(heli.position.x, heli.position.z),
    onRoof: surface > 3 && !atHelipad,
    threat: agents.attract.threat,
    grabbers: agents.attract.grabbers,
    x: heli.position.x,
    z: heli.position.z,
    fuel: heli.fuel,
    fuelCapacity: FUEL_CAPACITY,
  }, state, overlay ? new Set() : frame.actions);
  hud.updateOps(overlay ? null : ops.view, frame.usingGamepad);
  command.render(state);
  if (state) {
    const pilots = state.pilots.filter((p) => p.hired && p.status !== 'dead' && p.status !== 'deserted').length;
    hud.updateCargo(state.cargo, state.stats, state.research, pilots);
  }

  // Hovering low is loud: report it so the simulation draws zombies in from nearby districts.
  noiseTimer -= dt;
  if (noiseTimer <= 0) {
    noiseTimer = NOISE_REPORT_SECONDS;
    if (agents.attract.active && agents.attract.district >= 0) {
      sim.addNoise(agents.attract.district, NOISE_PER_REPORT * sim.timeScale);
    }
  }

  const districtIndex = districtAt(heli.position.x, heli.position.z);
  const forward = (-heli.yaw * 180) / Math.PI;
  hud.update(dt, sim.time, sim.timeScale, state && districtIndex >= 0 ? state.districts[districtIndex] : null, {
    altitude,
    drawn: agents.attract.active ? agents.attract.drawn : 0,
    grabbers: agents.attract.grabbers,
    fuel: heli.fuel,
    fuelCapacity: FUEL_CAPACITY,
    // Endurance is what matters in the air, even while sitting on the ground.
    burnRate: Math.max(heli.burnRate, heli.flightBurn),
    engineOut: heli.engineOut,
    sling: state?.cargo.sling ?? 0,
    speed: heli.speed,
    verticalSpeed: heli.velocity.y,
    heading: ((forward % 360) + 360) % 360,
    health: heli.health,
    landed: heli.landed,
    destroyed: heli.destroyed,
    searchlight: heli.searchlight.intensity > 0,
  }, state && districtIndex >= 0 ? state.sites.filter((x) => x.district === districtIndex) : [],
  state ? siteNear(state, heli.position.x, heli.position.z, SITE_HUD_RADIUS) ?? null : null);

  if (map.visible) {
    mapTimer -= dt;
    if (mapTimer <= 0) {
      mapTimer = MAP_REFRESH;
      map.draw(state, { heliX: heli.position.x, heliZ: heli.position.z, heliYaw: heli.yaw, timeScale: sim.timeScale, aiHelis: fleet.markers });
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
Object.assign(window, { game: { sim, heli, city, seed, input, map, agents, effects, ops, command, fleet, sites, traffic } });
