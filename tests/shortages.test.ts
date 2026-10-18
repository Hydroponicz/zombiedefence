import { describe, expect, it } from 'vitest';
import { deployed } from './helpers';
import { CitySim, createCity } from '../src/sim/CitySim';
import { airportOf } from '../src/sim/command';
import { shortageAlerts } from '../src/sim/logistics';
import { baseOf } from '../src/sim/operations';
import { policeAmmo } from '../src/sim/supplies';
import type { CityState } from '../src/sim/types';

const named = (s: CityState, name: string) => s.districts.find((d) => d.name === name)!;

/** An outbreak in Westfield with no trucks to help (the airport's stores empty). */
function outbreak(seed: string): CitySim {
  const sim = deployed(new CitySim(seed));
  const s = sim.state;
  const airport = airportOf(s);
  airport.medicine = 0;
  airport.troops.ammo = airport.troops.strength * 300;
  const d = named(s, 'Westfield');
  d.flags.outbreak = true;
  d.zombies = 300;
  d.infected = 200;
  return sim;
}

describe('Shortages', () => {
  it('of ammunition: troops kill less, the radio says they are holding their fire, and the HUD shows it', () => {
    const kills = (ammo: number) => {
      const sim = outbreak('ammo');
      const d = named(sim.state, 'Westfield');
      d.troops.strength = 60;
      d.troops.ammo = ammo;
      // No rounds from the police armoury either.
      for (const x of sim.state.sites) if (x.district === d.id && x.kind === 'police') x.ammo = 0;
      d.medicine = 1e5;
      const zombies = d.zombies;
      sim.step(60);
      return { killed: zombies - d.zombies, s: sim.state, d };
    };
    const full = kills(60 * 300);
    const dry = kills(60 * 20);
    expect(dry.killed).toBeLessThan(full.killed * 0.6);
    expect(dry.s.log.some((e) => /Westfield are running out of ammunition and holding their fire/.test(e.text))).toBe(true);
    expect(shortageAlerts(dry.s, dry.d).some((a) => /holding fire/.test(a))).toBe(true);
    // Sweeping the streets uses rounds even with few kills.
    expect(full.d.troops.ammo).toBeLessThan(60 * 300 - 60 * 6);
  });

  it('of ammunition for the police: their armoury runs dry and they fight with batons', () => {
    const sim = outbreak('police');
    const s = sim.state;
    const d = named(s, 'Westfield');
    d.troops.strength = 0;
    d.troops.ammo = 0;
    for (const x of s.sites) if (x.district === d.id && x.kind === 'police') x.ammo = 0;
    sim.step(5);
    expect(policeAmmo(s, d)).toBe(0);
    expect(s.log.some((e) => /police in Westfield are out of ammunition/.test(e.text))).toBe(true);
    // A crate of ammunition fills the armoury.
    sim.command({ type: 'loadCrate', kind: 'ammo' });
    expect(sim.command({ type: 'dropCrate', district: d.id })).toBe(true);
    expect(policeAmmo(s, d)).toBeGreaterThan(0);
  });

  it('of medicine: the bitten turn untreated, the radio says so, and it ends when medicine comes', () => {
    const sim = outbreak('medicine');
    const s = sim.state;
    const d = named(s, 'Westfield');
    d.medicine = 0;
    for (const x of s.sites) if (x.district === d.id) x.medicine = 0;
    sim.step(60);
    expect(s.log.some((e) => /Westfield is out of medicine/.test(e.text))).toBe(true);
    expect(s.today[d.id].untreated).toBeGreaterThan(10);
    expect(shortageAlerts(s, d)[0]).toMatch(/No medicine/);
    airportOf(s).medicine = 3000;
    sim.command({ type: 'loadCrate', kind: 'medicine' });
    const pharmacy = s.sites.find((x) => x.district === d.id && x.kind === 'pharmacy')!;
    expect(sim.command({ type: 'dropCrate', district: d.id, site: pharmacy.id })).toBe(true);
    sim.step(2);
    expect(s.log.some((e) => /Medicine has reached Westfield/.test(e.text))).toBe(true);
    expect(s.today[d.id].delivered.you.medicine).toBe(3000);
  });

  it('show in the morning report: what you delivered, and the bitten isolated because of it', () => {
    const s = deployed(createCity('report'));
    const d = named(s, 'Westfield');
    airportOf(s).medicine = 0;
    d.flags.outbreak = true;
    d.infected = 300;
    d.medicine = 0;
    for (const x of s.sites) if (x.district === d.id) x.medicine = 0;
    // The day is replayed without you for its report from here.
    const sim = new CitySim(s, true);
    // Into the day, a crate of medicine to Westfield; then on to the morning report.
    sim.step(1);
    baseOf(s).medicine += 3000;
    sim.command({ type: 'loadCrate', kind: 'medicine' });
    const pharmacy = s.sites.find((x) => x.district === d.id && x.kind === 'pharmacy')!;
    expect(sim.command({ type: 'dropCrate', district: d.id, site: pharmacy.id })).toBe(true);
    sim.step(1440 - (s.t % 1440) + 360 + 1);
    const report = s.campaign.reports.at(-1)!;
    const day = report.districts!.find((x) => x.district === d.id)!;
    expect(day.delivered.you.medicine).toBe(3000);
    expect(day.isolated - day.isolatedWithout).toBeGreaterThan(50);
    // Without it, more of them would have turned untreated.
    expect(day.untreatedWithout).toBeGreaterThan(day.untreated + 20);
    expect(s.log.some((e) => /more of the bitten were found and isolated/.test(e.text))).toBe(true);
  });
});
