// The street grid: roads run along every 80 m line from the city edge, so intersections
// form a lattice. People and zombies walk this lattice, which keeps them on the streets.

import { CITY_DEPTH, CITY_WIDTH, DISTRICT_SIZE } from '../sim/layout';

export const STREET_SPACING = DISTRICT_SIZE / 8;
export const ROAD_WIDTH = 14;
export const NODES_X = CITY_WIDTH / STREET_SPACING + 1;
export const NODES_Z = CITY_DEPTH / STREET_SPACING + 1;

export const nodeX = (i: number) => -CITY_WIDTH / 2 + i * STREET_SPACING;
export const nodeZ = (j: number) => -CITY_DEPTH / 2 + j * STREET_SPACING;

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
