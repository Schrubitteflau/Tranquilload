import { describe, expect, it } from "@effect/vitest"
import { Cause, Chunk, Effect, Exit, Ref, Stream } from "effect"
import {
  CompleteUploadError,
  PartUploadError,
} from "../errors/upload-error.js"
import { LoggerServiceLive } from "../services/logger-service.js"
import { uploadMultipartEffect } from "./upload-stream.js"

// Helper: single-shot ReadableStream from a Uint8Array.
const fromBytes = (bytes: Uint8Array): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start(c) {
      c.enqueue(bytes)
      c.close()
    },
  })

// Helper: empty ReadableStream — closes immediately, no bytes.
const emptyStream = (): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start(c) {
      c.close()
    },
  })

// Helper: ReadableStream that emits some bytes then errors mid-read.
const erroringMidRead = (
  preludeBytes: Uint8Array,
  cause: Error,
): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start(c) {
      c.enqueue(preludeBytes)
      c.error(cause)
    },
  })

const runUpload = (options: Parameters<typeof uploadMultipartEffect>[0]) =>
  Stream.runCollect(uploadMultipartEffect(options)).pipe(
    Effect.map((c) => Array.from(c)),
    Effect.provide(LoggerServiceLive),
  )

describe("uploadMultipartEffect — chunking edges (Story 11.6)", () => {
  // --- 11.6-INT-001 (F#24) — zero-byte file -----------------------------------
  // Empty source stream → chunkStream emits no chunks → completeUpload is called
  // with an empty parts list. Real S3 rejects this with a 4xx; we simulate by
  // having the user's `completeUpload` throw, and assert the typed surface:
  // CompleteUploadError carrying the original cause.
  it.effect(
    "11.6-INT-001 (F#24) — zero-byte file: completeUpload sees empty parts; user reject surfaces as CompleteUploadError",
    () =>
      Effect.gen(function* () {
        const seenParts: number[] = []
        const cause = new Error("MalformedXML: empty parts list")

        const exit = yield* Effect.exit(
          runUpload({
            stream: emptyStream(),
            chunkSize: 10,
            uploadPart: () => "etag-never-called",
            completeUpload: (_uploadId, parts) => {
              seenParts.push(parts.length)
              throw cause
            },
          }),
        )

        // completeUpload was invoked exactly once with 0 parts.
        expect(seenParts).toEqual([0])

        // Typed failure (not a fiber DEFECT) → CompleteUploadError(cause).
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          expect(Cause.dieOption(exit.cause)._tag).toBe("None")
          expect(Chunk.size(Cause.defects(exit.cause))).toBe(0)
          const failure = Cause.failureOption(exit.cause)
          expect(failure._tag).toBe("Some")
          if (failure._tag === "Some") {
            expect(failure.value).toBeInstanceOf(CompleteUploadError)
            expect((failure.value as CompleteUploadError)._tag).toBe(
              "CompleteUploadError",
            )
            expect((failure.value as CompleteUploadError).cause).toBe(cause)
          }
        }
      }),
  )

  // --- 11.6-INT-002 (F#25) — source stream errors mid-read --------------------
  // chunkStream wraps its source-side errors via `Stream.mapError((cause) =>
  // new PartUploadError(0, 0, cause))`. A `ReadableStream` that errors after
  // emitting some bytes must therefore surface as PartUploadError(0, 0, cause)
  // in the typed Effect channel, preserving the original cause.
  it.effect(
    "11.6-INT-002 (F#25) — source stream errors mid-read: typed PartUploadError(0, 0, cause), no fiber DEFECT",
    () =>
      Effect.gen(function* () {
        const cause = new Error("source EIO")

        const exit = yield* Effect.exit(
          runUpload({
            stream: erroringMidRead(new Uint8Array(5).fill(1), cause),
            chunkSize: 10,
            uploadPart: () => "etag-1",
            completeUpload: () => {},
          }),
        )

        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          expect(Cause.dieOption(exit.cause)._tag).toBe("None")
          expect(Chunk.size(Cause.defects(exit.cause))).toBe(0)
          const failure = Cause.failureOption(exit.cause)
          expect(failure._tag).toBe("Some")
          if (failure._tag === "Some") {
            expect(failure.value).toBeInstanceOf(PartUploadError)
            const err = failure.value as PartUploadError
            expect(err._tag).toBe("PartUploadError")
            expect(err.partNumber).toBe(0)
            expect(err.attempt).toBe(0)
            expect(err.cause).toBe(cause)
          }
        }
      }),
  )

  // --- 11.6-INT-003 (F#28) — throttled concurrency saturation -----------------
  // The semaphore must hold *exactly* maxConcurrency parts in flight at the
  // peak, given enough parts and an artificial gate that prevents any one part
  // from completing early. We hold all in-flight parts in `Effect.never` until
  // a Deferred is released, then read the max-observed in-flight counter.
  it.effect(
    "11.6-INT-003 (F#28) — throttled concurrency: max-observed in-flight === maxConcurrency",
    () =>
      Effect.gen(function* () {
        const maxConcurrency = 3
        const refInFlight = yield* Ref.make(0)
        const refMaxObserved = yield* Ref.make(0)
        const gate = yield* Effect.makeLatch(false)

        // 5 parts of 10 bytes — more parts than the concurrency budget.
        // Each part bumps the counter, waits on the latch, then releases. After
        // we observe the max counter has reached `maxConcurrency`, open the
        // latch so all in-flight parts can settle.
        const uploadPart = (n: number, _chunk: Uint8Array) =>
          Effect.gen(function* () {
            const current = yield* Ref.updateAndGet(refInFlight, (x) => x + 1)
            yield* Ref.update(refMaxObserved, (m) => Math.max(m, current))
            yield* gate.await
            yield* Ref.update(refInFlight, (x) => x - 1)
            return `etag-${n}`
          }) as Effect.Effect<string, never>

        const watcher = Effect.gen(function* () {
          // Wait until the max-observed reaches maxConcurrency, then release.
          while (true) {
            const m = yield* Ref.get(refMaxObserved)
            if (m >= maxConcurrency) {
              yield* gate.open
              return
            }
            yield* Effect.yieldNow()
          }
        })

        const upload = runUpload({
          stream: fromBytes(new Uint8Array(50).fill(1)),
          chunkSize: 10,
          uploadPart,
          completeUpload: () => {},
          maxConcurrency,
        })

        // Run upload + watcher in parallel; watcher releases the latch once
        // saturation is reached, allowing all in-flight parts to complete.
        yield* Effect.all([upload, watcher], { concurrency: "unbounded" })

        const maxObserved = yield* Ref.get(refMaxObserved)
        expect(maxObserved).toBe(maxConcurrency)
      }),
  )

  // --- 11.6-INT-013 (F#42) — chunkSize=1 ------------------------------------
  // Tiny chunk size must NOT crash. 8 bytes with chunkSize=1 → 8 single-byte
  // parts. Note: at scale this would hit the S3 10k-part limit; that's an
  // Epic 13 candidate (caller-side chunkSize validation against object size).
  it.effect(
    "11.6-INT-013 (F#42) — chunkSize=1: emits one part per byte, no crash",
    () =>
      Effect.gen(function* () {
        const totalBytes = 8
        const seen: Array<{ partNumber: number; length: number }> = []

        const events = yield* runUpload({
          stream: fromBytes(new Uint8Array(totalBytes).fill(1)),
          chunkSize: 1,
          uploadPart: (partNumber, chunk) => {
            seen.push({ partNumber, length: chunk.length })
            return `etag-${partNumber}`
          },
          completeUpload: () => {},
        })

        // 8 single-byte parts uploaded.
        expect(seen).toHaveLength(totalBytes)
        for (const s of seen) expect(s.length).toBe(1)
        expect(seen.map((s) => s.partNumber).sort((a, b) => a - b)).toEqual([
          1, 2, 3, 4, 5, 6, 7, 8,
        ])

        // Stream-level: 8 PartCompleted + 1 UploadCompleted (plus ProgressTicks).
        const partEvents = events.filter((e) => e._tag === "PartCompleted")
        const completeEvent = events.find((e) => e._tag === "UploadCompleted")
        expect(partEvents).toHaveLength(totalBytes)
        expect(completeEvent).toMatchObject({
          _tag: "UploadCompleted",
          totalParts: totalBytes,
        })
      }),
  )

  // --- 11.6-INT-014 (F#43) — chunkSize > totalBytes -------------------------
  // When chunkSize exceeds totalBytes, chunkStream's `flush` path emits the
  // entire buffer as a single part. The user's uploadPart sees one chunk whose
  // length equals totalBytes — the whole file goes in one PUT.
  it.effect(
    "11.6-INT-014 (F#43) — chunkSize > totalBytes: 1 part, body length === totalBytes",
    () =>
      Effect.gen(function* () {
        const totalBytes = 7
        const seenBodies: Uint8Array[] = []
        const sourceBytes = new Uint8Array(totalBytes)
        for (let i = 0; i < totalBytes; i++) sourceBytes[i] = i + 1

        const events = yield* runUpload({
          stream: fromBytes(sourceBytes),
          chunkSize: 1024, // way more than 7
          uploadPart: (_partNumber, chunk) => {
            seenBodies.push(chunk)
            return "etag-only"
          },
          completeUpload: () => {},
        })

        expect(seenBodies).toHaveLength(1)
        expect(seenBodies[0]).toHaveLength(totalBytes)
        expect(Array.from(seenBodies[0]!)).toEqual([1, 2, 3, 4, 5, 6, 7])

        const partEvents = events.filter((e) => e._tag === "PartCompleted")
        expect(partEvents).toHaveLength(1)
        expect(partEvents[0]).toMatchObject({
          partNumber: 1,
          bytesUploaded: totalBytes,
        })
      }),
  )

  // --- 11.6-INT-015 (F#44) — non-integer chunkSize 1024.7 -------------------
  // Epic 13 (Story 13.1): a non-integer chunkSize is REJECTED pre-flight. The
  // guard in upload-stream.ts (`!Number.isInteger(chunkSize)`) throws a
  // TypeError synchronously when uploadMultipartEffect is constructed — before
  // any chunk is read or part uploaded.
  it("11.6-INT-015 (F#44) — non-integer chunkSize 1024.7: rejected pre-flight with TypeError, no uploadPart call", () => {
    let uploadPartCalls = 0
    const construct = () =>
      uploadMultipartEffect({
        stream: fromBytes(new Uint8Array(2048)),
        chunkSize: 1024.7,
        uploadPart: () => {
          uploadPartCalls++
          return "etag"
        },
        completeUpload: () => {},
      })

    expect(construct).toThrow(TypeError)
    expect(construct).toThrow(/positive finite integer/)
    expect(uploadPartCalls).toBe(0)
  })
})
