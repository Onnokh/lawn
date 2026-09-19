import { Context, Effect } from "effect";

/**
 * Call one method of a service without pulling the whole service first.
 *
 * `yield* Sockets.Service` then `sockets.broadcast(m)` is two steps where the
 * caller wanted one. `yield* Sockets.use.broadcast(m)` is the same thing said
 * once. Layers still pull the whole service — they hold it for the life of the
 * layer — and consumers use this.
 */
export type ServiceUse<Identifier, Shape> = {
  [K in keyof Shape]: Shape[K] extends (...args: infer A) => Effect.Effect<infer Out, infer Err, infer Req>
    ? (...args: A) => Effect.Effect<Out, Err, Req | Identifier>
    : never;
};

export const serviceUse = <Identifier, Shape extends object>(
  tag: Context.Service<Identifier, Shape>,
): ServiceUse<Identifier, Shape> => {
  const cache = new Map<string, (...args: never[]) => Effect.Effect<unknown, unknown, unknown>>();
  return new Proxy({} as ServiceUse<Identifier, Shape>, {
    get: (_, key: string) => {
      const cached = cache.get(key);
      if (cached) return cached;
      const accessor = (...args: never[]) =>
        tag.use((service) => {
          const method = service[key as keyof Shape];
          if (typeof method !== "function") {
            return Effect.die(new Error(`Service method not found: ${key}`));
          }
          return (method as (...a: never[]) => Effect.Effect<unknown, unknown, unknown>)(...args);
        });
      cache.set(key, accessor);
      return accessor;
    },
  });
};

export * as Service from "./service";
