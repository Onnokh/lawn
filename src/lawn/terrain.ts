import { Context, Layer } from "effect";
import { blocked } from "../ground/map";

/**
 * What stops a Mower: Water, and the trunk of a tree.
 *
 * The Lawn asks this of every step of every swath, so the answer is a plain
 * function and not an Effect — a Mow Stroke reads it some forty times. It is a
 * service all the same, because it is the one thing about the ground a check
 * wants to take away: a test of how fast a Mower may drive is not a test of
 * where the water is, and it should not have to steer round it.
 */
export interface Interface {
  readonly blocked: (x: number, y: number) => boolean;
}

export class Service extends Context.Service<Service, Interface>()("lawn/Terrain") {}

export const layer = Layer.succeed(Service, { blocked });

/** Ground a Mower can drive anywhere on. For checks that are not about the map. */
export const openLayer = Layer.succeed(Service, { blocked: () => false });

export * as Terrain from "./terrain";
