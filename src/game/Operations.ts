// What the player can do while the helicopter is on the ground: a short menu of operations
// (load at the base; deploy, drop, evacuate, relieve or extract in the city; fuel work). An
// operation runs one person, crate or pump-load at a time and pauses while zombies are at the
// doors. Refuelling at the base or a forward refuelling point happens on its own.

import type { Action } from '../input/Input';
import {
  BASE_RESERVE_TROOPS,
  baseOf,
  BLADDER_LITRES,
  canApply,
  CRATES,
  FARP_GUARDS,
  farpNear,
  fuelStock,
  passengers,
  ROUNDS_PER_TROOP,
  SEATS,
  seatsUsed,
  type FuelSource,
  type PlayerCommand,
} from '../sim/operations';
import type { CityState, CrateKind } from '../sim/types';

export interface GroundContext {
  /** On the ground and nearly stopped. */
  landed: boolean;
  district: number;
  /** On a rooftop that isn't a helipad: people take the stairs, so boarding is slower. */
  onRoof: boolean;
  /** Zombies close to the doors, and hanging off the skids. */
  threat: number;
  grabbers: number;
  /** Where the helicopter is, for forward refuelling points. */
  x: number;
  z: number;
  fuel: number;
  fuelCapacity: number;
}

/** Forward refuelling points serve helicopters landed within this many metres. */
export const FARP_RADIUS = 35;
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

const fmt = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(Math.floor(n)));

export class Operations {
  view: OperationsView | null = null;
  onToast: (text: string) => void = () => {};
  private selected = 0;
  private active: { id: string; timer: number; interval: number } | null = null;
  private wasLanded = false;
  private lastDistrict = -1;
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
    if (!ctx.landed || !state || ctx.district < 0) {
      this.active = null;
      this.view = null;
      this.wasLanded = false;
      return;
    }
    const atBase = state.districts[ctx.district].kind === 'airbase';
    // A new landing site has a different menu: start from the top.
    if (ctx.district !== this.lastDistrict || !this.wasLanded) {
      this.selected = 0;
      this.active = null;
      this.lastDistrict = ctx.district;
    }

    // Touching down at the base unloads everyone aboard.
    if (!this.wasLanded && atBase && passengers(state.cargo) > 0) {
      const c = state.cargo;
      const parts = [
        c.civilians + c.infected && `${c.civilians + c.infected} civilians`,
        c.tired && `${c.tired} soldiers`,
        c.scientists && `${c.scientists} scientists`,
      ].filter(Boolean);
      this.send({ type: 'unloadAtBase' });
      this.onToast(`Unloaded ${parts.join(', ')}`);
    }
    this.wasLanded = true;

    // Pumps at the base and at forward refuelling points fill the tank on their own.
    const farp = farpNear(state, ctx.x, ctx.z, FARP_RADIUS);
    const pump: FuelSource | null = atBase ? { district: ctx.district } : farp ? { farp: farp.id } : null;
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

    const options = atBase ? this.baseOptions(state, ctx) : this.districtOptions(state, ctx);
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
    this.view = {
      title: `${state.districts[ctx.district].name}: on the ground${farp ? ' at the refuelling point' : ctx.onRoof ? ' (rooftop)' : ''}`,
      status: status || [`Seats ${seatsUsed(c)}/${SEATS}`, pumping].filter(Boolean).join(' · '),
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
    const c = s.cargo;
    const options: Option[] = [];
    const farp = farpNear(s, ctx.x, ctx.z, FARP_RADIUS);
    if (d.features.fuelDepot && c.sling === 0) {
      const command: PlayerCommand = { type: 'hookBladder', district: d.id };
      options.push({
        id: 'hook', label: 'Hook up a fuel bladder',
        detail: `${BLADDER_LITRES.toLocaleString('en-US')} L · ${fmt(d.fuel)} L in the depot`,
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

  private baseOptions(s: CityState, ctx: GroundContext): Option[] {
    const base = baseOf(s);
    const c = s.cargo;
    const crate = (kind: CrateKind, stock: number): Option => {
      const command: PlayerCommand = { type: 'loadCrate', kind };
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
    const options: Option[] = [
      {
        id: 'load-troops',
        label: 'Load fresh troops',
        detail: seatsUsed(c) >= SEATS ? 'Seats full' : `${fmt(Math.max(0, base.troops.strength - BASE_RESERVE_TROOPS))} available`,
        enabled: canApply(s, { type: 'loadTroop' }),
        command: { type: 'loadTroop' },
        interval: 0.5,
        repeat: true,
      },
      crate('rations', base.rations),
      crate('ammo', base.troops.ammo),
      crate('medicine', base.medicine),
    ];
    if (c.troops > 0) {
      options.push({
        id: 'return-troops',
        label: 'Send troops back to barracks',
        detail: `${c.troops} aboard`,
        enabled: true,
        command: { type: 'returnTroop' },
        interval: 0.4,
        repeat: true,
      });
    }
    return [...options, ...this.fuelOptions(s, ctx, true)];
  }

  private districtOptions(s: CityState, ctx: GroundContext): Option[] {
    const d = s.districts[ctx.district];
    const c = s.cargo;
    const stairs = ctx.onRoof ? ROOF_SLOWDOWN : 1;
    const full = seatsUsed(c) >= SEATS;
    const board = (kind: 'civilian' | 'soldier' | 'scientist'): PlayerCommand => ({ type: 'board', district: d.id, kind });
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
        detail: c.crates.length ? c.crates.map((k) => CRATES[k].label).join(', ') : 'None aboard',
        enabled: canApply(s, { type: 'dropCrate', district: d.id }),
        command: { type: 'dropCrate', district: d.id },
        interval: 2,
        repeat: true,
      },
      {
        id: 'evacuate',
        label: 'Evacuate civilians',
        detail: full ? 'Seats full' : `${fmt(d.population + d.infected)} still here`,
        enabled: canApply(s, board('civilian')),
        command: board('civilian'),
        interval: 1 * stairs,
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
    return [...options, ...this.fuelOptions(s, ctx, false)];
  }
}
