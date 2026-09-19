import { Context, Effect, Layer } from "effect";
import { serviceUse } from "../support/service";
import { FIELD_NAMES } from "../achievements";
import { fieldAt } from "../ground/parcels";
import { FIELD_CHECK_MS, FIELD_NEARLY } from "./limits";
import { Alarm } from "./alarm";
import { Log } from "./log";
import { Places } from "./places";
import { Scores } from "./scores";
import { Sockets } from "./sockets";
import { Tiles } from "./tiles";
import { noFinishes, type MowerKey } from "./schema";

/**
 * Which Fields are finished, and who was standing in one when it was.
 *
 * The Lawn judges the finish itself, from the Tiles it holds, by the same sum
 * the Tracker uses. It has to: the flare, the banner and the Achievement are
 * one moment, and a Lawn that worked it out differently from the client would
 * put the medal a second to one side of the thing it belongs to.
 */
export interface Interface {
  /**
   * Read every Field this Mow Stroke took grass off, and crown the Mowers
   * standing in one that has just been finished.
   */
  readonly watch: (cutByField: Float64Array) => Effect.Effect<void>;
}

export class Service extends Context.Service<Service, Interface>()("lawn/Quests") {}

export const use = serviceUse(Service);

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const tiles = yield* Tiles.Service;
    const sockets = yield* Sockets.Service;
    const places = yield* Places.Service;
    const scores = yield* Scores.Service;
    const log = yield* Log.Service;
    const alarm = yield* Alarm.Service;

    /**
     * What the Lawn last read of each Field, and when. `at` of 0 means it has
     * never read that Field: the first read only takes the measure of it and
     * crowns nobody, or a Lawn waking beside a Field that was finished while
     * it slept would hand out medals for somebody else's work.
     */
    const watching = FIELD_NAMES.map(() => ({ at: 0, percent: 0, done: false }));

    /**
     * Give every Mower standing in a Field the Achievement for it.
     *
     * Being there is the whole of the test, and that is the point: the Field
     * lights up, the banner falls and the card arrives, all of it at once and
     * all of it for the Mowers who were in it. It is not a share of the work —
     * the Lawn does not ask who cut what — so a Mower that drove in at the end
     * is crowned with the one that cut the parcel. That is the cost of the
     * moment arriving whole, and it was taken with open eyes.
     */
    const crown = (field: number) =>
      Effect.gen(function* () {
        const crowned = new Set<MowerKey>();
        for (const ws of yield* sockets.open()) {
          const place = yield* places.at(ws);
          if (!place) continue;
          if (fieldAt(Math.floor(place.x), Math.floor(place.y)) !== field) continue;
          const who = yield* sockets.whoIs(ws);
          if (!who?.key) continue;
          const score = yield* scores.ensure(who.key, who.name || who.id);
          // Two tabs of one browser are two Mowers on the screen but one Key,
          // and one Key was there once. The card goes to whichever of them the
          // Lawn reaches first, because `award` speaks only when the mask grows
          // and by the second tab it has already grown.
          if (!crowned.has(who.key)) {
            crowned.add(who.key);
            const finishes = score.q ?? (score.q = noFinishes());
            finishes[field] += 1;
          }
          yield* scores.award(ws, score);
        }
        yield* alarm.needsWriting();
      });

    return Service.of({
      watch: (cutByField) =>
        Effect.gen(function* () {
          const now = Date.now();
          for (let field = 0; field < cutByField.length; field++) {
            if (cutByField[field] <= 0) continue;
            const watch = watching[field];
            // A Field near the line is read on every stroke, because the
            // stroke that takes the last of it may be the last stroke anyone
            // makes there.
            if (watch.percent < FIELD_NEARLY && now - watch.at < FIELD_CHECK_MS) continue;
            const first = watch.at === 0;
            watch.at = now;
            watch.percent = yield* tiles.standing(field);
            const done = watch.percent >= 100 - 1e-7;
            // Only the crossing counts. A Field stays done until the Regrowth
            // takes it back under the line, and then it can be finished — and
            // crowned — all over again.
            if (done && !watch.done && !first) {
              // The line about a finished Field is said by each client as it
              // draws the flare, so the two land together. The Lawn only
              // remembers it, for whoever arrives afterwards.
              yield* log.remember({ k: "cut", f: field });
              yield* crown(field);
            }
            watch.done = done;
          }
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

export * as Quests from "./quests";
