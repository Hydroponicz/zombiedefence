import * as THREE from 'three';
import { FARP_RADIUS, Operations } from './game/Operations';
import { ChaseCamera } from './heli/ChaseCamera';
import { FUEL_CAPACITY, Helicopter } from './heli/Helicopter';
import { Input, type FrameInput } from './input/Input';
import { ARMY_BASE, districtAt } from './sim/layout';
import { baseOf, farpNear, MAX_PAYLOAD_KG, payloadKg, type BaseId } from './sim/operations';
import { SimClient } from './sim/SimClient';
import { CommandPanel } from './ui/CommandPanel';
import { DebugMap } from './ui/DebugMap';
import { Hud } from './ui/Hud';
import { Agents } from './world/Agents';
import { AiFleet } from './world/AiFleet';
import { City, type Helipad } from './world/City';
import { Effects } from './world/Effects';
import { Environment } from './world/Environment';
import { Farps } from './world/Farps';
import { Sites } from './world/Sites';
import { Traffic } from './world/Traffic';
import { Cars } from './world/Cars';
import { cityLight } from './world/CityLight';
import { POLICY_LABELS, ruleLine } from './sim/policy';
import { MilitaryConvoys } from './world/MilitaryConvoys';
import { AirportWorks } from './world/AirportWorks';
import { Lures } from './world/Lures';
import { RequestTracker, requestTarget } from './game/Requests';
import { Transmission } from './ui/Transmission';
import { hasResearch } from './sim/research';
import { CampaignView } from './ui/CampaignView';
import { Joc } from './world/Joc';
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
/** The door gun fires like this many troops at the doors. */
const DOOR_GUN_SHOOTERS = 4;
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
const cars = new Cars();
scene.add(cars.group);
const joc = new Joc();
scene.add(joc.group);
const fleet = new AiFleet(city.helipads);
scene.add(fleet.group);
const lures = new Lures();
scene.add(lures.group);
const convoys = new MilitaryConvoys();
scene.add(convoys.group);
const works = new AirportWorks();
scene.add(works.group);
const requests = new RequestTracker((cmd) => sim.command(cmd));
// New requests come in over the radio, and wait for an answer.
const radio = new Transmission((r, how) => {
  if (how === 'take' && !r.tracked) {
    sim.command({ type: 'trackRequest', request: r.id });
    hud.toast(`Taken on: ${r.title}`, 3);
  } else if (how === 'open') {
    command.showRequest(r.id);
    input.releasePointer();
  }
}, (policy) => {
  // Command's call on movement restrictions (null: stand by, it asks again later).
  sim.command({ type: 'setPolicy', policy });
  hud.toast(policy ? `${POLICY_LABELS[policy]} ordered` : 'Standing by: Command will ask again', 3);
});
scene.add(requests.marker);

const heli = new Helicopter();
scene.add(heli.object, heli.slingObject);
// Everything solid in the scene is lit by the city's night lights (see CityLight).
scene.traverse((o) => {
  const material = (o as THREE.Mesh).material;
  for (const m of Array.isArray(material) ? material : material ? [material] : []) {
    if (m instanceof THREE.MeshLambertMaterial || m instanceof THREE.MeshPhongMaterial || m instanceof THREE.MeshStandardMaterial) cityLight.patch(m);
  }
});
let lightClock = 0;
/** Pad 1 at the hub: Camp Ridgeway, then the airport once the JOC is set up. */
function spawnPad(base = sim.state ? baseOf(sim.state).name : ARMY_BASE.name): Helipad {
  return city.helipads.find((p) => p.name.startsWith(base)) ?? { x: ARMY_BASE.x, y: 0, z: ARMY_BASE.z, name: ARMY_BASE.name };
}
// The game starts at Camp Ridgeway, before the simulation is up.
const start = spawnPad(ARMY_BASE.name);
heli.reset(start.x, start.y, start.z, 0);

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
    hud.toast('Crew recovered', 3);
    // Into a spare at the base, as soon as the simulation has found one.
    respawnDue = 1;
  },
);
ops.onToast = (text) => hud.toast(text, 2.5);

input.onGamepadChange = (name) => hud.toast(name ? 'Controller connected' : 'Controller disconnected', 2);

let paused = false;
/** Door-gun kills not yet reported to the simulation, by district. */
const doorGunKills = new Map<number, number>();
let killReportTimer = 0;
/** A radio call was up last frame (to free the mouse once when one appears). */
let radioWasUp = false;
let respawnTimer = 0;
/** Seconds until the crew takes a spare helicopter at the base (after abandoning one), or -1. */
let respawnDue = -1;
let waitToast = 0;

/** Whether a spare helicopter is free for the player (always, once flying on after the campaign). */
function spareReady(): boolean {
  const s = sim.state;
  return !s || !!s.flags.freePlay || !(s.flags.awaitingAirframe || s.flags.grounded);
}
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
  // The campaign is over: fly on, or start a new city.
  // An incoming radio call takes its answer first (not while a menu is open over it).
  // Left–right from the right stick, or A / D (yaw) on the keyboard.
  const across = Math.abs(frame.lookX) > Math.abs(frame.yaw) ? frame.lookX : frame.yaw;
  if (!map.visible && !command.visible && !paused && radio.handle(a, across)) return;
  if (campaignView.endVisible) {
    if (a.has('confirm')) {
      sim.command({ type: 'freePlay' });
      campaignView.hideEnd();
    } else if (a.has('newGame') || a.has('sling')) {
      location.search = `?seed=${Math.floor(Math.random() * 1e6)}`;
    }
    return;
  }
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
    for (let i = 1; i <= 8; i++) if (a.has(`overlay${i}`)) map.setOverlay(i - 1);
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
  // B closes menus; in flight it toggles the sensor overlay.
  if (a.has('sensor') || (!map.visible && a.has('back'))) {
    hud.toast(agents.toggleSensor() ? 'Sensor: zombies red · bitten amber · civilians green · troops and police blue' : 'Sensor off', 2.5);
  }
  if (a.has('timeFaster') || (!map.visible && a.has('dpadRight'))) sim.changeTimeScale(1);
  if (a.has('timeSlower') || (!map.visible && a.has('dpadLeft'))) sim.changeTimeScale(-1);
}

function nearCamp(): boolean {
  return Math.hypot(heli.position.x - ARMY_BASE.x, heli.position.z - ARMY_BASE.z) < 900;
}

/** Which base the helicopter is at: Camp Ridgeway, or the airport once it's the JOC. */
function baseHere(): BaseId | null {
  const p = heli.position;
  if (Math.abs(p.x - ARMY_BASE.x) < 460 && Math.abs(p.z - ARMY_BASE.z) < 360) return 'army';
  const d = districtAt(p.x, p.z);
  return d >= 0 && sim.state?.flags.joc && sim.state.districts[d].kind === 'airbase' ? 'airport' : null;
}

/** A fresh helicopter at the base, fuelled from the base's stores. */
function respawn(): void {
  const stores = sim.state ? baseOf(sim.state).fuel : FUEL_CAPACITY;
  const fuel = Math.min(FUEL_CAPACITY, stores);
  const pad = spawnPad();
  heli.reset(pad.x, pad.y, pad.z, 0, fuel);
  if (sim.state && fuel > 0) {
    sim.command({ type: 'refuel', source: sim.state.flags.joc ? { district: baseOf(sim.state).id } : { army: true }, litres: fuel });
  }
  if (fuel < FUEL_CAPACITY) hud.toast(`Base fuel is low: only ${Math.floor(fuel)} L for the replacement`, 4);
}

/** Let go of the slung bladder: set down gently it delivers its fuel, dropped from height it bursts. */
function releaseSling(): void {
  const state = sim.state;
  if (!state || heli.destroyed) return;
  // With no bladder on the hook, F / X drops a noise lure.
  if (state.cargo.sling <= 0) {
    if (state.cargo.lures <= 0) return;
    const district = districtAt(heli.position.x, heli.position.z);
    if (district < 0) {
      hud.toast('Drop lures over the city', 2);
      return;
    }
    sim.command({ type: 'dropLure', district, x: heli.position.x, z: heli.position.z });
    hud.toast(`Noise lure dropped in ${state.districts[district].name}`, 2.5);
    return;
  }
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
  // An incoming radio call holds the game until it's answered.
  if (radio.visible) {
    // Free the mouse to reach the answers.
    if (!radioWasUp) input.releasePointer();
    radioWasUp = true;
    radio.update(dt, sim.state, heli.position, (r) => (sim.state ? requestTarget(sim.state, r, sim.time) : null));
    return;
  }
  radioWasUp = false;

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
    if (respawnTimer > RESPAWN_SECONDS) respawnDue = 0;
  }
  if (respawnDue >= 0) {
    respawnDue -= dt;
    waitToast -= dt;
    if (respawnDue <= 0 && spareReady()) {
      respawnDue = -1;
      respawnTimer = 0;
      respawn();
      hud.toast(`Replacement helicopter ready at ${spawnPad().name}`, 3);
    } else if (respawnDue <= 0) {
      // Check again shortly.
      respawnDue = 0.5;
      if (waitToast <= 0 && !sim.state?.flags.grounded) {
        waitToast = 6;
        hud.toast('No spare helicopter at base: waiting for one to come back', 5);
      }
    }
  }

  chase.update(dt, heli, overlay ? { ...frame, lookX: 0, lookY: 0, mouseX: 0, mouseY: 0, zoom: 0 } : frame, (x, z) => city.surfaceHeight(x, z));
  const night = environment.update(sim.time, heli.position);
  city.setNight(night);
  lightClock += dt;
  cityLight.setNight(night, lightClock);
  cityLight.begin(heli.position.x, heli.position.z);

  const state = sim.state;
  if (state && state !== lastSyncedState) {
    lastSyncedState = state;
    state.districts.forEach((d, i) => city.setDistrictLight(i, POWER_LIGHT[d.power]));
    effects.syncWithSim(state);
    farps.sync(state.farps);
    sites.sync(state.sites, state.districts);
    joc.sync(state);
    lures.sync(state.lures);
    convoys.sync(state.convoys);
    works.sync(state.airportWorks);
  }

  const surface = city.surfaceHeight(heli.position.x, heli.position.z);
  const altitude = heli.position.y - SKID_DEPTH - surface;
  const clearance = heli.position.y - SKID_DEPTH;
  agents.update(dt, heli.position, altitude, heli.destroyed ? 0 : heli.rotor, state, night, clearance, sim.time);
  // The door gun fires as well as a few troops at the doors would.
  const doorGun = state && hasResearch(state, 'doorGun') ? DOOR_GUN_SHOOTERS : 0;
  if (!heli.destroyed) {
    // What the door guns kill is gone from the simulation too: each figure is 1 / scale of the dead.
    const kills = agents.doorGunners(dt, heli.position, (state?.cargo.troops ?? 0) + doorGun);
    const district = districtAt(heli.position.x, heli.position.z);
    if (kills > 0 && district >= 0) doorGunKills.set(district, (doorGunKills.get(district) ?? 0) + kills / agents.scale);
  }
  killReportTimer -= dt;
  if (killReportTimer <= 0) {
    killReportTimer = 1;
    for (const [district, count] of doorGunKills) sim.command({ type: 'killZombies', district, count });
    doorGunKills.clear();
  }
  hud.figureScale = agents.scale;
  lures.update(dt);
  convoys.update(sim.time);
  works.update(dt);
  requests.update(dt, state, sim.time, heli.position, altitude);
  radio.update(dt, state, heli.position, (r) => (state ? requestTarget(state, r, sim.time) : null));
  effects.update(dt, night);
  farps.update(dt);
  sites.update(dt, night);
  traffic.update(state, sim.time);
  cars.update(dt, state, heli.position.x, heli.position.z, agents);
  fleet.update(dt, state, sim.time);

  // Ground operations: loading, deploying, evacuating.
  const atHelipad = city.helipads.some((p) => Math.hypot(p.x - heli.position.x, p.z - heli.position.z) < HELIPAD_RADIUS && Math.abs(p.y - surface) < 1);
  ops.update(dt, {
    landed: heli.landed && heli.speed < PARKED_SPEED && !heli.destroyed,
    district: districtAt(heli.position.x, heli.position.z),
    base: baseHere(),
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
  // Over Camp Ridgeway the panel shows the base.
  const here = state ? (districtIndex >= 0 ? state.districts[districtIndex] : baseHere() === 'army' || nearCamp() ? state.army : null) : null;
  campaignView.update(dt, sim.state);
  hud.update(dt, sim.time, sim.timeScale, here, {
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
  state ? siteNear(state, heli.position.x, heli.position.z, SITE_HUD_RADIUS) ?? null : null, state?.traffic ?? null,
  state && districtIndex >= 0 ? ruleLine(state, state.districts[districtIndex], sim.time) : '');

  if (map.visible) {
    mapTimer -= dt;
    if (mapTimer <= 0) {
      mapTimer = MAP_REFRESH;
      map.draw(state, { heliX: heli.position.x, heliZ: heli.position.z, heliYaw: heli.yaw, timeScale: sim.timeScale, aiHelis: fleet.markers });
    }
  }
}

const timer = new THREE.Timer();
const campaignView = new CampaignView();
renderer.setAnimationLoop((time) => {
  timer.update(time);
  update(Math.min(timer.getDelta(), 0.1));
  cityLight.render(renderer);
  renderer.render(scene, camera);
});

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// Handy for debugging from the console.
Object.assign(window, { game: { sim, heli, city, seed, input, map, agents, effects, ops, command, fleet, sites, traffic, cars, camera, cityLight } });
