import { Context, Effect, Layer } from "effect";
import { serviceUse } from "../support/service";
import { countHeld } from "../achievements";
import { MOW_RADIUS } from "../mowing";
import { LAWN_WIDTH, LAWN_HEIGHT } from "../ground/dimensions";
import { COOLDOWN_SECONDS, PATCH_TILES, REGROW_MAX_SECONDS, REGROW_MIN_SECONDS } from "../ground/growth";
import { BallGame } from "./ballgame";
import { Budgets } from "./budgets";
import { Log } from "./log";
import { Motion } from "./motion";
import { Scores } from "./scores";
import { Sockets } from "./sockets";
import { Strokes } from "./strokes";
import { Tiles } from "./tiles";
import {
  mowerId, mowerKey, tallyMessage,
  type Attachment, type MowerId, type MowerKey, type Spot,
} from "./schema";

/**
 * How the Lawn talks to one Mower: what it says when one arrives, what it
 * shows the others about it, and what it tells that Mower about itself.
 *
 * Who a Mower is rides on its socket and not in memory, because a socket
 * survives hibernation and memory does not.
 */
export interface Interface {
  /** What the Lawn says to a socket that has just opened. */
  readonly hello: (id: MowerId) => Effect.Effect<string>;
  /**
   * Take the Mower Key a Mower says it holds, and answer with who that makes
   * it. The Lawn takes a Key back only when it already holds a Score under it,
   * so a Mower cannot name itself into the Score of another; one the Lawn has
   * never issued simply becomes a new Mower, which costs it nothing.
   *
   * A socket does this once. The name it was given when it opened is replaced
   * by the name that belongs to the Key, so a Mower is the same Mower, with
   * the same colour, on every visit.
   */
  readonly claim: (ws: WebSocket, given: string | undefined) => Effect.Effect<void>;
  /**
   * Show a Mower to the others, and tell it what it has really cut. Both come
   * from one report, so the tally that goes out is the one the Mow Stroke in
   * that same report just added to.
   */
  readonly report: (
    ws: WebSocket, who: Attachment, at: Spot, a: number,
    velocity?: { vx: number; vy: number },
  ) => Effect.Effect<void>;
  /**
   * Send a Mower the Lawn as the server sees it, so an optimistic client never
   * keeps a swath the server refused. It is held to a gap, because a Snapshot
   * is the largest thing the Lawn ever says.
   */
  readonly resync: (ws: WebSocket) => Effect.Effect<void>;
  /** Tell a Mower that a numbered Mow Stroke of its own landed, and where. */
  readonly accept: (ws: WebSocket, seq: number | undefined, at: Spot) => Effect.Effect<void>;
  /**
   * Forget the travel purse once the last Mower driving on it has gone.
   *
   * `webSocketClose` fires before the socket leaves the list, so the one that
   * is going does not count itself as still driving.
   */
  readonly forgetPurse: (going: WebSocket, purse: string) => Effect.Effect<void>;
}

export class Service extends Context.Service<Service, Interface>()("lawn/Mower") {}

export const use = serviceUse(Service);

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const sockets = yield* Sockets.Service;
    const scores = yield* Scores.Service;
    const budgets = yield* Budgets.Service;
    const motion = yield* Motion.Service;
    const ballgame = yield* BallGame.Service;
    const strokes = yield* Strokes.Service;
    const tiles = yield* Tiles.Service;
    const log = yield* Log.Service;

    return Service.of({
      hello: (id) =>
        Effect.gen(function* () {
          const mowers = (yield* sockets.all()).length;
          return JSON.stringify({
            t: "hello",
            id,
            w: LAWN_WIDTH,
            h: LAWN_HEIGHT,
            regrowMin: REGROW_MIN_SECONDS,
            regrowMax: REGROW_MAX_SECONDS,
            cooldown: COOLDOWN_SECONDS,
            patch: PATCH_TILES,
            radius: MOW_RADIUS,
            now: Date.now(),
            mowers,
            strokes: yield* strokes.made(),
          });
        }),

      claim: (ws, given) =>
        Effect.gen(function* () {
          const who = yield* sockets.whoIs(ws);
          if (who?.key) return;

          const held = given === undefined ? undefined : yield* scores.of(given as MowerKey);
          const key = held ? (given as MowerKey) : mowerKey();
          // The id stays the one this socket opened with. Only the name and
          // the colour come from the Key, so a Mower is recognisable across
          // visits without two of its tabs becoming one Mower.
          const id = who?.id ?? mowerId();
          const name = held?.n ?? mowerId();
          yield* sockets.attach(ws, { id, key, name });
          // Say so to the Lawn. A Mower is only worth announcing once it holds
          // its Key: that is the moment it has the name it will wear, and the
          // Key is what says whether this is somebody new or the same Mower
          // back from a reload.
          yield* log.arrive(key, name);
          yield* log.sweep();
          // The Achievements come back with the Key, because they are the whole
          // of what a returning Mower has to show for its last visit. They are
          // what it already had, so the client lands them rather than
          // announcing them, the way the Score is landed rather than rolled up
          // to.
          yield* sockets.send(ws, JSON.stringify({
            t: "you", id, key, nm: name, a: held?.a ?? 0, ...tallyMessage(held),
          }));
        }),

      report: (ws, who, at, a, velocity) =>
        Effect.gen(function* () {
          yield* motion.track(ws, who.id, at);
          yield* ballgame.stir(ws);
          const held = who.key ? yield* scores.of(who.key) : undefined;
          // How many Achievements this Mower holds, for the board. It rides on
          // the report for the reason the tally does: the board is built from
          // presence, so anything the board shows about a Mower has to arrive
          // with it. It is the count and not the mask, because the board shows
          // a number.
          //
          // `nm` is what this Mower is called and coloured by, and `n` is when
          // the report was made. They are different things with unlucky names.
          // A client draws other Mowers slightly in the past, between two
          // reports, and it needs to know when each one was really made: the
          // gaps between arrivals are network jitter, not movement.
          yield* sockets.broadcast(JSON.stringify({
            t: "peer",
            id: who.id,
            nm: who.name || who.id,
            x: at.x,
            y: at.y,
            a,
            ...velocity,
            s: Math.round(held?.c ?? 0),
            ac: countHeld(held?.a ?? 0),
            n: Date.now(),
          }), ws);
          yield* scores.tell(ws, held);
        }),

      resync: (ws) =>
        Effect.gen(function* () {
          if (!(yield* budgets.mayResync(ws))) return;
          yield* sockets.send(ws, yield* tiles.snapshot());
        }),

      accept: (ws, seq, at) =>
        Effect.gen(function* () {
          if (seq === undefined || !Number.isSafeInteger(seq) || seq <= 0) return;
          yield* sockets.send(ws, JSON.stringify({ t: "accepted", seq, x: at.x, y: at.y }));
        }),

      forgetPurse: (going, purse) =>
        Effect.gen(function* () {
          if (!purse) return;
          for (const ws of yield* sockets.open()) {
            if (ws === going) continue;
            const who = yield* sockets.whoIs(ws);
            if ((who?.key || who?.id || "") === purse) return;
          }
          yield* budgets.forgetTravel(purse);
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

export * as Mower from "./mower";
