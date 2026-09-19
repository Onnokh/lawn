import { Effect, ManagedRuntime } from "effect";
import { OPEN } from "./sockets";
import { Terrain } from "./terrain";
import { layer } from "./runtime";
import { Session } from "./session";
import type { Attachment } from "./schema";

/**
 * A Lawn a check can drive on.
 *
 * It is the real Session over the real services; only the two things a check
 * cannot have are stood in for. The Durable Object becomes a Map and a list of
 * sockets, and the ground can be made flat, because a check of how fast a Mower
 * may drive is not a check of where the water is.
 *
 * Nothing imports this but the checks, so none of it is deployed.
 */

/** A socket that remembers what it was told. */
export interface Heard {
  readyState: number;
  tags: string[];
  /** Everything the Lawn said to this socket, in order, strings only. */
  readonly said: unknown[];
  /** Everything the Lawn sent it that was not a string: a Snapshot. */
  readonly sent: ArrayBuffer[];
  serializeAttachment: (value: unknown) => void;
  deserializeAttachment: () => unknown;
  send: (raw: string | ArrayBuffer) => void;
}

export interface Harness {
  /** Put a socket on the Lawn, as `Session.open` would. */
  readonly join: (who: Partial<Attachment>) => Heard;
  /** Say one thing, as that socket. */
  readonly say: (ws: Heard, message: unknown) => void;
  /** Close one socket. */
  readonly leave: (ws: Heard) => void;
  /** Serve the alarm the Lawn set for itself. */
  readonly wake: () => Promise<void>;
  /** What is on the Lawn's disk. */
  readonly disk: Map<string, unknown>;
}

let ids = 0;

/**
 * It is awaited for the reason the Durable Object holds its constructor open:
 * the Tiles, the board and the Ball are read off the disk while the layers are
 * built, and nothing may be said to the Lawn until they are. A check that ran
 * before that would be told the Lawn is asleep.
 */
export const harness = async (options: { readonly flat?: boolean } = {}): Promise<Harness> => {
  const sockets: Heard[] = [];
  const disk = new Map<string, unknown>();

  const storage = {
    get: async (key: string | string[]) =>
      Array.isArray(key)
        ? new Map(key.filter((k) => disk.has(k)).map((k) => [k, disk.get(k)]))
        : disk.get(key),
    put: async (a: string | Record<string, unknown>, b?: unknown) => {
      if (typeof a === "string") disk.set(a, b);
      else for (const [k, v] of Object.entries(a)) disk.set(k, v);
    },
    setAlarm: async () => {},
    deleteAlarm: async () => {},
  };

  const state = {
    storage,
    getWebSockets: (tag?: string) =>
      tag === undefined ? sockets : sockets.filter((ws) => ws.tags.includes(tag)),
    acceptWebSocket: (ws: Heard, tags: string[] = []) => {
      ws.tags = tags;
      sockets.push(ws);
    },
    waitUntil: () => {},
    blockConcurrencyWhile: <A>(run: () => Promise<A>) => run(),
  } as unknown as DurableObjectState;

  const runtime = ManagedRuntime.make(
    layer(state, options.flat ? Terrain.openLayer : Terrain.layer),
  );

  await runtime.context();

  const join: Harness["join"] = (who) => {
    const said: unknown[] = [];
    const sent: ArrayBuffer[] = [];
    let attachment: unknown = null;
    const ws: Heard = {
      readyState: OPEN,
      tags: [],
      said,
      sent,
      serializeAttachment: (value) => void (attachment = value),
      deserializeAttachment: () => attachment,
      send: (raw) => {
        if (typeof raw === "string") said.push(JSON.parse(raw));
        else sent.push(raw);
      },
    };
    ws.tags = [];
    sockets.push(ws);
    ws.serializeAttachment({ id: who.id ?? `m${++ids}`, key: who.key ?? "", name: who.name });
    return ws;
  };

  return {
    join,
    say: (ws, message) =>
      runtime.runSync(Session.use.heard(ws as unknown as WebSocket, JSON.stringify(message))),
    leave: (ws) => {
      ws.readyState = 3;
      runtime.runSync(Session.use.closed(ws as unknown as WebSocket));
      const at = sockets.indexOf(ws);
      if (at >= 0) sockets.splice(at, 1);
    },
    wake: () => runtime.runPromise(Session.use.woke().pipe(Effect.orDie)),
    disk,
  };
};

export * as Testing from "./testing";
