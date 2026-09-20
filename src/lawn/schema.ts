import { Result, Schema } from "effect";

/** The same record, with the `readonly` taken off every field. */
type Mutable<T> = { -readonly [K in keyof T]: T[K] };
import { FIELD_NAMES, emptyTally, type Tally } from "../achievements";
import { EMOTE_COUNT } from "./limits";

/**
 * Everything a Mower may say, everything the Lawn writes down, and the things
 * that can go wrong reading either. The shapes live apart from the services
 * that use them: a Mow Stroke means the same thing whether the Lawn is cutting
 * it, counting it or loading it back off disk.
 */

/**
 * One socket. It is one per socket and not one per Mower Key, so two tabs of
 * one browser stay two Mowers on the screen and neither writes over the other.
 */
export const MowerId = Schema.String.pipe(Schema.brand("MowerId"));
export type MowerId = typeof MowerId.Type;

/**
 * What a Mower is, across visits. The Key travels in a message and never in
 * the address of the socket: an address is written down by every machine it
 * passes, and the Key is the whole of the proof of who a Mower is.
 */
export const MowerKey = Schema.String.pipe(Schema.brand("MowerKey"));
export type MowerKey = typeof MowerKey.Type;

/** A short random string. Both an id and a name seed are one of these. */
export const mowerId = (): MowerId => crypto.randomUUID().slice(0, 8) as MowerId;
export const mowerKey = (): MowerKey => crypto.randomUUID() as MowerKey;

/** A number that is really a number: no NaN and no infinity off the wire. */
const Coordinate = Schema.Number.check(Schema.isFinite());

/**
 * A Mow Stroke says where the Mower is now and which way it points. The swath
 * is from where the Lawn last saw that Mower to there, so the Mower cannot
 * name its own starting point. It is the position report as well, because
 * both say the same thing about the same movement and a second message would
 * cost the Lawn a second time. `x1`/`y1` is the old name for the same point,
 * and a missing `a` the older shape, for a tab open across a deploy.
 */
export const MowMessage = Schema.Struct({
  t: Schema.Literal("mow"),
  x: Schema.optional(Coordinate),
  y: Schema.optional(Coordinate),
  x1: Schema.optional(Coordinate),
  y1: Schema.optional(Coordinate),
  a: Schema.optional(Coordinate),
  vx: Schema.optional(Coordinate),
  vy: Schema.optional(Coordinate),
  seq: Schema.optional(Schema.Number),
});
export type MowMessage = typeof MowMessage.Type;

/**
 * Where a Mower is and which way it points. A Mow Stroke now carries this,
 * so only a tab open across a deploy still sends it on its own.
 */
export const PositionMessage = Schema.Struct({
  t: Schema.Literal("pos"),
  x: Coordinate,
  y: Coordinate,
  a: Coordinate,
});
export type PositionMessage = typeof PositionMessage.Type;

/**
 * Which Mower Key this one holds, or none. It is the first thing a Mower
 * says.
 */
export const ClaimMessage = Schema.Struct({
  t: Schema.Literal("i"),
  k: Schema.optional(Schema.String),
});
export type ClaimMessage = typeof ClaimMessage.Type;

/** Which Emote a Mower shows. Relayed, never stored. */
export const EmoteMessage = Schema.Struct({
  t: Schema.Literal("emote"),
  e: Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 0, maximum: EMOTE_COUNT - 1 })),
});
export type EmoteMessage = typeof EmoteMessage.Type;

/**
 * That this Mower has been bumped and is dazed. A Mower speaks only for
 * itself here, the same as with its position and its score: it cannot daze
 * another Mower, it can only say that it is dazed.
 */
export const BumpMessage = Schema.Struct({ t: Schema.Literal("bump") });
export type BumpMessage = typeof BumpMessage.Type;

export const ClientMessage = Schema.Union([
  MowMessage,
  PositionMessage,
  ClaimMessage,
  EmoteMessage,
  BumpMessage,
]).pipe(Schema.toTaggedUnion("t"));
export type ClientMessage = typeof ClientMessage.Type;

const readMessage = Schema.decodeUnknownResult(ClientMessage);

/**
 * Read what a Mower said, or nothing at all.
 *
 * Anything the Lawn cannot make sense of is dropped in silence, which is what
 * it did before: a Mower has no use for the reason, and a client that sends
 * nonsense is either very old or not a client.
 */
export function readClientMessage(raw: string): ClientMessage | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  const read = readMessage(parsed);
  return Result.isSuccess(read) ? read.success : undefined;
}

/**
 * Where a Mow Stroke says the Mower now is. A Mow Stroke carries the point
 * under either name, so this is the one place that knows there are two.
 */
export function strokeAt(message: MowMessage): { x: number; y: number } | undefined {
  const x = message.x ?? message.x1;
  const y = message.y ?? message.y1;
  return x === undefined || y === undefined ? undefined : { x, y };
}

/**
 * What the Lawn keeps under one Mower Key: what that Mower is called, and the
 * blades it has cut.
 *
 * The name seed is not the `id`. An `id` is one per socket, so two tabs of one
 * browser stay two Mowers on the screen and neither writes over the other on
 * the board. The name seed is one per Key, so those two Mowers wear the same
 * name and the same colour, and so does the Mower that comes back tomorrow.
 *
 * Every field is mutable on purpose: a Score is changed in place and never
 * rebuilt, because a Score that is rebuilt is a Score that silently drops the
 * fields a later version added.
 */
const ScoreShape = Schema.Struct({
  /** What it is called and coloured by. */
  n: Schema.String,
  /** Its blades. */
  c: Schema.Number,
  /**
   * The Achievements it has earned, one bit each. A Score written before
   * Achievements existed carries none, and earns them on its next Mow Stroke
   * from what it already holds.
   */
  a: Schema.optional(Schema.Number),
  /**
   * How often it stood in each Field as that Field was finished, in the order
   * of `FIELD_NAMES`.
   */
  q: Schema.optional(Schema.mutable(Schema.Array(Schema.Number))),
  /**
   * The blades it took off each Field, from when a Field was earned by cutting
   * a whole one yourself. Nothing reads it. It is dropped from a record the
   * first time the Lawn writes that record, so no old number is ever mistaken
   * for a count of finishes.
   */
  h: Schema.optional(Schema.mutable(Schema.Array(Schema.Number))),
  /** Tiles it has driven, as the Lawn drove it. */
  d: Schema.optional(Schema.Number),
  /** Bumps the Lawn saw it in. */
  b: Schema.optional(Schema.Number),
});
/**
 * A Score is changed in place and never rebuilt, because a Score that is
 * rebuilt is a Score that silently drops the fields a later version added. The
 * schema says what is on disk; this says what the Lawn works on.
 */
export type Score = Mutable<typeof ScoreShape.Type>;
export const Score = ScoreShape;

/**
 * A Score as it comes off the disk. It used to be a bare number: one written
 * before the id was kept is given one on the way in, so an old Mower Key still
 * opens the Score it holds.
 */
export const StoredScore = Schema.Union([Score, Schema.Number]);
export const StoredEntry = Schema.Tuple([Schema.String, StoredScore]);

const readEntry = Schema.decodeUnknownResult(StoredEntry);

/**
 * Read the board off the disk.
 *
 * One record at a time, and on purpose. A record the Lawn cannot read costs
 * that one Mower its Score; reading the board as a whole would have cost every
 * Mower theirs, because the next alarm writes back whatever was loaded — so a
 * single bad row would not just be unread, it would be overwritten, and a
 * Score is the one thing here that cannot be mown again.
 *
 * The Lawn writes every one of these itself, so none of them should be
 * unreadable. That is the argument for being strict about what is read, and it
 * is not an argument for betting the board on it.
 */
export function readStoredScores(stored: unknown): Map<MowerKey, Score> {
  if (!Array.isArray(stored)) return new Map();
  const board = new Map<MowerKey, Score>();
  for (const entry of stored) {
    const read = readEntry(entry);
    if (Result.isFailure(read)) continue;
    const [key, held] = read.success;
    board.set(
      key as MowerKey,
      typeof held === "number" ? { n: mowerId() as string, c: held } : { ...held },
    );
  }
  return board;
}

/** What a Score has done, in the shape the Achievement table reads. */
export function tallyOf(score: Score): Tally {
  return {
    c: score.c,
    q: score.q ?? emptyTally().q,
    d: score.d ?? 0,
    b: score.b ?? 0,
  };
}

/** What a Mower has done, in the shape the Achievements window draws. */
export function tallyMessage(held: Score | undefined) {
  return {
    s: Math.round(held?.c ?? 0),
    d: Math.round(held?.d ?? 0),
    b: held?.b ?? 0,
    q: held?.q ?? emptyTally().q,
  };
}

/**
 * Round a running total before it is written down. A Score is one storage
 * value for every Mower on the Lawn, and the last ten decimal places of a
 * distance are bytes spent on nothing.
 */
export function tidy(value: number, places = 4): number {
  const scale = 10 ** places;
  return Math.round(value * scale) / scale;
}

/** A fresh, empty count of finishes, one per Field. */
export const noFinishes = (): number[] => FIELD_NAMES.map(() => 0);

/**
 * What the Lawn rides on a socket between one message and the next. It
 * survives hibernation, which is why the Lawn keeps it there and not in
 * memory.
 */
export interface Attachment {
  id: MowerId;
  key: MowerKey | "";
  name?: string;
}

/** One thing the Lawn has lately had to say. */
export interface Note {
  /** Which kind of thing happened: `here`, `gone`, `won` or `cut`. */
  k: string;
  /** Who it happened to. */
  nm?: string;
  /** Which Achievement was won. */
  w?: number;
  /** Which Field was finished. */
  f?: number;
}

/** Where the Lawn last saw a Mower, in Tiles. */
export interface Spot {
  x: number;
  y: number;
}

/** The Lawn could not read or write what it keeps on disk. */
export class LawnStoreError extends Schema.TaggedError<LawnStoreError>()("LawnStoreError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

export * as LawnSchema from "./schema";
