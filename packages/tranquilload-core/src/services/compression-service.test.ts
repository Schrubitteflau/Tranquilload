import { it, describe, expect } from "@effect/vitest"
import { Cause, Effect, Layer } from "effect"
import {
  CompressionService,
  CompressionServiceLive,
  CompressionUnavailableError,
} from "./compression-service.js"

describe("CompressionService", () => {
  it.effect("CompressionServiceLive fails with typed CompressionUnavailableError when CompressionStream is absent", () =>
    Effect.gen(function* () {
      const AbsentLayer: Layer.Layer<CompressionService, CompressionUnavailableError> =
        Layer.effect(CompressionService, Effect.fail(new CompressionUnavailableError()))

      const result = yield* Effect.exit(
        Effect.provide(
          Effect.flatMap(CompressionService, (s) => Effect.succeed(s)),
          AbsentLayer
        )
      )

      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") {
        const failure = Cause.failureOption(result.cause)
        expect(failure._tag).toBe("Some")
        if (failure._tag === "Some") {
          expect(failure.value).toBeInstanceOf(CompressionUnavailableError)
          expect(failure.value._tag).toBe("CompressionUnavailableError")
          expect(failure.value.message).toBe("globalThis.CompressionStream is not available in this environment")
        }
      }
    })
  )

  it.effect("CompressionUnavailableError has correct _tag and message", () =>
    Effect.gen(function* () {
      const err = new CompressionUnavailableError()
      expect(err._tag).toBe("CompressionUnavailableError")
      expect(err.name).toBe("CompressionUnavailableError")
      expect(err.message).toBe("globalThis.CompressionStream is not available in this environment")
    })
  )

  it.effect("custom CompressionService Layer is used when provided", () =>
    Effect.gen(function* () {
      const mockStream = new ReadableStream<Uint8Array>()
      let calledWith: ReadableStream<Uint8Array> | null = null

      const TestLayer: Layer.Layer<CompressionService> = Layer.succeed(CompressionService, {
        compress: (stream: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> => {
          calledWith = stream
          return mockStream
        },
      })

      const inputStream = new ReadableStream<Uint8Array>()
      const result = yield* Effect.provide(
        Effect.flatMap(CompressionService, (svc) =>
          Effect.sync(() => svc.compress(inputStream))
        ),
        TestLayer
      )

      expect(result).toBe(mockStream)
      expect(calledWith).toBe(inputStream)
    })
  )
})
