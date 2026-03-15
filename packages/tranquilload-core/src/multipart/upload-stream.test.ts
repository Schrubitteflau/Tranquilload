import { describe, expect, it } from "@effect/vitest"
import { Effect, Ref, Schedule, Stream } from "effect"
import { AbortError, MaxRetriesExceededError, PartUploadError } from "../errors/upload-error.js"
import { LoggerServiceLive } from "../services/logger-service.js"
import { uploadMultipartEffect, type CompletedPart } from "./upload-stream.js"

const fromBytes = (bytes: Uint8Array): ReadableStream<Uint8Array> =>
  new ReadableStream({ start: c => { c.enqueue(bytes); c.close() } })

const run = (options: Parameters<typeof uploadMultipartEffect>[0]) =>
  Stream.runCollect(uploadMultipartEffect(options)).pipe(
    Effect.map(chunk => Array.from(chunk)),
    Effect.provide(LoggerServiceLive)
  )

describe("uploadMultipartEffect", () => {
  it.effect("emits PartCompleted per chunk and UploadCompleted at end", () =>
    Effect.gen(function* () {
      const etags = ["etag-1", "etag-2", "etag-3"]
      const receivedParts: CompletedPart[] = []

      const events = yield* run({
        stream: fromBytes(new Uint8Array(30).fill(1)),
        chunkSize: 10,
        uploadPart: (partNumber, chunk) => {
          expect(chunk.length).toBeLessThanOrEqual(10)
          return etags[partNumber - 1]!
        },
        completeUpload: (parts) => { receivedParts.push(...parts) },
      })

      const partEvents = events.filter(e => e._tag === "PartCompleted")
      const completeEvent = events.find(e => e._tag === "UploadCompleted")

      expect(partEvents).toHaveLength(3)
      expect(partEvents[0]).toMatchObject({ _tag: "PartCompleted", partNumber: 1, etag: "etag-1", bytesUploaded: 10 })
      expect(partEvents[1]).toMatchObject({ _tag: "PartCompleted", partNumber: 2, etag: "etag-2", bytesUploaded: 10 })
      expect(partEvents[2]).toMatchObject({ _tag: "PartCompleted", partNumber: 3, etag: "etag-3", bytesUploaded: 10 })
      expect(completeEvent).toMatchObject({ _tag: "UploadCompleted", totalParts: 3 })

      expect(receivedParts).toHaveLength(3)
      expect(receivedParts.map(p => p.partNumber).sort()).toEqual([1, 2, 3])
    })
  )

  it.effect("limits concurrent parts to maxConcurrency", () =>
    Effect.gen(function* () {
      const refConcurrent = yield* Ref.make(0)
      const refMaxObserved = yield* Ref.make(0)

      const uploadPart = (_partNumber: number, _chunk: Uint8Array): Effect.Effect<string, never> =>
        Effect.gen(function* () {
          yield* Ref.update(refConcurrent, n => n + 1)
          const current = yield* Ref.get(refConcurrent)
          yield* Ref.update(refMaxObserved, max => Math.max(max, current))
          yield* Effect.yieldNow()
          yield* Ref.update(refConcurrent, n => n - 1)
          return `etag-${_partNumber}`
        }) as Effect.Effect<string, never>

      yield* run({
        stream: fromBytes(new Uint8Array(60).fill(1)),
        chunkSize: 10,
        uploadPart,
        completeUpload: () => {},
        maxConcurrency: 3,
      })

      const maxObserved = yield* Ref.get(refMaxObserved)
      expect(maxObserved).toBeLessThanOrEqual(3)
      expect(maxObserved).toBeGreaterThanOrEqual(1)
    })
  )

  it.effect("retries on failure and emits PartCompleted on eventual success", () =>
    Effect.gen(function* () {
      const refAttempts = yield* Ref.make(0)

      const events = yield* run({
        stream: fromBytes(new Uint8Array(10).fill(1)),
        chunkSize: 10,
        uploadPart: (_partNumber, _chunk) => Effect.gen(function* () {
          const attempts = yield* Ref.updateAndGet(refAttempts, n => n + 1)
          if (attempts < 2) return yield* Effect.fail(new PartUploadError(1, attempts, new Error("transient")) as never)
          return "etag-ok"
        }) as Effect.Effect<string, PartUploadError>,
        completeUpload: () => {},
        retrySchedule: Schedule.recurs(2),
      })

      const partEvent = events.find(e => e._tag === "PartCompleted")
      expect(partEvent).toMatchObject({ _tag: "PartCompleted", etag: "etag-ok" })
      expect(yield* Ref.get(refAttempts)).toBe(2)
    })
  )

  it.effect("fails with MaxRetriesExceededError when retries exhausted", () =>
    Effect.gen(function* () {
      const cause = new Error("permanent failure")
      const result = yield* run({
        stream: fromBytes(new Uint8Array(10).fill(1)),
        chunkSize: 10,
        uploadPart: () => Promise.reject(cause),
        completeUpload: () => {},
        retrySchedule: Schedule.recurs(1),
      }).pipe(Effect.flip)

      expect(result).toBeInstanceOf(MaxRetriesExceededError)
      expect((result as MaxRetriesExceededError).partNumber).toBe(1)
      expect((result as MaxRetriesExceededError).totalAttempts).toBe(2)
      expect((result as MaxRetriesExceededError).cause).toBe(cause)
    })
  )

  it.effect("fails with AbortError when signal is aborted", () =>
    Effect.gen(function* () {
      const controller = new AbortController()

      const uploadPart = () => new Promise<string>((_resolve) => {
        setTimeout(() => controller.abort(), 5)
      })

      const result = yield* run({
        stream: fromBytes(new Uint8Array(10).fill(1)),
        chunkSize: 10,
        uploadPart,
        completeUpload: () => {},
        signal: controller.signal,
      }).pipe(Effect.flip)

      expect(result).toBeInstanceOf(AbortError)
    })
  )
})
