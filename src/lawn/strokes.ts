import { Context, Effect, Layer } from "effect";
import { serviceUse } from "../support/service";
import { Store } from "./store";

/**
 * How many Mow Strokes the Lawn has ever seen.
 *
 * It is not a Score and belongs to nobody: it is what the Lawn has had done to
 * it, and it rides on every Mow Stroke the Lawn relays so that every screen
 * shows the same number.
 */
export interface Interface {
  readonly made: () => Effect.Effect<number>;
  readonly count: () => Effect.Effect<number>;
}

export class Service extends Context.Service<Service, Interface>()("lawn/Strokes") {}

export const use = serviceUse(Service);

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const store = yield* Store.Service;
    let strokes = yield* store.loadStrokes();
    return Service.of({
      made: () => Effect.succeed(strokes),
      count: () => Effect.sync(() => ++strokes),
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

export * as Strokes from "./strokes";
