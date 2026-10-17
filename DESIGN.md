# Zombie Defence — Design Doc

> Living document. Numbers are starting points for tuning, not final values.

## Pitch

A 3D browser sandbox where a city falls to a zombie outbreak in real time. You're the
helicopter pilot and air-logistics commander: fly troops to breaches, evacuate key
scientists and civilians, keep fuel and supplies moving, and hire AI pilots to extend your
reach. The city **will** fall. The question is **when**, and how much you save before it does.

## Pillars

1. **The city lives without you.** A background simulation runs the whole outbreak:
   shortages, riots, grid failure, hordes. You push against it; you never fully control it.
2. **Every seat and every litre counts.** Cargo space, fuel and rations are always scarce,
   and every flight is a trade-off.
3. **You can see the impact.** The city shows its state from the air (lights, smoke, crowds),
   and the game tells you what your actions caused.
4. **Flying feels great.** GTA V-style arcade helicopter handling, full controller support.

---

## Time

| | Game time | Real time | Rate |
|---|---|---|---|
| Day | 06:00 – 20:00 (14 h) | 20 min | ~1.43 real min per game hour |
| Night | 20:00 – 06:00 (10 h) | 10 min | 1 real min per game hour |
| **Full day** | 24 h | **30 min** | |

- The simulation ticks once per **game minute** (~0.7 ticks/s by day, 1 tick/s by night).
- Dusk and dawn are short transitions. Night is shorter but more dangerous (see Zombies).
- Pause or fast-forward is available while on the ground at base (sandbox convenience).

## Structure: an open-ended sandbox

- No win state. The outbreak grows on a curve the player can **bend but not break**.
- A run ends at **Collapse**: when the last held safe zone (including your main base) falls.
  You can also retire voluntarily by evacuating the base on a final flight.
- End-of-run report: days survived, people evacuated, scientists saved, districts held
  longest, and the key moments ("Eastside held 3 extra days because you kept its substation
  fuelled").
- Research from scientists **slows** the curve (lower infection rate, better troops, cheaper
  fuel use) but never stops it.

---

## Simulation architecture

Two levels, so it runs in a browser:

- **City sim (abstract, always on):** about 12 districts on a graph, each a small set of numbers.
  Runs in a **Web Worker** on a fixed tick with a **seeded, deterministic** random number
  generator. It can run headless at high speed for balancing.
- **Local scene (concrete, near the player):** when the heli is within range of a district,
  the renderer spawns crowds, zombies, fires and vehicles that match the district's numbers.
  Player actions (landings, drops, gunfire) write back into the numbers. When the player
  leaves, the scene folds back into the abstract state.

### District state (keep it small)

| Field | Meaning |
|---|---|
| `population` | Healthy civilians |
| `infected` | Bitten, turning soon |
| `zombies` | Active zombies in the district |
| `troops` | Squads: strength, ammo, fatigue, morale |
| `food`, `water`, `medicine` | Stock (days of supply) |
| `fuel` | Local fuel stock (generators, depots) |
| `power` | Grid state: on / backup / dark |
| `order` | 0–100: calm → anxious → panic → riot → collapse |
| `status` | held / contested / overrun |

### Simulation layers and cascades

- **Outbreak:** infection spreads by contact. Zombies move between districts as **hordes**,
  drawn to noise (rotor wash, gunfire), light and dense crowds.
- **Supplies:** panic buying drains stock early, then real shortages set in. Low food and
  water push `order` down.
- **Infrastructure:** substations need crews and, once the main grid fails, fuel. When power
  goes, water pumps stop, hospitals run on generators, and fuel demand spikes.
- **Social order:** shortages, darkness and nearby zombies drive riots. Riots loot depots,
  pull troops off barricades and spread infection.
- **Military (lite):** squads hold positions and lose ammo, tire out and lose morale. Low
  morale makes them fall back or rout. Tired squads need rotating out.

Cascades come from thresholds, not scripts. A typical chain:
power fails → pumps stop → hospital on generators → fuel demand → riot at the fuel depot →
troops pulled off the barricade → breach.

**The light dilemma:** lit districts are calmer but draw hordes at night.

**Hordes** (`src/sim/hordes.ts`): a district whose zombies outnumber its prey (or that has fallen)
sheds 30% of them as a horde. Hordes move along the street lattice at about 2.5 m/s (twice that
when hunting noise). They pick the district with the strongest draw: √(people) × light at night ×
noise, divided by distance, and switch only for a 30% stronger draw. Each hour they absorb 15% of
the resident dead where they stand, merge within 220 m, settle for three hours on arrival, and
scatter back into the district below 40. Horde zombies count toward a district's combat and
status (`totalZombies`). Without a player they snowball into a few masses of 50–100k by day 14.

### Expected arc (emergent, varies per seed)

- **Days 1–2 (confusion):** scattered outbreaks, grid up, traffic jams block road evacuation.
- **Days 3–5 (shortages):** stores emptied, supply-point queues, first riots, troops stretched.
- **Days 6–9 (breakdown):** substations fail and districts go dark. Hospitals become hot spots.
- **Day 10+ (aftermath):** isolated holdouts, self-organised survivor groups, huge hordes.

---

## The player

### Missions (self-directed, from radio calls and the map)

- **Reinforce a breach:** fly troops in fast, and shuttle out tired squads.
- **Scientist extraction:** high value, usually in dangerous sites (labs, hospitals).
- **Civilian evacuation:** fewer mouths to feed and less riot risk in the district.
- **Supply drop:** rations, water, ammo, medicine (landed or sling-loaded).
- **Engineer escort:** carry a repair crew to a failing substation and cover them while they work.
- **Fuel run:** sling-load fuel bladders from a depot (see Fuel).
- **Pilot rescue:** downed or stranded pilots can be recruited (see AI pilots).

### Hot landing zones

- Boarding takes seconds per passenger. **Rotor noise draws zombies**, so lingering escalates.
- Hover too low and zombies grab the skids, pulling the heli down.
- Smoke flares mark landing zones. Some calls come from zones that are already overrun.
- Payload weight changes handling: a full heli is sluggish and burns more fuel.

---

## Economy

Three physical resources. All are stored at bases and moved by air:

| Resource | Used for | Sources |
|---|---|---|
| **Rations** (food + water) | Feeding civilians at bases, **paying pilots**, calming districts | Warehouses, supply drops (early days), scavenging sites |
| **Fuel** | Every flight, generators, power backup | Fuel depots, airport tank farm, gas stations |
| **Ammo** | Troop effectiveness | Armouries, military depots |

**Rations are the currency.** Every ration paid to a pilot is a ration a civilian doesn't
eat. Evacuating civilians adds mouths to feed at your base, so saving people creates its own
cost.

Research points (from scientists) are separate and unlock upgrades.

### Fuel

- Every heli burns fuel by flight time, weight and how hard it's flown. Running dry means
  autorotation and a crash landing.
- **Fuel sources are places in the city** that can be overrun, looted by rioters, or
  set on fire (which draws a horde).
- **Ways to get it to base:**
  - **Sling-load runs:** lift fuel bladders from a depot. This is slow, heavy flying.
  - **Defended depots:** station troops at a depot, and it trickles fuel to base while held.
  - **Forward refuelling points (FARPs):** deliver fuel and a squad to a rooftop or park to
    create a forward refuelling point. This extends range but must be held and resupplied.
- Generators compete for the same fuel, so fuel for helis can mean darkness somewhere else.

---

## AI pilots

AI pilots extend your reach but are a resource to manage, not a free multiplier.

### Recruiting
- Pilots appear among evacuees (police, news and civilian pilots, National Guard), or as
  **downed or stranded pilots** you rescue on a dedicated mission.
- Each pilot needs an airframe. Helis are limited: salvage them from airfields and hospital
  helipads, or lose them to crashes.

### Paying them
- Pilots demand **rations per day** (a daily wage) plus a bonus for dangerous jobs.
- Missed pay lowers **loyalty**. Low loyalty means refusing orders, then **deserting with the
  heli** (and sometimes the cargo).

### Traits
| Trait | Effect |
|---|---|
| Skill | Speed, fuel efficiency, crash chance in hot landing zones |
| Nerve | Willingness to take risky jobs, and holding a landing zone under pressure |
| Loyalty | Driven by pay, success and losses. Low loyalty leads to refusals and desertion |
| Fatigue | Builds per sortie. Exhausted pilots make mistakes; they need rest at base |

### Orders
- **Standing routes:** e.g. "fuel run Depot A → Base", "rations to Northside every 4 hours".
- **One-off tasks** from the map: evacuate X, drop Y.
- AI pilots are good at routine runs and **unreliable in hot zones**, so the critical,
  messy missions stay with the player.
- Pilots resolve abstractly when far from the player (success and loss chances from traits,
  district danger and weather), and fly for real when the player is nearby.

---

## Visible impact (legibility)

- **From the air:** district lights going dark at night, riot smoke, crowds at supply
  points, burning vehicles at failed barricades, fires at looted depots.
- **Radio chatter:** constant, prioritised status calls and requests.
- **Map overlays:** power, order, supplies, infection, fuel, troop morale.
- **Daily report with cause and effect:** links your actions to outcomes.

---

## Controls (GTA V style)

| Action | Controller | Keyboard |
|---|---|---|
| Throttle up / down | RT / LT | W / S |
| Yaw left / right | LB / RB | A / D |
| Pitch / roll | Left stick | Arrow keys / numpad 8-5-4-6 |
| Camera | Right stick | Mouse |
| Map / command | View (Back) | M |
| Flare / sling hook / interact | Face buttons | E / F / G |

Arcade flight model: auto-level when sticks are released, altitude hold at neutral
throttle, light assists. Deadzones and sensitivity are configurable. Uses the Gamepad API
"standard" mapping.

## Tech

- **Vite + TypeScript + Three.js**, low-poly stylised art.
- City generated from a block grid with district boundaries.
- **Zombie crowd** (`src/world/Crowd.ts`): up to 9,000 agents in typed arrays, drawn in one
  instanced draw call. Poses are animated in the vertex shader. Spatial hashes use counting sort.
  A BFS flow field on a 4 m walk grid drives attraction. Horde members take slots along a shared
  path. Updates are tiered by distance (every frame within 120 m, every 2nd frame within 350 m,
  every 4th frame beyond). Civilians and soldiers stay as plain objects (`Agents.ts`).
- **Next steps for bigger hordes:**
  - Move the crowd update to a worker over a SharedArrayBuffer (needs COOP/COEP headers).
  - Use a cheaper far LOD: impostor quads beyond about 300 m.
  - Pile zombies up into climbing pyramids against buildings with the helicopter on the roof.
- Custom arcade heli physics. Add Rapier only if collisions need it.
- City sim in a Web Worker, deterministic and seeded, with a headless runner for balancing.

## Build order

Status: phases 1–5 are done (see README). AI helicopters follow their planned routes visually but
don't fly full physics near the player; their outcomes are resolved in the simulation. The player's
own replacement helicopters don't yet draw from the limited airframe pool. Research points accumulate but there is nothing to spend
them on yet (phase 7). The base gets a daily supply flight so the player has troops and stores to
move. The supply flight deliberately brings no fuel: fuel comes from the city's depots.

Phase 1 tuning note: with no player, the baseline run is a slow outbreak on days 1–4, shortages
and riots on days 4–6, most districts falling on days 6–9, and the base falling around day 14–16.
The main breakdown is still fairly compressed (about two days); revisit once the player can
reinforce districts.

1. **In parallel:**
   - Heli flight feel over a generated city, with controller and keyboard.
   - Headless city sim with a 2D debug map: watch the cascades and tune them.
2. **Connect them:** district state drives the visuals; landing and drops write back.
3. **Core player actions:** troop drops, evacuations, supply drops, hot landing zones.
4. **Fuel:** consumption, depots, sling loads, forward refuelling points.
5. **AI pilots:** recruiting, ration wages, traits, standing routes.
6. **Layer in** grid failure, riots and military morale one at a time, tuning as you go.
7. **Research, the end-of-run report, polish.**
