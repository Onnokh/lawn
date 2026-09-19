import { treeAt, treeEarthAt } from "../trees";
import { ringDistance, STREET_HALF_WIDTH } from "../road";
import { LAWN_WIDTH, LAWN_HEIGHT } from "./dimensions";

/**
 * The map: where each seed of a Field sits, in fractions of the Lawn, how
 * wide a Path and a run of Water are, and what each seam is made of. It is
 * the same table as `public/fields.js` and must stay so: the two sides have
 * to agree on which Tiles are grass, or a score counts blades that were never
 * there. `scripts/check-junctions.mjs` holds this file to that copy.
 */
export const SEEDS: [number, number][] = [
  [0.20, 0.31], [0.40, 0.30], [0.60, 0.29], [0.80, 0.30],
  [0.17, 0.70], [0.335, 0.72], [0.50, 0.71], [0.665, 0.69], [0.83, 0.68],
];
export const PATH = 2.6;
export const WATER = 3.4;
export const BANK = 1.6;
export const BRIDGE = 6;
/** Mirrors `SEAMS` in `public/fields.js`: the seams that carry Water, and the Streets. */
export const WATERS = [[1, 2], [5, 6], [7, 8]];
export const STREETS = [[0, 4], [0, 5], [1, 5], [1, 6], [2, 6], [2, 7], [3, 7], [3, 8]];
export const SHORE_RADIUS = 1.2;

export function warpX(x: number, y: number): number {
  return x + 7 * Math.sin(y * 0.052 + 0.6) + 2.6 * Math.sin(y * 0.127 + 2.1);
}
export function warpY(x: number, y: number): number {
  return y + 7 * Math.sin(x * 0.045) + 2.6 * Math.sin(x * 0.103 + 1.3);
}

/**
 * How far the shoreline of a run of Water wanders from the straight, in Tiles.
 * Mirrors `shoreWander` in `public/fields.js`, which must stay identical or
 * the Lawn and the client disagree about which Tiles are grass.
 */
export function shoreWander(x: number, y: number): number {
  return 0.55 * Math.sin(x * 0.23 + y * 0.17)
    + 0.3 * Math.sin(x * 0.11 - y * 0.31)
    + 0.16 * Math.sin(x * 0.47 + y * 0.39);
}

/** How far a point lies inside the water. Mirrors `water` in the client. */
export function water(into: number, beyond: number): number {
  if (into > 0 && beyond > 0) return Math.min(into, beyond);
  const dx = Math.max(0, -into), dy = Math.max(0, -beyond);
  return -Math.sqrt(dx * dx + dy * dy);
}

/** Where one point stands on the Lawn. */
export interface Place {
  /** The Field that owns it, or -1 for a Path, a Street, a bank or the Water. */
  field: number;
  /** How far it lies inside the Water. */
  wet: number;
  street: number;
  edge: number;
}

/**
 * Where a point stands on the Lawn: the Field that owns it, or -1 for a Path,
 * a Street, a bank or the Water, and how far it lies inside the Water.
 * Mirrors `placeAt` in `public/fields.js` exactly.
 */
export function placeAt(x: number, y: number, width: number, height: number): Place {
  if (x < 0 || y < 0 || x >= width || y >= height) return { field: -1, wet: -BRIDGE, street: -BRIDGE, edge: 0 };
  const px = warpX(x, y), py = warpY(x, y);
  let first = 0, second = 0, third = 0;
  let d0 = Infinity, d1 = Infinity, d2 = Infinity;
  const distances: number[] = [];
  for (let k = 0; k < SEEDS.length; k++) {
    const dx = px - SEEDS[k][0] * width, dy = py - SEEDS[k][1] * height;
    const d = Math.sqrt(dx * dx + dy * dy);
    distances.push(d);
    if (d < d0) { d2 = d1; third = second; d1 = d0; second = first; d0 = d; first = k; }
    else if (d < d1) { d2 = d1; third = second; d1 = d; second = k; }
    else if (d < d2) { d2 = d; third = k; }
  }
  const edge = (d1 - d0) * 0.5;
  const beside = (a: number, b: number) =>
    (first !== a && first !== b ? d0 : (second !== a && second !== b ? d1 : d2));
  let wet = -BRIDGE;
  const wander = shoreWander(x, y);
  // Measure every run of Water, even across a field boundary. Switching the
  // nearest pair at a junction must not cut off the shoreline or its
  // collision margin.
  for (const [a, b] of WATERS) {
    const across = Math.abs(distances[a] - distances[b]) * 0.5;
    let third = Infinity;
    for (let k = 0; k < SEEDS.length; k++) {
      if (k !== a && k !== b) third = Math.min(third, distances[k]);
    }
    // Leave a dry Path before the third field, with rounded bank corners.
    const end = (third - Math.max(distances[a], distances[b])) * 0.5 - PATH - BANK;
    const shore = water(WATER + wander - across - SHORE_RADIUS, end + wander - SHORE_RADIUS) + SHORE_RADIUS;
    const bx = (SEEDS[a][0] + SEEDS[b][0]) * 0.5 * width;
    const by = (SEEDS[a][1] + SEEDS[b][1]) * 0.5 * height;
    const span2 = (px - bx) ** 2 + (py - by) ** 2;
    const along = Math.sqrt(Math.max(0, span2 - across * across));
    wet = Math.max(wet, water(shore, along - BRIDGE + wander));
  }
  const kerb = -ringDistance(x, y, width, height);
  let street = kerb;
  for (const [a, b] of STREETS) {
    const across = Math.abs(distances[a] - distances[b]) * 0.5;
    const past = Math.max(0, (Math.max(distances[a], distances[b]) - beside(a, b)) * 0.5);
    street = Math.min(street, Math.hypot(across, past));
  }
  wet = Math.min(wet, street - STREET_HALF_WIDTH);
  const path = PATH + 0.35 * Math.sin(x * 0.19 + y * 0.11);
  const bare = street <= STREET_HALF_WIDTH || edge <= path || wet > -BANK
    || treeEarthAt(x, y, width, height);
  return { field: bare ? -1 : first, wet, street, edge };
}

/** Water and trunks stop reported strokes, whatever the client says. */
export function blocked(x: number, y: number): boolean {
  return placeAt(x, y, LAWN_WIDTH, LAWN_HEIGHT).wet > 0
    || treeAt(x, y, LAWN_WIDTH, LAWN_HEIGHT);
}

export * as LawnMap from "./map";
