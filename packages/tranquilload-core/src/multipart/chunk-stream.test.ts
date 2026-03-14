import { describe, expect, it } from "@effect/vitest"
import { Effect, Stream } from "effect"
import { chunkStream } from "./chunk-stream.js"

// Helper: create a ReadableStream from a Uint8Array (single chunk)
const fromBytes = (bytes: Uint8Array): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start(controller) {
      controller.enqueue(bytes)
      controller.close()
    },
  })

// Helper: run chunkStream and collect chunks as a plain Array
const collectChunks = (
  stream: ReadableStream<Uint8Array>,
  chunkSize: number
): Effect.Effect<Uint8Array[], unknown> =>
  Stream.runCollect(chunkStream(stream, chunkSize)).pipe(
    Effect.map((chunk) => Array.from(chunk))
  )

describe("chunkStream", () => {
  it.effect("splits into chunkSize chunks, last chunk smaller", () =>
    Effect.gen(function* () {
      // 10 bytes, chunkSize 3 → chunks: [3, 3, 3, 1]
      const data = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
      const chunks = yield* collectChunks(fromBytes(data), 3)

      expect(chunks).toHaveLength(4)
      expect(chunks[0]).toEqual(new Uint8Array([0, 1, 2]))
      expect(chunks[1]).toEqual(new Uint8Array([3, 4, 5]))
      expect(chunks[2]).toEqual(new Uint8Array([6, 7, 8]))
      expect(chunks[3]).toEqual(new Uint8Array([9]))
    })
  )

  it.effect("preserves all bytes across chunks", () =>
    Effect.gen(function* () {
      const data = new Uint8Array(100).map((_, i) => i % 256)
      const chunks = yield* collectChunks(fromBytes(data), 7)

      const totalLength = chunks.reduce((sum, c) => sum + c.length, 0)
      expect(totalLength).toBe(100)

      // Verify byte values are intact
      const reconstructed = new Uint8Array(100)
      let offset = 0
      for (const chunk of chunks) {
        reconstructed.set(chunk, offset)
        offset += chunk.length
      }
      expect(reconstructed).toEqual(data)
    })
  )

  it.effect("emits single chunk when stream is smaller than chunkSize", () =>
    Effect.gen(function* () {
      const data = new Uint8Array([10, 20, 30])
      const chunks = yield* collectChunks(fromBytes(data), 100)

      expect(chunks).toHaveLength(1)
      expect(chunks[0]).toEqual(new Uint8Array([10, 20, 30]))
    })
  )

  it.effect("emits no trailing empty chunk on exact multiple", () =>
    Effect.gen(function* () {
      const data = new Uint8Array(9).fill(5) // 9 = 3 * 3
      const chunks = yield* collectChunks(fromBytes(data), 3)

      expect(chunks).toHaveLength(3)
      for (const chunk of chunks) {
        expect(chunk).toHaveLength(3)
        expect(chunk).toEqual(new Uint8Array([5, 5, 5]))
      }
    })
  )
})
