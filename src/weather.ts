/**
 * Weather is a pure function of the wall clock, the same way Blade Height is a
 * pure function of the time since a Tile was last mown. Nothing schedules
 * Rain and nothing stores it: every Mower asks "is it raining right now" and
 * gets the same answer, because every Mower is looking at the same clock.
 */

/** Length of one Weather Cycle. Every Cycle independently decides its own Rain. */
export const WEATHER_CYCLE_MS = 12 * 60 * 1000;
/** Fraction of Cycles that bring Rain at all. */
const RAIN_CHANCE = 0.55;
/** A rainy Cycle's Rain lasts somewhere in this range, picked per Cycle. */
const RAIN_MIN_MS = 2 * 60 * 1000;
const RAIN_MAX_MS = 5 * 60 * 1000;
/** Rain fades in and out instead of switching, so it never snaps a drifting Mower. */
export const RAIN_RAMP_MS = 15 * 1000;
/** How much faster grass grows while Rain is falling on it. */
export const RAIN_GROWTH_MULTIPLIER = 2.2;

/** One lattice point of the Weather noise, 0 to 1. Same mix as the Growth Rate's, seeded by Cycle instead of position. */
function cycleHash(seed: number): number {
  let h = Math.imul(seed | 0, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}

/** Whether a Cycle rains at all, and for how long, decided once from its index. */
function rainWindow(cycleIndex: number): { rains: boolean; durationMs: number } {
  const rains = cycleHash(cycleIndex) < RAIN_CHANCE;
  const lengthRoll = cycleHash(cycleIndex + 0x5bd1e995);
  return { rains, durationMs: RAIN_MIN_MS + lengthRoll * (RAIN_MAX_MS - RAIN_MIN_MS) };
}

/**
 * How hard it is raining right now, 0 to 1. Drives traction and the rain
 * effect on screen; not used for Regrowth, which needs the whole span between
 * two moments rather than one instant — see `effectiveElapsedMs`.
 */
export function rainIntensityAt(nowMs: number): number {
  const cycleIndex = Math.floor(nowMs / WEATHER_CYCLE_MS);
  const { rains, durationMs } = rainWindow(cycleIndex);
  if (!rains) return 0;
  const into = nowMs - cycleIndex * WEATHER_CYCLE_MS;
  if (into >= durationMs) return 0;
  const rampIn = Math.min(1, into / RAIN_RAMP_MS);
  const rampOut = Math.min(1, (durationMs - into) / RAIN_RAMP_MS);
  return Math.min(rampIn, rampOut);
}

/**
 * Milliseconds of Regrowth a Tile should be credited for between two moments,
 * counting time spent in Rain at `RAIN_GROWTH_MULTIPLIER`. A plain
 * `toMs - fromMs` would ignore every Cycle of Rain a Tile sat through since it
 * was last mown; this walks the Cycles between the two moments instead — at
 * most a few dozen for the longest a Tile ever waits — and weighs each one's
 * overlap by whether it rained. The ramp in `rainIntensityAt` is not counted
 * here: it exists to be gentle on a Mower's tyres, not to be gentle on a
 * fraction of a second of Regrowth.
 *
 * A Tile nobody has ever mown carries the Unix epoch as its moment, decades
 * of Cycles away — walking every one of them would be the actual cost of
 * asking. No Tile takes a week to finish Regrowth, so any span that long is
 * already past the point where the exact count still matters: it is credited
 * the fastest a span that size could possibly grow, which is enough to read
 * as fully overgrown without walking a single Cycle of it.
 */
const MAX_WALKED_SPAN_MS = 7 * 24 * 60 * 60 * 1000;
export function effectiveElapsedMs(fromMs: number, toMs: number): number {
  if (toMs <= fromMs) return 0;
  if (toMs - fromMs > MAX_WALKED_SPAN_MS) return (toMs - fromMs) * RAIN_GROWTH_MULTIPLIER;
  const startCycle = Math.floor(fromMs / WEATHER_CYCLE_MS);
  const endCycle = Math.floor(toMs / WEATHER_CYCLE_MS);
  let elapsed = 0;
  for (let c = startCycle; c <= endCycle; c++) {
    const cycleStart = c * WEATHER_CYCLE_MS;
    const segFrom = Math.max(fromMs, cycleStart);
    const segTo = Math.min(toMs, cycleStart + WEATHER_CYCLE_MS);
    if (segTo <= segFrom) continue;
    const { rains, durationMs } = rainWindow(c);
    if (!rains) { elapsed += segTo - segFrom; continue; }
    const rainFrom = Math.max(segFrom, cycleStart);
    const rainTo = Math.min(segTo, cycleStart + durationMs);
    const rainOverlap = Math.max(0, rainTo - rainFrom);
    elapsed += (segTo - segFrom - rainOverlap) + rainOverlap * RAIN_GROWTH_MULTIPLIER;
  }
  return elapsed;
}
