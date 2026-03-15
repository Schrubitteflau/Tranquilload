import { Effect } from "effect"

export type Transform = (stream: ReadableStream<Uint8Array>) => ReadableStream<Uint8Array>

export function compose(): Transform
export function compose(...transforms: Transform[]): Transform
export function compose<E, R>(
  ...transforms: Array<Transform | Effect.Effect<Transform, E, R>>
): Effect.Effect<Transform, E, R>
export function compose(
  ...transforms: Array<Transform | Effect.Effect<Transform, any, any>>
): Transform | Effect.Effect<Transform, any, any> {
  const hasEffect = transforms.some((t) => typeof t !== "function")
  if (!hasEffect || transforms.length === 0) {
    return (stream: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> =>
      (transforms as Transform[]).reduce((s, t) => t(s), stream)
  }
  return Effect.map(
    Effect.all(
      transforms.map((t) =>
        typeof t === "function"
          ? Effect.succeed(t as Transform)
          : (t as Effect.Effect<Transform, any, any>)
      )
    ),
    (resolved) =>
      (stream: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> =>
        resolved.reduce((s, t) => t(s), stream)
  )
}
