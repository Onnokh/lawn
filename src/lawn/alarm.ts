import { Context, Effect, Layer } from "effect";
import { serviceUse } from "../support/service";
import { PERSIST_DELAY_MS } from "./limits";
import { Durable } from "./durable";

/**
 * The one alarm a Durable Object has, and the two things that want it.
 *
 * Writing the Lawn down wants it, and so does deciding whether a Mower that
 * went quiet has really gone. Whichever wants it first gets it, and whatever
 * is left over asks again when the alarm has been served.
 */
export interface Interface {
  /** Ask to be woken in `delay` ms, unless something sooner is already asked for. */
  readonly wake: (delay: number) => Effect.Effect<void>;
  /**
   * Say that the Lawn has changed and must be written down. The first caller
   * sets the alarm; the ones after it cost nothing, which is what lets every
   * Mow Stroke say this without every Mow Stroke being a write.
   */
  readonly needsWriting: () => Effect.Effect<void>;
  /**
   * Take the alarm. It answers whether there is anything to write down, and
   * forgets that there was, so one alarm writes the Lawn once.
   */
  readonly settle: () => Effect.Effect<boolean>;
}

export class Service extends Context.Service<Service, Interface>()("lawn/Alarm") {}

export const use = serviceUse(Service);

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { state } = yield* Durable.Service;
    /** When the alarm is next set for, so two callers cannot undercut it. */
    let alarmAt = 0;
    let dirty = false;

    const wake = (delay: number) =>
      Effect.sync(() => {
        const at = Date.now() + delay;
        if (alarmAt > Date.now() && alarmAt <= at) return;
        alarmAt = at;
        void state.storage.setAlarm(at);
      });

    return Service.of({
      wake,
      needsWriting: () =>
        Effect.gen(function* () {
          if (dirty) return;
          dirty = true;
          yield* wake(PERSIST_DELAY_MS);
        }),
      settle: () =>
        Effect.sync(() => {
          alarmAt = 0;
          const owed = dirty;
          dirty = false;
          return owed;
        }),
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

export * as Alarm from "./alarm";
