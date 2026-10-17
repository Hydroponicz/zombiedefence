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

## Scale

Everything is built at real-world size. Districts are 1.44 km across, so the city is 5.8 x 4.3 km
for 308,000 people, about 1.5 minutes across at full speed. Blocks are 120 m between 18 m streets
and 30 m avenues; houses sit on lots with gable roofs; apartment slabs run 6–20 floors; downtown
towers rise toward a 470 m supertall with a rooftop helipad; the port stacks real 40 ft containers
under ship-to-shore cranes; the airbase has a 1.4 km runway. People are life size (about 1.75 m),
cars are 4.5 m, and the helicopter matches a Black Hawk (16 m rotor, about 245 km/h flat out).
Streetlights burn at night while a district has grid power.

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

## Police

- **Who:** every city district has police, about one officer per 900 residents, plus riot police at
  its police station. There are 12 per district and 40 at Central Police HQ downtown, but none in
  Industrial Park or at the base. Patrol officers wear navy with hi-vis vests; riot police wear black
  kit with visored helmets and shields.
- **Against the dead:** police help screen civilians and kill zombies in the early days, but kill only
  about a quarter as well as soldiers (pistols and batons against rifles). They take heavier losses,
  and the bitten among them turn.
- **Against riots:** riot police are what keeps order. A shield line raises the district's order
  target and restores order faster than soldiers can.
- **Morale:** police morale wears down every day of the outbreak, and with losses, riots, darkness
  and fear. Below about a third, officers walk off the job and go home as civilians. Most districts
  lose their police between days 7 and 10.
- **Police stations:** the district's police help hold the station, and it is only looted once
  nobody is left to guard it.
- **Where to see them:** the HUD shows "Police N" for the district, and the map sidebar shows officers,
  riot police and morale.

## Food trucks and trains

- **Freight trains** run every four hours into the rail yard in Industrial Park, on a line from the
  south. Each brings 60,000 rations. They run only while Industrial Park has no infection at all;
  the radio reports when they stop and when they start again.
- **Civilian food trucks** drive the streets from the rail yard and the Market District warehouse to
  any district below two days of food. You can see them in the city and as white squares on the map.
- **A district without infection never runs out of food.** If the city's own stocks are spent,
  regional trucks come in from outside.
- **Districts with the dead in them** get trucks only from the city's stocks, and only while they
  hold or still keep order. Once the yard and warehouse are empty they go hungry: "No food is left
  to truck into …".
- **Trucks at risk:** trucks crossing contested or overrun ground can be lost, and rioters hijack
  them.

Keeping Industrial Park clean keeps the trains running, and the trains feed the whole city.

## Fort Kessler is sealed

No infection or zombie gets into the base until every other district has been overrun:
- **Hordes:** they never target the base and walk around its perimeter.
- **Resident zombies:** they don't drift in.
- **The on-screen dead:** they pile up at the edge of the base's ground instead of crossing it.
- **The bitten:** any arriving with refugees or evacuees, yours or the AI pilots', are caught at the
  quarantine checkpoint.

When the last district falls, the radio reports "The dead are at the gates" and the base is open
to the dead from then on.

## Strategic sites

Every district has key buildings the military holds: about 54 in all. They're clustered on the blocks around each district's central intersection, as a defensible core, with exact blocks varying by seed.

- **Police stations** keep an armoury that resupplies the district's troops. Their own officers keep looters out.
- **Supermarkets** and **pharmacies** hold most of the district's food and medicine, and hand it out
  while staffed and the district runs short.
- **Shelters** take civilians in once the dead are in the streets: schools (1,500), churches and halls
  (800), and the Civic Convention Center and University Arena (6,000). People inside are mostly out of
  reach of the dead.

How sites change over time:
- **Guards:** the military posts up to 60% of a district's soldiers at its sites: police stations and
  shelters first, then food, then pharmacies. Unguarded stores are looted in a riot.
- **Sieges:** the dead besiege sites, a settled horde hardest. Barricades hold for hours, longer with
  guards. A fallen shelter loses many of the people inside, and fallen sites burn. Troops can retake a
  site once the district is quiet again.
- **Showing their status:** each site flies a flag (green held, amber under siege, black fallen),
  has a sandbag ring while guarded, and blinks a beacon at night while it holds. The map marks every
  site (P, S, H, +), the district panel lists them, and the HUD names the one you're over.
- **Land in the site's car park, field or plaza** to use it:
  - Garrison it with troops aboard (they stay posted there), or retake it if it has fallen.
  - Evacuate the shelter: quicker than the street, with people screened at the door so few of the
    bitten get aboard.
  - Load crates from its stock: food from a supermarket, ammunition from a police armoury, medicine
    from a pharmacy. This works even at a fallen site, if you dare.
  - Restock it with crates you brought.
- **AI pilots** on an evacuation run take people from the fullest shelter.

## Hordes

- **Hordes form on their own.** Once a district runs short of prey (or falls), part of its dead set
  off as a horde, usually from day 6–8 onward. Hordes walk the street grid at a shamble, toward
  whatever draws them hardest: people, lit districts at night, gunfire and your rotors. They pick up the
  dead of districts they pass through, merge when they meet, and settle on a district to attack it. By
  day 10 or so expect a handful of masses tens of thousands strong. The radio announces big ones, the
  map shows them (red discs, dashed line to their target), and the district panel shows how much of
  its count is horde.
- **Thousands on screen.** Up to 9,000 zombies are drawn at once: residents around you plus the
  hordes within about 1.2 km, laid out as a column along the streets they walked, or a dense disc
  when they've settled. Hover low and the whole mass pours toward you through the streets.
- **How it stays fast:**
  - **One draw call.** The crowd is a single instanced mesh. Each zombie is four floats of position
    and pose, and the vertex shader animates the limbs (walk, feed, claw, dead), so the CPU never
    touches a bone.
  - **Flat arrays.** Agent data lives in typed arrays, with a counting-sort spatial hash rebuilt each
    frame and no per-agent objects.
  - **Shared paths.** One flow field (a breadth-first search over a 4 m walk grid, every 0.5 s) steers
    the whole crowd around buildings toward the helicopter, and horde members follow slots along a
    shared path instead of pathfinding.
  - **Distance tiers.** Zombies within 120 m of the helicopter update every frame, those within 350 m
    every 2nd frame and the rest every 4th. Crowd separation runs at half rate.
  - Measured: about 4–5 ms of CPU per frame for 9,000 zombies, on a slow cloud CPU.

## Project layout

```
src/sim/      City simulation (no browser dependencies), clock, layout, worker bridge
src/game/     Ground operations menu (loading, deploying, evacuating, fuel, salvage, rescues)
src/world/    City generation and collision, walk grid, the zombie crowd, people on the streets, site markers, effects,
              refuelling points, sky
src/heli/     Helicopter flight model and chase camera
src/input/    Keyboard, mouse and gamepad input
src/ui/       HUD, debug map and flight command
scripts/      Headless simulation runner
tests/        Vitest tests
```
