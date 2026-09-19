import { Context, Effect, Layer } from "effect";
import { serviceUse } from "../support/service";
import { Durable } from "./durable";
import type { Attachment, MowerKey } from "./schema";

/**
 * Every Mower the Lawn can speak to, and everything it says to them.
 *
 * The list of sockets is not kept here: the Durable Object holds it, and it
 * survives hibernation, which is the whole reason a Lawn can sleep between Mow
 * Strokes. What this service owns is the manner of speaking — that a send to a
 * socket which is going away is not an error, and that what a socket carries
 * about its Mower is read and written in one place.
 */
export interface Interface {
  /** Every socket, open or not. The Durable Object's own list. */
  readonly all: () => Effect.Effect<WebSocket[]>;
  /** Only the sockets that can still hear anything. */
  readonly open: () => Effect.Effect<WebSocket[]>;
  /** How many Mowers one address has on the Lawn now. */
  readonly countAt: (address: string) => Effect.Effect<number>;
  /** What a socket carries about its Mower. */
  readonly whoIs: (ws: WebSocket) => Effect.Effect<Attachment | undefined>;
  /** Write who a socket is. It rides on the socket, so it survives hibernation. */
  readonly attach: (ws: WebSocket, who: Attachment) => Effect.Effect<void>;
  /** Say something to one Mower. A socket going away is not an error. */
  readonly send: (ws: WebSocket, message: string | ArrayBuffer) => Effect.Effect<void>;
  /** Say something to everyone, except one. */
  readonly broadcast: (message: string | ArrayBuffer, except?: WebSocket) => Effect.Effect<void>;
  /** Whether any open socket other than `going` holds this Mower Key. */
  readonly keyIsHere: (key: MowerKey, going?: WebSocket) => Effect.Effect<boolean>;
  /** Tell everyone how many Mowers are on the Lawn. */
  readonly announceMowers: () => Effect.Effect<void>;
}

/**
 * `WebSocket.READY_STATE_OPEN`. It is named here, and not read off the class,
 * so that a check can make a socket that is open without the Workers runtime
 * to ask. One is what the WebSocket standard says an open socket reads.
 */
export const OPEN = 1;

export class Service extends Context.Service<Service, Interface>()("lawn/Sockets") {}

export const use = serviceUse(Service);

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { state } = yield* Durable.Service;

    const isOpen = (ws: WebSocket) => ws.readyState === OPEN;
    const whoIs = (ws: WebSocket) => (ws.deserializeAttachment() as Attachment | null) ?? undefined;
    const speak = (ws: WebSocket, message: string | ArrayBuffer) => {
      try {
        ws.send(message);
      } catch {
        /* socket is going away; nothing said to it was worth keeping */
      }
    };

    return Service.of({
      all: () => Effect.sync(() => state.getWebSockets()),
      open: () => Effect.sync(() => state.getWebSockets().filter(isOpen)),
      countAt: (address) => Effect.sync(() => state.getWebSockets(address).filter(isOpen).length),
      whoIs: (ws) => Effect.sync(() => whoIs(ws)),
      attach: (ws, who) => Effect.sync(() => ws.serializeAttachment(who)),
      send: (ws, message) => Effect.sync(() => speak(ws, message)),
      broadcast: (message, except) =>
        Effect.sync(() => {
          for (const ws of state.getWebSockets()) {
            if (ws === except) continue;
            speak(ws, message);
          }
        }),
      keyIsHere: (key, going) =>
        Effect.sync(() => {
          for (const ws of state.getWebSockets()) {
            if (ws === going || !isOpen(ws)) continue;
            if (whoIs(ws)?.key === key) return true;
          }
          return false;
        }),
      announceMowers: () =>
        Effect.sync(() => {
          // `webSocketClose` fires before the socket leaves the list, so the
          // count is of the ones that can still hear it.
          const sockets = state.getWebSockets().filter(isOpen);
          const message = JSON.stringify({ t: "mowers", mowers: sockets.length });
          for (const ws of sockets) speak(ws, message);
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

export * as Sockets from "./sockets";
