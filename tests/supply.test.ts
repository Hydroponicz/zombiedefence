import { describe, expect, it } from 'vitest';
import { CitySim, createCity } from '../src/sim/CitySim';
import { districtAt } from '../src/sim/layout';
import { nodeX, nodeZ } from '../src/sim/streets';
import { clean, RAIL, TRAIN_RATIONS, TRUCK_RATIONS, truckPose, updateSupply } from '../src/sim/supply';
import { ACCESS_END } from '../src/sim/airportGrounds';
import { closedEdge, edgeIndex } from '../src/sim/traffic';
import type { CityState } from '../src/sim/types';

const quiet = () => {};
const people = (s: CityState, id: number) => {
  const d = s.districts[id];
  return d.population + d.troops.strength + d.infected;
};

/** A city with no infection anywhere. */
function cleanCity(seed = 'supply'): CityState {
  const s = createCity(seed);
  for (const d of s.districts) {
    d.infected = 0;
    d.zombies = 0;
  }
  return s;
}

const industrial = (s: CityState) => s.districts.find((d) => d.kind === 'industrial')!;

describe('food supply', () => {
  it('never lets a district without infection run out of food', () => {
    const sim = new CitySim(cleanCity());
    // Nobody ever gets bitten in this test: keep the city clean while the days pass.
    for (let m = 0; m < 1440 * 6; m++) {
      sim.step(1);
      for (const d of sim.state.districts) {
        d.infected = 0;
        d.zombies = 0;
        if (d.population > 0) expect(d.rations).toBeGreaterThan(0);
      }
    }
    expect(sim.state.supply.seq).toBeGreaterThan(20);
  });

  it('runs freight trains into the rail yard while the industrial district is clean', () => {
    const s = cleanCity();
    s.supply.yard = 0;
    let delivered = 0;
    for (let m = 0; m < 600; m++) {
      const before = s.supply.yard;
      updateSupply(s, false, quiet);
      if (s.supply.yard > before) delivered += s.supply.yard - before;
      s.t++;
    }
    expect(delivered).toBeGreaterThanOrEqual(TRAIN_RATIONS);
    expect(s.supply.railHalted).toBe(false);
  });

  it('stops the trains when infection reaches the rail yard, and starts them again once it is clean', () => {
    const s = cleanCity();
    const yard = industrial(s);
    yard.infected = 5;
    s.supply.yard = 0;
    for (let m = 0; m < 600; m++, s.t++) updateSupply(s, false, quiet);
    expect(s.supply.railHalted).toBe(true);
    expect(s.supply.yard).toBe(0);
    yard.infected = 0;
    for (let m = 0; m < 600; m++, s.t++) updateSupply(s, false, quiet);
    expect(s.supply.railHalted).toBe(false);
    expect(s.supply.yard).toBeGreaterThan(0);
  });

  it('sends regional trucks to clean districts once the city stocks are spent, but not to infected ones', () => {
    const s = cleanCity();
    s.supply.yard = 0;
    for (const d of s.districts) if (d.features.warehouse) d.rations = 0;
    const hungry = s.districts.find((d) => d.name === 'Westfield')!;
    const sick = s.districts.find((d) => d.name === 'Eastside')!;
    hungry.rations = 0;
    sick.rations = 0;
    sick.infected = 50;
    updateSupply(s, true, quiet);
    const to = (id: number) => s.supply.trucks.filter((t) => t.to === id);
    expect(to(hungry.id).length).toBeGreaterThan(0);
    expect(to(hungry.id).every((t) => t.from === -1)).toBe(true);
    expect(to(sick.id)).toHaveLength(0);
    // A clean district's shelves are never bare, even before the trucks arrive.
    expect(hungry.rations).toBeGreaterThan(0);
    expect(clean(sick)).toBe(false);
  });

  it('brings the airport its food by its access road, never across the airfield', () => {
    const s = cleanCity();
    const airport = s.districts.find((d) => d.kind === 'airbase')!;
    const sim = new CitySim(s);
    let truck: (typeof s.supply.trucks)[number] | undefined;
    for (let m = 0; m < 1440 * 3 && !truck; m++) {
      airport.rations = 0;
      sim.step(1);
      truck = s.supply.trucks.find((t) => t.to === airport.id);
    }
    expect(truck).toBeTruthy();
    const path = truck!.path;
    expect([path[path.length - 2], path[path.length - 1]]).toEqual(ACCESS_END);
    for (let k = 2; k < path.length; k += 2) expect(closedEdge(edgeIndex(path[k - 2], path[k - 1], path[k], path[k + 1]))).toBe(false);
    expect(s.log.some((e) => /can't get through to Kessler/.test(e.text))).toBe(false);
  });

  it('drives trucks along the streets and unloads on arrival', () => {
    const s = cleanCity();
    const d = s.districts.find((x) => x.name === 'Northside')!;
    d.rations = 0;
    updateSupply(s, true, quiet);
    const truck = s.supply.trucks.find((t) => t.to === d.id)!;
    expect(truck).toBeDefined();
    // Starts at its first corner and ends at its last, inside the destination.
    const start = truckPose(truck, truck.depart);
    expect(start.x).toBeCloseTo(nodeX(truck.path[0]));
    expect(start.z).toBeCloseTo(nodeZ(truck.path[1]));
    const end = truckPose(truck, truck.arrive);
    expect(districtAt(end.x, end.z)).toBe(d.id);
    const before = d.rations;
    s.t = Math.ceil(truck.arrive);
    updateSupply(s, false, quiet);
    expect(s.supply.trucks.find((t) => t.id === truck.id)).toBeUndefined();
    expect(d.rations).toBeGreaterThanOrEqual(before + TRUCK_RATIONS - 1e-6);
    expect(people(s, d.id)).toBeGreaterThan(0);
  });

  it('loses trucks crossing overrun ground', () => {
    const s = cleanCity();
    for (const d of s.districts) d.rations = 0;
    updateSupply(s, true, quiet);
    const sent = s.supply.trucks.length;
    for (const d of s.districts) if (d.kind !== 'airbase') d.status = 'overrun';
    for (let h = 0; h < 12; h++) {
      s.t += 60;
      updateSupply(s, true, quiet);
    }
    expect(sent).toBeGreaterThan(0);
    expect(s.supply.trucks.length).toBe(0);
  });

  it('lays the railway into the industrial district', () => {
    const s = cleanCity();
    expect(districtAt(RAIL.x, RAIL.stopZ)).toBe(industrial(s).id);
    expect(RAIL.farZ).toBeGreaterThan(RAIL.stopZ);
  });
});
