// The street grid: a road runs along every 120 m line from the city edge, so intersections form
// a lattice. Every third line (including every district boundary) is a wider avenue. People and
// zombies walk this lattice, which keeps them on the streets.

import { CITY_DEPTH, CITY_WIDTH, DISTRICT_SIZE } from './layout';

export const BLOCKS_PER_DISTRICT = 12;
export const STREET_SPACING = DISTRICT_SIZE / BLOCKS_PER_DISTRICT;
/** Two lanes and parking, curb to curb. */
export const STREET_WIDTH = 18;
/** Four lanes and a median. */
export const AVENUE_WIDTH = 30;
export const AVENUE_EVERY = 3;
export const SIDEWALK = 3.5;
export const NODES_X = CITY_WIDTH / STREET_SPACING + 1;
export const NODES_Z = CITY_DEPTH / STREET_SPACING + 1;

export const nodeX = (i: number) => -CITY_WIDTH / 2 + i * STREET_SPACING;
export const nodeZ = (j: number) => -CITY_DEPTH / 2 + j * STREET_SPACING;

/** Curb-to-curb width of the road along grid line `index` (either axis). */
export const roadWidth = (index: number) => (index % AVENUE_EVERY === 0 ? AVENUE_WIDTH : STREET_WIDTH);

export const clampNodeI = (i: number) => Math.max(0, Math.min(NODES_X - 1, i));
export const clampNodeJ = (j: number) => Math.max(0, Math.min(NODES_Z - 1, j));

/** Nearest intersection to a world point. */
export function nearestNode(x: number, z: number): [number, number] {
  return [
    clampNodeI(Math.round((x + CITY_WIDTH / 2) / STREET_SPACING)),
    clampNodeJ(Math.round((z + CITY_DEPTH / 2) / STREET_SPACING)),
  ];
}

const STEPS: [number, number][] = [[1, 0], [-1, 0], [0, 1], [0, -1]];

/** Neighbouring intersections of (i, j) inside the city. */
export function neighbors(i: number, j: number): [number, number][] {
  return STEPS.flatMap(([di, dj]) => {
    const ni = i + di;
    const nj = j + dj;
    return ni >= 0 && ni < NODES_X && nj >= 0 && nj < NODES_Z ? [[ni, nj] as [number, number]] : [];
  });
}

/** The neighbouring intersection that gets closest to (or furthest from) a point. */
export function stepToward(i: number, j: number, x: number, z: number, away = false): [number, number] {
  let best: [number, number] = [i, j];
  let bestScore = away ? -Infinity : Infinity;
  for (const [ni, nj] of neighbors(i, j)) {
    const d = Math.hypot(nodeX(ni) - x, nodeZ(nj) - z);
    if (away ? d > bestScore : d < bestScore) {
      bestScore = d;
      best = [ni, nj];
    }
  }
  return best;
}
