import { MOW_RADIUS, forEachMownTile } from "../mowing";
import { LAWN_WIDTH, LAWN_HEIGHT } from "./dimensions";
import { bladeHeight } from "./growth";

/**
 * The ground one Mow Stroke works on: what has been cut, what grows where, and
 * where the last stroke's grass is put.
 *
 * It is handed in rather than reached for so that a check can cut a Lawn that
 * is all grass and all the same. What the swath touches is geometry, and a
 * check of the geometry should not have to find a parcel to stand in.
 */
export interface Ground {
  /** Epoch seconds of the last Mow Stroke per Tile. 0 means never mown. */
  readonly mownAt: Uint32Array;
  /** Which Field owns each Tile, or `NO_FIELD`. */
  readonly fieldOf: Uint8Array;
  /** Seconds of Regrowth for each Tile. */
  readonly regrow: Float32Array;
  /** Where the grass off this stroke is put, one number per Field. */
  readonly byField: Float64Array;
  /** The value of `fieldOf` that means no grass grows there. */
  readonly bare: number;
}

/**
 * Cut every Tile the swath touches back to zero Blade Height, and answer with
 * the grass that came off. That number is the Score: the Lawn counts the
 * blades itself, so a Mower cannot name its own tally.
 *
 * It leaves the same grass split by Field in `byField`, which is how the Lawn
 * knows which Fields this stroke could have finished. That costs the Mow
 * Stroke nothing: it has to know which Tiles are grass to count them at all,
 * and the table that says so names the Field in the same byte.
 */
export function cutSwath(
  ground: Ground,
  x0: number, y0: number, x1: number, y1: number,
  now: number,
): number {
  const { mownAt, fieldOf, regrow, byField, bare } = ground;
  byField.fill(0);
  let blades = 0;
  forEachMownTile(x0, y0, x1, y1, LAWN_WIDTH, LAWN_HEIGHT, MOW_RADIUS, (i) => {
    const field = fieldOf[i];
    if (field !== bare) {
      const off = bladeHeight(mownAt[i], regrow[i], now);
      blades += off;
      byField[field] += off;
    }
    mownAt[i] = now;
  });
  return blades;
}

export * as Cutting from "./cutting";
