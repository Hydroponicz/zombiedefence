// What the player can do while the helicopter is on the ground: a short menu of operations
// (load at the base; deploy, drop, evacuate, relieve or extract in the city; fuel work). An
// operation runs one person, crate or pump-load at a time and pauses while zombies are at the
// doors. Refuelling at the base or a forward refuelling point happens on its own.

import { hasResearch, LURE_CAPACITY, LURE_HOURS } from '../sim/research';
import type { Action } from '../input/Input';
import {
  BASE_RESERVE_TROOPS,
  bladderLitres,
  canApply,
  CRATES,
  FARP_GUARDS,
  farpNear,
  fuelStock,
  passengers,
  ROUNDS_PER_TROOP,
  SEATS,
  seatsUsed,
  siteStock,
  baseAt,
  COMMAND_TEAM_SEATS,
  type BaseId,
  type FuelSource,
  type PlayerCommand,
} from '../sim/operations';
import { guardsNeeded, SITE_LABELS, siteNear } from '../sim/sites';
import type { CityState, CrateKind, Site } from '../sim/types';

export interface GroundContext {
  /** On the ground and nearly stopped. */
  landed: boolean;
  district: number;
  /** On a rooftop that isn't a helipad: people take the stairs, so boarding is slower. */
  onRoof: boolean;
  /** Zombies close to the doors, and hanging off the skids. */
  threat: number;
  grabbers: number;
  /** Landed at a base: Camp Ridgeway, or the airport once the JOC is there (null elsewhere). */
  base: BaseId | null;
  /** Where the helicopter is, for forward refuelling points. */
  x: number;
  z: number;
  fuel: number;
  fuelCapacity: number;
}

/** Forward refuelling points serve helicopters landed within this many metres. */
export const FARP_RADIUS = 35;
/** Landed within this many metres of a site's landing zone, the helicopter is at that site. */
export const SITE_RADIUS = 60;
/** Pump rates in litres per second: base and refuelling points, and siphoning in the city. */
const PUMP_RATE = 80;
const SIPHON_RATE = 20;
/** Below this share of a tank, with no fuel to be had, the crew can abandon the helicopter. */
const ABANDON_FUEL = 0.05;

export interface OperationView {
  label: string;
  detail: string;
  enabled: boolean;
  selected: boolean;
  active: boolean;
  /** 0..1 progress of the current person or crate. */
  progress: number;
}

export interface OperationsView {
  title: string;
  status: string;
  warning: boolean;
  options: OperationView[];
}

interface Option {
  id: string;
  label: string;
  detail: string;
  enabled: boolean;
  command: PlayerCommand;
  /** Runs after the command is sent (e.g. putting pumped fuel in the tank). */
  after?: () => void;
  /** Seconds per person or crate. */
  interval: number;
  /** Keep going until full, empty or stopped. */
  repeat: boolean;
}

/** Stairs are slow: boarding from a rooftop takes this much longer than from the street or a helipad. */
const ROOF_SLOWDOWN = 2.5;

/** The loudspeaker halves boarding times. */
const speaker = (s: CityState) => (hasResearch(s, 'loudspeaker') ? 0.5 : 1);

const fmt = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(Math.floor(n)));

export class Operations {
  view: OperationsView | null = null;
  onToast: (text: string) => void = () => {};
  private selected = 0;
  private active: { id: string; timer: number; interval: number } | null = null;
  private wasLanded = false;
  private lastPlace = '';
  private pumpTimer = 0;

  /**
   * @param send passes a command to the simulation
   * @param addFuel puts litres into the helicopter's tank
   * @param onAbandon the crew leaves the helicopter (a replacement is waiting at the base)
   */
  constructor(
    private send: (cmd: PlayerCommand) => void,
    private addFuel: (litres: number) => void = () => {},
    private onAbandon: () => void = () => {},
  ) {}

  update(dt: number, ctx: GroundContext, state: CityState | null, actions: Set<Action>): void {
    if (!ctx.landed || !state || (ctx.district < 0 && !ctx.base)) {
      this.active = null;
      this.view = null;
      this.wasLanded = false;
      return;
    }
    const atBase = ctx.base !== null;
    const site = atBase ? undefined : siteNear(state, ctx.x, ctx.z, SITE_RADIUS);
    // A new landing site has a different menu: start from the top.
    const place = `${ctx.base ?? ctx.district}:${site?.id ?? ''}`;
    if (place !== this.lastPlace || !this.wasLanded) {
      this.selected = 0;
      this.active = null;
      this.lastPlace = place;
    }

    // Touching down at the base unloads everyone aboard.
    if (!this.wasLanded && atBase && passengers(state.cargo) > 0) {
      const c = state.cargo;
      const parts = [
        c.civilians + c.infected && `${c.civilians + c.infected} civilians`,
        c.tired && `${c.tired} soldiers`,
        c.scientists && `${c.scientists} scientists`,
      ].filter(Boolean);
      this.send({ type: 'unloadAtBase', at: ctx.base! });
      this.onToast(`Unloaded ${parts.join(', ')}`);
    }
    this.wasLanded = true;

    // Pumps at the base and at forward refuelling points fill the tank on their own.
    const farp = farpNear(state, ctx.x, ctx.z, FARP_RADIUS);
    const pump: FuelSource | null = ctx.base === 'army' ? { army: true } : atBase ? { district: ctx.district } : farp ? { farp: farp.id } : null;
    let pumping = '';
    if (pump && ctx.fuel < ctx.fuelCapacity - 0.5) {
      this.pumpTimer += dt;
      const stock = fuelStock(state, pump);
      if (stock <= 0) pumping = farp ? 'Refuelling point is dry' : 'Base fuel stores are empty';
      else {
        pumping = `Refuelling ${Math.floor(ctx.fuel)}/${ctx.fuelCapacity} L`;
        if (this.pumpTimer >= 0.25) {
          const litres = Math.min(this.pumpTimer * PUMP_RATE, ctx.fuelCapacity - ctx.fuel, stock);
          this.pumpTimer = 0;
          this.send({ type: 'refuel', source: pump, litres });
          this.addFuel(litres);
        }
      }
    }

    const options = atBase ? this.baseOptions(state, ctx)
      : [...this.jocOptions(state, ctx), ...(site ? this.siteOptions(state, ctx, site) : []), ...this.districtOptions(state, ctx)];
    if (actions.has('dpadUp') || actions.has('arrowUp')) this.selected--;
    if (actions.has('dpadDown') || actions.has('arrowDown')) this.selected++;
    this.selected = (this.selected + options.length) % options.length;

    if (actions.has('confirm')) {
      const option = options[this.selected];
      if (this.active?.id === option.id) this.active = null;
      else if (option.enabled) this.active = { id: option.id, timer: option.interval, interval: option.interval };
    }

    const blocked = ctx.grabbers > 0 || ctx.threat > 0;
    let status = '';
    if (this.active) {
      const option = options.find((o) => o.id === this.active!.id);
      if (!option || !option.enabled) {
        this.active = null;
      } else if (!blocked) {
        this.active.interval = option.interval;
        this.active.timer -= dt;
        if (this.active.timer <= 0) {
          this.send(option.command);
          option.after?.();
          if (option.repeat) this.active.timer = option.interval;
          else this.active = null;
        }
      }
    }
    if (ctx.grabbers > 0) status = `${ctx.grabbers} on the skids! Climb to shake them off`;
    else if (ctx.threat > 0) status = `Zombies at the doors (${ctx.threat}): loading paused`;

    const c = state.cargo;
    const where = site
      ? `${site.name}: ${site.status}`
      : atBase ? `${baseAt(state, ctx.base!).name}${ctx.base === 'airport' ? ' (Joint Operations Command)' : ''}`
        : `${state.districts[ctx.district].name}: on the ground${farp ? ' at the refuelling point' : ctx.onRoof ? ' (rooftop)' : ''}`;
    const siteInfo = site
      ? `${Math.round(site.guards)}/${Math.ceil(guardsNeeded(site))} guards${site.capacity ? ` · ${fmt(site.sheltered)} sheltered` : ''}`
      : '';
    this.view = {
      title: where,
      status: status || [`Seats ${seatsUsed(c)}/${SEATS}`, siteInfo, pumping].filter(Boolean).join(' · '),
      warning: !!status,
      options: options.map((o, i) => ({
        label: o.label,
        detail: o.detail,
        enabled: o.enabled,
        selected: i === this.selected,
        active: this.active?.id === o.id,
        progress: this.active?.id === o.id ? 1 - this.active.timer / this.active.interval : 0,
      })),
    };
  }

  /** Fuel work available here: bladders, refuelling points, siphoning, and abandoning when stranded. */
  private fuelOptions(s: CityState, ctx: GroundContext, atBase: boolean): Option[] {
    const d = s.districts[ctx.district];
    // Camp Ridgeway pumps its own fuel; the rest of this is work in the city.
    if (!d) return [];
    const c = s.cargo;
    const options: Option[] = [];
    const farp = farpNear(s, ctx.x, ctx.z, FARP_RADIUS);
    if (d.features.fuelDepot && c.sling === 0) {
      const command: PlayerCommand = { type: 'hookBladder', district: d.id };
      options.push({
        id: 'hook', label: 'Hook up a fuel bladder',
        detail: `${bladderLitres(s).toLocaleString('en-US')} L · ${fmt(d.fuel)} L in the depot`,
        enabled: canApply(s, command), command, interval: 3, repeat: false,
      });
    }
    if (c.sling > 0) {
      const release: PlayerCommand = { type: 'releaseBladder', district: d.id, farp: farp?.id };
      options.push({
        id: 'release', label: farp ? 'Refill the refuelling point' : 'Set down the fuel bladder',
        detail: farp ? `${fmt(farp.fuel)} L there now` : `Into ${d.name}'s stocks`,
        enabled: canApply(s, release), command: release, interval: 2, repeat: false,
      });
      if (!atBase && !farp) {
        const setup: PlayerCommand = { type: 'setupFarp', district: d.id, x: ctx.x, z: ctx.z };
        options.push({
          id: 'farp', label: 'Set up a forward refuelling point',
          detail: c.troops < FARP_GUARDS ? `Needs ${FARP_GUARDS} troops aboard to guard it` : `Leaves ${FARP_GUARDS} troops on guard`,
          enabled: canApply(s, setup), command: setup, interval: 4, repeat: false,
        });
      }
    }
    if (!atBase && !farp) {
      const source: FuelSource = { district: d.id };
      const litres = SIPHON_RATE * 0.5;
      options.push({
        id: 'siphon', label: d.features.fuelDepot ? 'Refuel from the depot' : 'Siphon fuel from petrol stations',
        detail: `${fmt(d.fuel)} L here · tank ${Math.floor(ctx.fuel)}/${ctx.fuelCapacity}`,
        enabled: d.fuel > 0 && ctx.fuel < ctx.fuelCapacity - 1,
        command: { type: 'refuel', source, litres },
        after: () => this.addFuel(Math.min(litres, fuelStock(s, source))),
        interval: 0.5, repeat: true,
      });
      if (ctx.fuel < ctx.fuelCapacity * ABANDON_FUEL && d.fuel <= 0) {
        options.push({
          id: 'abandon', label: 'Abandon the helicopter',
          detail: 'Passengers and cargo stay here; the crew is recovered',
          enabled: true, command: { type: 'abandon', district: d.id }, after: () => this.onAbandon(),
          interval: 2, repeat: false,
        });
      }
    }
    return options;
  }

  /** At the airport with the command team aboard: set up the JOC. */
  private jocOptions(s: CityState, ctx: GroundContext): Option[] {
    if (s.districts[ctx.district]?.kind !== 'airbase' || !s.cargo.commandTeam) return [];
    const command: PlayerCommand = { type: 'establishJoc' };
    return [{
      id: 'joc', label: 'Establish the Joint Operations Command',
      detail: 'The command team sets up here; the airlift follows', enabled: canApply(s, command), command, interval: 6, repeat: false,
    }];
  }

  private baseOptions(s: CityState, ctx: GroundContext): Option[] {
    const at = ctx.base!;
    const base = baseAt(s, at);
    const c = s.cargo;
    const crate = (kind: CrateKind, stock: number): Option => {
      const command: PlayerCommand = { type: 'loadCrate', kind, at };
      return {
        id: `crate-${kind}`,
        label: `Load ${CRATES[kind].label} crate`,
        detail: c.crates.length >= 2 ? 'Hold full' : `${Math.floor(stock / CRATES[kind].amount)} in store`,
        enabled: canApply(s, command),
        command,
        interval: 1.5,
        repeat: false,
      };
    };
    const options: Option[] = [];
    if (at === 'army' && s.flags.jocAuthorized && !s.flags.joc) {
      const team: PlayerCommand = { type: 'loadCommandTeam' };
      options.push({
        id: 'command-team', label: 'Take the JOC command team aboard',
        detail: c.commandTeam ? 'Aboard: fly them to Kessler Airport' : `${COMMAND_TEAM_SEATS} seats · they set up at the airport`,
        enabled: canApply(s, team), command: team, interval: 3, repeat: false,
      });
    }
    options.push(
      {
        id: 'load-troops',
        label: 'Load fresh troops',
        detail: !s.flags.joc ? 'Held here until the JOC is set up in the city'
          : seatsUsed(c) >= SEATS ? 'Seats full' : `${fmt(Math.max(0, base.troops.strength - BASE_RESERVE_TROOPS))} available`,
        enabled: canApply(s, { type: 'loadTroop', at }),
        command: { type: 'loadTroop', at },
        interval: 0.5,
        repeat: true,
      },
      crate('rations', base.rations),
      crate('ammo', base.troops.ammo),
      crate('medicine', base.medicine),
    );
    if (hasResearch(s, 'noiseLures')) {
      const lure: PlayerCommand = { type: 'loadLure', at };
      options.push({
        id: 'load-lure', label: 'Load a noise lure',
        detail: `${c.lures} of ${LURE_CAPACITY} aboard · drop from the air with F / X`,
        enabled: canApply(s, lure), command: lure, interval: 1.5, repeat: false,
      });
    }
    if (c.troops > 0) {
      options.push({
        id: 'return-troops',
        label: 'Send troops back to barracks',
        detail: `${c.troops} aboard`,
        enabled: true,
        command: { type: 'returnTroop', at },
        interval: 0.4,
        repeat: true,
      });
    }
    return [...options, ...this.fuelOptions(s, ctx, true)];
  }

  /** What can be done at a police station, supermarket, shelter or pharmacy. */
  private siteOptions(s: CityState, ctx: GroundContext, site: Site): Option[] {
    const d = s.districts[ctx.district];
    const c = s.cargo;
    const full = seatsUsed(c) >= SEATS;
    const label = SITE_LABELS[site.kind];
    const deploy: PlayerCommand = { type: 'deployTroop', district: d.id, site: site.id };
    const options: Option[] = [{
      id: 'site-garrison',
      label: site.status === 'fallen' ? `Retake the ${label}` : `Garrison the ${label}`,
      detail: c.troops ? `${c.troops} aboard · ${Math.round(site.guards)} posted, ${Math.ceil(guardsNeeded(site))} wanted` : 'No troops aboard',
      enabled: canApply(s, deploy), command: deploy, interval: 0.5, repeat: true,
    }];
    if (site.capacity > 0) {
      const board: PlayerCommand = { type: 'board', district: d.id, kind: 'civilian', site: site.id };
      options.push({
        id: 'site-evacuate', label: 'Evacuate the shelter',
        detail: full ? 'Seats full' : site.status === 'fallen' ? 'Nobody left inside' : `${fmt(site.sheltered)} sheltering · screened at the door`,
        // Organised and waiting at the door: quicker than gathering people off the street.
        enabled: canApply(s, board), command: board, interval: 0.6 * speaker(s), repeat: true,
      });
    }
    // Take stock away: food from a supermarket, ammunition from an armoury, medicine from a pharmacy.
    const kinds: CrateKind[] = site.kind === 'police' ? ['ammo'] : site.kind === 'pharmacy' ? ['medicine']
      : site.kind === 'supermarket' || site.kind === 'depot' ? ['rations'] : site.kind === 'shelter' ? ['rations', 'medicine'] : [];
    for (const kind of kinds) {
      const stock = siteStock(site, kind);
      if (stock < 1 && site.kind === 'shelter') continue;
      const load: PlayerCommand = { type: 'loadCrate', kind, site: site.id };
      options.push({
        id: `site-load-${kind}`, label: `Load ${CRATES[kind].label} from the ${label}`,
        detail: c.crates.length >= 2 ? 'Hold full' : `${Math.floor(stock / CRATES[kind].amount)} crates' worth here`,
        enabled: canApply(s, load), command: load, interval: 3, repeat: false,
      });
    }
    if (c.crates.length) {
      const drop: PlayerCommand = { type: 'dropCrate', district: d.id, site: site.id };
      options.push({
        id: 'site-drop', label: `Restock the ${label}`,
        detail: `${c.crates.map((k) => CRATES[k].label).join(', ')} · stocked here, handed out when ${d.name} runs short`,
        enabled: canApply(s, drop), command: drop, interval: 2, repeat: true,
      });
    }
    return options;
  }

  private districtOptions(s: CityState, ctx: GroundContext): Option[] {
    const d = s.districts[ctx.district];
    const c = s.cargo;
    const stairs = ctx.onRoof ? ROOF_SLOWDOWN : 1;
    const full = seatsUsed(c) >= SEATS;
    const board = (kind: 'civilian' | 'soldier' | 'scientist' | 'pilot'): PlayerCommand => ({ type: 'board', district: d.id, kind });
    const options: Option[] = [
      {
        id: 'deploy',
        label: 'Deploy troops',
        detail: c.troops ? `${c.troops} aboard · ${ROUNDS_PER_TROOP} rounds each` : 'None aboard',
        enabled: canApply(s, { type: 'deployTroop', district: d.id }),
        command: { type: 'deployTroop', district: d.id },
        interval: 0.5 * Math.sqrt(stairs),
        repeat: true,
      },
      {
        id: 'drop',
        label: 'Unload crates',
        detail: c.crates.length ? `${c.crates.map((k) => CRATES[k].label).join(', ')} · straight into ${d.name}'s supplies` : 'None aboard',
        enabled: canApply(s, { type: 'dropCrate', district: d.id }),
        command: { type: 'dropCrate', district: d.id },
        interval: 2,
        repeat: true,
      },
      ...(c.lures > 0 ? [{
        id: 'drop-lure', label: 'Set down a noise lure',
        detail: `${c.lures} aboard · the dead come to it for ${LURE_HOURS} hours`,
        enabled: true, command: { type: 'dropLure', district: d.id, x: ctx.x, z: ctx.z } as PlayerCommand, interval: 2, repeat: false,
      }] : []),
      {
        id: 'evacuate',
        label: 'Evacuate civilians',
        detail: full ? 'Seats full' : `${fmt(d.population + d.infected)} still here`,
        enabled: canApply(s, board('civilian')),
        command: board('civilian'),
        interval: 1 * stairs * speaker(s),
        repeat: true,
      },
      {
        id: 'relieve',
        label: 'Relieve exhausted soldiers',
        detail: full ? 'Seats full' : d.troops.strength >= 1
          ? `${fmt(d.troops.strength)} here · ${Math.round(d.troops.fatigue * 100)}% exhausted`
          : 'No troops here',
        enabled: canApply(s, board('soldier')),
        command: board('soldier'),
        interval: 1 * stairs,
        repeat: true,
      },
    ];
    if (d.scientists >= 1 || d.features.lab || d.features.hospital) {
      options.push({
        id: 'scientists',
        label: 'Extract scientists',
        detail: full ? 'Seats full' : d.scientists >= 1 ? `${Math.floor(d.scientists)} left` : 'None left',
        enabled: canApply(s, board('scientist')),
        command: board('scientist'),
        interval: 1.5 * stairs,
        repeat: true,
      });
    }
    const stranded = s.pilots.filter((p) => p.status === 'stranded' && p.district === d.id);
    if (stranded.length) {
      options.push({
        id: 'pilot',
        label: 'Pick up the downed pilot',
        detail: full ? 'Seats full' : stranded.map((p) => p.name).join(', '),
        enabled: canApply(s, board('pilot')),
        command: board('pilot'),
        interval: 1.5 * stairs,
        repeat: true,
      });
    }
    if (d.salvage >= 1) {
      options.push({
        id: 'salvage',
        label: 'Salvage the abandoned helicopter',
        detail: 'Patched up and ferried to the base',
        enabled: true,
        command: { type: 'salvage', district: d.id },
        interval: 8,
        repeat: false,
      });
    }
    return [...options, ...this.fuelOptions(s, ctx, false)];
  }
}
