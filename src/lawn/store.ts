import { Context, Effect, Layer } from "effect";
import { serviceUse } from "../support/service";
import { createBall, type Ball } from "../ball";
import { LAWN_WIDTH, LAWN_HEIGHT, TILE_COUNT } from "../ground/dimensions";
import { Durable } from "./durable";
import { LawnStoreError, readStoredScores, type MowerKey, type Score } from "./schema";

/**
 * What the Lawn keeps on disk, and the only place that knows how.
 *
 * The Tiles are one array and a storage value holds at most 128 KiB, so the
 * array is written in chunks. The size of a chunk is not part of the format:
 * the chunks are read back in order and joined, so a Lawn written before this
 * one grew still loads.
 */
const TILES_KEY = "mownAt";
const STROKE_KEY = "strokes";
const SCORE_KEY = "scores";
const BALL_KEY = "ball";
const CHUNK_BYTES = 96 * 1024;
const CHUNK_COUNT = Math.ceil((TILE_COUNT * 4) / CHUNK_BYTES);
const chunkKey = (k: number) => (k === 0 ? TILES_KEY : `${TILES_KEY}:${k}`);

/** The widths a Lawn was saved at before this one, newest first. */
const OLD_WIDTHS = [288, 144, 72];

/** What one load of the ground found. */
export interface Loaded {
  readonly mownAt: Uint32Array;
  /**
   * Whether the Tiles had to be moved to fit this Lawn. A Lawn that grew has
   * to be written down again at its new size, or the next load re-centres the
   * same old square all over again.
   */
  readonly regrown: boolean;
}

export interface Interface {
  /** The Tiles, at the size of this Lawn, however they were last written. */
  readonly loadGround: () => Effect.Effect<Loaded, LawnStoreError>;
  /** How many Mow Strokes the Lawn has seen. */
  readonly loadStrokes: () => Effect.Effect<number, LawnStoreError>;
  /** The board, with a Score of the older shape read as a Score. */
  readonly loadScores: () => Effect.Effect<Map<MowerKey, Score>, LawnStoreError>;
  /** Where the Ball came to rest. */
  readonly loadBall: () => Effect.Effect<Ball | undefined, LawnStoreError>;
  /** Write the ground, the count and the board in one go. */
  readonly save: (what: {
    readonly mownAt: Uint32Array;
    readonly strokes: number;
    readonly scores: Map<MowerKey, Score>;
  }) => Effect.Effect<void, LawnStoreError>;
  /**
   * Write where the Ball is, without waiting. The Ball moves on its own clock
   * and the tick that writes it has the next tick to get to; the Durable Object
   * is asked to stay awake for the write instead.
   */
  readonly saveBall: (ball: Ball) => Effect.Effect<void>;
}

export class Service extends Context.Service<Service, Interface>()("lawn/Store") {}

export const use = serviceUse(Service);

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { state } = yield* Durable.Service;
    const storage = state.storage;

    const failing = <A>(message: string, run: () => Promise<A>) =>
      Effect.tryPromise({
        try: run,
        catch: (cause) => new LawnStoreError({ message, cause }),
      });

    /**
     * Read one key more than this Lawn writes, so a Lawn saved in smaller
     * chunks is still read whole.
     */
    const readChunks = async (): Promise<ArrayBuffer | undefined> => {
      const keys = Array.from({ length: CHUNK_COUNT + 4 }, (_, k) => chunkKey(k));
      const stored = await storage.get<ArrayBuffer>(keys);
      const parts: ArrayBuffer[] = [];
      for (const key of keys) {
        const part = stored.get(key);
        if (!part) break;
        parts.push(part);
      }
      if (!parts.length) return undefined;
      if (parts.length === 1) return parts[0];
      const joined = new Uint8Array(parts.reduce((n, part) => n + part.byteLength, 0));
      let at = 0;
      for (const part of parts) {
        joined.set(new Uint8Array(part), at);
        at += part.byteLength;
      }
      return joined.buffer;
    };

    /**
     * Put a Lawn saved at a smaller size in the middle of this one. The Lawn
     * grew around what was already mown, so what was mown stays mown and the
     * new ground starts fully overgrown.
     */
    const recentre = (stored: ArrayBuffer): Loaded | undefined => {
      const oldWidth = OLD_WIDTHS.find((width) => stored.byteLength === width * (width * 2 / 3) * 4);
      if (!oldWidth) return undefined;
      const oldHeight = oldWidth * 2 / 3;
      const mownAt = new Uint32Array(TILE_COUNT);
      const previous = new Uint32Array(stored);
      const offsetX = (LAWN_WIDTH - oldWidth) / 2;
      const offsetY = (LAWN_HEIGHT - oldHeight) / 2;
      for (let y = 0; y < oldHeight; y++) {
        mownAt.set(
          previous.subarray(y * oldWidth, (y + 1) * oldWidth),
          (y + offsetY) * LAWN_WIDTH + offsetX,
        );
      }
      return { mownAt, regrown: true };
    };

    return Service.of({
      loadGround: () =>
        failing("cannot read the ground", readChunks).pipe(
          Effect.map((stored): Loaded => {
            if (stored && stored.byteLength === TILE_COUNT * 4) {
              return { mownAt: new Uint32Array(stored.slice(0)), regrown: false };
            }
            return (stored && recentre(stored)) ?? { mownAt: new Uint32Array(TILE_COUNT), regrown: false };
          }),
        ),

      loadStrokes: () =>
        failing("cannot read the stroke count", () => storage.get<number>(STROKE_KEY)).pipe(
          Effect.map((strokes) => strokes ?? 0),
        ),

      loadScores: () =>
        failing("cannot read the board", () => storage.get<unknown>(SCORE_KEY)).pipe(
          Effect.map(readStoredScores),
        ),

      loadBall: () =>
        failing("cannot read the ball", () => storage.get<Ball>(BALL_KEY)).pipe(
          Effect.map((saved) => (saved ? createBall(saved.x, saved.y) : undefined)),
        ),

      save: ({ mownAt, strokes, scores }) =>
        failing("cannot write the Lawn", () => {
          // Each storage value stays below 128 KiB; save every chunk atomically.
          const write: Record<string, unknown> = {
            [STROKE_KEY]: strokes,
            [SCORE_KEY]: [...scores],
          };
          for (let k = 0; k < CHUNK_COUNT; k++) {
            write[chunkKey(k)] = mownAt.buffer.slice(k * CHUNK_BYTES, (k + 1) * CHUNK_BYTES);
          }
          return storage.put(write);
        }),

      saveBall: (ball) => Effect.sync(() => state.waitUntil(storage.put(BALL_KEY, ball))),
    });
  }),
);

/**
 * There is no `defaultLayer` here, and there is none on any service of the
 * Lawn. A `defaultLayer` is the layer with its dependencies already wired, and
 * every service here holds the state of one Lawn: wiring them service by
 * service would give the one that asked its own Sockets, its own board and its
 * own budgets, and two halves of the Lawn would stop agreeing about who is on
 * it. The graph is built once, in `runtime.ts`, and that is the only place it
 * may be built.
 */

export * as Store from "./store";
