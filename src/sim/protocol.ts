import type { PlayerCommand } from './operations';
import type { CityState, SimEvent } from './types';

export type SimRequest =
  | { type: 'init'; seed: number | string }
  | { type: 'step'; ticks: number }
  /** Rotor noise over a district; applied immediately and not answered. */
  | { type: 'noise'; district: number; amount: number }
  /** A player action; answered with an 'ack' carrying the updated state. */
  | { type: 'command'; command: PlayerCommand };

export interface SimResponse {
  /** 'state' answers init and step; 'ack' answers a command. */
  type: 'state' | 'ack';
  state: CityState;
  events: SimEvent[];
}
