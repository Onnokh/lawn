/**
 * What a Mower has done on the Lawn, and what the Lawn gives it for doing it.
 *
 * An Achievement is a thing the Lawn saw one Mower do, kept under the Mower
 * Key beside the Score. The Lawn awards it; a Mower never claims one. That is
 * the whole of the design: the board already learned that a client asked what
 * its score is answers seven hundred million, and an Achievement a client can
 * claim is worth exactly as much.
 *
 * This file is the one table, and it has two readers — the Lawn, which
 * decides what is earned, and the client, which draws it. It is built to
 * `public/achievements.js` exactly as `src/ball.ts` is built to
 * `public/ball.js`, so neither side can drift from the other. It touches no
 * DOM, which is why it can be shared where `public/fields.js` had to be
 * mirrored.
 */

/**
 * The names of the nine Fields, in the reading order of the map. A copy of
 * `FIELD_NAMES` in `public/fields.js`, which cannot be imported here because
 * it draws the minimap and the tracker and so reaches for the DOM.
 * `scripts/check-achievements.mjs` proves the two lists are the same.
 */
export const FIELD_NAMES = [
  'Daisy Hollow', 'Cloverbank', 'Heron Reach',
  'Bramble Meadow', 'Buttercup Rise', 'Willow Bend',
  'The Long Acre', 'Foxglove Pasture', 'Mill Green',
];

/**
 * What the Lawn counts for one Mower. Every one of these only ever grows, so
 * an Achievement once earned can never be lost.
 */
export interface Tally {
  /** Blades cut, over every visit. It is the Score. */
  c: number;
  /**
   * How often this Mower stood in each Field as that Field was finished, in
   * the order of `FIELD_NAMES`.
   */
  q: number[];
  /** Tiles driven, as the Lawn drove the Mower and not as it claimed. */
  d: number;
  /** Bumps the Lawn saw for itself. */
  b: number;
  /** Blades cut while a Mow Stroke carried a drift, on the Mower's own word. */
  g: number;
}

/**
 * Times a Mower must be there as one Field is finished before that Field has
 * plainly grown back and been cut again under its wheels.
 */
export const THRICE = 3;

/** Blades cut, for each step of the ladder. */
export const BLADE_STEPS = [1000, 20000, 200000, 1000000];
/** Tiles driven, for each step of the ladder. */
export const DRIVE_STEPS = [1000, 10000, 100000, 500000];
/**
 * Bumps seen, for each step of the ladder. A Bump buys `STUN_GRACE_MS` of
 * Grace, so the fastest honest run at the top step is some ten minutes of
 * nothing but ramming.
 */
export const BUMP_STEPS = [5, 40, 200];
/**
 * Blades cut while drifting, for each step of the ladder. Checked the way a
 * Bump is checked: the Lawn reads the Mower's nose against the swath it drove
 * and counts the blades only while the two disagree, so a drift is a thing the
 * Lawn saw and not a thing a Mower claimed. See `sawDrift`.
 */
export const DRIFT_STEPS = [200, 4000, 40000, 200000];

/**
 * Which ladder an Achievement stands in.
 *
 * A ladder is a row of the same thing at rising heights, and only one rung of
 * it is ever worth looking at: the one being climbed. `field` is the odd one —
 * its nine are not a ladder but a set, climbed in any order, so they are shown
 * as the ticked list inside `lawn` rather than as nine rows of their own.
 */
export type Tier = 'field' | 'lawn' | 'again' | 'blades' | 'tiles' | 'bumps' | 'drift';

/** The ladders the window draws, in the order it draws them. */
export const TIERS: Tier[] = ['lawn', 'again', 'blades', 'tiles', 'bumps', 'drift'];

export interface Achievement {
  /** Which bit of the mask this one holds. It must never be reassigned. */
  bit: number;
  name: string;
  blurb: string;
  tier: Tier;
  /** How far a Tally has come towards it. */
  have(tally: Tally): number;
  /** How far it must come. `have` at or past this is earned. */
  goal: number;
}

/** How many Fields this Mower has seen finished, at least once each. */
function fieldsSeen(tally: Tally): number {
  return tally.q.filter((times) => times >= 1).length;
}

/**
 * Every Achievement, by the bit it holds.
 *
 * The bit is the whole of the wire format, so a bit is never reused and never
 * renumbered: a Mower that earned bit 9 last month must still read bit 9 as
 * the same thing. A new Achievement takes the next free bit, and a retired one
 * leaves its bit standing empty.
 *
 * Every one of them is a number against a number, so the window can draw how
 * far along it is without knowing what any of them mean.
 */
export const ACHIEVEMENTS: Achievement[] = [
  // 0-8: one per Field, in the reading order of the map.
  ...FIELD_NAMES.map((name, field) => ({
    bit: field,
    name,
    blurb: `Stand in ${name} as the last of it is cut.`,
    tier: 'field' as Tier,
    have: (tally: Tally) => tally.q[field] ?? 0,
    goal: 1,
  })),
  {
    bit: 9,
    name: 'The Whole Lawn',
    blurb: 'Be there as all nine Fields are finished.',
    tier: 'lawn',
    have: fieldsSeen,
    goal: FIELD_NAMES.length,
  },
  {
    bit: 10,
    name: 'It Grew Back',
    blurb: 'Be there as one Field is finished three times.',
    tier: 'again',
    have: (tally) => Math.max(0, ...tally.q),
    goal: THRICE,
  },
  ...['First Cut', 'Grass Stains', 'Deep Green', 'The Long Season'].map((name, step) => ({
    bit: 11 + step,
    name,
    blurb: `Cut ${BLADE_STEPS[step].toLocaleString('en-GB')} blades.`,
    tier: 'blades' as Tier,
    have: (tally: Tally) => tally.c,
    goal: BLADE_STEPS[step],
  })),
  ...['Round the Block', 'Out and Back', 'The Long Way', 'Nine Fields Wide'].map((name, step) => ({
    bit: 15 + step,
    name,
    blurb: `Drive ${DRIVE_STEPS[step].toLocaleString('en-GB')} Tiles.`,
    tier: 'tiles' as Tier,
    have: (tally: Tally) => tally.d,
    goal: DRIVE_STEPS[step],
  })),
  ...['Paint Swap', 'Rough Ground', 'Demolition Derby'].map((name, step) => ({
    bit: 19 + step,
    name,
    blurb: `Be in ${BUMP_STEPS[step].toLocaleString('en-GB')} Bumps.`,
    tier: 'bumps' as Tier,
    have: (tally: Tally) => tally.b,
    goal: BUMP_STEPS[step],
  })),
  ...['Loose Surface', 'Countersteer', 'Opposite Lock', 'Full Send'].map((name, step) => ({
    bit: 22 + step,
    name,
    blurb: `Cut ${DRIFT_STEPS[step].toLocaleString('en-GB')} blades while drifting.`,
    tier: 'drift' as Tier,
    have: (tally: Tally) => tally.g,
    goal: DRIFT_STEPS[step],
  })),
];

/** Whether a Tally has earned one Achievement. */
export function earned(achievement: Achievement, tally: Tally): boolean {
  return achievement.have(tally) >= achievement.goal;
}

/** A Mower that has done nothing yet. */
export function emptyTally(): Tally {
  return { c: 0, q: new Array(FIELD_NAMES.length).fill(0), d: 0, b: 0, g: 0 };
}

/**
 * Which Achievements a Tally has earned, as a bit per Achievement.
 *
 * It is worked out from the Tally every time rather than remembered, so a new
 * Achievement is awarded to every Mower that already deserves it the moment it
 * is added. The caller still ORs the answer into what it holds: an Achievement
 * is for ever, and a threshold that moves must never take one back.
 */
export function earnedMask(tally: Tally): number {
  let mask = 0;
  for (const achievement of ACHIEVEMENTS) {
    if (earned(achievement, tally)) mask |= 1 << achievement.bit;
  }
  return mask >>> 0;
}

/** Whether a mask holds one Achievement. */
export function holds(mask: number, bit: number): boolean {
  return (mask & (1 << bit)) !== 0;
}

/**
 * How many Achievements a mask holds.
 *
 * It counts the bits that belong to an Achievement and not the bits that are
 * set, so a bit left standing by a retired Achievement adds nothing to
 * anybody's tally.
 */
export function countHeld(mask: number): number {
  let held = 0;
  for (const achievement of ACHIEVEMENTS) {
    if (holds(mask, achievement.bit)) held += 1;
  }
  return held;
}
