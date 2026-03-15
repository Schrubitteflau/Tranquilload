import { Context, Effect, Layer } from "effect"

export class CompressionUnavailableError extends Error {
  readonly _tag = "CompressionUnavailableError" as const
  constructor() {
    super("globalThis.CompressionStream is not available in this environment")
    this.name = "CompressionUnavailableError"
  }
}

export class CompressionService extends Context.Tag("@tranquilload/CompressionService")<
  CompressionService,
  { readonly compress: (stream: ReadableStream<Uint8Array>, algorithm: string) => ReadableStream<Uint8Array> }
>() {}

export const CompressionServiceLive: Layer.Layer<CompressionService, CompressionUnavailableError> =
  Layer.effect(
    CompressionService,
    Effect.gen(function* () {
      const cs = (globalThis as { CompressionStream?: unknown }).CompressionStream
      if (typeof cs === "undefined") {
        return yield* Effect.fail(new CompressionUnavailableError())
      }
      return {
        compress: (stream, algorithm) =>
          stream.pipeThrough(
            new CompressionStream(algorithm as CompressionFormat) as unknown as TransformStream<Uint8Array, Uint8Array>
          ),
      }
    })
  )
