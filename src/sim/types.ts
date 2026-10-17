import type { DistrictFeatures, DistrictKind } from './layout';

export type PowerState = 'on' | 'backup' | 'dark';
export type DistrictStatus = 'held' | 'contested' | 'overrun';
export type Severity = 'info' | 'warn' | 'critical';

export interface Troops {
  /** Number of soldiers. */
  strength: number;
  /** 0 fresh .. 1 exhausted. */
  fatigue: number;
  /** 0 broken .. 1 steady. */
  morale: number;
  /** Rounds of ammunition held by the district's troops. */
  ammo: number;
}

export interface DistrictState {
  id: number;
  name: string;
  kind: DistrictKind;
  col: number;
  row: number;
  neighbors: number[];
  features: DistrictFeatures;

  population: number;
  infected: number;
  zombies: number;
  dead: number;
  troops: Troops;

  /** Food and water, in person-days. */
  rations: number;
  /** Medical supplies, in person-days. */
  medicine: number;
  /** Litres. */
  fuel: number;

  power: PowerState;
  /** The district loses grid power when city grid integrity drops below this. */
  powerThreshold: number;
  /** 0 collapse .. 100 calm. */
  order: number;
  rioting: boolean;
  status: DistrictStatus;

  /** Combat noise 0..2. Attracts zombies from neighbouring districts. */
  noise: number;
  /** Zombie kills per game hour, smoothed. */
  killRate: number;
  /** Rotor noise from the player's helicopter, 0..3. Draws zombies in from neighbouring districts. */
  playerNoise: number;
  /** Game minutes a depot fire has left to burn. */
  burning: number;

  /** One-shot event flags. */
  flags: Record<string, boolean>;
  /** Game minute something last happened, for rate-limiting. */
  cooldowns: Record<string, number>;
}

export interface HistorySample {
  t: number;
  population: number;
  infected: number;
  zombies: number;
  troops: number;
  dead: number;
  grid: number;
}

export interface SimEvent {
  id: number;
  t: number;
  district: number | null;
  severity: Severity;
  text: string;
}

export interface CityState {
  seed: number | string;
  /** Absolute game minute (see clock.ts). */
  t: number;
  rng: number;
  /** City grid integrity 0..1. */
  grid: number;
  districts: DistrictState[];
  history: HistorySample[];
  /** Most recent events, newest last. */
  log: SimEvent[];
  eventSeq: number;
  collapsed: boolean;
  collapsedAt: number | null;
  flags: Record<string, boolean>;
}
