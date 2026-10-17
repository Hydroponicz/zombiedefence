// Main-thread side of the simulation: owns the smooth game clock and asks the worker to
// catch up one tick per elapsed game minute.

import { advanceGameTime, START_MINUTE } from './clock';
import type { SimRequest, SimResponse } from './protocol';
import type { CityState, SimEvent } from './types';

/** Never ask the worker for more than a day at once, so the UI keeps receiving updates. */
const MAX_BATCH = 1440;

export const TIME_SCALES = [1, 5, 20, 60, 240];

export class SimClient {
  state: CityState | null = null;
  /** Smooth game time in minutes (the simulation runs in whole minutes). */
  time = START_MINUTE;
  timeScaleIndex = 0;
  paused = false;
  onEvents: (events: SimEvent[]) => void = () => {};

  private worker: Worker;
  private requestedTo = START_MINUTE;
  private inFlight = false;

  constructor(seed: number | string) {
    this.worker = new Worker(new URL('./sim.worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e: MessageEvent<SimResponse>) => {
      this.state = e.data.state;
      this.inFlight = false;
      if (e.data.events.length) this.onEvents(e.data.events);
      this.flush();
    };
    this.send({ type: 'init', seed });
    this.inFlight = true;
  }

  get timeScale(): number {
    return TIME_SCALES[this.timeScaleIndex];
  }

  changeTimeScale(delta: number): void {
    this.timeScaleIndex = Math.max(0, Math.min(TIME_SCALES.length - 1, this.timeScaleIndex + delta));
  }

  update(realDt: number): void {
    if (this.paused) return;
    this.time = advanceGameTime(this.time, realDt * this.timeScale);
    this.flush();
  }

  private flush(): void {
    if (this.inFlight) return;
    const ticks = Math.min(MAX_BATCH, Math.floor(this.time) - this.requestedTo);
    if (ticks <= 0) return;
    this.requestedTo += ticks;
    this.inFlight = true;
    this.send({ type: 'step', ticks });
  }

  private send(msg: SimRequest): void {
    this.worker.postMessage(msg);
  }
}
