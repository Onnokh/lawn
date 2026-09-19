import { Context, Effect, Layer } from "effect";
import { serviceUse } from "../support/service";
import { BALL_RADIUS, BALL_STEP, ballMoving, createBall, hitBall, stepBall, type Ball, type BallContact } from "../ball";
import { COLLISION_RADIUS } from "../mowing";
import { LAWN_WIDTH, LAWN_HEIGHT } from "../ground/dimensions";
import { placeAt } from "../ground/map";
import { Motion } from "./motion";
import { Sockets } from "./sockets";
import { Store } from "./store";

/**
 * The Ball: the one thing on the Lawn that moves when nobody is driving it.
 *
 * It only moves while it is worth moving. A Mower that comes at it fast enough
 * starts the clock; the clock stops itself the moment the Ball comes to rest,
 * so a Lawn nobody is playing on pays nothing for the Ball being there.
 */

/** How often the Ball is stepped while it is moving. */
const TICK_MS = 1000 / 30;
/** How many steps one tick may make up for after a stall. */
const MAX_STEPS = 12;
/** How far behind the clock may fall before the Ball gives up catching it. */
const TICK_DRIFT_MS = 200;
/** Shortest gap between two Ball messages while it is still moving. */
const BALL_GAP_MS = 50;
/** Shortest gap between two writes of where the Ball is. */
const BALL_SAVE_MS = 2000;
/** How stale a Mower's movement may be and still push the Ball. */
const PUSH_STALE_MS = 180;
/** How stale a Mower may be before the Ball stops counting it at all. */
const MOVER_STALE_MS = 1000;
/** Slower than this and a Mower rolls up to the Ball rather than striking it. */
const STIR_SPEED = 0.3;

export interface Interface {
  /** Where the Ball is, in the shape the clients read. */
  readonly message: () => Effect.Effect<string>;
  /**
   * A Mower has moved. Start the Ball if that Mower has just struck it, and do
   * nothing at all if it has not — which is almost always.
   */
  readonly stir: (ws: WebSocket) => Effect.Effect<void>;
}

export class Service extends Context.Service<Service, Interface>()("lawn/BallGame") {}

export const use = serviceUse(Service);

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const store = yield* Store.Service;
    const sockets = yield* Sockets.Service;
    const motion = yield* Motion.Service;
    // The clock of the Ball belongs to the layer, not to the Mow Stroke that
    // started it: a Mower may leave in the middle of a roll and the Ball still
    // has to come to rest.
    const scope = yield* Effect.scope;

    const saved = yield* store.loadBall();
    const ball: Ball = saved ?? createBall(LAWN_WIDTH / 2 + 7, LAWN_HEIGHT / 2);

    let contact: BallContact | undefined;
    let rolling = false;
    let tickAt = 0;
    let sentAt = 0;
    let savedAt = 0;

    const message = () => Effect.sync(() => JSON.stringify({ t: "ball", ...ball, n: Date.now() }));

    const wetAt = (x: number, y: number) => placeAt(x, y, LAWN_WIDTH, LAWN_HEIGHT).wet;

    /** One turn of the clock. It answers whether the Ball is still moving. */
    const tick = Effect.gen(function* () {
      const now = Date.now();
      yield* motion.prune(MOVER_STALE_MS);
      const movers = yield* motion.moving();
      const steps = Math.min(MAX_STEPS, Math.floor((now - tickAt) / (BALL_STEP * 1000)));
      for (let i = 0; i < steps; i++) {
        tickAt += BALL_STEP * 1000;
        for (const mover of movers.values()) {
          // A Mower whose last report is old is standing, not driving: it can
          // still be in the way of the Ball, but it cannot strike it.
          const pushing = now - mover.at < PUSH_STALE_MS;
          const hit = hitBall(
            ball,
            { ...mover, vx: pushing ? mover.vx : 0, vy: pushing ? mover.vy : 0 },
            tickAt,
            contact,
          );
          if (hit) contact = hit;
        }
        stepBall(ball, BALL_STEP, LAWN_WIDTH, LAWN_HEIGHT, wetAt);
      }
      if (now - tickAt > TICK_DRIFT_MS) tickAt = now;

      const moving = ballMoving(ball);
      if (!moving || now - sentAt >= BALL_GAP_MS) {
        yield* sockets.broadcast(JSON.stringify({ t: "ball", ...ball, n: now }));
        sentAt = now;
      }
      // Only a Ball at rest on dry ground is worth writing down. One in the air
      // or over water would be read back somewhere it could never have stopped.
      if ((!moving || now - savedAt > BALL_SAVE_MS)
        && ball.z === BALL_RADIUS
        && wetAt(ball.x, ball.y) <= -BALL_RADIUS) {
        yield* store.saveBall(ball);
        savedAt = now;
      }
      return moving;
    });

    /**
     * The clock waits before it is read, and not after. A turn steps the Ball
     * by the time that has gone by since the last one, so a turn taken the
     * instant the clock started has no time in it: it would step nothing, find
     * the Ball standing still, and stop the clock on a Ball that was just
     * struck.
     */
    const roll = Effect.gen(function* () {
      do {
        yield* Effect.sleep(TICK_MS);
      } while (yield* tick);
      rolling = false;
    });

    return Service.of({
      message,
      stir: (ws) =>
        Effect.gen(function* () {
          if (rolling) return;
          const mover = yield* motion.of(ws);
          if (!mover) return;
          if (Math.hypot(mover.vx, mover.vy) <= STIR_SPEED) return;
          if (Math.hypot(mover.x - ball.x, mover.y - ball.y) >= BALL_RADIUS + COLLISION_RADIUS) return;
          rolling = true;
          tickAt = Date.now();
          yield* Effect.forkIn(roll, scope);
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

export * as BallGame from "./ballgame";
