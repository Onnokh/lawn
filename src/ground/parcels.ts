import { FIELD_NAMES, FIELD_SLACK } from "../achievements";
import { LAWN_WIDTH, LAWN_HEIGHT, TILE_COUNT } from "./dimensions";
import { placeAt } from "./map";
import { REGROW, bladeHeight } from "./growth";

/**
 * Which Field owns each Tile, or `NO_FIELD` for a Path, a Street, a bank or
 * the Water.
 *
 * It is the same answer `placeAt` gives, held as a table for the same reason
 * the Growth Rate is: the Lawn is read Tile by Tile, many times a second, and
 * `placeAt` measures nine seeds and three runs of Water for every read. The Mow
 * Stroke used to pay that price per Tile to ask whether grass grows there; it
 * now reads one byte, and gets the Field the Tile belongs to for nothing —
 * which is how the Lawn knows which Fields to read for a finish.
 */
export const NO_FIELD = 255;
export const FIELD_OF = new Uint8Array(TILE_COUNT);
/** Which Tiles each Field is made of. The Lawn walks these to read a Field. */
export const FIELD_TILES: Uint32Array[] = [];
{
  const gathered: number[][] = FIELD_NAMES.map(() => []);
  for (let y = 0; y < LAWN_HEIGHT; y++) {
    for (let x = 0; x < LAWN_WIDTH; x++) {
      const field = placeAt(x + 0.5, y + 0.5, LAWN_WIDTH, LAWN_HEIGHT).field;
      FIELD_OF[y * LAWN_WIDTH + x] = field < 0 ? NO_FIELD : field;
      if (field >= 0) gathered[field].push(y * LAWN_WIDTH + x);
    }
  }
  for (const tiles of gathered) FIELD_TILES.push(Uint32Array.from(tiles));
}

/** The Field a Tile at these whole coordinates belongs to, or `NO_FIELD`. */
export function fieldAt(x: number, y: number): number {
  if (x < 0 || y < 0 || x >= LAWN_WIDTH || y >= LAWN_HEIGHT) return NO_FIELD;
  return FIELD_OF[y * LAWN_WIDTH + x];
}

/**
 * How far through a Field the Lawn is, from 0 to 100. It mirrors
 * `fieldProgress` in `public/fields.js` exactly, because the Tracker and the
 * Lawn have to call the same moment the finish: the Mower sees the Field light
 * up and the Achievement has to arrive with it, not a second behind.
 */
export function fieldStanding(tiles: Uint32Array, mownAt: Uint32Array, now: number): number {
  if (!tiles.length) return 0;
  let remaining = 0;
  for (const i of tiles) {
    // Short stubble counts as cut, so slow regrowth doesn't prevent completion.
    remaining += Math.max(0, Math.min(1, (bladeHeight(mownAt[i], REGROW[i], now) - 0.1) / 0.9));
  }
  return 100 * Math.min(1, (1 - remaining / tiles.length) / (1 - FIELD_SLACK));
}

export * as Parcels from "./parcels";
