import { DurableObject } from "cloudflare:workers";
import { Session } from "./session";
import { make, type LawnRuntime } from "./runtime";

/**
 * One shared field of Tiles, and everybody on it.
 *
 * This class is the platform's side of the Lawn and nothing else: it holds the
 * runtime the services live in, and it hands each thing the Durable Object
 * tells it straight to the Session. Nothing here decides anything.
 *
 * Every socket message is run synchronously. The Durable Object gives them to
 * this object one at a time, in order, and a Mow Stroke is only correct in the
 * order it was sent: the swath runs from where the Lawn last saw that Mower,
 * so two strokes that overtook each other would cut ground nobody drove over.
 * Running them synchronously is what keeps that order, and every step of
 * handling one is synchronous, so nothing is given up by asking for it.
 */
export class Lawn extends DurableObject {
  readonly #runtime: LawnRuntime;

  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx as never, env as never);
    this.#runtime = make(ctx);
    // Build every service before the first message can arrive. The Tiles, the
    // board and the Ball are all read off the disk while this is held, so a
    // Mow Stroke never lands on a Lawn that is still loading.
    ctx.blockConcurrencyWhile(() => this.#runtime.context().then(() => undefined));
  }

  fetch(request: Request): Promise<Response> {
    return this.#runtime.runPromise(Session.use.open(request));
  }

  webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): void {
    this.#runtime.runSync(Session.use.heard(ws, raw));
  }

  webSocketClose(ws: WebSocket): void {
    this.#runtime.runSync(Session.use.closed(ws));
  }

  webSocketError(ws: WebSocket): void {
    this.#runtime.runSync(Session.use.failed(ws));
  }

  alarm(): Promise<void> {
    return this.#runtime.runPromise(Session.use.woke());
  }
}

export * as TheLawn from "./lawn";
