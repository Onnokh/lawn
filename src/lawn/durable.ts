import { Context, Layer } from "effect";

/**
 * The Durable Object the Lawn lives in: its storage, its sockets and its
 * alarm.
 *
 * It is the one thing no layer can build for itself — the platform hands it to
 * the constructor — so it is supplied per instance and everything else is
 * built on top of it. Holding it as a service is what keeps every other layer
 * free of the platform: a service that wants storage asks for `Store`, and
 * `Store` is the only one that knows what a `DurableObjectState` is.
 */
export interface Interface {
  readonly state: DurableObjectState;
}

export class Service extends Context.Service<Service, Interface>()("lawn/Durable") {}

export const layer = (state: DurableObjectState): Layer.Layer<Service> =>
  Layer.succeed(Service, { state });

export * as Durable from "./durable";
