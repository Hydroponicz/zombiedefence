import { describe, expect, it } from 'vitest';
import { CitySim } from '../src/sim/CitySim';
import { Cars } from '../src/world/Cars';

describe('street traffic', () => {
  it('drives cars through the intersections instead of popping them out', () => {
    const sim = new CitySim('cars');
    sim.step(8 * 60);
    const cars = new Cars() as unknown as {
      update: (dt: number, s: unknown, x: number, z: number) => void;
      cars: { axis: number; line: number; dir: number; lane: number; s: number; v: number; ox: number; oz: number }[];
      place: (c: unknown) => { x: number; z: number };
    };
    const at = (c: (typeof cars.cars)[number]) => {
      const p = cars.place(c);
      return [p.x + c.ox, p.z + c.oz];
    };
    const dt = 1 / 60;
    cars.update(dt, sim.state, 0, 0);
    let prev = new Map(cars.cars.map((c) => [c, at(c)]));
    let vanished = 0;
    let worst = 0;
    let turned = 0;
    let waited = 0;
    const seen = new Set<unknown>();
    const start = new Map(cars.cars.map((c) => [c, `${c.axis}:${c.line}`]));
    for (let f = 0; f < 60 * 60; f++) {
      cars.update(dt, sim.state, 0, 0);
      const now = new Map(cars.cars.map((c) => [c, at(c)]));
      for (const [c, [x, z]] of prev) {
        const n = now.get(c);
        // Nothing near the player leaves the street.
        if (!n) {
          if (Math.hypot(x, z) < 250) vanished++;
          continue;
        }
        worst = Math.max(worst, Math.hypot(n[0] - x, n[1] - z));
      }
      for (const c of cars.cars) {
        if (start.has(c) && start.get(c) !== `${c.axis}:${c.line}`) turned++, start.delete(c);
        if (c.v < 0.1 && !seen.has(c)) waited++, seen.add(c);
      }
      prev = now;
    }
    expect(cars.cars.length).toBeGreaterThan(100);
    expect(vanished).toBe(0);
    // No car jumps: at 12 m/s a frame is 0.2 m, a turn's swing is eased.
    expect(worst).toBeLessThan(1);
    expect(turned).toBeGreaterThan(10);
    // Some wait at the lights.
    expect(waited).toBeGreaterThan(10);
  });
});
