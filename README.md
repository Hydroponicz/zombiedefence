# Zombie Defence

A 3D browser sandbox where a city falls to a zombie outbreak in real time and you fly the
helicopter that tries to hold it together. See [DESIGN.md](DESIGN.md) for the full design.

## Running it

```bash
npm install
npm run dev        # open the printed localhost URL
```

Add `?seed=1234` to the URL to replay a specific city and outbreak.

| Command | What it does |
|---|---|
| `npm run dev` | Dev server with hot reload |
| `npm run build` | Typecheck and production build into `dist/` |
| `npm test` | Simulation, clock and flight model tests |
| `npm run sim -- --seed 42 --days 14` | Run the city simulation headless and print the collapse day by day (`--districts` for per-district detail, `--events all\|warn\|critical`) |

## Controls

| Action | Controller | Keyboard / mouse |
|---|---|---|
| Throttle up / down | RT / LT | W / S |
| Yaw left / right | LB / RB | A / D |
| Pitch / roll | Left stick | Arrow keys or Numpad 8 5 4 6 |
| Camera | Right stick | Mouse (click to capture), wheel zooms |
| Camera distance | R3 | C |
| Searchlight | Y | L |
| City map (debug) | View | M |
| Time speed | D-pad left / right (LT / RT on the map) | [ / ] |
| Map: select district | D-pad | Arrow keys or click |
| Map: overlay | LB / RB | 1–6 or Tab |
| Pause | Menu | Esc |
| Show / hide controls | | H |

Any controller using the browser's standard gamepad mapping works (Xbox, PlayStation, most others).

## What's in phase 1

- **Arcade helicopter** in the GTA V style: the stick sets the attitude and the aircraft self-levels
  when released, neutral throttle holds altitude, banking turns the nose, landings and crashes do damage.
- **Generated city** of 12 districts (downtown, residential, harbor, hospital, university, industrial,
  airbase) with collision against every building and landable rooftops.
- **Day and night** on the design's clock: a full day is 30 real minutes (20 day, 10 night).
- **City simulation** running in a Web Worker: outbreak, supplies, power grid, civil order and troops,
  all deterministic from a seed. Its events come in over the radio.
- **Debug map** with overlays for status, infection, power, order, supplies and troops, a history chart
  and the full radio log.
- **District lights** follow the simulation's power grid, so blackouts are visible from the air.

## What's in phase 2

- **Living streets** within about 380 m of the helicopter: zombies, civilians and soldiers whose
  numbers match the simulation (one-for-one while an outbreak is small, compressed for hordes).
  Zombies shamble along the streets, chase and bite civilians, who flee and later rise as zombies.
  Soldiers man sandbag posts while their district holds and shoot with tracers.
- **Rotor noise:** hovering under 70 m draws nearby zombies toward the helicopter (the HUD shows
  how many) and is reported to the simulation, which pulls hordes in from neighbouring districts.
- **The collapse from afar:** smoke columns and street fires over contested, rioting and overrun
  districts; depot fires with towering black smoke; abandoned cars across the city.
- **HUD:** the district panel shows rough zombie and troop counts.

## Project layout

```
src/sim/      City simulation (no browser dependencies), clock, layout, worker bridge
src/world/    City generation and collision, street grid, people on the streets, effects, sky
src/heli/     Helicopter flight model and chase camera
src/input/    Keyboard, mouse and gamepad input
src/ui/       HUD and debug map
scripts/      Headless simulation runner
tests/        Vitest tests
```
