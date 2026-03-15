import { Effect } from "effect"

export const normalizeCallback = <A, E = never>(
  fn: () => A | Promise<A> | Effect.Effect<A, E>
): Effect.Effect<A, E | unknown> =>
  Effect.suspend((): Effect.Effect<A, E | unknown> => {
    let result: A | Promise<A> | Effect.Effect<A, E>
    try {
      result = fn()
    } catch (e) {
      return Effect.fail(e)
    }
    if (Effect.isEffect(result)) return result
    if (result instanceof Promise) {
      return Effect.tryPromise({ try: () => result as Promise<A>, catch: (e) => e })
    }
    return Effect.succeed(result)
  })
