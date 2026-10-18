// Kessler Airport's grounds. Inside its perimeter fence there are no city streets: runways,
// taxiways, the apron and grass. The one way in from the city is the landside access road from the
// gate on its north side down to the terminal car park; the military road comes in at its west gate
// from Camp Ridgeway (see convoys.ts). Once the JOC is up, civilians are turned back at the north
// gate: only the airport's own staff, coming in to work, are let through after screening.

import { DISTRICT_SIZE, DISTRICT_TEMPLATES, districtCenter } from './layout';
import { BLOCKS_PER_DISTRICT, nodeX, nodeZ } from './streets';

const AIRPORT = DISTRICT_TEMPLATES.find((d) => d.kind === 'airbase')!;
const I0 = AIRPORT.col * BLOCKS_PER_DISTRICT;
const J0 = AIRPORT.row * BLOCKS_PER_DISTRICT;
const I1 = I0 + BLOCKS_PER_DISTRICT;
const J1 = J0 + BLOCKS_PER_DISTRICT;

/** The access road runs down this street line, from the north gate (on the district's edge)... */
export const ACCESS_I = I0 + BLOCKS_PER_DISTRICT / 2;
export const ACCESS_GATE: [number, number] = [ACCESS_I, J0];
/** ...to the terminal car park. */
export const ACCESS_END: [number, number] = [ACCESS_I, J0 + 4];

/** The perimeter fence, this far inside the district's edge. */
export const FENCE_INSET = 20;

/** Where the north gate is in the fence, in world metres. */
export function northGate(): { x: number; z: number } {
  return { x: nodeX(ACCESS_I), z: nodeZ(J0) + FENCE_INSET };
}

/** The airport's centre and half-size. */
export function airportBounds(): { x: number; z: number; half: number } {
  return { ...districtCenter(AIRPORT.col, AIRPORT.row), half: DISTRICT_SIZE / 2 };
}

const inside = (i: number, j: number) => i > I0 && i < I1 && j > J0 && j < J1;
const onAccess = (i: number, j: number) => i === ACCESS_I && j >= J0 && j <= ACCESS_END[1];

/** Whether the street between two corners runs inside the airport fence (and isn't its access road). */
export function closedStreet(i: number, j: number, ni: number, nj: number): boolean {
  if (!inside(i, j) && !inside(ni, nj)) return false;
  return !(onAccess(i, j) && onAccess(ni, nj));
}

/** Whether the street between two corners is the airport's access road. */
export function accessRoad(i: number, j: number, ni: number, nj: number): boolean {
  return onAccess(i, j) && onAccess(ni, nj) && (i !== ni || j !== nj);
}
