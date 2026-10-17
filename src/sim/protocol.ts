import type { CityState, SimEvent } from './types';

export type SimRequest =
  | { type: 'init'; seed: number | string }
  | { type: 'step'; ticks: number };

export interface SimResponse {
  type: 'state';
  state: CityState;
  events: SimEvent[];
}
