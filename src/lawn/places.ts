import { Context, Effect, Layer } from "effect";
import { serviceUse } from "../support/service";
import { POSITION_SLACK, WATER_STEP } from "./limits";
import { Budgets } from "./budgets";
import { Terrain } from "./terrain";
import type { Spot } from "./schema";

/**
 * Where the Lawn holds every Mower, and how far it will let one travel.
 *
 * A Mower is where the Lawn says it is, not where the client says it is. The
 * places are forgotten when the Lawn hibernates, which costs nothing: a Lawn
 * only hibernates when nobody is driving, and the next Mow Stroke from a Mower
 * the Lawn has lost says where it starts and cuts nothing.
 */
export interface Interface {
  /** Where the Lawn last put this Mower, if it has put it anywhere. */
  readonly at: (ws: WebSocket) => Effect.Effect<Spot | undefined>;
  /**
   * Put a Mower on the Lawn where it says it is, with no travel banked. The
   * first Mow Stroke of a Mower only says where it starts: nothing is cut,
   * because the Lawn has no idea where that Mower came from.
   */
  readonly seed: (ws: WebSocket, purse: string, x: number, y: number) => Effect.Effect<Spot>;
  /**
   * Move a Mower from where the Lawn holds it towards where it says it is, and
   * no further than its travel allows. The answer is the far end of the swath:
   * it is the claim itself when the Mower kept to the speed of a Mower, and a
   * point on the way there when it did not.
   */
  readonly drive: (ws: WebSocket, purse: string, from: Spot, x: number, y: number) => Effect.Effect<Spot>;
  /**
   * Pull a reported position back to within reach of the last Mow Stroke of
   * that Mower. Travel is spent by mowing, not by reporting: a Mow Stroke and
   * the position that follows it are the same movement, and paying twice for
   * it would hold back every honest Mower.
   */
  readonly within: (ws: WebSocket, purse: string, x: number, y: number) => Effect.Effect<Spot>;
  /** Forget where a Mower stood. Its socket has gone. */
  readonly forget: (ws: WebSocket) => Effect.Effect<void>;
}

export class Service extends Context.Service<Service, Interface>()("lawn/Places") {}

export const use = serviceUse(Service);

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const budgets = yield* Budgets.Service;
    const { blocked } = yield* Terrain.Service;
    const places = new WeakMap<WebSocket, Spot>();

    /**
     * How far a Mower really gets along its swath: as far as it asked for, or
     * as far as the near bank of the Water. A Mower cannot drive through
     * water, so neither can a client that says it did — the Lawn stops the
     * swath at the water's edge and sends that Mower the Lawn as it sees it.
     *
     * An honest Mower is never held back here. Its own client keeps it a whole
     * Mower's width from the water, and this stops only at the water itself.
     */
    const dryRun = (from: Spot, ux: number, uy: number, distance: number): number => {
      for (let travelled = WATER_STEP; travelled < distance; travelled += WATER_STEP) {
        if (blocked(from.x + ux * travelled, from.y + uy * travelled)) {
          return Math.max(0, travelled - WATER_STEP);
        }
      }
      return blocked(from.x + ux * distance, from.y + uy * distance)
        ? Math.max(0, Math.floor(distance / WATER_STEP) * WATER_STEP - WATER_STEP)
        : distance;
    };

    const seed = (ws: WebSocket, purse: string, x: number, y: number) =>
      Effect.gen(function* () {
        const spot: Spot = { x, y };
        places.set(ws, spot);
        yield* budgets.emptyTravel(purse);
        return spot;
      });

    return Service.of({
      at: (ws) => Effect.sync(() => places.get(ws)),

      seed,

      drive: (ws, purse, from, x, y) =>
        Effect.gen(function* () {
          const dx = x - from.x;
          const dy = y - from.y;
          const distance = Math.hypot(dx, dy);
          if (distance === 0) {
            const still: Spot = { x, y };
            places.set(ws, still);
            return still;
          }
          const allowed = Math.min(distance, yield* budgets.travelLeft(purse));
          const dry = dryRun(from, dx / distance, dy / distance, allowed);
          yield* budgets.spendTravel(purse, dry);
          // The claim itself, and not a point worked back to it: the caller
          // reads an answer that differs from the claim as a swath it has to
          // put right.
          const to: Spot = dry >= distance
            ? { x, y }
            : { x: from.x + dx * (dry / distance), y: from.y + dy * (dry / distance) };
          places.set(ws, to);
          return to;
        }),

      within: (ws, purse, x, y) =>
        Effect.gen(function* () {
          const place = places.get(ws);
          if (!place) return yield* seed(ws, purse, x, y);
          const dx = x - place.x;
          const dy = y - place.y;
          const distance = Math.hypot(dx, dy);
          const reach = (yield* budgets.travelLeft(purse)) + POSITION_SLACK;
          if (distance <= reach) return { x, y };
          const k = reach / distance;
          return { x: place.x + dx * k, y: place.y + dy * k };
        }),

      forget: (ws) => Effect.sync(() => void places.delete(ws)),
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

export * as Places from "./places";
