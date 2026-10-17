import { CitySim } from '../src/sim/CitySim';
for (const seed of ['42', '1', 'abc', '7', 'scene', '2', '3']) {
  const sim = new CitySim(seed);
  const t0 = performance.now();
  let d = 0;
  let auth = -1, joc = -1;
  const row: string[] = [];
  while (!sim.state.collapsed && d < 30) {
    for (let h = 0; h < 24; h++) {
      sim.step(60);
      if (auth < 0 && sim.state.flags.jocAuthorized) auth = sim.state.t / 1440;
      if (joc < 0 && sim.state.flags.joc) joc = sim.state.t / 1440;
    }
    d++;
    const ds = sim.state.districts;
    const air = ds.find((x) => x.kind === 'airbase')!;
    row.push(`${Math.round(ds.reduce((n, x) => n + x.troops.strength, 0))}t/${ds.filter((x) => x.police.stage === 'checkpoints').length}c/${Math.round(air.population)}`);
  }
  console.log(seed, 'auth', auth.toFixed(2), 'joc', joc.toFixed(2), 'collapse', sim.state.collapsed ? (sim.state.collapsedAt! / 1440).toFixed(1) : '-', 'flown', Math.round(sim.state.stats.flownOut), row.slice(0, 10).join(' '));
}
