import { Layer, ManagedRuntime } from "effect";
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
import { Session } from "./session";
import { Sockets } from "./sockets";
import { Store } from "./store";
import { Strokes } from "./strokes";
import { Terrain } from "./terrain";
import { Tiles } from "./tiles";

/**
 * The whole Lawn, built in the order its parts depend on each other.
 *
 * It is written as tiers rather than as one merge so the graph can be read:
 * everything on a line may be built at the same moment, and everything below a
 * line is what the line above it is built on. A service that grows a new
 * dependency has to move down the page, which is the point — a graph that
 * cannot be drawn is a graph nobody is checking.
 *
 * One runtime per Durable Object, and no shared memo map between them. Every
 * service here holds the state of one Lawn — its Tiles, its board, its
 * budgets — so two Lawns sharing one instance of any of them would be two
 * Lawns wearing each other's grass.
 */
export const layer = (
  state: DurableObjectState,
  /** The ground a Mower may not drive on. A check may hand over a flat one. */
  terrain: Layer.Layer<Terrain.Service> = Terrain.layer,
) => {
  /** The platform, and the three things that need nothing but themselves. */
  const ground = Layer.mergeAll(Budgets.layer, Motion.layer, terrain).pipe(
    Layer.provideMerge(Durable.layer(state)),
  );

  /** Storage, sockets and the alarm: everything that touches the outside. */
  const edges = Layer.mergeAll(Sockets.layer, Store.layer, Alarm.layer).pipe(
    Layer.provideMerge(ground),
  );

  /** What the Lawn is made of, and what it remembers saying. */
  const body = Layer.mergeAll(
    Tiles.layer,
    Strokes.layer,
    Places.layer,
    Log.layer,
    BallGame.layer,
  ).pipe(Layer.provideMerge(edges));

  /** The board, which needs the log to announce an Achievement. */
  const board = Scores.layer.pipe(Layer.provideMerge(body));

  /** The two that speak for the Lawn: its quests, and its manner with a Mower. */
  const voice = Layer.mergeAll(Quests.layer, Mower.layer).pipe(Layer.provideMerge(board));

  return Session.layer.pipe(Layer.provideMerge(voice));
};

export type LawnRuntime = ManagedRuntime.ManagedRuntime<
  Layer.Success<ReturnType<typeof layer>>,
  Layer.Error<ReturnType<typeof layer>>
>;

export const make = (state: DurableObjectState): LawnRuntime =>
  ManagedRuntime.make(layer(state));

export * as LawnRuntime from "./runtime";
