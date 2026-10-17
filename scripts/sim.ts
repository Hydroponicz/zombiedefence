// Headless city simulation for balancing.
//   npm run sim -- --seed 42 --days 14 [--events all|warn|critical] [--districts]

import { CitySim } from '../src/sim/CitySim';
import { formatClock, MINUTES_PER_DAY } from '../src/sim/clock';
import type { CityState } from '../src/sim/types';

const args = process.argv.slice(2);
const arg = (name: string, fallback: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const seed = arg('seed', '1');
const days = Number(arg('days', '14'));
const eventLevel = arg('events', 'critical');
const showDistricts = args.includes('--districts');

const sim = new CitySim(seed);
const fmt = (n: number) => (n >= 10000 ? `${(n / 1000).toFixed(0)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : n.toFixed(0));

function summary(s: CityState): string {
  let pop = 0, inf = 0, z = 0, tr = 0, dead = 0;
  const count = { held: 0, contested: 0, overrun: 0, dark: 0, riot: 0 };
  for (const d of s.districts) {
    pop += d.population;
    inf += d.infected;
    z += d.zombies;
    tr += d.troops.strength;
    dead += d.dead;
    count[d.status]++;
    if (d.power === 'dark') count.dark++;
    if (d.rioting) count.riot++;
  }
  return [
    formatClock(s.t).padEnd(15),
    `pop ${fmt(pop).padStart(5)}`,
    `inf ${fmt(inf).padStart(5)}`,
    `Z ${fmt(z).padStart(5)}`,
    `troops ${fmt(tr).padStart(4)}`,
    `dead ${fmt(dead).padStart(5)}`,
    `grid ${(s.grid * 100).toFixed(0).padStart(3)}%`,
    `H/C/O ${count.held}/${count.contested}/${count.overrun}`,
    `dark ${count.dark}`,
    `riot ${count.riot}`,
  ].join('  ');
}

function districtTable(s: CityState): string {
  return s.districts
    .map((d) => {
      const people = d.population + d.troops.strength + d.infected;
      return `    ${d.name.padEnd(19)} ${d.status.padEnd(9)} ${d.power.padEnd(6)} pop ${fmt(d.population).padStart(5)} ` +
        `Z ${fmt(d.zombies).padStart(5)} T ${fmt(d.troops.strength).padStart(4)} ` +
        `ord ${d.order.toFixed(0).padStart(3)} food ${(d.rations / Math.max(1, people)).toFixed(1).padStart(4)}d ` +
        `fat ${d.troops.fatigue.toFixed(2)} mor ${d.troops.morale.toFixed(2)}${d.rioting ? ' RIOT' : ''}`;
    })
    .join('\n');
}

const levels = { info: 0, warn: 1, critical: 2 } as const;
const minLevel = eventLevel === 'all' ? 0 : levels[eventLevel as keyof typeof levels] ?? 2;

console.log(`seed ${seed}`);
console.log(summary(sim.state));
for (let day = 0; day < days; day++) {
  for (let m = 0; m < MINUTES_PER_DAY; m++) {
    sim.step();
    for (const e of sim.takeEvents()) {
      if (levels[e.severity] >= minLevel) console.log(`    ${formatClock(e.t)}  [${e.severity}] ${e.text}`);
    }
  }
  console.log(summary(sim.state));
  if (showDistricts) console.log(districtTable(sim.state));
}
if (sim.state.collapsedAt !== null) console.log(`Collapsed at ${formatClock(sim.state.collapsedAt)}`);
