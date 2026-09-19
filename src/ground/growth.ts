import { LAWN_WIDTH, LAWN_HEIGHT } from "./dimensions";

/**
 * The Lawn keeps nothing that ticks. A Tile stores only the moment it was last
 * mown, and Blade Height is a pure function of the time since that moment, so
 * the grass keeps growing while the Durable Object hibernates.
 */

/**
 * Seconds a Tile needs to grow from mown to fully overgrown: 2 hours to 6
 * hours. No Tile grows at the speed of its neighbour: the Growth Rate moves
 * between these two bounds across the Lawn, so the field comes back uneven,
 * the way a real lawn does.
 */
export const REGROW_MIN_SECONDS = 7200;
export const REGROW_MAX_SECONDS = 21600;
/**
 * Seconds a Tile stays mown before its Regrowth starts. Without it the grass
 * behind the Mower is already coming back before the far side of a Field is
 * cut, and a Field can never read as wholly mown. One hour is long enough to
 * finish a Field and see it stand at 100%.
 */
export const COOLDOWN_SECONDS = 3600;
/**
 * Width of one patch of like-minded grass, in Tiles. Below about ten the
 * Growth Rate reads as speckle on single Tiles instead of as slow ground.
 */
export const PATCH_TILES = 16;
/**
 * Full scale of one Snapshot entry. A Snapshot carries how far a Tile is
 * through its Regrowth, not its age in seconds, so the wire does not change
 * when the Regrowth does. One step is a third of a second at the slowest
 * Growth Rate, far below one part in 255 of Blade Height.
 */
export const SNAPSHOT_SCALE = 65535;

/** One lattice point of the Growth Rate noise, 0 to 1. */
export function vigourAt(x: number, y: number): number {
  let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}

/**
 * Seconds from a Mow Stroke to a fully overgrown Tile: the Cooldown first,
 * then the Regrowth. It is the span a Snapshot entry measures.
 */
export function cycle(regrow: number): number {
  return COOLDOWN_SECONDS + regrow;
}

/**
 * Seconds of Regrowth for every Tile. It is a pure function of the position of
 * the Tile, so the client works out the same table and nothing is stored or
 * sent. Both sides hold it as a table because the Lawn is read Tile by Tile,
 * many times a second, and the noise is the same on every read.
 */
export function regrowTable(width: number, height: number): Float32Array {
  const table = new Float32Array(width * height);
  const span = REGROW_MAX_SECONDS - REGROW_MIN_SECONDS;
  for (let y = 0; y < height; y++) {
    const gy = y / PATCH_TILES;
    const y0 = Math.floor(gy);
    const ty = gy - y0;
    const fy = ty * ty * (3 - 2 * ty);
    for (let x = 0; x < width; x++) {
      const gx = x / PATCH_TILES;
      const x0 = Math.floor(gx);
      const tx = gx - x0;
      const fx = tx * tx * (3 - 2 * tx);
      const a = vigourAt(x0, y0);
      const b = vigourAt(x0 + 1, y0);
      const c = vigourAt(x0, y0 + 1);
      const d = vigourAt(x0 + 1, y0 + 1);
      const top = a + (b - a) * fx;
      const bottom = c + (d - c) * fx;
      table[y * width + x] = REGROW_MIN_SECONDS + (top + (bottom - top) * fy) * span;
    }
  }
  return table;
}

/** The Growth Rate of every Tile of this Lawn. Built once and read for ever. */
export const REGROW = regrowTable(LAWN_WIDTH, LAWN_HEIGHT);

/**
 * How tall the grass on a Tile stands, from 0 to 1. A Tile nobody ever mowed
 * is fully overgrown. Mirrors `heightAt` in the client, which is what makes
 * the score the server counts the same score the Mower watches.
 */
export function bladeHeight(mownAt: number, regrow: number, now: number): number {
  const age = mownAt === 0 ? cycle(regrow) : now - mownAt;
  if (age >= cycle(regrow)) return 1;
  if (!(age > COOLDOWN_SECONDS) || !(regrow > 0)) return 0;
  const t = (age - COOLDOWN_SECONDS) / regrow;
  return 1 - (1 - t) * (1 - t);
}

export * as Growth from "./growth";
