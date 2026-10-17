import type { CityState, SimEvent } from './types';

export type SimRequest =
  | { type: 'init'; seed: number | string }
  | { type: 'step'; ticks: number }
  /** Rotor noise over a district; applied immediately and not answered. */
  | { type: 'noise'; district: number; amount: number };

export interface SimResponse {
  type: 'state';
  state: CityState;
  events: SimEvent[];
}
