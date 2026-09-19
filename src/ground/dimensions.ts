/**
 * How big the Lawn is. Every table in `ground/` is this size, and the map is
 * laid out in fractions of it, so the two cannot drift apart.
 */
export const LAWN_WIDTH = 408;
export const LAWN_HEIGHT = 272;
export const TILE_COUNT = LAWN_WIDTH * LAWN_HEIGHT;

export * as Dimensions from "./dimensions";
