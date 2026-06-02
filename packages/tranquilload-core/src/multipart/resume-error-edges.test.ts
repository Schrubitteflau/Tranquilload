import { describe, expect, it } from "@effect/vitest"
import { Effect, Schedule, Stream } from "effect"
import {
  CompleteUploadError,
  MaxRetriesExceededError,
  PartUploadError,
  PresignedUrlError,
  ReconcileError,
} from "../errors/upload-error.js"
import { LoggerServiceLive } from "../services/logger-service.js"
import { uploadMultipartEffect } from "./upload-stream.js"

// Story 11.3 — Resume + reconcile + error-mapping edges (R-P2-6, MEDIUM).
// All 6 tests are vitest-integration LOCKs of the lib's phase-accurate
// `UploadError` mapping. No MinIO: callbacks are stubbed. The companion
// `tests/e2e/ui/resume-safety.spec.ts` (Epic 10) covers the real MinIO path.

const fromBytes = (bytes: Uint8Array): ReadableStream<Uint8Array> =>
  new ReadableStream({ start: c => { c.enqueue(bytes); c.close() } })

const run = (options: Parameters<typeof uploadMultipartEffect>[0]) =>
  Stream.runCollect(uploadMultipartEffect(options)).pipe(
    Effect.map(chunk => Array.from(chunk)),
    Effect.provide(LoggerServiceLive)
  )

describe("Story 11.3 — resume + reconcile + error-mapping edges", () => {
  // --- 11.3-INT-001 (F#5) — PresignedUrlError inside uploadPart ------------
  // The adapter obtains its own presigned URL inside `uploadPart`. When that
  // sign step throws a `PresignedUrlError`, the lib does NOT special-case it:
  // it is wrapped exactly like any other `uploadPart` failure (→ PartUploadError
  // on each attempt) and RETRIED uniformly per the schedule. This codifies the
  // design-gap surfaced in brainstorming: there is no fail-fast on
  // PresignedUrlError — a single-attempt schedule surfaces it as
  // `PartUploadError.cause`, a multi-attempt schedule retries it and surfaces
  // `MaxRetriesExceededError.cause`. Both preserve the original PresignedUrlError.
  //
  // Epic 13 candidate: an opt-in fail-fast policy for PresignedUrlError (today
  // the caller must encode it via `Schedule.whileInput`, see the existing
  // upload-stream.test.ts "Schedule.whileInput" test for the opt-out path).
  it.effect("11.3-INT-001 (F#5) — PresignedUrlError in uploadPart wraps as PartUploadError.cause and is retried uniformly", () =>
    Effect.gen(function* () {
      const presigned = new PresignedUrlError(new Error("presigned URL expired"))

      // (a) Single attempt → surfaces directly as PartUploadError, cause preserved.
      let singleCalls = 0
      const single = yield* run({
        stream: fromBytes(new Uint8Array(10).fill(1)),
        chunkSize: 10,
        uploadPart: () => { singleCalls++; throw presigned },
        completeUpload: () => {},
        retrySchedule: Schedule.recurs(0),
      }).pipe(Effect.flip)

      expect(singleCalls).toBe(1)
      expect(single).toBeInstanceOf(PartUploadError)
      expect((single as PartUploadError).attempt).toBe(1)
      expect((single as PartUploadError).cause).toBe(presigned)

      // (b) Multi-attempt → retried uniformly (3 calls), surfaces as
      // MaxRetriesExceededError; the PresignedUrlError survives as the cause.
      let retriedCalls = 0
      const retried = yield* run({
        stream: fromBytes(new Uint8Array(10).fill(1)),
        chunkSize: 10,
        uploadPart: () => { retriedCalls++; throw presigned },
        completeUpload: () => {},
        retrySchedule: Schedule.recurs(2),
      }).pipe(Effect.flip)

      expect(retriedCalls).toBe(3) // retried like any transient failure — no fail-fast
      expect(retried).toBeInstanceOf(MaxRetriesExceededError)
      expect((retried as MaxRetriesExceededError).totalAttempts).toBe(3)
      expect((retried as MaxRetriesExceededError).cause).toBe(presigned)
    })
  )

  // --- 11.3-INT-002 (F#7) — 500 on /parts reconcile -----------------------
  // A 500 on the reconcile (`/parts`) endpoint must surface as `ReconcileError`
  // BEFORE any PUT is attempted. Reconcile is yield-ed in the setup Effect.gen
  // before the parts stream is consumed, so a call counter on `uploadPart`
  // proves zero PUTs happened.
  it.effect("11.3-INT-002 (F#7) — 500 on /parts reconcile fails with ReconcileError before any uploadPart", () =>
    Effect.gen(function* () {
      const reconcile500 = Object.assign(new Error("Internal Server Error"), {
        statusCode: 500,
      })
      let uploadPartCalls = 0

      const result = yield* run({
        stream: fromBytes(new Uint8Array(30).fill(1)),
        chunkSize: 10,
        reconcileCompletedParts: () => Promise.reject(reconcile500),
        uploadPart: (n) => { uploadPartCalls++; return `etag-${n}` },
        completeUpload: () => {},
      }).pipe(Effect.flip)

      expect(result).toBeInstanceOf(ReconcileError)
      expect((result as ReconcileError).cause).toBe(reconcile500)
      // Phase-accurate: failed during reconcile, before any byte was uploaded.
      expect(uploadPartCalls).toBe(0)
    })
  )

  // --- 11.3-INT-003 (F#12) — resume against a deleted uploadId -------------
  // The server reports the persisted uploadId as gone (S3 `NoSuchUpload`) when
  // the resume reconcile runs. Phase-accurate variant is `ReconcileError`
  // (the failure happens during the reconcile phase) carrying the S3-shaped
  // cause. The lib does NOT auto-re-init a fresh multipart upload — that is an
  // Epic 13 candidate (auto-reinit on stale uploadId). Locked: no PUT happens.
  it.effect("11.3-INT-003 (F#12) — resume against deleted uploadId (NoSuchUpload) surfaces ReconcileError, no auto-reinit", () =>
    Effect.gen(function* () {
      const noSuchUpload = Object.assign(
        new Error("The specified multipart upload does not exist"),
        { Code: "NoSuchUpload", $metadata: { httpStatusCode: 404 } }
      )
      let uploadPartCalls = 0

      const result = yield* run({
        stream: fromBytes(new Uint8Array(20).fill(1)),
        chunkSize: 10,
        reconcileCompletedParts: () => Promise.reject(noSuchUpload),
        uploadPart: (n) => { uploadPartCalls++; return `etag-${n}` },
        completeUpload: () => {},
      }).pipe(Effect.flip)

      expect(result).toBeInstanceOf(ReconcileError)
      expect((result as ReconcileError).cause).toBe(noSuchUpload)
      expect(((result as ReconcileError).cause as { Code: string }).Code).toBe("NoSuchUpload")
      // CURRENT BEHAVIOUR — Epic 13 candidate: no auto-re-init on stale uploadId.
      expect(uploadPartCalls).toBe(0)
    })
  )

  // --- 11.3-INT-004 (F#13) — presigned URL expiry recovered via re-sign ----
  // The presigned URL is obtained fresh inside `uploadPart` on every attempt
  // (re-sign-per-attempt). The first attempt fails because the URL had expired;
  // the retry re-signs and succeeds. The upload completes; the first failure is
  // absorbed by the retry machinery (wrapped internally as PartUploadError) and
  // never surfaces — it does not hang. Complements Story 10.3-E2E-002 (real
  // MinIO) with the phase-accurate Effect-channel path.
  it.effect("11.3-INT-004 (F#13) — presigned URL expiry recovers when re-signed per attempt", () =>
    Effect.gen(function* () {
      let signCalls = 0
      let part1Attempts = 0
      const sign = () => { signCalls++; return `https://signed.example/${signCalls}` }

      const events = yield* run({
        stream: fromBytes(new Uint8Array(10).fill(1)),
        chunkSize: 10,
        uploadPart: (n) => {
          const url = sign() // re-sign on every (re)attempt
          if (n === 1) {
            part1Attempts++
            if (part1Attempts === 1) {
              return Promise.reject(new PresignedUrlError(new Error(`URL ${url} expired`)))
            }
          }
          return `etag-${n}`
        },
        completeUpload: () => {},
        retrySchedule: Schedule.recurs(2),
      })

      const completed = events.find(e => e._tag === "UploadCompleted")
      expect(completed).toMatchObject({ _tag: "UploadCompleted", totalParts: 1 })
      // Re-signed per attempt: first (expired) + second (fresh) = 2 signs, 2 attempts.
      expect(part1Attempts).toBe(2)
      expect(signCalls).toBe(2)
    })
  )

  // --- 11.3-INT-005 (F#14) — stale reconcile result (part GC'd) ------------
  // Reconcile reports part 3 as already complete, so the lib skips its PUT and
  // forwards the reconciled etag to completeUpload. But the server GC'd that
  // part between ListParts and complete, so completeUpload rejects with
  // `InvalidPart`. The divergence is NOT detected mid-flight: it surfaces only
  // at the complete phase, mapped to `CompleteUploadError` (phase-accurate).
  // CURRENT BEHAVIOUR — Epic 13 candidate: detect/re-upload a GC'd reconciled
  // part instead of failing at complete.
  it.effect("11.3-INT-005 (F#14) — stale reconciled part surfaces as CompleteUploadError at complete phase", () =>
    Effect.gen(function* () {
      const invalidPart = Object.assign(
        new Error("One or more of the specified parts could not be found"),
        { Code: "InvalidPart", $metadata: { httpStatusCode: 400 } }
      )
      const uploadedPartNumbers: number[] = []

      const result = yield* run({
        stream: fromBytes(new Uint8Array(30).fill(1)),
        chunkSize: 10,
        // Part 3 reportedly already uploaded; the server later GC's it.
        reconcileCompletedParts: () => [{ partNumber: 3, etag: "etag-stale-3" }],
        uploadPart: (n) => { uploadedPartNumbers.push(n); return `etag-fresh-${n}` },
        completeUpload: () => Promise.reject(invalidPart),
      }).pipe(Effect.flip)

      // Part 3 was skipped (trusted from reconcile); only 1 & 2 were PUT.
      expect(uploadedPartNumbers.sort()).toEqual([1, 2])
      // The staleness is invisible until complete → CompleteUploadError.
      expect(result).toBeInstanceOf(CompleteUploadError)
      expect((result as CompleteUploadError).cause).toBe(invalidPart)
    })
  )

  // --- 11.3-INT-006 (F#15) — 0-parts reconcile == fresh start -------------
  // An empty reconcile array for a known uploadId must behave EXACTLY like a
  // fresh upload from part 1. Proven by equivalence: the same source uploaded
  // with `reconcileCompletedParts: () => []` and with no reconcile callback at
  // all produces the identical set of uploadPart calls (= ceil(total/chunk)).
  // Cross-ref: Story 7.2 established "reconcile absent ⇒ identical to fresh".
  it.effect("11.3-INT-006 (F#15) — empty reconcile uploads all parts, identical to a fresh upload", () =>
    Effect.gen(function* () {
      const totalBytes = 50
      const chunkSize = 10
      const expectedParts = Math.ceil(totalBytes / chunkSize) // 5

      // (a) Empty reconcile for a known uploadId.
      const withEmptyReconcile: number[] = []
      const eventsEmpty = yield* run({
        stream: fromBytes(new Uint8Array(totalBytes).fill(1)),
        chunkSize,
        reconcileCompletedParts: () => [],
        uploadPart: (n) => { withEmptyReconcile.push(n); return `etag-${n}` },
        completeUpload: () => {},
      })

      // (b) No reconcile callback at all (genuine fresh upload).
      const withNoReconcile: number[] = []
      yield* run({
        stream: fromBytes(new Uint8Array(totalBytes).fill(1)),
        chunkSize,
        uploadPart: (n) => { withNoReconcile.push(n); return `etag-${n}` },
        completeUpload: () => {},
      })

      // All parts uploaded — count matches the ceil formula.
      expect(withEmptyReconcile.sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5])
      expect(withEmptyReconcile).toHaveLength(expectedParts)
      // Equivalence: empty reconcile == fresh upload (identical PUT set).
      expect(withEmptyReconcile.sort((a, b) => a - b)).toEqual(
        withNoReconcile.sort((a, b) => a - b)
      )

      const completed = eventsEmpty.find(e => e._tag === "UploadCompleted")
      expect(completed).toMatchObject({ _tag: "UploadCompleted", totalParts: expectedParts })
    })
  )
})
