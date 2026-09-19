import { Context, Effect, Layer } from "effect";
import { serviceUse } from "../support/service";
import { FIELD_NAMES } from "../achievements";
import { TILE_COUNT } from "../ground/dimensions";
import { REGROW, SNAPSHOT_SCALE, cycle } from "../ground/growth";
import { FIELD_OF, FIELD_TILES, NO_FIELD, fieldStanding } from "../ground/parcels";
import { cutSwath, type Ground } from "../ground/cutting";
import { Store } from "./store";
import { LawnStoreError } from "./schema";

/**
 * The ground itself: the moment every Tile was last mown.
 *
 * A Tile stores only that moment, so nothing ticks and the Lawn keeps growing
 * while the Durable Object hibernates. Everything that reads a Blade Height
 * reads it from here through the same pure function the client uses, which is
 * what makes the score the Lawn counts the score the Mower watches.
 */

/** What one Mow Stroke took off. */
export interface Cut {
  /** The grass that came off, all told. This is the Score. */
  readonly blades: number;
  /**
   * The same grass split by Field, which is how the Lawn knows which Fields
   * this stroke could have finished. It is reused between strokes and says
   * nothing once the next one is cut: read it and be done with it.
   */
  readonly byField: Float64Array;
}

export interface Interface {
  /**
   * Cut every Tile the swath touches back to zero Blade Height, and answer
   * with the grass that came off. The Lawn counts the blades itself, so a
   * Mower cannot name its own tally.
   */
  readonly mow: (x0: number, y0: number, x1: number, y1: number) => Effect.Effect<Cut>;
  /**
   * How far every Tile is through Cooldown and Regrowth together, 0 to
   * `SNAPSHOT_SCALE`. The span is the whole cycle and not the Regrowth alone,
   * so one entry still says everything about one Tile and the wire keeps its
   * size.
   */
  readonly snapshot: () => Effect.Effect<ArrayBuffer>;
  /** How far through one Field the Lawn is, from 0 to 100. */
  readonly standing: (field: number) => Effect.Effect<number>;
  /** The ground as it is, for whoever writes it down. */
  readonly ground: () => Effect.Effect<Uint32Array>;
  /**
   * Whether the ground had to be moved to fit a Lawn that grew, and so has to
   * be written down again.
   */
  readonly regrown: () => Effect.Effect<boolean>;
}

export class Service extends Context.Service<Service, Interface>()("lawn/Tiles") {}

export const use = serviceUse(Service);

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const store = yield* Store.Service;
    const loaded = yield* store.loadGround();
    const byField = new Float64Array(FIELD_NAMES.length);
    const mownAt = loaded.mownAt;
    const ground: Ground = { mownAt, fieldOf: FIELD_OF, regrow: REGROW, byField, bare: NO_FIELD };

    return Service.of({
      mow: (x0, y0, x1, y1) =>
        Effect.sync(() => ({
          blades: cutSwath(ground, x0, y0, x1, y1, Math.floor(Date.now() / 1000)),
          byField,
        })),

      snapshot: () =>
        Effect.sync(() => {
          const now = Math.floor(Date.now() / 1000);
          const ages = new Uint16Array(TILE_COUNT);
          for (let i = 0; i < TILE_COUNT; i++) {
            const mown = mownAt[i];
            const span = cycle(REGROW[i]);
            const age = mown === 0 ? span : now - mown;
            const grown = age >= span ? 1 : age < 0 ? 0 : age / span;
            ages[i] = Math.round(grown * SNAPSHOT_SCALE);
          }
          return ages.buffer;
        }),

      standing: (field) =>
        Effect.sync(() => fieldStanding(FIELD_TILES[field], mownAt, Math.floor(Date.now() / 1000))),

      ground: () => Effect.succeed(mownAt),
      regrown: () => Effect.succeed(loaded.regrown),
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

export * as Tiles from "./tiles";
