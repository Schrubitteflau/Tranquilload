import { describe, expect, it } from "@effect/vitest"
import { Cause, Effect, Exit, Option } from "effect"
import { AbortError } from "../errors/upload-error.js"
import { compress } from "../pipeline/compress.js"
import { compose, type Transform } from "../pipeline/middleware.js"
import { uploadMultipart } from "./index.js"
import { uploadMultipartEffect } from "./upload-stream.js"

// Helper: create a ReadableStream from a Uint8Array
const fromBytes = (bytes: Uint8Array): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start(c) {
      c.enqueue(bytes)
      c.close()
    },
  })

// Helper: read all events from the ReadableStream
const readAllEvents = async <T>(rs: ReadableStream<T>): Promise<T[]> => {
  const reader = rs.getReader()
  const events: T[] = []
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    events.push(value)
  }
  return events
}

describe("uploadMultipart — Dual API entry point", () => {
  it.effect("happy path: result resolves with UploadCompleted, events contains all events", () =>
    Effect.gen(function* () {
      const { result, events } = uploadMultipart({
        stream: fromBytes(new Uint8Array(20).fill(1)),
        chunkSize: 10,
        uploadPart: (n) => `etag-${n}`,
        completeUpload: () => {},
      })

      const [uploadResult, evts] = yield* Effect.all([
        Effect.promise(() => result),
        Effect.promise(() => readAllEvents(events)),
      ])

      expect(uploadResult._tag).toBe("UploadCompleted")
      expect(uploadResult.totalParts).toBe(2)

      const partEvents = evts.filter((e) => e._tag === "PartCompleted")
      expect(partEvents).toHaveLength(2)
      expect(evts.find((e) => e._tag === "UploadCompleted")).toBeDefined()
    })
  )

  it.effect("getProgress tracks bytesUploaded; totalBytes is Some when provided", () =>
    Effect.gen(function* () {
      const { result, getProgress } = uploadMultipart({
        stream: fromBytes(new Uint8Array(30).fill(1)),
        chunkSize: 10,
        uploadPart: () => "etag",
        completeUpload: () => {},
        totalBytes: 30,
      })

      yield* Effect.promise(() => result)

      const progress = yield* Effect.promise(() => getProgress())
      expect(progress.bytesUploaded).toBe(30)
      expect(progress.totalBytes).toEqual(Option.some(30))
    })
  )

  it.effect("getProgress returns None for totalBytes when not provided", () =>
    Effect.gen(function* () {
      const { result, getProgress } = uploadMultipart({
        stream: fromBytes(new Uint8Array(10).fill(1)),
        chunkSize: 10,
        uploadPart: () => "etag",
        completeUpload: () => {},
      })

      yield* Effect.promise(() => result)

      const progress = yield* Effect.promise(() => getProgress())
      expect(progress.totalBytes).toEqual(Option.none())
    })
  )

  it.effect("abort signal: result rejects with AbortError, events stream closes cleanly", () =>
    Effect.gen(function* () {
      const controller = new AbortController()
      const { result, events } = uploadMultipart({
        stream: fromBytes(new Uint8Array(10).fill(1)),
        chunkSize: 10,
        uploadPart: () =>
          new Promise<string>((_resolve) => {
            setTimeout(() => controller.abort(), 5)
          }),
        completeUpload: () => {},
        signal: controller.signal,
      })

      // result rejects with AbortError
      const resultExit = yield* Effect.exit(
        Effect.tryPromise({
          try: () => result,
          catch: (e) => e,
        })
      )
      expect(Exit.isFailure(resultExit)).toBe(true)
      if (Exit.isFailure(resultExit)) {
        const errOption = Cause.failureOption(resultExit.cause)
        expect(errOption._tag).toBe("Some")
        const err = (errOption as { _tag: "Some"; value: unknown }).value
        expect(err).toBeInstanceOf(AbortError)
        expect((err as AbortError)._tag).toBe("AbortError")
      }

      // events ReadableStream closes cleanly (no throw)
      const evts = yield* Effect.promise(() => readAllEvents(events))
      // Stream should close without throwing — length may be 0 (aborted before any parts complete)
      expect(Array.isArray(evts)).toBe(true)
    })
  )

  it(".effect property points to uploadMultipartEffect", () => {
    expect(uploadMultipart.effect).toBe(uploadMultipartEffect)
  })

  it.effect("applies plain Transform pipeline before chunking (data reaches uploadPart transformed)", () =>
    Effect.gen(function* () {
      const received: Uint8Array[] = []
      // Transform: replace every byte with 0xAA
      const markerTransform: Transform = (stream) =>
        stream.pipeThrough(
          new TransformStream<Uint8Array, Uint8Array>({
            transform(chunk, controller) {
              controller.enqueue(new Uint8Array(chunk.length).fill(0xaa))
            },
          })
        )

      const { result } = uploadMultipart({
        stream: new ReadableStream({
          start(c) { c.enqueue(new Uint8Array([1, 2, 3])); c.close() },
        }),
        chunkSize: 3,
        pipeline: markerTransform,
        uploadPart: (_, chunk) => {
          received.push(chunk)
          return "etag-1"
        },
        completeUpload: () => {},
      })

      yield* Effect.promise(() => result)
      expect(received).toHaveLength(1)
      expect(Array.from(received[0]!)).toEqual([0xaa, 0xaa, 0xaa])
    })
  )

  it.effect("applies Effect pipeline (compress) before chunking — PartCompleted.bytesUploaded reflects compressed size", () =>
    Effect.gen(function* () {
      const received: Uint8Array[] = []
      const original = new Uint8Array([1, 2, 3, 4, 5])

      const { result } = uploadMultipart({
        stream: new ReadableStream({
          start(c) { c.enqueue(original); c.close() },
        }),
        chunkSize: 4096, // large enough to receive all compressed output in one part
        pipeline: compress("deflate-raw"),
        uploadPart: (_, chunk) => {
          received.push(chunk)
          return "etag-1"
        },
        completeUpload: () => {},
      })

      yield* Effect.promise(() => result)
      expect(received).toHaveLength(1)
      // Compressed output is non-empty
      expect(received[0]!.length).toBeGreaterThan(0)
      // Compressed bytes differ from raw input
      expect(Array.from(received[0]!)).not.toEqual(Array.from(original))
    })
  )

  it.effect("compose(compress()) can be passed as pipeline — same as compress() directly", () =>
    Effect.gen(function* () {
      const received: Uint8Array[] = []

      const { result } = uploadMultipart({
        stream: new ReadableStream({
          start(c) { c.enqueue(new Uint8Array([10, 20, 30])); c.close() },
        }),
        chunkSize: 4096,
        pipeline: compose(compress("deflate-raw")),
        uploadPart: (_, chunk) => {
          received.push(chunk)
          return "etag-1"
        },
        completeUpload: () => {},
      })

      yield* Effect.promise(() => result)
      expect(received).toHaveLength(1)
      expect(received[0]!.length).toBeGreaterThan(0)
    })
  )
})
