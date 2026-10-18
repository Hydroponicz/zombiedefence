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
| Release slung fuel bladder, or drop a noise lure | X | F |
| Landed: choose operation | D-pad up / down | Up / Down arrows |
| Landed: start / stop it | A | E or Enter |
| Flight command (requests, pilots, research, platoons) | L3, or Y on the map; LT / RT change tab | P; [ ] change tab |
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

- **At the base** (Camp Ridgeway, or the JOC at Kessler Airport once it's up): load fresh troops (the
  base keeps 50 back; none until the JOC exists), and relief crates of rations, ammunition or medicine
  from the base stores. Passengers unload automatically when you touch down.
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
- **Refuelling:** automatic while landed at the base or a forward refuelling point, from their
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

## The campaign

The city can't be saved, only emptied.

- **The deadline:** once Command authorizes the Joint Operations Command, it announces that at 06:00
  nine days later the city will be sealed and sterilized. A countdown sits under the clock, and the
  radio warns at three days, six hours and one hour out.
- **The final evacuation:** for the last 24 hours, flights leave Kessler Airport every hour (800
  seats instead of 400 every three hours). The airport's gates open to everyone, and people make for
  it district by district; the bitten among them are caught at the gate.
- **How it ends:**
  - **Sealed:** the deadline arrives.
  - **Fallen:** Kessler Airport is overrun.
  - **Grounded:** you run out of helicopters. Each crash or abandoned helicopter uses up a spare
    from the fleet. With none ready, you wait for one to come back; with none at all, you're
    grounded. Salvage helicopters to keep spares.
- **Morning reports:** at 06:00 each day a report card shows the day:
  - who was flown out, who escaped by road, who you brought in, and which districts fell;
  - what you changed. The day is replayed from its start without your actions and compared, so
    the report says how many more people are alive or out of the city because of you, and which
    districts held because of you.
- **The end screen:** how many got out of the city, the lives your own actions saved (the sum of
  the daily differences), a rating, and the campaign day by day. You can fly on with the city
  running freely (Enter / A), or start a new city (N / X).

## Command requests

Every couple of hours Command puts out what the city needs most, as a request with a deadline and a
reward. There are more than one helicopter can do: triage is the game.

- **What comes up:**
  - **Supplies:** a pharmacy or shelter out of medicine, a supermarket or depot running out of food,
    or troops low on ammunition. Deliver the crates. Reward: 15 troops and order in the district.
  - **Reinforce:** a district under attack with too few soldiers. Land 8 troops. Reward: 30 troops.
  - **Evacuate:** a shelter under siege. Bring its people out. Reward: a pilot looking for work.
  - **Extract:** a research team about to be cut off. Bring the scientists out. Reward: 80 research.
  - **Overwatch:** a food truck crawling through infested streets. Hover over it (within 160 m,
    below 160 m) for 15 minutes; while you do it can't be lost, and while it waits for you its crew
    keeps its head down. Reward: a helicopter for the fleet.
- **They come in over the radio:** each new request pops up as a transmission on a cockpit radio
  (frequency display, signal bars, a squelch and call tones; one tone for routine traffic, three for a
  FLASH call), typed out as it's read: "DUSTOFF 1-1, KESSLER ACTUAL. Research team in St. Mary's…
  How copy? Over." The game holds until you answer, with one of three: take it on, hand it off (opens
  it in Flight Command to give to a pilot), or negative (it stays open in Flight Command).
  - **Choose:** D-pad or right stick left / right, <kbd>A</kbd> / <kbd>D</kbd> or the arrow keys, or
    hover with the mouse. The highlighted answer glows amber with ▶ ◀ either side.
  - **Pick it:** <kbd>A</kbd> on the controller, <kbd>Enter</kbd>, or click.
  - **Turn it down at once:** <kbd>B</kbd> or <kbd>Backspace</kbd>.

  The first press finishes the typing. Calls that come in together queue up.
- **Taking them on:** Flight Command (P) → Requests. "Take it on" puts the request under the clock
  with its distance and bearing, a gold beam marks the place in the world, and a gold diamond marks
  it on the map (the other requests are white diamonds).
- **Handing them to pilots:** any request but overwatch can go to an AI pilot as a one-off trip.
  An evacuation brings any research team out first.
- **Credit:** deliveries and boardings by you or your pilots count toward any request they answer.
  A request fails when its time runs out, or when its district, site, team or truck is lost. After
  failing it can't come back for 10 hours (6 after it's done).

## Research

Scientists at the base earn a research point an hour each (and requests can pay in research).
Spend them in Flight Command (P) → Research:

| Project | Cost | Effect |
| --- | --- | --- |
| Rapid bite tests | 120 | Checkpoints catch twice as many of the bitten, fewer slip through with people fleeing, and the bitten are caught before they board. |
| Noise lures | 200 | Load sirens at the base and drop them from the air (F / X) or set them down. For six hours a lure pulls hordes and the district's dead toward it. |
| Loudspeaker | 150 | Boarding civilians and evacuating shelters takes half the time. |
| Door gun | 250 | Fires on the dead near a low helicopter like four troops at the doors. |
| Heavy sling | 150 | Fuel bladders hold 3,000 L. |
| Troop vaccine | 600 | After rapid tests. Bitten soldiers don't turn, and fewer fall. |
| Antiviral | 1,200 | After the vaccine. The bitten among your evacuees are treated at the base instead of turned away. |

## Army platoons

Once the JOC is up, a platoon leaves the airport each hour. Flight Command (P) → Platoons shows where
the next one goes and when. Command chooses by default (districts without a platoon, those under
attack first); pick a district to send the next one there instead, or hold them at the airport.

## Downtown

Downtown is built block by block from a lumpy height field: the main financial core, a second
business cluster to the north-east, and block-to-block variation. That height field decides what goes
up:
- **Financial core:** glass office towers in several shapes: wedding-cake setbacks, slim shafts with
  spires, split twin slabs, and box towers with lit crown bands. Stone corporate headquarters and
  luxury apartment towers stand among them.
- **Mixed middle:** mid-height offices, slender apartment towers (some in pairs) over shop podiums,
  stone firms, retail, parking garages and plazas.
- **Edges:** mid-rise apartment blocks over shops around courtyards, retail streets with awnings,
  department stores, small offices and garages.

Facades come in four styles: punched windows, glass curtain walls that reflect the sky (whole office
floors light up at night), apartments with balcony slabs and warm light, and stone offices with tall
narrow windows.

## Telling the living, the bitten and the dead apart

- **Zombies** have grey dead skin, blood down the shirt and round the mouth, ragged dark clothes, a
  hunched shamble and arms reaching forward.
- **The bitten** stagger along hunched and swaying, with a bloody bandaged forearm, blood at the
  neck and grey-green skin. A civilian bitten in front of you staggers on for a few seconds, then
  collapses and rises. Some of a district's hidden infected walk among the crowds this way too, and
  the dead leave them be.
- **Civilians** walk upright in bright everyday clothes; soldiers wear olive and tan, patrol police
  hi-vis vests over navy, and riot police black.
- **Sensor overlay** (**T**, or **B** on a controller in flight): the helicopter's sensor paints
  everyone by what they are, with a fixed-size dot over each that reads at any altitude and at night.
  Zombies show red, the bitten amber, civilians green, and soldiers and police blue.

## Police

- **Who:** every city district has police, about one officer per 900 residents, plus riot police at
  its police station. There are 12 per district and 40 at Central Police HQ downtown, but none in
  Industrial Park or at the airport. Patrol officers wear navy with hi-vis vests; riot police wear black
  kit with visored helmets and shields.
- **Against the dead:** police help screen civilians and kill zombies in the early days, but kill only
  about a quarter as well as soldiers (pistols and batons against rifles). They take heavier losses,
  and the bitten among them turn.
- **Against riots:** riot police are what keeps order. A shield line raises the district's order
  target and restores order faster than soldiers can.
- **Riot squads:** riot police stay in reserve at the station until they're called out: by a riot,
  by unrest (order below 40), or by the infected starting to gather in the district. They stand down
  once the streets are quiet. Only squads that are out fight the dead; in reserve they still steady
  people a little. On the street they arrive as squads of four to eight with a riot truck parked
  at the curb, form a shield line beside it, and go out up to 70 m from it to club down the dead.
- **On the street:**
  - **Patrol cars** keep order by being seen; they don't fight from behind the wheel. When the
    dead come within 40 m, the car pulls over to the curb and its two officers get out to deal
    with them. Once it has been quiet for a while, they get back in and drive on.
  - **Foot patrols** walk in twos and threes, never alone, mostly in the downtown and commercial
    districts.
  - **Checkpoints:** once they're set up, a few officers man each checkpoint in view.
- **Morale:** police morale wears down every day of the outbreak, and with losses, riots, darkness
  and fear. Below about a third, officers walk off the job and go home as civilians. Most districts
  lose their police between days 7 and 10.
- **Police stations:** the district's police help hold the station, and it is only looted once
  nobody is left to guard it.
- **Where to see them:** the HUD shows "Police N" for the district, and the map sidebar shows officers,
  riot police and morale.

## People on the street

- Civilians keep to the sidewalks: they walk the blocks, cross at the crosswalks and turn at the
  corners. They run down the middle of the street only when fleeing the dead, or once a district has
  broken down (civil order has collapsed or it has been overrun).
- The bitten stagger along the sidewalks with everyone else until they turn.

## Traffic

The whole street grid (about 3,500 street segments) carries simulated traffic:
- **Demand:** every hour people drive. They commute between districts on a rush-hour curve, flee
  toward calmer districts when afraid, and leave the city by the highways (Highway 9 west and east,
  Routes 4 and 7 south). Trips take the quickest route; avenues carry three times what side streets
  do, and each street slows as it fills.
- **Breakdown:** gridlock and the dead nearby make drivers abandon their cars, more at night. The
  wrecks stay, choking streets until they're impassable, and rioters burn cars. Soldiers and police
  tow wrecks clear in districts they hold.
- **Logistics:**
  - Food trucks route around wrecked streets and crawl through jams.
  - Trucks stuck in a jam in an infected district are easy targets.
  - With no route left, a district can't be supplied by road: "Food trucks can't get through to …".
  - Fuel convoys need a road to the base and slow down in traffic.
- **People:** jammed streets in infected districts mean more bites. While the highways flow, some
  residents escape the city; when they're jammed, people are trapped in their cars.
- **What you see:**
  - **Around the helicopter:** every car is driven: it keeps its lane and its distance, waits at
    the lights where avenues cross (they go dark with the power), and drives on through each
    intersection or turns into the cross street, so you can follow one across the city. Cars join
    and leave out at the edge of view, as many as each street's flow calls for, and queue bumper to
    bumper in jams. Abandoned cars lie at angles across lanes and sidewalks, some burnt out.
  - **Traffic map overlay (8):** each street coloured by flow, wrecked streets purple, plus the
    highways.
  - **HUD and map sidebar:** each district's roads, e.g. "jammed · 30% wrecked".

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

## The military and police response

- **The army starts outside the city.** Its base is Camp Ridgeway, about 2 km west of the airport,
  with about 1,500 troops, the helicopters, a fuel farm and stores. You start there. The city begins
  with its police alone; no soldiers are posted in the districts.
- **The Joint Operations Command:**
  - **Authorization:** once outbreaks are confirmed in two districts, Command declares a state of
    emergency and authorizes a JOC at Kessler Airport.
  - **Setting it up:** take the command team aboard at Camp Ridgeway (4 seats), fly them to the
    airport, and choose "Establish the Joint Operations Command" on the ground. If nobody does within
    about 12 game hours, Command flies its own team in.
  - **The airlift:** it lands 400 troops with food and medicine, and a command compound goes up on the
    apron.
  - **The hub moves:** the airport becomes the military's hub. Supply flights land there, fuel
    convoys run there, troops are ferried out from there, and replacement helicopters wait there.
  - **Platoons:** the army deploys one into a district every hour, those under attack first.
  - **Troops:** none can be loaded until the JOC exists.
  - **Last stand:** when the last district falls, Command throws what's left at Camp Ridgeway into
    the airport.
- **The airport** is Kessler International: a runway, a glass terminal with airliners at the gates, a
  control tower and cargo hangars. Its population is its 2,200 staff, and it's closed to refugees.
  Evacuees brought in are flown out of the city on evacuation flights every three hours (400 seats);
  those landed at Camp Ridgeway are bussed out.
- **Police escalate in each district:**
  1. **Routine patrols** on foot and in cruisers among the traffic.
  2. **Checkpoints:** once the outbreak there is confirmed and spreading, police set up concrete
     barriers and cruisers at four avenue intersections. They screen people (the bitten are held in
     isolation), hold most of the bitten back from fleeing elsewhere, and slow the district's traffic.
  3. **Support:** once soldiers arrive, police support military operations. They fight better, and
     their morale holds up longer.

  The HUD shows the stage ("Police 28 (checkpoints)").

## Kessler Airport is sealed

No infection or zombie gets into the airport until every other district has been overrun:
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
- **Sites suit their district:**
  - **Police:** in the suburbs, a small station with a car park; in denser districts, a brick
    precinct with a walled yard; downtown, the police HQ tower on a plaza.
  - **Supermarkets:** big-box stores in the suburbs, corner markets under flats in the city, and the
    mall downtown.
  - **Pharmacies:** strip pharmacies in the suburbs, clinics in the city.
  - **Shelters:** schools and churches in the suburbs, multi-storey high schools and community halls
    in the city, arenas downtown and on campus.
- **Industrial Park has works, not shelters or shops,** and each keeps something flowing to the city:
  - **Food Distribution Depot:** trucks load at the rail yard only through it, and it holds 40,000
    rations of its own.
  - **Ration plant:** packs 3,000 rations an hour into the yard while it holds, has power and has
    hands.
  - **Waterworks:** if it falls, the taps run dry. Food goes 25% faster everywhere and order drops.
  - **Fuel terminal:** the park's fuel convoys to the base stop if it falls.

  The radio says what the city loses when one falls.
- **Guards:** the military posts up to 60% of a district's soldiers at its sites: police stations and
  shelters first, then food, then pharmacies. Unguarded stores are looted in a riot.
- **Sieges:** the dead besiege sites, a settled horde hardest. Barricades hold for hours, longer with
  guards. A fallen shelter loses many of the people inside, and fallen sites burn. Troops can retake a
  site once the district is quiet again.
- **Showing their status:** each site flies a flag (green held, amber under siege, black fallen),
  has a sandbag ring while guarded, and blinks a beacon at night while it holds: green, red when its
  district needs the medicine it takes, amber when it needs the food. The map marks every
  site (P, S, H, +), the district panel lists them, and the HUD names the one you're over.
- **Land in the site's car park, field or plaza** to use it:
  - Garrison it with troops aboard (they stay posted there), or retake it if it has fallen.
  - Evacuate the shelter: quicker than the street, with people screened at the door so few of the
    bitten get aboard.
  - Load crates from its stock: food from a supermarket, ammunition from a police armoury, medicine
    from a pharmacy. This works even at a fallen site, if you dare.
  - Deliver the crates it takes (see Relief crates).
- **AI pilots** on an evacuation run take people from the fullest shelter.

## Relief crates

Every crate has its kind of place, and does its job the moment it lands.

- **Where each goes:**
  - **Medicine:** a pharmacy, a shelter, or anywhere at St. Mary's (the hospital).
  - **Food:** a supermarket, a food depot or a shelter.
  - **Ammunition:** anywhere: a street or any site. It goes to the district's troops, or, with
    none there, arms its police for a day (they fight about a third better).
- **The menu tells you:** landed, each kind of crate aboard gets a "Deliver" option showing what it
  will do ("Westfield's food 0.4 → 1.1 days"), or, greyed out, where it goes instead.
- **Straight into the district:** a delivery adds to the district's supplies at once. A site under
  siege loses 30% of it in the fighting; a fallen site can't take it. A toast and the radio say what
  changed.
- **What medicine does:** once a district's outbreak is confirmed, medicine lets it find and isolate
  the bitten before they turn (15% of them an hour, 10 doses each). They die in isolation, or are
  cured once you have the antiviral.
- **Needs:** the district panel and the map sidebar show what a district is short of: medicine (more
  bitten than its doses can isolate), food (under a day left) or ammunition (under 100 rounds a
  soldier).
- **AI pilots** on a resupply run set down at the right place for what they carry.

## Hordes

- **Hordes form on their own.** Once a district runs short of prey (or falls), part of its dead set
  off as a horde, usually from day 6–8 onward. Hordes walk the street grid at a shamble, toward
  whatever draws them hardest: people, lit districts at night, gunfire and your rotors. They pick up the
  dead of districts they pass through, merge when they meet, and settle on a district to attack it. By
  day 10 or so expect a handful of masses tens of thousands strong. The radio announces big ones, the
  map shows them (red discs, dashed line to their target), and the district panel shows how much of
  its count is horde.
- **Thousands on screen.** Up to 9,000 zombies are drawn at once: residents around you plus the
  hordes within about 1.2 km. A marching horde is a column laid along the corners it actually
  walked, spread across the street's width, with its head easing smoothly along between the
  simulation's ticks, so you can hover over it and follow it from one end of the city to the other at
  any time speed. A settled horde floods out along the four streets from its corner. Hover low and
  the whole mass pours toward you through the streets.
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

## The city at night

- **Streets:** streetlights pool on the road while a district has grid power. In the dense districts,
  ground-floor shop fronts and lobbies glow and spill light across the sidewalks, some blocks under
  pink, cyan, orange or violet neon. Houses have porch lights, the port and industry are floodlit,
  and the airport has a floodlit apron, car park and runway edge lights. Towers over 60 m blink red
  aviation lights. A blackout still takes a district dark: streets, shops and windows together.
- **Moving lights:** every car drives with headlights and tail lights, police cruisers flash red and
  blue (and wash the street around them in it), and after dark soldiers and police carry weapon
  lights that sweep the street ahead, with a faint visible beam. The dead walking into any of these
  are lit by them.
- **How it stays fast:** there are no real lights (a forward renderer pays for each one on every
  pixel). Instead:
  - **Baked light:** the static lights are splatted once, when the city is built, into a top-down
    texture over the whole city at 4 m per texel. Its three channels hold streetlight, building
    spill and neon, and the shader switches each district's share by its power.
  - **Light buffer:** the moving lights near the helicopter (up to 4,096) are drawn each frame as
    soft additive shapes into a small top-down buffer, 512 × 512 at 1.5 m per texel, in one draw
    call.
  - **Cost per surface:** every lit material reads both with two texture lookups, fading with
    height above the street, so walls, cars, people and the dead are lit without any per-light
    cost.

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
