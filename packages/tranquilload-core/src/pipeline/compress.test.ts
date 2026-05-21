import { it, describe, expect } from "@effect/vitest"
import { Cause, Effect, Layer } from "effect"
import { compress } from "./compress.js"
import {
  CompressionService,
  CompressionServiceLive,
  CompressionUnavailableError,
} from "../services/compression-service.js"

describe("compress", () => {
  it.effect("uses custom CompressionService when provided", () =>
    Effect.gen(function* () {
      const marker = new ReadableStream<Uint8Array>()
      let receivedAlgorithm = ""
      const TestLayer = Layer.succeed(CompressionService, {
        compress: (stream, algorithm) => {
          receivedAlgorithm = algorithm
          return marker
        },
      })
      const transform = yield* Effect.provide(compress("deflate-raw"), TestLayer)
      const input = new ReadableStream<Uint8Array>()
      const result = transform(input)
      expect(result).toBe(marker)
      expect(receivedAlgorithm).toBe("deflate-raw")
    })
  )

  it.effect("F#16 — CompressionServiceLive produces compressed bytes (deflate-raw) (compression actually compresses)", () =>
    Effect.gen(function* () {
      const transform = yield* Effect.provide(compress("deflate-raw"), CompressionServiceLive)
      const input = new ReadableStream<Uint8Array>({
        start(ctrl) {
          ctrl.enqueue(new Uint8Array([1, 2, 3, 4]))
          ctrl.close()
        },
      })
      const compressed = transform(input)
      const reader = compressed.getReader()
      const chunks: Uint8Array[] = []
      while (true) {
        const { done, value } = yield* Effect.promise(() => reader.read())
        if (done) break
        chunks.push(value)
      }
      const totalBytes = chunks.reduce((acc, c) => acc + c.length, 0)
      expect(totalBytes).toBeGreaterThan(0)
    })
  )

  it.effect("F#20, F#73 — fails with typed CompressionUnavailableError when CompressionStream is absent (no unhandled throw)", () =>
    Effect.gen(function* () {
      const AbsentLayer: Layer.Layer<CompressionService, CompressionUnavailableError> =
        Layer.effect(CompressionService, Effect.fail(new CompressionUnavailableError()))
      const result = yield* Effect.exit(
        Effect.provide(compress("deflate-raw"), AbsentLayer)
      )
      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") {
        const failure = Cause.failureOption(result.cause)
        expect(failure._tag).toBe("Some")
        if (failure._tag === "Some") {
          expect(failure.value).toBeInstanceOf(CompressionUnavailableError)
          expect(failure.value._tag).toBe("CompressionUnavailableError")
        }
      }
    })
  )
})
