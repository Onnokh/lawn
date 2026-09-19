import { Context, Effect, Layer } from "effect";
import { serviceUse } from "../support/service";
import { earnedMask } from "../achievements";
import { KEY_KEEP, SCORE_KEEP } from "./limits";
import { Budgets } from "./budgets";
import { Log } from "./log";
import { Sockets } from "./sockets";
import { Store } from "./store";
import {
  LawnStoreError, noFinishes, tallyMessage, tallyOf, tidy,
  type MowerKey, type Score,
} from "./schema";

/**
 * The board: what every Mower has cut, driven and won.
 *
 * The Lawn counts the blades as it cuts them, so a tally is not a number a
 * client can name. Unlike a position it outlives the socket, because a Score is
 * worth nothing that does not outlive the visit that earned it.
 */
export interface Interface {
  /** What the Lawn holds under a Mower Key, if it holds anything. */
  readonly of: (key: MowerKey) => Effect.Effect<Score | undefined>;
  /**
   * The record the Lawn holds under a Key, made if there is none. A Mower that
   * has stood still since it arrived has cut nothing and driven nowhere, so
   * the Lawn holds no record for it yet.
   */
  readonly ensure: (key: MowerKey, name: string) => Effect.Effect<Score>;
  /**
   * Add one Mow Stroke to what the Lawn holds for this Mower: the blades it
   * took off, and the Tiles it drove. Both grow and neither ever falls, which
   * is what lets an Achievement be for ever.
   */
  readonly credit: (
    ws: WebSocket, key: MowerKey, name: string, blades: number, drove: number,
  ) => Effect.Effect<void>;
  /**
   * Work out which Achievements a Score has earned, and tell that Mower when
   * the answer has grown. What it holds is ORed with what it has earned and
   * never replaced: an Achievement is a thing that happened, so a threshold
   * raised afterwards must not take one back from the Mower that had it.
   */
  readonly award: (ws: WebSocket, score: Score) => Effect.Effect<void>;
  /**
   * Tell a Mower what it has really cut, and what else it has done. The client
   * counts the blades along so the digits roll without waiting for the Lawn,
   * and this puts that guess right a few times a second.
   */
  readonly tell: (ws: WebSocket, held: Score | undefined) => Effect.Effect<void>;
  /** The whole board, for whoever writes it down. */
  readonly all: () => Effect.Effect<Map<MowerKey, Score>>;
  /**
   * Forget the lowest Scores once the Lawn holds more than it keeps.
   *
   * A Mower that is driving is never forgotten, whatever it has cut, so nobody
   * loses a Score while they are earning it. Nor is a Mower that has earned an
   * Achievement, while the Lawn stays under `KEY_KEEP`: a Score can be mown
   * again in an afternoon and an Achievement cannot be earned twice, so the two
   * are not worth the same and must not be pruned the same.
   *
   * Past `KEY_KEEP` that exemption ends, because every Score is written into
   * one storage value and one storage value has a ceiling. A Lawn with more
   * decorated Mowers than that forgets the quietest of them, and the Mower it
   * forgets gets a fresh Mower Key on its next visit. That is the hole this
   * leaves open, and it opens only on a Lawn that has been busy for a long
   * time; raise `KEY_KEEP` — and split the storage value — before it does.
   */
  readonly prune: () => Effect.Effect<void>;
}

export class Service extends Context.Service<Service, Interface>()("lawn/Scores") {}

export const use = serviceUse(Service);

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const store = yield* Store.Service;
    const sockets = yield* Sockets.Service;
    const budgets = yield* Budgets.Service;
    const log = yield* Log.Service;

    const scores = yield* store.loadScores();

    const award: Interface["award"] = (ws, score) =>
      Effect.gen(function* () {
        const before = score.a ?? 0;
        const after = (before | earnedMask(tallyOf(score))) >>> 0;
        if (after === before) return;
        score.a = after;
        // Everyone hears about it. An Achievement earned where nobody can see
        // it is half an Achievement, and the Lawn is a shared field.
        const who = yield* sockets.whoIs(ws);
        for (let bit = 0; bit < 32; bit++) {
          if ((after & (1 << bit)) && !(before & (1 << bit))) {
            yield* log.announce({ k: "won", nm: who?.name, w: bit });
          }
        }
        yield* sockets.send(ws, JSON.stringify({ t: "got", a: after, ...tallyMessage(score) }));
      });

    return Service.of({
      of: (key) => Effect.sync(() => scores.get(key)),

      ensure: (key, name) =>
        Effect.sync(() => {
          const score = scores.get(key) ?? { n: name, c: 0 };
          scores.set(key, score);
          return score;
        }),

      credit: (ws, key, name, blades, drove) =>
        Effect.gen(function* () {
          // The record is the one the map holds, so it is changed in place and
          // not rebuilt: a Score that is rebuilt is a Score that silently drops
          // the fields a later version added.
          const score = scores.get(key) ?? { n: name, c: 0 };
          score.c += blades;
          score.d = tidy((score.d ?? 0) + drove);
          // The finishes are put on the record even when there are none, so
          // that reading it never has to build them: a Mower reports ten times
          // a second, and a Tally built afresh each time is throwaway arrays
          // ten times a second. The blades-per-Field of the older shape go at
          // the same moment.
          if (!score.q) score.q = noFinishes();
          if (score.h) delete score.h;
          scores.set(key, score);
          yield* award(ws, score);
        }),

      award,

      tell: (ws, held) =>
        Effect.gen(function* () {
          if (!(yield* budgets.mayScore(ws))) return;
          yield* sockets.send(ws, JSON.stringify({ t: "score", ...tallyMessage(held) }));
        }),

      all: () => Effect.succeed(scores),

      prune: () =>
        Effect.gen(function* () {
          if (scores.size <= SCORE_KEEP) return;
          const driving = new Set<MowerKey>();
          for (const ws of yield* sockets.all()) {
            const key = (yield* sockets.whoIs(ws))?.key;
            if (key) driving.add(key);
          }
          const decorated = scores.size > KEY_KEEP;
          const keep = decorated ? KEY_KEEP : SCORE_KEEP;
          const spare = [...scores]
            .filter(([key, held]) => !driving.has(key) && (decorated || !held.a))
            .sort((a, b) => a[1].c - b[1].c);
          for (const [key] of spare.slice(0, scores.size - keep)) scores.delete(key);
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

export * as Scores from "./scores";
