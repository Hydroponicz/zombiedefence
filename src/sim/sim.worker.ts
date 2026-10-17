// Runs the city simulation off the main thread so it never stutters the flying.
import { CitySim } from './CitySim';
import type { SimRequest, SimResponse } from './protocol';

let sim: CitySim | null = null;

const post = (msg: SimResponse) => (self as unknown as Worker).postMessage(msg);

self.onmessage = (e: MessageEvent<SimRequest>) => {
  const msg = e.data;
  if (msg.type === 'noise') {
    sim?.addPlayerNoise(msg.district, msg.amount);
    return;
  }
  if (msg.type === 'init') {
    sim = new CitySim(msg.seed);
  } else if (msg.type === 'step' && sim) {
    sim.step(msg.ticks);
  }
  if (sim) post({ type: 'state', state: sim.state, events: sim.takeEvents() });
};
