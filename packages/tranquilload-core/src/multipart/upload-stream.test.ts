import { describe, expect, it } from "@effect/vitest"
import { Cause, Effect, Fiber, Ref, Schedule, Stream, TestClock } from "effect"
import { AbortError, CircuitOpenError, CompleteUploadError, MaxRetriesExceededError, PartTimeoutError, PartUploadError, PresignedUrlError, ReconcileError, ResumeMismatchError } from "../errors/upload-error.js"
import type { UploadEvent } from "../progress/upload-event.js"
import { LoggerServiceLive } from "../services/logger-service.js"
import { uploadMultipartEffect, type CompletedPart, type ResumeState } from "./upload-stream.js"

const fromBytes = (bytes: Uint8Array): ReadableStream<Uint8Array> =>
  new ReadableStream({ start: c => { c.enqueue(bytes); c.close() } })

const run = (options: Parameters<typeof uploadMultipartEffect>[0]) =>
  Stream.runCollect(uploadMultipartEffect(options)).pipe(
    Effect.map(chunk => Array.from(chunk)),
    Effect.provide(LoggerServiceLive)
  )

describe("uploadMultipartEffect", () => {
  it.effect("F#1 — emits PartCompleted per chunk and UploadCompleted at end (multipart golden, 3 parts)", () =>
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

  it.effect("F#26, F#29 — limits concurrent parts to maxConcurrency (Effect-typed uploadPart at boundary)", () =>
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

  // --- 10.1-INT-018 (F#27) — maxConcurrency > totalParts (no blocking) -----
  // The semaphore must not stall when more permits are requested than parts
  // exist. Asserts: 4 parts upload at concurrency 16 → all complete, observed
  // concurrency ≤ totalParts (semaphore never tries to hold > 4 permits since
  // there are only 4 work items).
  it.effect("10.1-INT-018 (F#27) — maxConcurrency > totalParts: all parts upload without blocking the semaphore", () =>
    Effect.gen(function* () {
      const refConcurrent = yield* Ref.make(0)
      const refMaxObserved = yield* Ref.make(0)
      const refCompleted = yield* Ref.make(0)

      const uploadPart = (partNumber: number, _chunk: Uint8Array): Effect.Effect<string, never> =>
        Effect.gen(function* () {
          yield* Ref.update(refConcurrent, n => n + 1)
          const current = yield* Ref.get(refConcurrent)
          yield* Ref.update(refMaxObserved, max => Math.max(max, current))
          yield* Effect.yieldNow()
          yield* Ref.update(refConcurrent, n => n - 1)
          yield* Ref.update(refCompleted, n => n + 1)
          return `etag-${partNumber}`
        }) as Effect.Effect<string, never>

      // 4 parts of 10 bytes each = 40 total; maxConcurrency=16 (way more than parts).
      const events = yield* run({
        stream: fromBytes(new Uint8Array(40).fill(1)),
        chunkSize: 10,
        uploadPart,
        completeUpload: () => {},
        maxConcurrency: 16,
      })

      const completed = yield* Ref.get(refCompleted)
      const maxObserved = yield* Ref.get(refMaxObserved)

      // All 4 parts uploaded.
      expect(completed).toBe(4)
      // Semaphore never tried to hold more permits than parts — capped by totalParts.
      expect(maxObserved).toBeLessThanOrEqual(4)
      expect(maxObserved).toBeGreaterThanOrEqual(1)

      // 4 PartCompleted events emitted.
      const partEvents = events.filter(e => e._tag === "PartCompleted")
      expect(partEvents).toHaveLength(4)
    })
  )

  it.effect("F#3 — retries on failure and emits PartCompleted on eventual success (transient 503 → recovery)", () =>
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

  it.effect("F#4 — fails with MaxRetriesExceededError when retries exhausted (indefinite 503)", () =>
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

  it.effect("F#8 — wraps completeUpload non-UploadError in CompleteUploadError (500 on /complete)", () =>
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

  it.effect("F#9 — fails with AbortError when signal is aborted (Effect.raceFirst path)", () =>
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

  // --- Story 13.4 — opt-in partTimeout (C#15) -----------------------------
  // A pathologically slow part (an attempt that never resolves) is bounded by
  // `partTimeout`. The timed-out ATTEMPT fails with PartUploadError whose cause
  // is a PartTimeoutError, so it feeds the existing retrySchedule like any
  // transient failure. TestClock drives the timeout deterministically — no real
  // waiting, no MinIO. (The companion E2E lock 11.5-E2E-010 guards the
  // non-breaking DEFAULT: with no partTimeout a slow part still completes.)
  it.effect("13.4-INT-001 (C#15) — partTimeout bounds a slow attempt: times out as PartUploadError(cause=PartTimeoutError), no retry", () =>
    Effect.gen(function* () {
      let calls = 0
      const fiber = yield* Effect.fork(run({
        stream: fromBytes(new Uint8Array(10).fill(1)),
        chunkSize: 10,
        partTimeout: "100 millis",
        retrySchedule: Schedule.recurs(0), // single attempt, no retry
        uploadPart: () => { calls++; return new Promise<string>(() => {}) }, // never resolves
        completeUpload: () => {},
      }).pipe(Effect.flip))

      yield* TestClock.adjust("1 second") // past the 100ms attempt deadline
      const result = yield* Fiber.join(fiber)

      expect(calls).toBe(1)
      expect(result).toBeInstanceOf(PartUploadError)
      expect((result as PartUploadError).attempt).toBe(1)
      expect((result as PartUploadError).partNumber).toBe(1)
      expect((result as PartUploadError).cause).toBeInstanceOf(PartTimeoutError)
      expect(((result as PartUploadError).cause as PartTimeoutError).partNumber).toBe(1)
    })
  )

  it.effect("13.4-INT-002 (C#15) — partTimeout: repeated timeouts feed retrySchedule → MaxRetriesExceededError(cause=PartTimeoutError)", () =>
    Effect.gen(function* () {
      let calls = 0
      const fiber = yield* Effect.fork(run({
        stream: fromBytes(new Uint8Array(10).fill(1)),
        chunkSize: 10,
        partTimeout: "100 millis",
        retrySchedule: Schedule.recurs(2), // 3 total attempts, no backoff delay
        uploadPart: () => { calls++; return new Promise<string>(() => {}) }, // never resolves
        completeUpload: () => {},
      }).pipe(Effect.flip))

      yield* TestClock.adjust("1 second") // covers 3 × 100ms sequential timeouts
      const result = yield* Fiber.join(fiber)

      expect(calls).toBe(3) // every attempt timed out and was retried per schedule
      expect(result).toBeInstanceOf(MaxRetriesExceededError)
      expect((result as MaxRetriesExceededError).totalAttempts).toBe(3)
      expect((result as MaxRetriesExceededError).cause).toBeInstanceOf(PartTimeoutError)
    })
  )

  it.effect("13.4-INT-003 (C#15) — partTimeout set but part completes within budget → no timeout, upload completes (non-breaking control)", () =>
    Effect.gen(function* () {
      const events = yield* run({
        stream: fromBytes(new Uint8Array(10).fill(1)),
        chunkSize: 10,
        partTimeout: "10 seconds", // generous; the sync uploadPart wins the race
        uploadPart: () => "etag-1",
        completeUpload: () => {},
      })

      expect(events.some(e => e._tag === "UploadCompleted")).toBe(true)
      expect(events.find(e => e._tag === "PartCompleted")).toMatchObject({ partNumber: 1, etag: "etag-1" })
    })
  )
})

describe("uploadMultipartEffect with reconcileCompletedParts", () => {
  it.effect("F#11 — skipped parts emit PartCompleted with reconciled etag, uploadPart not called for them (golden resume: 3/5 already, only PUTs for 4 & 5)", () =>
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

  it.effect("reconcileCompletedParts throws: fails with ReconcileError", () =>
    Effect.gen(function* () {
      const cause = new Error("reconcile failed")

      const result = yield* run({
        stream: fromBytes(new Uint8Array(10).fill(1)),
        chunkSize: 10,
        reconcileCompletedParts: () => { throw cause },
        uploadPart: () => "etag",
        completeUpload: () => {},
      }).pipe(Effect.flip)

      expect(result).toBeInstanceOf(ReconcileError)
      expect((result as ReconcileError).cause).toBe(cause)
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

  describe("chunkSize validation", () => {
    const baseOptions = {
      stream: fromBytes(new Uint8Array(10)),
      uploadPart: () => "etag",
      completeUpload: () => {},
    } as const

    it("throws TypeError when chunkSize is 0", () => {
      expect(() => uploadMultipartEffect({ ...baseOptions, chunkSize: 0 }))
        .toThrow(TypeError)
    })

    it("throws TypeError when chunkSize is negative", () => {
      expect(() => uploadMultipartEffect({ ...baseOptions, chunkSize: -1 }))
        .toThrow(/positive finite integer/)
    })

    it("throws TypeError when chunkSize is NaN", () => {
      expect(() => uploadMultipartEffect({ ...baseOptions, chunkSize: NaN }))
        .toThrow(/positive finite integer/)
    })

    it("throws TypeError when chunkSize is Infinity", () => {
      expect(() => uploadMultipartEffect({ ...baseOptions, chunkSize: Infinity }))
        .toThrow(/positive finite integer/)
    })

    it("accepts a positive integer chunkSize (control)", () => {
      expect(() => uploadMultipartEffect({ ...baseOptions, chunkSize: 5 }))
        .not.toThrow()
    })
  })
})

describe("ResumeState validation", () => {
  const baseOptions = {
    stream: new ReadableStream<Uint8Array>({ start: (c) => { c.enqueue(new Uint8Array(10)); c.close() } }),
    chunkSize: 10,
    uploadPart: () => "etag",
    completeUpload: () => {},
  } as const

  const validResumeState = (overrides: Partial<ResumeState> = {}): ResumeState => ({
    version: 1,
    uploadId: "upload-stored-1",
    chunkSize: 10,
    contentDigestCaptured: false,
    ...overrides,
  })

  it("throws TypeError when resumeFrom.uploadId is empty string", () => {
    expect(() =>
      uploadMultipartEffect({
        ...baseOptions,
        resumeFrom: validResumeState({ uploadId: "" }),
      })
    ).toThrow(/non-empty string/)
  })

  it("throws ResumeMismatchError(version_mismatch) when version != 1", () => {
    let caught: unknown
    try {
      uploadMultipartEffect({
        ...baseOptions,
        // Cast: future v2 schema would pass typecheck, but here we force-test the v1 check.
        resumeFrom: { ...validResumeState(), version: 2 as unknown as 1 },
      })
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(ResumeMismatchError)
    expect((caught as ResumeMismatchError).reason).toBe("version_mismatch")
  })

  it("throws ResumeMismatchError(chunksize_mismatch) when chunkSize differs", () => {
    let caught: unknown
    try {
      uploadMultipartEffect({
        ...baseOptions,
        chunkSize: 10,
        resumeFrom: validResumeState({ chunkSize: 5 }),
      })
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(ResumeMismatchError)
    expect((caught as ResumeMismatchError).reason).toBe("chunksize_mismatch")
  })

  it("throws ResumeMismatchError(pipeline_mismatch) when pipelineIdentity differs", () => {
    let caught: unknown
    try {
      uploadMultipartEffect({
        ...baseOptions,
        pipelineIdentity: "gzip-v1",
        resumeFrom: validResumeState({ pipelineIdentity: "deflate-v1" }),
      })
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(ResumeMismatchError)
    expect((caught as ResumeMismatchError).reason).toBe("pipeline_mismatch")
  })

  it("throws ResumeMismatchError(content_mismatch) when contentDigestCaptured=true but contentDigest is undefined (F9)", () => {
    let caught: unknown
    try {
      uploadMultipartEffect({
        ...baseOptions,
        resumeFrom: validResumeState({
          contentDigestCaptured: true,
          contentDigest: undefined,
        }),
      })
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(ResumeMismatchError)
    expect((caught as ResumeMismatchError).reason).toBe("content_mismatch")
  })

  it.effect("fails with ResumeMismatchError(content_mismatch) at runtime when digest value differs", () =>
    Effect.gen(function* () {
      const exit = yield* Stream.runCollect(
        uploadMultipartEffect({
          stream: new ReadableStream<Uint8Array>({ start: (c) => { c.enqueue(new Uint8Array(10)); c.close() } }),
          chunkSize: 10,
          uploadPart: () => "etag",
          completeUpload: () => {},
          resumeFrom: validResumeState({
            contentDigest: "digest-original",
            contentDigestCaptured: true,
          }),
          getContentDigest: () => "digest-different",
        })
      ).pipe(Effect.exit, Effect.provide(LoggerServiceLive))

      expect(exit._tag).toBe("Failure")
      const err = Cause.squash((exit as Extract<typeof exit, { _tag: "Failure" }>).cause)
      expect(err).toBeInstanceOf(ResumeMismatchError)
      expect((err as ResumeMismatchError).reason).toBe("content_mismatch")
    })
  )

  it.effect("accepts a valid resumeFrom: no throw, uploadId honored, reconcile called", () =>
    Effect.gen(function* () {
      let initiateCalled = 0
      let reconcileCalls = 0
      const completedWith: { uploadId: string; parts: ReadonlyArray<CompletedPart> } = { uploadId: "", parts: [] }

      const events = yield* Stream.runCollect(
        uploadMultipartEffect({
          stream: new ReadableStream<Uint8Array>({ start: (c) => { c.enqueue(new Uint8Array(20)); c.close() } }),
          chunkSize: 10,
          uploadPart: (n) => `fresh-etag-${n}`,
          completeUpload: (uploadId, parts) => {
            completedWith.uploadId = uploadId
            completedWith.parts = parts
          },
          initiate: () => { initiateCalled++; return { uploadId: "should-not-be-used" } },
          reconcileCompletedParts: () => {
            reconcileCalls++
            return [{ partNumber: 1, etag: "etag-reconciled-1" }]
          },
          resumeFrom: validResumeState({ uploadId: "upload-stored-1", chunkSize: 10 }),
        })
      ).pipe(
        Effect.map((chunk) => Array.from(chunk)),
        Effect.provide(LoggerServiceLive)
      )

      expect(initiateCalled).toBe(0)
      expect(reconcileCalls).toBe(1)
      expect(completedWith.uploadId).toBe("upload-stored-1")
    })
  )

  it.effect("does NOT emit UploadInitiated on resume (G1)", () =>
    Effect.gen(function* () {
      const events = yield* Stream.runCollect(
        uploadMultipartEffect({
          stream: new ReadableStream<Uint8Array>({ start: (c) => { c.enqueue(new Uint8Array(10)); c.close() } }),
          chunkSize: 10,
          uploadPart: () => "etag-1",
          completeUpload: () => {},
          initiate: () => ({ uploadId: "ignored" }),
          resumeFrom: validResumeState({ uploadId: "upload-stored-1", chunkSize: 10 }),
        })
      ).pipe(
        Effect.map((chunk) => Array.from(chunk)),
        Effect.provide(LoggerServiceLive)
      )

      expect(events.find((e) => e._tag === "UploadInitiated")).toBeUndefined()
      // First event must come from the parts stream
      expect(events[0]?._tag).toBe("PartCompleted")
    })
  )
})
