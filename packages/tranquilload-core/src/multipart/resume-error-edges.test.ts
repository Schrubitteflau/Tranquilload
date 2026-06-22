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
  // sign step throws a `PresignedUrlError`, the lib does NOT special-case it by
  // default: it is wrapped like any other `uploadPart` failure (→ PartUploadError
  // on each attempt) and RETRIED uniformly per the schedule — arms (a)/(b),
  // which lock the non-breaking DEFAULT.
  //
  // Story 13.4 adds an opt-in `failFast` predicate (arm (c)): the caller
  // classifies a cause as unrecoverable and the part fails immediately on that
  // attempt WITHOUT consuming the retry budget. `failFast` is ergonomic sugar
  // over the equivalent `Schedule.whileInput` path (see the existing
  // upload-stream.test.ts "Schedule.whileInput" test). The DEFAULT (no
  // `failFast`) is unchanged — still uniform retry.
  it.effect("11.3-INT-001 (F#5) — PresignedUrlError: retried uniformly by default; opt-in failFast skips the retry budget", () =>
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

      // (c) OPT-IN failFast → fails immediately on the first attempt, the retry
      // budget (recurs(2) = 3 total) is NOT consumed. Surfaces as PartUploadError
      // (attempt 1, totalAttempts <= 1), cause preserved.
      let failFastCalls = 0
      const failFasted = yield* run({
        stream: fromBytes(new Uint8Array(10).fill(1)),
        chunkSize: 10,
        uploadPart: () => { failFastCalls++; throw presigned },
        completeUpload: () => {},
        retrySchedule: Schedule.recurs(2), // budget of 3 — failFast skips it
        failFast: (cause) => cause instanceof PresignedUrlError,
      }).pipe(Effect.flip)

      expect(failFastCalls).toBe(1) // fail-fast: retry budget untouched
      expect(failFasted).toBeInstanceOf(PartUploadError)
      expect((failFasted as PartUploadError).attempt).toBe(1)
      expect((failFasted as PartUploadError).cause).toBe(presigned)
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
  // the resume reconcile runs. Two arms:
  //  (a) DEFAULT (no `reinitOnStale`) — phase-accurate `ReconcileError` carrying
  //      the S3-shaped cause; no PUT happens (non-breaking default preserved).
  //  (b) OPT-IN `reinitOnStale` + `initiate` — the lib abandons the stale
  //      uploadId, re-initiates a fresh multipart and completes from part 1.
  // Story 13.2 flipped arm (b) from the Epic 11 lock ("no auto-reinit").
  it.effect("11.3-INT-003 (F#12) — resume against deleted uploadId (NoSuchUpload): default fails fast, reinitOnStale auto-reinitiates from part 1", () =>
    Effect.gen(function* () {
      const noSuchUpload = Object.assign(
        new Error("The specified multipart upload does not exist"),
        { Code: "NoSuchUpload", $metadata: { httpStatusCode: 404 } }
      )

      // (a) Default (no reinitOnStale) — fail-fast ReconcileError, no PUT.
      let defaultCalls = 0
      const failed = yield* run({
        stream: fromBytes(new Uint8Array(20).fill(1)),
        chunkSize: 10,
        reconcileCompletedParts: () => Promise.reject(noSuchUpload),
        uploadPart: (n) => { defaultCalls++; return `etag-${n}` },
        completeUpload: () => {},
      }).pipe(Effect.flip)

      expect(failed).toBeInstanceOf(ReconcileError)
      expect((failed as ReconcileError).cause).toBe(noSuchUpload)
      expect(((failed as ReconcileError).cause as { Code: string }).Code).toBe("NoSuchUpload")
      expect(defaultCalls).toBe(0)

      // (b) Opt-in reinitOnStale + initiate — abandon stale uploadId, re-initiate
      // from part 1, complete against the fresh uploadId.
      let reinitCalls = 0
      const events = yield* run({
        stream: fromBytes(new Uint8Array(20).fill(1)),
        chunkSize: 10,
        reconcileCompletedParts: () => Promise.reject(noSuchUpload),
        reinitOnStale: (cause) => (cause as { Code?: string })?.Code === "NoSuchUpload",
        initiate: () => ({ uploadId: "reinit-fresh-id" }),
        uploadPart: (n) => { reinitCalls++; return `etag-${n}` },
        completeUpload: () => {},
      })

      // Re-initiated from scratch: both parts (20 bytes / chunkSize 10) uploaded fresh.
      expect(reinitCalls).toBe(2)
      // A fresh UploadInitiated for the new uploadId was emitted (observability preserved).
      const initiated = events.find(e => e._tag === "UploadInitiated")
      expect(initiated).toMatchObject({ _tag: "UploadInitiated", uploadId: "reinit-fresh-id" })
      // Terminal completion against the fresh uploadId.
      const completed = events.find(e => e._tag === "UploadCompleted")
      expect(completed).toMatchObject({ _tag: "UploadCompleted", uploadId: "reinit-fresh-id", totalParts: 2 })

      // (c) Reinit during a REAL cross-session resume: a STALE `resumeFrom.uploadId`
      // must be overridden by the freshly re-initiated id — both in the terminal
      // event AND in the uploadId handed to completeUpload. Locks the invariant
      // that the reinit branch wins over the resume branch (refUploadId is the
      // fresh id, never the stale resume id).
      let completedWith = ""
      const resumeEvents = yield* run({
        stream: fromBytes(new Uint8Array(20).fill(1)),
        chunkSize: 10,
        resumeFrom: {
          version: 1,
          uploadId: "stale-resume-id",
          chunkSize: 10,
          contentDigestCaptured: false,
        },
        reconcileCompletedParts: () => Promise.reject(noSuchUpload),
        reinitOnStale: (cause) => (cause as { Code?: string })?.Code === "NoSuchUpload",
        initiate: () => ({ uploadId: "reinit-fresh-id" }),
        uploadPart: (n) => `etag-${n}`,
        completeUpload: (uploadId) => { completedWith = uploadId },
      })

      // The stale resume id never reaches completeUpload — the reinit id wins.
      expect(completedWith).toBe("reinit-fresh-id")
      const resumeCompleted = resumeEvents.find(e => e._tag === "UploadCompleted")
      expect(resumeCompleted).toMatchObject({ _tag: "UploadCompleted", uploadId: "reinit-fresh-id" })
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
  // STILL A LOCK — Story 13.7 (spike) RESOLVED → decline/document-only
  // (Project Lead, 2026-06-22, via design pass + AskUserQuestion). The
  // literal "detect/re-upload a GC'd reconciled part" AC is not honestly
  // deliverable: (1) the protocol-agnostic core can't tell which part S3's
  // `InvalidPart` refers to without parsing S3 error strings; (2) the
  // reconciled chunk is discarded after the skip and the source is drained by
  // the complete phase, so an in-band re-upload needs unbounded retention
  // (defeats resume) — bounded retention only covers a GC'd part in the
  // retained window, not the general case. The recovery capability already
  // exists caller-side (verify-before-skip in `reconcileCompletedParts`, or
  // catch `CompleteUploadError` → re-probe → re-invoke with a fresh source).
  // So 13.7 ships NO library code; it documents the trust boundary + remedies
  // (README "Reconciled-part integrity" + `reconcileCompletedParts` TSDoc).
  // This test stays GREEN — NOT flipped — locking the current
  // CompleteUploadError-at-complete behaviour as the documented boundary.
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
