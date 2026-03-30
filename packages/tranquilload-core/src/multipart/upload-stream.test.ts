import { describe, expect, it } from "@effect/vitest"
import { Cause, Effect, Fiber, Ref, Schedule, Stream, TestClock } from "effect"
import { AbortError, CircuitOpenError, CompleteUploadError, MaxRetriesExceededError, PartUploadError, PresignedUrlError } from "../errors/upload-error.js"
import type { UploadEvent } from "../progress/upload-event.js"
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
        completeUpload: (_uploadId, parts) => { receivedParts.push(...parts) },
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

  it.effect("fails with PartUploadError on single-attempt failure (no retries)", () =>
    Effect.gen(function* () {
      const cause = new Error("immediate failure")
      const result = yield* run({
        stream: fromBytes(new Uint8Array(10).fill(1)),
        chunkSize: 10,
        uploadPart: () => Promise.reject(cause),
        completeUpload: () => {},
        retrySchedule: Schedule.recurs(0),
      }).pipe(Effect.flip)

      expect(result).toBeInstanceOf(PartUploadError)
      expect((result as PartUploadError).partNumber).toBe(1)
      expect((result as PartUploadError).attempt).toBe(1)
      expect((result as PartUploadError).cause).toBe(cause)
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

  it.effect("wraps completeUpload non-UploadError in CompleteUploadError", () =>
    Effect.gen(function* () {
      const cause = new TypeError("network down")
      const result = yield* run({
        stream: fromBytes(new Uint8Array(10).fill(1)),
        chunkSize: 10,
        uploadPart: () => "etag-1",
        completeUpload: () => { throw cause },
      }).pipe(Effect.flip)

      expect(result).toBeInstanceOf(CompleteUploadError)
      expect((result as CompleteUploadError)._tag).toBe("CompleteUploadError")
      expect((result as CompleteUploadError).cause).toBe(cause)
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

  it.effect("default schedule retries 3 total attempts (1 initial + 2 retries)", () =>
    Effect.gen(function* () {
      let attempts = 0
      const cause = new Error("permanent")

      const fiber = yield* Effect.fork(run({
        stream: fromBytes(new Uint8Array(10).fill(1)),
        chunkSize: 10,
        // No retrySchedule → DEFAULT_RETRY_SCHEDULE = exponential(100ms) + recurs(2) = 3 total
        uploadPart: () => { attempts++; throw cause },
        completeUpload: () => {},
      }).pipe(Effect.flip))

      // Advance TestClock to let exponential backoff proceed (100ms + 200ms)
      yield* TestClock.adjust("500 millis")

      const result = yield* Fiber.join(fiber)

      expect(attempts).toBe(3)
      expect(result).toBeInstanceOf(MaxRetriesExceededError)
      expect((result as MaxRetriesExceededError).totalAttempts).toBe(3)
      expect((result as MaxRetriesExceededError).cause).toBe(cause)
    })
  )

  it.effect("Schedule.whileInput allows differentiating by original error type", () =>
    Effect.gen(function* () {
      let attempts = 0
      const cause = new PresignedUrlError(new Error("presigned URL expired"))

      // Schedule that only retries when the cause is NOT a PresignedUrlError
      // uploadPart errors are wrapped in PartUploadError by upload-stream.ts,
      // so err.cause holds the original error thrown by the callback
      const scheduleNoRetryForPresigned = Schedule.whileInput(
        Schedule.recurs(2),
        (err: PartUploadError) => !(err.cause instanceof PresignedUrlError)
      )

      const result = yield* run({
        stream: fromBytes(new Uint8Array(10).fill(1)),
        chunkSize: 10,
        retrySchedule: scheduleNoRetryForPresigned,
        uploadPart: () => { attempts++; throw cause },
        completeUpload: () => {},
      }).pipe(Effect.flip)

      // Schedule.whileInput returns false on first attempt → no retries → 1 attempt only
      expect(attempts).toBe(1)
      // 1 attempt only → PartUploadError (not MaxRetriesExceededError — totalAttempts <= 1)
      expect(result).toBeInstanceOf(PartUploadError)
      expect((result as PartUploadError).cause).toBe(cause)
    })
  )
})

describe("uploadMultipartEffect with reconcileCompletedParts", () => {
  it.effect("skipped parts emit PartCompleted with reconciled etag, uploadPart not called for them", () =>
    Effect.gen(function* () {
      const uploadedPartNumbers: number[] = []

      const events = yield* run({
        stream: fromBytes(new Uint8Array(30).fill(1)),
        chunkSize: 10,
        reconcileCompletedParts: () => [
          { partNumber: 1, etag: "etag-reconciled-1" },
          { partNumber: 2, etag: "etag-reconciled-2" },
        ],
        uploadPart: (n) => { uploadedPartNumbers.push(n); return `etag-fresh-${n}` },
        completeUpload: () => {},
      })

      expect(uploadedPartNumbers).toEqual([3])

      const partEvents = events.filter(e => e._tag === "PartCompleted")
      expect(partEvents).toHaveLength(3)
      expect(partEvents.find(e => e._tag === "PartCompleted" && e.partNumber === 1)).toMatchObject({ partNumber: 1, etag: "etag-reconciled-1" })
      expect(partEvents.find(e => e._tag === "PartCompleted" && e.partNumber === 2)).toMatchObject({ partNumber: 2, etag: "etag-reconciled-2" })
      expect(partEvents.find(e => e._tag === "PartCompleted" && e.partNumber === 3)).toMatchObject({ partNumber: 3, etag: "etag-fresh-3" })
    })
  )

  it.effect("completeUpload receives all parts (reconciled + new)", () =>
    Effect.gen(function* () {
      let receivedParts: CompletedPart[] = []

      yield* run({
        stream: fromBytes(new Uint8Array(20).fill(1)),
        chunkSize: 10,
        reconcileCompletedParts: () => [{ partNumber: 1, etag: "etag-reconciled-1" }],
        uploadPart: () => "etag-fresh-2",
        completeUpload: (_uploadId, parts) => { receivedParts = [...parts] },
      })

      expect(receivedParts).toHaveLength(2)
      expect(receivedParts.find(p => p.partNumber === 1)).toMatchObject({ partNumber: 1, etag: "etag-reconciled-1" })
      expect(receivedParts.find(p => p.partNumber === 2)).toMatchObject({ partNumber: 2, etag: "etag-fresh-2" })
    })
  )

  it.effect("empty reconcile: all parts uploaded normally", () =>
    Effect.gen(function* () {
      const uploadedPartNumbers: number[] = []

      yield* run({
        stream: fromBytes(new Uint8Array(20).fill(1)),
        chunkSize: 10,
        reconcileCompletedParts: () => [],
        uploadPart: (n) => { uploadedPartNumbers.push(n); return `etag-${n}` },
        completeUpload: () => {},
      })

      expect(uploadedPartNumbers.sort()).toEqual([1, 2])
    })
  )

  it.effect("reconcileCompletedParts throws: fails with CompleteUploadError", () =>
    Effect.gen(function* () {
      const cause = new Error("reconcile failed")

      const result = yield* run({
        stream: fromBytes(new Uint8Array(10).fill(1)),
        chunkSize: 10,
        reconcileCompletedParts: () => { throw cause },
        uploadPart: () => "etag",
        completeUpload: () => {},
      }).pipe(Effect.flip)

      expect(result).toBeInstanceOf(CompleteUploadError)
      expect((result as CompleteUploadError).cause).toBe(cause)
    })
  )
})

describe("uploadMultipartEffect with circuitBreaker", () => {
  it.effect("opens circuit after threshold consecutive failures, emits CircuitOpen event", () =>
    Effect.gen(function* () {
      const received: UploadEvent[] = []

      // threshold=1: circuit opens on the very first part failure
      // (with unbounded concurrency, only 1 part completes its failure cycle
      // before Stream.mapEffect terminates the stream)
      const stream = uploadMultipartEffect({
        stream: fromBytes(new Uint8Array(30).fill(1)),
        chunkSize: 10,
        maxConcurrency: 1,
        uploadPart: () => Effect.fail(new PartUploadError(0, 1, new Error("network error"))),
        completeUpload: () => {},
        retrySchedule: Schedule.once,
        circuitBreaker: { threshold: 1, cooldown: 5000 },
      })

      const exit = yield* Stream.runForEach(
        stream,
        (event) => Effect.sync(() => received.push(event))
      ).pipe(Effect.exit, Effect.provide(LoggerServiceLive))

      expect(exit._tag).toBe("Failure")

      const circuitOpenEvent = received.find(e => e._tag === "CircuitOpen")
      expect(circuitOpenEvent).toBeDefined()
      expect(circuitOpenEvent!.failedParts).toBe(1)

      const err = Cause.squash((exit as any).cause)
      expect(err).toBeInstanceOf(CircuitOpenError)
    })
  )
})
