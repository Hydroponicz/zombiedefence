// The city layout, shared by the simulation and the 3D world so both agree on where
// every district is. The city is a 4 x 3 grid of districts; row 0 is the north edge (-z),
// which faces the sea.

export const DISTRICT_SIZE = 640; // metres
export const GRID_COLS = 4;
export const GRID_ROWS = 3;
export const CITY_WIDTH = DISTRICT_SIZE * GRID_COLS;
export const CITY_DEPTH = DISTRICT_SIZE * GRID_ROWS;

export type DistrictKind =
  | 'airbase'
  | 'downtown'
  | 'residential'
  | 'apartments'
  | 'commercial'
  | 'industrial'
  | 'harbor'
  | 'university'
  | 'hospital';

export interface DistrictFeatures {
  /** Local substation: the district goes dark if it is overrun. */
  substation?: boolean;
  /** City power plant: the whole grid is crippled if it is overrun. */
  powerPlant?: boolean;
  fuelDepot?: boolean;
  /** Food warehouse that trucks rations to the rest of the city. */
  warehouse?: boolean;
  hospital?: boolean;
  /** Research lab, where scientists are. */
  lab?: boolean;
  /** Backup generators (litres of fuel burned per game hour). */
  generator?: number;
  /** Walls and fences: defenders count for more. */
  fortified?: boolean;
}

export interface DistrictTemplate {
  name: string;
  kind: DistrictKind;
  col: number;
  row: number;
  population: number;
  troops: number;
  features: DistrictFeatures;
  /** Fixed grid power threshold. Omitted means a seeded random value. */
  powerThreshold?: number;
  fuel?: number;
  medicine?: number;
  rations?: number;
  scientists?: number;
  /** Abandoned helicopters that can be salvaged (medevac, news, police). */
  salvage?: number;
}

export const DISTRICT_TEMPLATES: DistrictTemplate[] = [
  { name: 'Northside', kind: 'residential', col: 0, row: 0, population: 32000, troops: 30, features: {} },
  { name: 'University Heights', kind: 'university', col: 1, row: 0, population: 18000, troops: 20, features: { lab: true }, scientists: 24 },
  { name: 'Riverside', kind: 'apartments', col: 2, row: 0, population: 45000, troops: 35, features: {} },
  { name: 'Harbor', kind: 'harbor', col: 3, row: 0, population: 9000, troops: 25, features: { fuelDepot: true }, fuel: 400000, salvage: 1 },
  { name: 'Westfield', kind: 'residential', col: 0, row: 1, population: 34000, troops: 30, features: { substation: true } },
  {
    name: 'Downtown', kind: 'downtown', col: 1, row: 1, population: 52000, troops: 90,
    features: { substation: true, generator: 200 }, powerThreshold: 0.3, fuel: 4000, salvage: 1,
  },
  { name: 'Market District', kind: 'commercial', col: 2, row: 1, population: 26000, troops: 30, features: { warehouse: true } },
  { name: 'Eastside', kind: 'residential', col: 3, row: 1, population: 38000, troops: 30, features: { substation: true } },
  {
    name: 'Fort Kessler', kind: 'airbase', col: 0, row: 2, population: 1500, troops: 600,
    features: { generator: 250, fortified: true, fuelDepot: true }, powerThreshold: 0.2, fuel: 120000,
    // Military stores the player loads relief crates from.
    rations: 60000, medicine: 20000,
  },
  { name: 'Industrial Park', kind: 'industrial', col: 1, row: 2, population: 7000, troops: 25, features: { powerPlant: true, fuelDepot: true }, fuel: 250000 },
  {
    name: "St. Mary's", kind: 'hospital', col: 2, row: 2, population: 16000, troops: 40,
    features: { hospital: true, generator: 300 }, powerThreshold: 0.15, fuel: 8000, medicine: 50000,
    scientists: 6, salvage: 1,
  },
  { name: 'Southgate', kind: 'residential', col: 3, row: 2, population: 30000, troops: 25, features: {} },
];

export function districtCenter(col: number, row: number): { x: number; z: number } {
  return {
    x: (col - GRID_COLS / 2 + 0.5) * DISTRICT_SIZE,
    z: (row - GRID_ROWS / 2 + 0.5) * DISTRICT_SIZE,
  };
}

/** Index of the district containing world point (x, z), or -1 outside the city. */
export function districtAt(x: number, z: number): number {
  const col = Math.floor(x / DISTRICT_SIZE + GRID_COLS / 2);
  const row = Math.floor(z / DISTRICT_SIZE + GRID_ROWS / 2);
  if (col < 0 || col >= GRID_COLS || row < 0 || row >= GRID_ROWS) return -1;
  return DISTRICT_TEMPLATES.findIndex((d) => d.col === col && d.row === row);
}

export function neighborsOf(index: number): number[] {
  const { col, row } = DISTRICT_TEMPLATES[index];
  return DISTRICT_TEMPLATES.flatMap((d, i) =>
    Math.abs(d.col - col) + Math.abs(d.row - row) === 1 ? [i] : [],
  );
}
