import { Context, Effect, Layer } from "effect";
import { serviceUse } from "../support/service";
import { LEAVING_STALE_MS, NOTE_AGE_MS, NOTE_KEEP, REJOIN_GRACE_MS } from "./limits";
import { Alarm } from "./alarm";
import { Sockets } from "./sockets";
import type { MowerKey, Note } from "./schema";

/**
 * What the Lawn has lately had to say, and who it believes is on it.
 *
 * The notes are held in memory and never written down. A Lawn only hibernates
 * when nobody is driving on it, so a Lawn that has forgotten its notes is a
 * Lawn where nothing has happened — which is exactly what an empty log says.
 * What this does buy is the thing a log is for: it survives a reload, and it
 * tells a Mower who has just walked in what it walked in on.
 *
 * Arriving and leaving are worked out per Mower Key and not per socket. A
 * reload closes one socket and opens another on the same Key, which is not a
 * Mower leaving and coming back — it is the same hands on the same machine,
 * and saying so twice in the corner is the log crying wolf.
 */
export interface Interface {
  /** Say a thing to everyone on the Lawn, and remember having said it. */
  readonly announce: (note: Note) => Effect.Effect<void>;
  /** Remember a thing without saying it. The clients say this one themselves. */
  readonly remember: (note: Note) => Effect.Effect<void>;
  /** What has lately happened, for a Mower that has just arrived. */
  readonly recent: () => Effect.Effect<string>;
  /** Tell the Lawn that a Mower Key has arrived, if it was not already here. */
  readonly arrive: (key: MowerKey, name: string) => Effect.Effect<void>;
  /** Note that the last socket on a Key has gone, and start its grace. */
  readonly departing: (key: MowerKey, name: string) => Effect.Effect<void>;
  /**
   * Work through the Keys whose sockets have gone, and announce the ones that
   * have stayed away. It runs whenever a socket opens or closes, which is the
   * only time any of this can have changed, and on the alarm, because the last
   * Mower out of the Lawn has nobody left to open or close anything.
   */
  readonly sweep: () => Effect.Effect<void>;
}

export class Service extends Context.Service<Service, Interface>()("lawn/Log") {}

export const use = serviceUse(Service);

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const sockets = yield* Sockets.Service;
    const alarm = yield* Alarm.Service;

    /** What the Lawn has lately had to say, newest last. */
    const notes: (Note & { at: number })[] = [];
    /** Mower Keys the others have been told are on the Lawn. */
    const announced = new Map<MowerKey, string>();
    /** Keys whose last socket has gone, waiting to see whether they come back. */
    const leaving = new Map<MowerKey, { name: string; at: number }>();

    const remember = (note: Note) =>
      Effect.sync(() => {
        notes.push({ ...note, at: Date.now() });
        if (notes.length > NOTE_KEEP) notes.shift();
      });

    const announce = (note: Note) =>
      Effect.gen(function* () {
        yield* remember(note);
        yield* sockets.broadcast(JSON.stringify({ t: note.k, ...note }));
      });

    const sweep: Interface["sweep"] = () =>
      Effect.gen(function* () {
        const now = Date.now();
        for (const [key, who] of leaving) {
          if (yield* sockets.keyIsHere(key)) {
            leaving.delete(key);
            continue;
          }
          const away = now - who.at;
          if (away < REJOIN_GRACE_MS) continue;
          leaving.delete(key);
          announced.delete(key);
          // Too long ago to be news. The last Mower left and nothing swept the
          // list until this one arrived; it does not want the old goodbye.
          if (away > LEAVING_STALE_MS) continue;
          yield* announce({ k: "gone", nm: who.name });
        }
        // Anything still waiting needs the Lawn to look again, and a socket may
        // never open or close between now and then.
        if (leaving.size) yield* alarm.wake(REJOIN_GRACE_MS);
      });

    return Service.of({
      announce,
      remember,
      recent: () =>
        Effect.sync(() => {
          const now = Date.now();
          return JSON.stringify({
            t: "log",
            lines: notes.filter((one) => now - one.at <= NOTE_AGE_MS),
          });
        }),
      arrive: (key, name) =>
        Effect.gen(function* () {
          leaving.delete(key);
          if (announced.has(key)) return;
          announced.set(key, name);
          yield* announce({ k: "here", nm: name });
        }),
      departing: (key, name) => Effect.sync(() => void leaving.set(key, { name, at: Date.now() })),
      sweep,
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

export * as Log from "./log";
