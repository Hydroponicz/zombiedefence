import { describe, expect, it } from 'vitest';
import { CitySim, createCity } from '../src/sim/CitySim';
import { districtAt, DISTRICT_TEMPLATES } from '../src/sim/layout';
import { applyCommand } from '../src/sim/operations';
import { planSites, updateSites } from '../src/sim/sites';
import { BLOCKS_PER_DISTRICT, nearestNode, nodeX, nodeZ } from '../src/sim/streets';
import type { CityState, Site } from '../src/sim/types';

const quiet = () => {};
const steady = () => 1;

function city(): CityState {
  const s = createCity('sites');
  for (const d of s.districts) {
    d.zombies = 0;
    d.infected = 0;
  }
  return s;
}

const westfield = DISTRICT_TEMPLATES.findIndex((d) => d.name === 'Westfield');
const siteOf = (s: CityState, kind: Site['kind'], district = westfield) => s.sites.find((x) => x.district === district && x.kind === kind)!;

function hours(s: CityState, n: number, night = false): void {
  for (let h = 0; h < n; h++) updateSites(s, night, quiet, steady);
}

describe('site planning', () => {
  const plans = planSites('plan');

  it('gives every city district its key buildings, and the base none', () => {
    DISTRICT_TEMPLATES.forEach((tpl, d) => {
      const here = plans.filter((p) => p.district === d);
      if (tpl.kind === 'airbase') {
        expect(here).toHaveLength(0);
        return;
      }
      const kinds = new Set(here.map((p) => p.kind));
      if (tpl.kind === 'industrial') {
        // Works, not shelters and shops.
        expect([...kinds].sort()).toEqual(['depot', 'factory', 'fuelTerminal', 'waterworks']);
        return;
      }
      expect(kinds.has('supermarket')).toBe(true);
      expect(kinds.has('shelter')).toBe(true);
      expect(kinds.has('police')).toBe(true);
    });
  });

  it('builds each kind to suit how dense its district is', () => {
    const variant = (district: string, kind: string) =>
      plans.find((p) => DISTRICT_TEMPLATES[p.district].name === district && p.kind === kind)!.variant;
    expect(variant('Westfield', 'police')).toBe('station');
    expect(variant('Riverside', 'police')).toBe('precinct');
    expect(variant('Downtown', 'police')).toBe('hq');
    expect(variant('Westfield', 'supermarket')).toBe('store');
    expect(variant('Riverside', 'supermarket')).toBe('market');
    expect(variant('Downtown', 'supermarket')).toBe('mall');
    expect(variant('Riverside', 'pharmacy')).toBe('clinic');
  });

  it('puts each site on its own block inside its district, off the landmark', () => {
    const blocks = new Set(plans.map((p) => `${p.i},${p.j}`));
    expect(blocks.size).toBe(plans.length);
    for (const p of plans) {
      expect(districtAt(p.x, p.z)).toBe(p.district);
      const tpl = DISTRICT_TEMPLATES[p.district];
      expect([p.i - tpl.col * BLOCKS_PER_DISTRICT, p.j - tpl.row * BLOCKS_PER_DISTRICT]).not.toEqual([5, 5]);
    }
  });

  it('clusters them around the district centre', () => {
    for (const p of plans) {
      const tpl = DISTRICT_TEMPLATES[p.district];
      const bi = p.i - tpl.col * BLOCKS_PER_DISTRICT + 0.5;
      const bj = p.j - tpl.row * BLOCKS_PER_DISTRICT + 0.5;
      expect(Math.hypot(bi - BLOCKS_PER_DISTRICT / 2, bj - BLOCKS_PER_DISTRICT / 2)).toBeLessThan(3.5);
    }
  });

  it('is the same for a seed and differs between seeds', () => {
    expect(planSites('plan')).toBe(plans);
    expect(planSites('other').map((p) => `${p.i},${p.j}`)).not.toEqual(plans.map((p) => `${p.i},${p.j}`));
  });
});

describe('sites in the simulation', () => {
  it('start with the district food and medicine split among them, and armouries stocked', () => {
    const s = city();
    expect(siteOf(s, 'supermarket').rations).toBeGreaterThan(1000);
    expect(siteOf(s, 'pharmacy').medicine).toBeGreaterThan(100);
    expect(siteOf(s, 'police').ammo).toBeGreaterThan(10000);
  });

  it('get soldiers posted, the police station first', () => {
    const s = city();
    s.districts[westfield].troops.strength = 15;
    hours(s, 1);
    expect(siteOf(s, 'police').guards).toBeGreaterThan(siteOf(s, 'pharmacy').guards);
    const posted = s.sites.filter((x) => x.district === westfield).reduce((n, x) => n + x.guards, 0);
    expect(posted).toBeLessThanOrEqual(15 * 0.6 + 1e-9);
  });

  it('fill shelters once the dead are in the streets', () => {
    const s = city();
    const d = s.districts[westfield];
    hours(s, 3);
    expect(d.sheltered).toBe(0);
    d.flags.outbreak = true;
    d.zombies = 400;
    hours(s, 6);
    expect(d.sheltered).toBeGreaterThan(100);
    expect(d.sheltered).toBeLessThanOrEqual(d.population);
  });

  it('hand food out to the district while staffed, and are looted when left to a riot', () => {
    const s = city();
    const d = s.districts[westfield];
    d.rations = 0;
    const store = siteOf(s, 'supermarket');
    const before = store.rations;
    hours(s, 1);
    expect(d.rations).toBeGreaterThan(0);
    expect(store.rations).toBeLessThan(before);

    const riot = city();
    const r = riot.districts[westfield];
    r.troops.strength = 0;
    r.rioting = true;
    r.order = 10;
    const loot = siteOf(riot, 'supermarket');
    const stock = loot.rations;
    hours(riot, 3);
    expect(loot.rations).toBeLessThan(stock * 0.7);
    expect(loot.looted).toBe(true);
  });

  it('fall to a settled horde unless the player garrisons them', () => {
    const besiege = (garrison: number) => {
      const s = city();
      const d = s.districts[westfield];
      d.flags.outbreak = true;
      d.troops.strength = garrison;
      const shelter = siteOf(s, 'shelter');
      shelter.sheltered = 1000;
      shelter.pinned = garrison;
      const [ni, nj] = nearestNode(shelter.x, shelter.z);
      s.hordes.push({ id: 1, x: nodeX(ni), z: nodeZ(nj), size: 4000, heading: 0, target: westfield, ni, nj, settle: 600, hunting: false, announcedAt: 0 });
      hours(s, 24);
      return { shelter, d };
    };
    const alone = besiege(0);
    expect(alone.shelter.status).toBe('fallen');
    expect(alone.shelter.sheltered).toBe(0);
    const held = besiege(80);
    expect(held.shelter.status).not.toBe('fallen');
    expect(held.shelter.sheltered).toBeGreaterThan(500);
  });

  it('keep civilians inside out of reach of the dead', () => {
    const run = (shelter: boolean) => {
      const s = city();
      const d = s.districts[westfield];
      d.troops.strength = 0;
      d.zombies = 2000;
      d.population = 10000;
      d.flags.outbreak = true;
      if (shelter) for (const x of s.sites) if (x.district === westfield) x.sheltered = x.capacity;
      d.sheltered = s.sites.reduce((n, x) => n + (x.district === westfield ? x.sheltered : 0), 0);
      // Shelter recounts happen on the hour: step just under one.
      new CitySim(s).step(59);
      return d.infected;
    };
    expect(run(true)).toBeLessThan(run(false));
  });
});

describe('player at a site', () => {
  it('garrisons, evacuates the shelter, takes stock away and delivers food there', () => {
    const s = city();
    const d = s.districts[westfield];
    const shelter = siteOf(s, 'shelter');
    shelter.sheltered = 300;
    d.sheltered = 300;
    s.cargo.troops = 4;
    for (let k = 0; k < 4; k++) expect(applyCommand(s, { type: 'deployTroop', district: westfield, site: shelter.id }, quiet)).toBe(true);
    expect(shelter.pinned).toBe(4);
    hours(s, 1);
    expect(shelter.guards).toBeGreaterThanOrEqual(4);

    for (let k = 0; k < 8; k++) expect(applyCommand(s, { type: 'board', district: westfield, kind: 'civilian', site: shelter.id }, quiet)).toBe(true);
    expect(s.cargo.civilians + s.cargo.infected).toBe(8);
    expect(shelter.sheltered).toBeLessThan(300);

    const store = siteOf(s, 'supermarket');
    const stock = store.rations;
    expect(applyCommand(s, { type: 'loadCrate', kind: 'rations', site: store.id }, quiet)).toBe(true);
    expect(store.rations).toBeCloseTo(stock - 5000, 6);
    // Delivered to the shelter, the food goes straight into the district's supplies.
    const food = s.districts[westfield].rations;
    expect(applyCommand(s, { type: 'dropCrate', district: westfield, site: shelter.id }, quiet)).toBe(true);
    expect(s.districts[westfield].rations).toBeGreaterThanOrEqual(food + 5000 * 0.7 - 1e-6);
  });

  it('cannot take more than a site holds', () => {
    const s = city();
    const pharmacy = siteOf(s, 'pharmacy');
    pharmacy.medicine = 100;
    expect(applyCommand(s, { type: 'loadCrate', kind: 'medicine', site: pharmacy.id }, quiet)).toBe(false);
  });
});

describe('industrial works', () => {
  const industrial = (s: CityState) => s.districts.find((d) => d.kind === 'industrial')!;
  const work = (s: CityState, kind: Site['kind']) => s.sites.find((x) => x.kind === kind)!;

  it('the ration factory packs food for the rail yard while it holds', () => {
    const s = city();
    const before = s.supply.yard;
    hours(s, 2);
    expect(s.supply.yard).toBeGreaterThan(before);
    work(s, 'factory').status = 'fallen';
    const after = s.supply.yard;
    hours(s, 2);
    expect(s.supply.yard).toBe(after);
    expect(industrial(s).kind).toBe('industrial');
  });

  it('losing the waterworks makes food go faster everywhere', () => {
    const eaten = (fallen: boolean) => {
      const s = city();
      if (fallen) work(s, 'waterworks').status = 'fallen';
      const d = s.districts.find((x) => x.name === 'Westfield')!;
      d.rations = 1e6;
      new CitySim(s).step(30);
      return 1e6 - d.rations;
    };
    expect(eaten(true)).toBeGreaterThan(eaten(false) * 1.15);
  });
});
