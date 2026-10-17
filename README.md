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
| Map: overlay | LB / RB | 1–7 or Tab |
| Release slung fuel bladder | X | F |
| Landed: choose operation | D-pad up / down | Up / Down arrows |
| Landed: start / stop it | A | E or Enter |
| Flight command (AI pilots) | L3, or Y on the map | P |
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

## What's in phase 3

Land anywhere (the street, a rooftop or a helipad) and a menu of ground operations appears.
Each runs one person or crate at a time; lift off to leave.

- **At Fort Kessler:** load fresh troops (the base keeps 50 back), and relief crates of rations,
  ammunition or medicine from the base stores. Passengers unload automatically when you touch down.
  A supply flight brings fresh troops and stores every morning at 07:00.
- **In the city:** deploy troops, unload crates, evacuate civilians, relieve exhausted soldiers, and
  extract scientists from the University Heights lab and St. Mary's.
- **8 seats and 2 crate slots.** A full load climbs and turns noticeably slower.
- **Hot landing zones:** zombies drawn by the rotors reach a helicopter on the street. While they're
  at the doors, loading pauses; if they get to the skids they drag it down and tear at it until you
  climb above 6 m. Troops aboard fire from the doors while you're low. Rooftops are out of reach, but
  people take the stairs, so boarding there takes 2.5× longer (except on helipads).
- **Consequences:** evacuees can carry hidden bites into the base; rested soldiers recover at the
  base; scientists there earn research points; a crash loses everyone aboard.
- **HUD:** seats and crates, people saved, scientists extracted and research earned.

## What's in phase 4

- **Fuel:** a 1,360 L tank, about 14 minutes hovering or 11–12 at cruise; climbing, speed and load
  burn more. The HUD shows litres and minutes left, with low-fuel and bingo warnings.
- **Flameout:** run dry and the engine quits. The rotor windmills you down at a survivable rate if
  you stay level, and throttle up gives one flare to soften the landing. Without fuel you can't take
  off again.
- **Refuelling:** automatic while landed at Fort Kessler or a forward refuelling point, from their
  stocks. Base fuel also runs the base's generators when the grid fails. In the city you can siphon
  petrol stations (slow); stranded with nothing to siphon, you can abandon the helicopter, leaving
  passengers and cargo in the district and taking a replacement at the base.
- **Depots:** Harbor and Industrial Park truck fuel to the base while they're held, calm and guarded
  by 15+ troops. Land at a depot (or the base) to hook up a 2,000 L fuel bladder on a sling. It swings
  under the helicopter and weighs it down. Set it down from the menu or release it with F / X while
  it's within 4 m of the ground; dropped from higher, it bursts.
- **Forward refuelling points:** with a bladder slung and 4+ troops aboard, land anywhere in the city
  to set one up. The troops stay to guard it, more bladders refill it, and it's lost if the district is
  overrun. They show on the map, which also gains a Fuel overlay (7).

## What's in phase 5

- **AI pilots.** You start with Lt. Ana Reyes and one spare helicopter. About 3% of the civilians you
  bring in turn out to be pilots looking for work; hire them or turn them away in flight command
  (P, L3, or Y on the map). Each has skill (crash risk), nerve (which landing zones they'll accept),
  loyalty and fatigue, and asks a daily wage in rations.
- **Orders:** reinforce, resupply (rations, ammo or medicine), evacuate, relieve troops, or a fuel run
  from a depot; once, or as a standing route. Trips draw troops, crates and 700 L of fuel from the base,
  take real game time (flight, 15 minutes on the ground, the flight home) and risk a crash on landing.
  AI helicopters fly their routes in the world and on the map, and report on the radio.
- **Pay and loyalty:** wages come out of base rations at 06:00, with a bonus for dangerous jobs. Unpaid
  pilots lose loyalty, refuse orders, and finally desert with a helicopter. Tired pilots rest.
- **Helicopters are limited:** salvage abandoned ones at St. Mary's, Downtown and the Harbor (land there
  and use the menu). Crashes and desertions lose them.
- **Downed pilots** who survive a crash wait in the district: land there to pick them up.

## Project layout

```
src/sim/      City simulation (no browser dependencies), clock, layout, worker bridge
src/game/     Ground operations menu (loading, deploying, evacuating, fuel, salvage, rescues)
src/world/    City generation and collision, street grid, people on the streets, effects,
              refuelling points, sky
src/heli/     Helicopter flight model and chase camera
src/input/    Keyboard, mouse and gamepad input
src/ui/       HUD, debug map and flight command
scripts/      Headless simulation runner
tests/        Vitest tests
```
