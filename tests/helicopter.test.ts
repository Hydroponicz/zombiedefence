import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { Helicopter, type CollisionWorld } from '../src/heli/Helicopter';
import type { FlightInput } from '../src/input/Input';

const DT = 1 / 120;
const flat: CollisionWorld = {
  surfaceHeight: () => 0,
  collide: () => new THREE.Vector3(),
};
const input = (o: Partial<FlightInput> = {}): FlightInput => ({ collective: 0, yaw: 0, pitch: 0, roll: 0, ...o });

function fly(h: Helicopter, seconds: number, i: FlightInput, world = flat): void {
  for (let t = 0; t < seconds; t += DT) h.update(DT, i, world);
}

function airborne(altitude = 100): Helicopter {
  const h = new Helicopter();
  h.reset(0, 0, 0, 0);
  fly(h, 5, input()); // spool up on the ground
  h.position.y = altitude;
  h.landed = false;
  return h;
}

describe('helicopter flight model', () => {
  it('sits on the ground at neutral throttle and climbs with throttle', () => {
    const h = new Helicopter();
    h.reset(0, 0, 0, 0);
    fly(h, 5, input());
    expect(h.landed).toBe(true);
    expect(h.position.y).toBeCloseTo(1.9, 1);
    fly(h, 4, input({ collective: 1 }));
    expect(h.landed).toBe(false);
    expect(h.position.y).toBeGreaterThan(20);
    expect(h.velocity.y).toBeGreaterThan(9);
  });

  it('holds altitude at neutral throttle', () => {
    const h = airborne();
    fly(h, 1, input({ collective: 1 }));
    fly(h, 6, input());
    const y = h.position.y;
    fly(h, 5, input());
    expect(Math.abs(h.position.y - y)).toBeLessThan(0.5);
  });

  it('accelerates forward with the nose down and holds altitude while doing so', () => {
    const h = airborne();
    fly(h, 20, input({ pitch: 1 }));
    // Heading 0 faces -Z.
    expect(h.velocity.z).toBeLessThan(-55);
    expect(h.speed).toBeLessThan(75);
    expect(Math.abs(h.position.y - 100)).toBeLessThan(3);
  });

  it('self-levels when the stick is released', () => {
    const h = airborne();
    fly(h, 2, input({ pitch: 1, roll: 1 }));
    expect(h.noseDown).toBeGreaterThan(0.4);
    fly(h, 2, input());
    expect(Math.abs(h.noseDown)).toBeLessThan(0.02);
    expect(Math.abs(h.bankRight)).toBeLessThan(0.02);
  });

  it('turns right with right yaw and with a right bank at speed', () => {
    const pedal = airborne();
    fly(pedal, 1, input({ yaw: 1 }));
    expect(pedal.yaw).toBeLessThan(-0.5);

    const bank = airborne();
    fly(bank, 10, input({ pitch: 1 }));
    const yaw = bank.yaw;
    fly(bank, 2, input({ pitch: 1, roll: 1 }));
    expect(bank.yaw).toBeLessThan(yaw - 0.5);
  });

  it('survives a gentle landing and is damaged by a crash', () => {
    const gentle = airborne(10);
    fly(gentle, 8, input({ collective: -0.3 }));
    expect(gentle.landed).toBe(true);
    expect(gentle.health).toBe(100);

    const crash = airborne(60);
    crash.velocity.set(0, -25, 0);
    fly(crash, 10, input({ collective: -1 }));
    expect(crash.landed).toBe(true);
    expect(crash.health).toBeLessThan(100);
  });

  it('is pushed out of buildings', () => {
    const wall: CollisionWorld = {
      surfaceHeight: () => 0,
      collide: (p, r) => (p.z < -50 + r ? new THREE.Vector3(0, 0, -50 + r - p.z) : new THREE.Vector3()),
    };
    const h = airborne();
    fly(h, 10, input({ pitch: 1 }), wall);
    expect(h.position.z).toBeGreaterThanOrEqual(-50 + 4 - 0.5);
  });
});

describe('carrying a load and fighting off grabbers', () => {
  it('climbs more slowly when fully loaded', () => {
    const empty = airborne(50);
    const full = airborne(50);
    full.load = 1;
    fly(empty, 2, input({ collective: 1 }));
    fly(full, 2, input({ collective: 1 }));
    expect(full.position.y).toBeLessThan(empty.position.y - 3);
  });

  it('can always climb out from under a pile of zombies, but takes damage', () => {
    const h = new Helicopter();
    h.reset(0, 0, 0, 0);
    fly(h, 5, input());
    h.load = 1;
    h.grabbers = 12;
    fly(h, 3, input({ collective: 1 }));
    expect(h.position.y).toBeGreaterThan(1.9 + 1);
    expect(h.health).toBeLessThan(100);
  });
});
