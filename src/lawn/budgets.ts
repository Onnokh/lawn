import { Context, Effect, Layer } from "effect";
import { serviceUse } from "../support/service";
import {
  BUMP_RATE, EMOTE_RATE, POS_RATE, RESYNC_GAP_MS, SCORE_GAP_MS,
  STROKE_RATE, TRAVEL_BANK, TRAVEL_RATE,
} from "./limits";

/**
 * How much a Mower may do, and how often.
 *
 * Two different purses are kept here, and the difference is the point. What a
 * socket may *send* is held per socket, because that is a cost to the line.
 * What a Mower may *cut* is held per Mower Key, because that is a cost to the
 * Lawn: windows are free and hands are not, so ten tabs on one Key drive one
 * Mower's worth of travel between them and a Score cannot be farmed by opening
 * windows. Two honest tabs pay the same price; what they share is one pair of
 * hands.
 */
interface Budget {
  tokens: number;
  refilledAt: number;
}

export interface Interface {
  /** Whether this socket may send one more Mow Stroke. */
  readonly spendStroke: (ws: WebSocket) => Effect.Effect<boolean>;
  /** Whether this socket may send one more position report. */
  readonly spendPos: (ws: WebSocket) => Effect.Effect<boolean>;
  /** Whether this socket may send one more Emote. */
  readonly spendEmote: (ws: WebSocket) => Effect.Effect<boolean>;
  /** Whether this socket may report one more Bump. */
  readonly spendBump: (ws: WebSocket) => Effect.Effect<boolean>;
  /** Whether enough time has passed to send this Mower the Lawn again. */
  readonly mayResync: (ws: WebSocket) => Effect.Effect<boolean>;
  /** Whether enough time has passed to tell this Mower its tally again. */
  readonly mayScore: (ws: WebSocket) => Effect.Effect<boolean>;
  /** How far this purse may still drive, in Tiles. */
  readonly travelLeft: (purse: string) => Effect.Effect<number>;
  /** Take that much travel out of the purse. */
  readonly spendTravel: (purse: string, tiles: number) => Effect.Effect<void>;
  /**
   * Empty a purse. A fresh socket must earn its travel exactly like the Mower
   * before it: without this a Mower could reconnect for a full bank, cut a
   * long swath at once, drop the socket and come straight back for another.
   */
  readonly emptyTravel: (purse: string) => Effect.Effect<void>;
  /**
   * Drop a purse once the last Mower driving on it has gone. A purse held by a
   * Key outlives the socket that spent from it, so unlike the socket budgets
   * it is not swept away with the socket. It holds no more than a second of
   * driving, so forgetting it gives nothing away.
   */
  readonly forgetTravel: (purse: string) => Effect.Effect<void>;
}

export class Service extends Context.Service<Service, Interface>()("lawn/Budgets") {}

export const use = serviceUse(Service);

export const layer = Layer.sync(Service, () => {
  /**
   * Give a budget back the time that has gone by, and hand it over to spend.
   */
  const refill = <K>(
    budgets: { get(purse: K): Budget | undefined; set(purse: K, budget: Budget): unknown },
    purse: K,
    rate: number,
    capacity: number,
  ): Budget => {
    const now = Date.now();
    const budget = budgets.get(purse) ?? { tokens: capacity, refilledAt: now };
    budget.tokens = Math.min(capacity, budget.tokens + ((now - budget.refilledAt) / 1000) * rate);
    budget.refilledAt = now;
    budgets.set(purse, budget);
    return budget;
  };

  const perSocket = (rate: number) => {
    const budgets = new WeakMap<WebSocket, Budget>();
    return (ws: WebSocket) =>
      Effect.sync(() => {
        const budget = refill(budgets, ws, rate, rate);
        if (budget.tokens < 1) return false;
        budget.tokens -= 1;
        return true;
      });
  };

  /** Not a bucket but a gap: how long since the Lawn last did this for a Mower. */
  const noSoonerThan = (gap: number) => {
    const last = new WeakMap<WebSocket, number>();
    return (ws: WebSocket) =>
      Effect.sync(() => {
        const now = Date.now();
        if (now - (last.get(ws) ?? 0) < gap) return false;
        last.set(ws, now);
        return true;
      });
  };

  const travel = new Map<string, Budget>();

  return Service.of({
    spendStroke: perSocket(STROKE_RATE),
    spendPos: perSocket(POS_RATE),
    spendEmote: perSocket(EMOTE_RATE),
    spendBump: perSocket(BUMP_RATE),
    mayResync: noSoonerThan(RESYNC_GAP_MS),
    mayScore: noSoonerThan(SCORE_GAP_MS),
    travelLeft: (purse) =>
      Effect.sync(() => refill(travel, purse, TRAVEL_RATE, TRAVEL_BANK).tokens),
    spendTravel: (purse, tiles) =>
      Effect.sync(() => {
        const budget = travel.get(purse);
        if (budget) budget.tokens -= tiles;
      }),
    emptyTravel: (purse) =>
      Effect.sync(() => void travel.set(purse, { tokens: 0, refilledAt: Date.now() })),
    forgetTravel: (purse) => Effect.sync(() => void travel.delete(purse)),
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

export * as Budgets from "./budgets";
