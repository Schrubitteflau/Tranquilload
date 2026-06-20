import { describe, expect, it } from "@effect/vitest"
import { Cause, Effect, Exit, Option, Schedule } from "effect"
import { afterEach, vi } from "vitest"
import { AbortError, CompleteUploadError, InitiateUploadError, PartUploadError } from "../errors/upload-error.js"
import { compress } from "../pipeline/compress.js"
import { compose, type Transform } from "../pipeline/middleware.js"
import type { PartCompleted } from "../progress/upload-event.js"
import { uploadMultipart, type ResumeState } from "./index.js"
import { uploadMultipartEffect } from "./upload-stream.js"

afterEach(() => {
  vi.restoreAllMocks()
})

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
  it.effect("F#19 — happy path: result resolves with UploadCompleted, events contains all events (no pipeline, passthrough control)", () =>
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

  it.effect("F#9 — abort signal: result rejects with AbortError, events stream closes cleanly (Dual API surface)", () =>
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

      // events ReadableStream closes cleanly (no throw). After Story 13.5 the
      // events stream FLUSHES everything emitted before the failure; in THIS
      // scenario the abort preempts all emission (no `initiate` → no
      // UploadInitiated, and `uploadPart` never resolves → no PartCompleted), so
      // 0 events is still correct here and the stream just closes cleanly. The
      // flush itself is proven by 13.5-INT-001/002 below (≥1 event lands first).
      const evts = yield* Effect.promise(() => readAllEvents(events))
      expect(Array.isArray(evts)).toBe(true)
      // No terminal UploadCompleted on the abort path.
      expect(evts.find((e) => e._tag === "UploadCompleted")).toBeUndefined()
    })
  )

  // ──────────────────────────────────────────────────────────────────────────
  // 13.5-INT-001 / 002 — Story 13.5 (Observability: event-stream flush-before-
  // error). BEFORE 13.5 the public `events` stream was built by awaiting the
  // fully-collected event array, so on the failure/abort path that array
  // rejected and the stream closed EMPTY — every event emitted before the
  // failure was lost (the "events read empty on the failure path" gap worked
  // around with callback-side counters across Story 11.5). AFTER 13.5 events are
  // enqueued live, so events emitted before the failure remain observable, while
  // the typed UploadError still surfaces only via `result` (channels split — the
  // error is never masked on the events channel). Locked at the UNIT tier here;
  // the Story 11.5 E2E callback-counter workaround is RE-TAGGED, not flipped
  // (E2E/MinIO is the wrong tier for a deterministic stream behaviour — same
  // tier-correctness call as Story 13.4 DD2).
  // ──────────────────────────────────────────────────────────────────────────
  it.effect("13.5-INT-001 — events emitted before a part-failure are flushed (not lost); result still rejects with the typed error", () =>
    Effect.gen(function* () {
      const boom = new Error("part 2 boom")
      const { result, events } = uploadMultipart({
        stream: fromBytes(new Uint8Array(20).fill(1)),
        chunkSize: 10, // → 2 parts
        maxConcurrency: 1, // serialize: part 1 fully completes (+ ProgressTick) before part 2 runs
        retrySchedule: Schedule.recurs(0), // 1 attempt → part 2 fails immediately (no retry wait)
        initiate: () => ({ uploadId: "u-flush" }), // emits UploadInitiated
        uploadPart: (n) => {
          if (n === 1) return "etag-1"
          return Promise.reject(boom)
        },
        completeUpload: () => {},
      })

      // result rejects with the typed PartUploadError — the error is NOT masked
      // by moving events to a live channel.
      const resultExit = yield* Effect.exit(
        Effect.tryPromise({ try: () => result, catch: (e) => e })
      )
      expect(Exit.isFailure(resultExit)).toBe(true)
      if (Exit.isFailure(resultExit)) {
        const errOption = Cause.failureOption(resultExit.cause)
        expect(errOption._tag).toBe("Some")
        const err = (errOption as { _tag: "Some"; value: unknown }).value
        expect(err).toBeInstanceOf(PartUploadError)
        expect((err as PartUploadError).partNumber).toBe(2)
      }

      // The events stream FLUSHED the pre-failure events (was EMPTY pre-13.5).
      const evts = yield* Effect.promise(() => readAllEvents(events))
      expect(evts.length).toBeGreaterThan(0)
      expect(evts.find((e) => e._tag === "UploadInitiated")).toBeDefined()
      const partEvents = evts.filter((e) => e._tag === "PartCompleted")
      expect(partEvents).toHaveLength(1)
      expect((partEvents[0] as PartCompleted).partNumber).toBe(1)
      // No terminal UploadCompleted — the upload failed before /complete.
      expect(evts.find((e) => e._tag === "UploadCompleted")).toBeUndefined()
    })
  )

  it.effect("13.5-INT-002 — events emitted before a mid-flight abort are flushed (not lost); result still rejects with AbortError", () =>
    Effect.gen(function* () {
      const controller = new AbortController()
      const { result, events } = uploadMultipart({
        stream: fromBytes(new Uint8Array(20).fill(1)),
        chunkSize: 10, // → 2 parts
        maxConcurrency: 1, // part 1 completes before part 2 starts
        initiate: () => ({ uploadId: "u-abort" }),
        uploadPart: (n) => {
          if (n === 1) return "etag-1"
          // part 2: trip the abort, then never resolve so raceFirst picks the abort.
          controller.abort()
          return new Promise<string>(() => {})
        },
        completeUpload: () => {},
        signal: controller.signal,
      })

      const resultExit = yield* Effect.exit(
        Effect.tryPromise({ try: () => result, catch: (e) => e })
      )
      expect(Exit.isFailure(resultExit)).toBe(true)
      if (Exit.isFailure(resultExit)) {
        const errOption = Cause.failureOption(resultExit.cause)
        expect(errOption._tag).toBe("Some")
        expect((errOption as { _tag: "Some"; value: unknown }).value).toBeInstanceOf(AbortError)
      }

      const evts = yield* Effect.promise(() => readAllEvents(events))
      expect(evts.find((e) => e._tag === "UploadInitiated")).toBeDefined()
      const partEvents = evts.filter((e) => e._tag === "PartCompleted")
      expect(partEvents).toHaveLength(1)
      expect((partEvents[0] as PartCompleted).partNumber).toBe(1)
      expect(evts.find((e) => e._tag === "UploadCompleted")).toBeUndefined()
    })
  )

  it(".effect property points to uploadMultipartEffect", () => {
    expect(uploadMultipart.effect).toBe(uploadMultipartEffect)
  })

  it.effect(
    "10.8-INT-001 (F#89) — two parallel uploadMultipart calls have isolated Refs (getProgress does not cross-talk)",
    () =>
      Effect.gen(function* () {
        // Two streams with distinct sizes so cross-contamination is observable
        // in `getProgress().bytesUploaded`. A shared Ref would yield the same
        // value (or the last write) on both probes.
        const callA = uploadMultipart({
          stream: fromBytes(new Uint8Array(50).fill(0xaa)),
          chunkSize: 10,
          totalBytes: 50,
          uploadPart: (n) => `etag-A-${n}`,
          completeUpload: () => {},
        })
        const callB = uploadMultipart({
          stream: fromBytes(new Uint8Array(30).fill(0xbb)),
          chunkSize: 10,
          totalBytes: 30,
          uploadPart: (n) => `etag-B-${n}`,
          completeUpload: () => {},
        })

        // Run them in parallel — the lib has no awareness of the other call.
        yield* Effect.all(
          [
            Effect.promise(() => callA.result),
            Effect.promise(() => callB.result),
          ],
          { concurrency: "unbounded" },
        )

        const progressA = yield* Effect.promise(() => callA.getProgress())
        const progressB = yield* Effect.promise(() => callB.getProgress())

        // Each call's getProgress reports ITS OWN bytes and totalBytes.
        // If Refs were shared, both would return the same value.
        expect(progressA.bytesUploaded).toBe(50)
        expect(progressB.bytesUploaded).toBe(30)
        expect(progressA.totalBytes).toEqual(Option.some(50))
        expect(progressB.totalBytes).toEqual(Option.some(30))

        // uploadId resolves independently per call.
        const idA = yield* Effect.promise(() => callA.uploadId)
        const idB = yield* Effect.promise(() => callB.uploadId)
        expect(idA).toBeTypeOf("string")
        expect(idB).toBeTypeOf("string")
      }),
  )

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

  it.effect("initiate callback: UploadInitiated event emitted first, uploadId resolves to correct value", () =>
    Effect.gen(function* () {
      const { result, events, uploadId } = uploadMultipart({
        stream: fromBytes(new Uint8Array(10).fill(1)),
        chunkSize: 10,
        initiate: () => Promise.resolve({ uploadId: "upload-abc-123" }),
        uploadPart: () => "etag-1",
        completeUpload: (uid, _parts) => {
          expect(uid).toBe("upload-abc-123")
        },
      })

      yield* Effect.promise(() => result)
      const resolvedId = yield* Effect.promise(() => uploadId)
      expect(resolvedId).toBe("upload-abc-123")

      const evts = yield* Effect.promise(() => readAllEvents(events))
      const initiatedEvent = evts.find(e => e._tag === "UploadInitiated")
      expect(initiatedEvent).toMatchObject({ _tag: "UploadInitiated", uploadId: "upload-abc-123" })
      expect(evts[0]!._tag).toBe("UploadInitiated")

      const completedEvent = evts.find(e => e._tag === "UploadCompleted")
      expect(completedEvent).toMatchObject({ _tag: "UploadCompleted", uploadId: "upload-abc-123" })
    })
  )

  it.effect("no initiate: no UploadInitiated event, uploadId resolves to empty string", () =>
    Effect.gen(function* () {
      const { result, events, uploadId } = uploadMultipart({
        stream: fromBytes(new Uint8Array(10).fill(1)),
        chunkSize: 10,
        uploadPart: () => "etag-1",
        completeUpload: () => {},
      })

      yield* Effect.promise(() => result)
      const resolvedId = yield* Effect.promise(() => uploadId)
      expect(resolvedId).toBe("")

      const evts = yield* Effect.promise(() => readAllEvents(events))
      expect(evts.find(e => e._tag === "UploadInitiated")).toBeUndefined()
    })
  )

  it.effect("F#6 — initiate failure: result rejects with InitiateUploadError, uploadId resolves to empty string (500 on /initiate)", () =>
    Effect.gen(function* () {
      const cause = new Error("initiation failed")
      const { result, uploadId } = uploadMultipart({
        stream: fromBytes(new Uint8Array(10).fill(1)),
        chunkSize: 10,
        initiate: () => { throw cause },
        uploadPart: () => "etag-1",
        completeUpload: () => {},
      })

      const resultExit = yield* Effect.exit(
        Effect.tryPromise({
          try: () => result,
          catch: (e) => e,
        })
      )
      expect(Exit.isFailure(resultExit)).toBe(true)
      if (Exit.isFailure(resultExit)) {
        const err = (Cause.failureOption(resultExit.cause) as { _tag: "Some"; value: unknown }).value
        expect(err).toBeInstanceOf(InitiateUploadError)
        expect((err as InitiateUploadError).cause).toBe(cause)
      }

      const resolvedId = yield* Effect.promise(() => uploadId)
      expect(resolvedId).toBe("")
    })
  )
})

describe("uploadMultipart — resumeState surface", () => {
  it.effect("resumeState resolves with correct shape on fresh init (no digest)", () =>
    Effect.gen(function* () {
      const { result, resumeState } = uploadMultipart({
        stream: fromBytes(new Uint8Array(10).fill(1)),
        chunkSize: 10,
        initiate: () => ({ uploadId: "fresh-up-1" }),
        pipelineIdentity: "ident-1",
        uploadPart: () => "etag-1",
        completeUpload: () => {},
      })

      yield* Effect.promise(() => result)
      const state = yield* Effect.promise(() => resumeState)
      expect(state).toEqual({
        version: 1,
        uploadId: "fresh-up-1",
        chunkSize: 10,
        pipelineIdentity: "ident-1",
        contentDigestCaptured: false,
      })
    })
  )

  it.effect("resumeState includes contentDigest when getContentDigest is provided (fresh init)", () =>
    Effect.gen(function* () {
      const { result, resumeState } = uploadMultipart({
        stream: fromBytes(new Uint8Array(10).fill(1)),
        chunkSize: 10,
        initiate: () => ({ uploadId: "fresh-up-2" }),
        getContentDigest: () => "digest-xyz",
        uploadPart: () => "etag-1",
        completeUpload: () => {},
      })

      yield* Effect.promise(() => result)
      const state = yield* Effect.promise(() => resumeState)
      expect(state).toMatchObject({
        version: 1,
        uploadId: "fresh-up-2",
        contentDigest: "digest-xyz",
        contentDigestCaptured: true,
      })
    })
  )

  it.effect("resumeState resolves with the passed resumeFrom shape on resume", () =>
    Effect.gen(function* () {
      const passed: ResumeState = {
        version: 1,
        uploadId: "stored-up-1",
        chunkSize: 10,
        contentDigestCaptured: false,
      }
      const { result, resumeState, uploadId } = uploadMultipart({
        stream: fromBytes(new Uint8Array(10).fill(1)),
        chunkSize: 10,
        uploadPart: () => "etag-1",
        completeUpload: () => {},
        resumeFrom: passed,
      })

      // uploadId resolves synchronously (AC22) — no need to await `result`
      const id = yield* Effect.promise(() => uploadId)
      expect(id).toBe("stored-up-1")

      yield* Effect.promise(() => result)
      const state = yield* Effect.promise(() => resumeState)
      expect(state).toBe(passed)
    })
  )
})

describe("uploadMultipart — legacy-pattern warn", () => {
  it("warns once when initiate + reconcile + no resumeFrom (AC16)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})

    const { result } = uploadMultipart({
      stream: fromBytes(new Uint8Array(10).fill(1)),
      chunkSize: 10,
      initiate: () => ({ uploadId: "u-1" }),
      reconcileCompletedParts: () => [{ partNumber: 1, etag: "etag-1" }],
      uploadPart: () => "should-not-be-called",
      completeUpload: () => {},
    })
    await result

    const legacyWarns = warnSpy.mock.calls.filter((c) =>
      typeof c[0] === "string" && c[0].startsWith("Tranquilload: detected legacy resume pattern")
    )
    expect(legacyWarns).toHaveLength(1)
  })

  it("does NOT warn when resumeFrom is provided alongside initiate + reconcile (AC17)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})

    const { result } = uploadMultipart({
      stream: fromBytes(new Uint8Array(10).fill(1)),
      chunkSize: 10,
      initiate: () => ({ uploadId: "ignored" }),
      reconcileCompletedParts: () => [{ partNumber: 1, etag: "etag-1" }],
      uploadPart: () => "should-not-be-called",
      completeUpload: () => {},
      resumeFrom: {
        version: 1,
        uploadId: "stored",
        chunkSize: 10,
        contentDigestCaptured: false,
      },
    })
    await result

    const legacyWarns = warnSpy.mock.calls.filter((c) =>
      typeof c[0] === "string" && c[0].startsWith("Tranquilload: detected legacy resume pattern")
    )
    expect(legacyWarns).toHaveLength(0)
  })

  it("warns even when reconcileCompletedParts returns an empty array (AC18)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})

    const { result } = uploadMultipart({
      stream: fromBytes(new Uint8Array(10).fill(1)),
      chunkSize: 10,
      initiate: () => ({ uploadId: "u-1" }),
      reconcileCompletedParts: () => [],
      uploadPart: () => "etag-1",
      completeUpload: () => {},
    })
    await result

    const legacyWarns = warnSpy.mock.calls.filter((c) =>
      typeof c[0] === "string" && c[0].startsWith("Tranquilload: detected legacy resume pattern")
    )
    expect(legacyWarns).toHaveLength(1)
  })

  it("warns when pipeline is set without pipelineIdentity (AC24)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})

    const noopTransform: Transform = (stream) => stream

    const { result } = uploadMultipart({
      stream: fromBytes(new Uint8Array(10).fill(1)),
      chunkSize: 10,
      pipeline: noopTransform,
      uploadPart: () => "etag-1",
      completeUpload: () => {},
    })
    await result

    const identityWarns = warnSpy.mock.calls.filter((c) =>
      typeof c[0] === "string" && c[0].includes("pipeline is set but pipelineIdentity is not")
    )
    expect(identityWarns).toHaveLength(1)
  })
})
