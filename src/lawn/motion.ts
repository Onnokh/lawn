import { Context, Effect, Layer } from "effect";
import { serviceUse } from "../support/service";
import { MAX_SPEED } from "../driving";
import type { BallMower } from "../ball";
import { BUMP_CLOSING, BUMP_REACH, BUMP_STALE_MS } from "./limits";
import type { MowerId, Spot } from "./schema";

/** A Mower as the Lawn last saw it move, and when. */
export interface Mover extends BallMower {
  readonly at: number;
}

/**
 * How every Mower is moving, worked out by the Lawn from the reports it gets.
 *
 * A Mower says where it is; it never says how fast. The Lawn takes the speed
 * from the gap between two reports, which is what lets it referee a Bump and
 * push the Ball without believing a single number a client sent.
 */
export interface Interface {
  /** Note where a Mower now is, and answer with how it is moving. */
  readonly track: (ws: WebSocket, id: MowerId, at: Spot) => Effect.Effect<Mover>;
  /** How the Lawn last saw this Mower move. */
  readonly of: (ws: WebSocket) => Effect.Effect<Mover | undefined>;
  /** Every Mower the Lawn has lately seen move. */
  readonly moving: () => Effect.Effect<Map<WebSocket, Mover>>;
  /** Forget a Mower. Its socket has gone. */
  readonly forget: (ws: WebSocket) => Effect.Effect<void>;
  /**
   * Forget every Mower the Lawn has not heard from lately. A report older than
   * this says nothing about how a Mower is moving now, and a Mower that is not
   * moving cannot push the Ball or be in a Bump.
   */
  readonly prune: (maxAge: number) => Effect.Effect<void>;
  /**
   * Whether the Lawn itself saw the Bump a Mower says it was in.
   *
   * A Mower speaks only for itself about a daze, and that is right: it cannot
   * daze anybody else with it. But a tally is worth forging, and two tabs
   * parked against each other could trade Bumps all afternoon. So the Lawn asks
   * its own question — is another Mower near, and were the two of them really
   * closing? A Mower alone in a corner, and two that stand still together, both
   * answer no.
   *
   * The Closing Speed is the speed along the line between the two, so it is the
   * same number whichever of them asks: the Mower that drove in and the Mower
   * that was standing are both in the Bump, and both are counted.
   */
  readonly sawBump: (ws: WebSocket) => Effect.Effect<boolean>;
}

export class Service extends Context.Service<Service, Interface>()("lawn/Motion") {}

export const use = serviceUse(Service);

export const layer = Layer.sync(Service, () => {
  const movers = new Map<WebSocket, Mover>();

  return Service.of({
    track: (ws, id, at) =>
      Effect.sync(() => {
        const now = Date.now();
        const previous = movers.get(ws);
        const dt = previous ? (now - previous.at) / 1000 : 0;
        const vx = previous && dt > 0 && dt < 1 ? (at.x - previous.x) / dt : 0;
        const vy = previous && dt > 0 && dt < 1 ? (at.y - previous.y) / dt : 0;
        const speed = Math.hypot(vx, vy);
        // A Mower cannot move faster than a Mower, whatever two reports say.
        const scale = speed > MAX_SPEED ? MAX_SPEED / speed : 1;
        const mover: Mover = { id, x: at.x, y: at.y, vx: vx * scale, vy: vy * scale, at: now };
        movers.set(ws, mover);
        return mover;
      }),

    of: (ws) => Effect.sync(() => movers.get(ws)),
    moving: () => Effect.succeed(movers),
    forget: (ws) => Effect.sync(() => void movers.delete(ws)),

    prune: (maxAge) =>
      Effect.sync(() => {
        const now = Date.now();
        for (const [ws, mover] of movers) {
          if (now - mover.at > maxAge) movers.delete(ws);
        }
      }),

    sawBump: (ws) =>
      Effect.sync(() => {
        const me = movers.get(ws);
        const now = Date.now();
        if (!me || now - me.at > BUMP_STALE_MS) return false;
        for (const [other, them] of movers) {
          if (other === ws || now - them.at > BUMP_STALE_MS) continue;
          const dx = them.x - me.x;
          const dy = them.y - me.y;
          const gap = Math.hypot(dx, dy);
          if (gap === 0 || gap > BUMP_REACH) continue;
          if (((me.vx - them.vx) * dx + (me.vy - them.vy) * dy) / gap >= BUMP_CLOSING) return true;
        }
        return false;
      }),
  });
});

/**
 * There is no `defaultLayer` here, and there is none on any service of the
 * Lawn. A `defaultLayer` is the layer with its dependencies already wired, and
 * every service here holds the state of one Lawn: wiring them service by
 * service would give the one that asked its own Sockets, its own board and its
 * own budgets, and two halves of the Lawn would stop agreeing about who is on
 * it. The graph is built once, in `runtime.ts`, and that is the only place it
 * may be built.
 */

export * as Motion from "./motion";
