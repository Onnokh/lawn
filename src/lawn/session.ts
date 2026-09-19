import { Context, Effect, Layer } from "effect";
import { serviceUse } from "../support/service";
import { MOW_RADIUS } from "../mowing";
import { motion as reportedMotion } from "../positions";
import { LAWN_WIDTH, LAWN_HEIGHT } from "../ground/dimensions";
import { MESSAGE_BYTES, MOWERS_PER_ADDRESS } from "./limits";
import { Alarm } from "./alarm";
import { BallGame } from "./ballgame";
import { Budgets } from "./budgets";
import { Durable } from "./durable";
import { Log } from "./log";
import { Motion } from "./motion";
import { Mower } from "./mower";
import { Places } from "./places";
import { Quests } from "./quests";
import { Scores } from "./scores";
import { Sockets } from "./sockets";
import { Store } from "./store";
import { Strokes } from "./strokes";
import { Tiles } from "./tiles";
import {
  LawnStoreError, mowerId, readClientMessage, strokeAt,
  type Attachment, type MowMessage, type MowerId,
} from "./schema";

/**
 * The Lawn's side of the whole conversation: who may come on, what happens
 * when one of them says something, and what is left to do when they all go.
 *
 * Nothing here decides anything on its own. It is the order of the steps, and
 * the order is the domain: a Mow Stroke is spent before it is driven, driven
 * before it is cut, cut before it is counted, and counted before anybody is
 * told.
 */
export interface Interface {
  /** Let a Mower on to the Lawn, or say why not. */
  readonly open: (request: Request) => Effect.Effect<Response>;
  /** One thing a Mower said. */
  readonly heard: (ws: WebSocket, raw: string | ArrayBuffer) => Effect.Effect<void>;
  /** A Mower has gone. */
  readonly closed: (ws: WebSocket) => Effect.Effect<void>;
  /** A Mower has gone badly. */
  readonly failed: (ws: WebSocket) => Effect.Effect<void>;
  /** The alarm the Lawn set for itself has come round. */
  readonly woke: () => Effect.Effect<void, LawnStoreError>;
}

export class Service extends Context.Service<Service, Interface>()("lawn/Session") {}

export const use = serviceUse(Service);

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { state } = yield* Durable.Service;
    const sockets = yield* Sockets.Service;
    const mower = yield* Mower.Service;
    const places = yield* Places.Service;
    const budgets = yield* Budgets.Service;
    const tiles = yield* Tiles.Service;
    const scores = yield* Scores.Service;
    const quests = yield* Quests.Service;
    const strokes = yield* Strokes.Service;
    const motion = yield* Motion.Service;
    const ballgame = yield* BallGame.Service;
    const log = yield* Log.Service;
    const alarm = yield* Alarm.Service;
    const store = yield* Store.Service;

    /**
     * What a socket that has not yet said which Key it holds is worth knowing
     * as: its own id, and a purse of its own rather than an empty one shared
     * with every other such socket.
     */
    const purseOf = (who: Attachment) => who.key || who.id;

    /** A socket the Lawn holds nothing about. It drives, and nothing is kept. */
    const NOBODY: Attachment = { id: "?" as MowerId, key: "" };

    const mow = (ws: WebSocket, who: Attachment, message: MowMessage) =>
      Effect.gen(function* () {
        const claim = strokeAt(message);
        if (!claim) return;
        if (claim.x < -MOW_RADIUS || claim.x > LAWN_WIDTH + MOW_RADIUS) return;
        if (claim.y < -MOW_RADIUS || claim.y > LAWN_HEIGHT + MOW_RADIUS) return;
        // A Mow Stroke that carries a heading is a position report as well. A
        // tab open across a deploy sends the two apart and carries none here,
        // and is then shown by its own `pos` message exactly as before.
        const a = message.a;
        const purse = purseOf(who);

        // A Mower over budget gets the Lawn as the server sees it, so an
        // optimistic client never keeps a swath the server refused.
        if (!(yield* budgets.spendStroke(ws))) {
          yield* mower.resync(ws);
          return;
        }

        const from = yield* places.at(ws);
        if (!from) {
          // The first Mow Stroke of a Mower only says where it starts. Nothing
          // is cut, because the Lawn has no idea where that Mower came from.
          yield* places.seed(ws, purse, claim.x, claim.y);
          if (a !== undefined) {
            yield* mower.report(ws, who, claim, a, reportedMotion(message.vx, message.vy));
          }
          yield* mower.accept(ws, message.seq, claim);
          return;
        }

        // Drive the Mower towards where it says it is, as far as its travel
        // allows. A client that says it moved further keeps a swath the Lawn
        // refused, so it gets the Lawn as the server sees it.
        const to = yield* places.drive(ws, purse, from, claim.x, claim.y);
        const held = to.x !== claim.x || to.y !== claim.y;
        if (held) yield* mower.resync(ws);

        if (to.x !== from.x || to.y !== from.y) {
          // The Lawn counts the blades as it cuts them. This is the whole
          // tally: no client adds anything to it and no client is asked what
          // it is.
          const cut = yield* tiles.mow(from.x, from.y, to.x, to.y);
          // Tiles driven is what the Lawn drove, not what the Mower asked for:
          // a client that claims a mile gets as far as its travel allows, and
          // the ladder is measured on the near end of that.
          const drove = Math.hypot(to.x - from.x, to.y - from.y);
          if (who.key) yield* scores.credit(ws, who.key, who.name || who.id, cut.blades, drove);
          // A Field can only be finished by grass coming off it, so this is
          // the one moment worth looking.
          if (cut.blades > 0) yield* quests.watch(cut.byField);
          yield* sockets.broadcast(JSON.stringify({
            t: "mow",
            x0: from.x,
            y0: from.y,
            x1: to.x,
            y1: to.y,
            by: who.id,
            strokes: yield* strokes.count(),
          }), ws);
          yield* alarm.needsWriting();
        }

        // A Mow Stroke that says which way the Mower points is the position
        // report as well, because it is the same movement. The Mower is shown
        // where the Lawn drove it to and not where the report said, so there is
        // nothing to pull back: `within` is for the older `pos` message only.
        if (a !== undefined) {
          const velocity = held ? { vx: 0, vy: 0 } : reportedMotion(message.vx, message.vy);
          yield* mower.report(ws, who, to, a, velocity);
        }
        yield* mower.accept(ws, message.seq, to);
      });

    /**
     * Let go of everything the Lawn held about one socket. It is the same
     * whether the socket said goodbye or simply broke.
     */
    const depart = (ws: WebSocket, who: Attachment | undefined) =>
      Effect.gen(function* () {
        yield* motion.forget(ws);
        yield* places.forget(ws);
        yield* mower.forgetPurse(ws, who ? purseOf(who) : "");
        yield* sockets.announceMowers();
      });

    return Service.of({
      open: (request) =>
        Effect.gen(function* () {
          if (request.headers.get("Upgrade") !== "websocket") {
            return new Response("expected websocket", { status: 426 });
          }
          // The address is a tag on the socket, not a note in memory: the Lawn
          // can then count the Mowers of one address with an index, and the
          // count stays right when the Lawn hibernates. Cloudflare writes this
          // header itself, so a client cannot claim another address.
          const address = request.headers.get("CF-Connecting-IP") ?? "";
          if (address && (yield* sockets.countAt(address)) >= MOWERS_PER_ADDRESS) {
            return new Response("too many mowers from here", { status: 429 });
          }

          const pair = new WebSocketPair();
          const [client, server] = [pair[0], pair[1]];

          // Hibernation: the Lawn sleeps between Mow Strokes and the sockets
          // survive. The id rides on the socket, so it survives hibernation
          // too. This one lasts until the Mower says which Key it holds, which
          // is the first thing it says.
          const id = mowerId();
          state.acceptWebSocket(server, address ? [address] : []);
          yield* sockets.attach(server, { id, key: "" });
          yield* sockets.send(server, yield* mower.hello(id));
          yield* sockets.send(server, yield* tiles.snapshot());
          yield* sockets.send(server, yield* ballgame.message());
          yield* sockets.send(server, yield* log.recent());
          yield* sockets.announceMowers();

          return new Response(null, { status: 101, webSocket: client });
        }),

      heard: (ws, raw) =>
        Effect.gen(function* () {
          if (typeof raw !== "string" || raw.length > MESSAGE_BYTES) return;
          const message = readClientMessage(raw);
          if (!message) return;

          // Which Key a Mower holds is the one thing it may say before the
          // Lawn knows who it is.
          if (message.t === "i") return yield* mower.claim(ws, message.k);

          // Every socket is given who it is when it opens, so this only ever
          // stands in for a socket the Lawn has somehow lost track of.
          const who = (yield* sockets.whoIs(ws)) ?? NOBODY;

          if (message.t === "pos") {
            // Presence is ephemeral: relay it and keep nothing on disk. A
            // Mower that goes quiet simply fades from the other screens.
            if (!(yield* budgets.spendPos(ws))) return;
            // A Mower shows itself where it mows. The report is pulled back to
            // within reach of the last Mow Stroke, so a Mower that drives
            // faster than a Mower can drive is seen at the speed of a Mower.
            // The score is what the Lawn counted, not what the report says.
            const seen = yield* places.within(ws, purseOf(who), message.x, message.y);
            return yield* mower.report(ws, who, seen, message.a);
          }

          if (message.t === "emote") {
            // An Emote is presence, like a position: relay it and store
            // nothing. It therefore fades from the other screens on its own,
            // and it costs the hibernating Lawn nothing.
            if (!(yield* budgets.spendEmote(ws))) return;
            return yield* sockets.broadcast(
              JSON.stringify({ t: "emoted", id: who.id, e: message.e }), ws,
            );
          }

          if (message.t === "bump") {
            // A daze is presence too: it lasts one second, so it is gone long
            // before a Lawn that hibernates wakes up. Relay it and store
            // nothing.
            if (!(yield* budgets.spendBump(ws))) return;
            yield* sockets.broadcast(JSON.stringify({ t: "bumped", id: who.id }), ws);
            // The daze is still relayed on the Mower's word, because a Mower
            // only ever dazes itself and a liar wearing its own Stars costs
            // nobody anything. The tally is not: an Achievement is the one
            // thing here worth forging, so the Lawn counts a Bump only when it
            // saw one.
            if (!who.key || !(yield* motion.sawBump(ws))) return;
            const score = yield* scores.of(who.key);
            if (!score) return;
            score.b = (score.b ?? 0) + 1;
            yield* scores.award(ws, score);
            return yield* alarm.needsWriting();
          }

          return yield* mow(ws, who, message);
        }),

      closed: (ws) =>
        Effect.gen(function* () {
          yield* motion.forget(ws);
          const who = yield* sockets.whoIs(ws);
          // The name rides on the goodbye, because the log names who left and
          // a Mower the others never heard report has no name on their
          // screens. `left` is presence and not news: the others use it to
          // forget where that Mower stood, and it fires for a reload exactly as
          // it does for a goodbye. Whether anything is said about it is the
          // log's to decide.
          if (who?.id) yield* sockets.broadcast(JSON.stringify({ t: "left", id: who.id }), ws);
          if (who?.key && who.name && !(yield* sockets.keyIsHere(who.key, ws))) {
            yield* log.departing(who.key, who.name);
          }
          yield* log.sweep();
          yield* depart(ws, who);
        }),

      failed: (ws) =>
        Effect.gen(function* () {
          yield* depart(ws, yield* sockets.whoIs(ws));
        }),

      woke: () =>
        Effect.gen(function* () {
          // A Mower that left while nobody else was coming or going is decided
          // here. Without this the last one out of the Lawn is never said to
          // have left.
          yield* log.sweep();
          if (!(yield* alarm.settle())) return;
          yield* scores.prune();
          yield* store.save({
            mownAt: yield* tiles.ground(),
            strokes: yield* strokes.made(),
            scores: yield* scores.all(),
          });
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

export * as Session from "./session";
