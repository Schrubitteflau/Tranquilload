import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { uploadMultipart } from "../multipart/index.js"

// Helper: ReadableStream from a Uint8Array, single-shot.
const fromBytes = (bytes: Uint8Array): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start(c) {
      c.enqueue(bytes)
      c.close()
    },
  })

// Helper: ReadableStream that emits one chunk per tick over `chunkCount` ticks
// with a small artificial delay — used to keep the upload in-flight long enough
// to make timing-based assertions stable.
const slowStream = (chunkCount: number, chunkSize: number, delayMs = 5): ReadableStream<Uint8Array> =>
  new ReadableStream({
    async start(controller) {
      for (let i = 0; i < chunkCount; i++) {
        controller.enqueue(new Uint8Array(chunkSize).fill(i))
        await new Promise((r) => setTimeout(r, delayMs))
      }
      controller.close()
    },
  })

describe("uploadMultipart — events / getProgress dual-mode edges (Story 11.6)", () => {
  // --- 11.6-INT-006 (F#33) — cancel events reader mid-upload -----------------
  // The events ReadableStream is buffered: its `start()` does `await collected`
  // BEFORE enqueueing anything (see `multipart/index.ts:173`). So a naive
  // `reader.read()` would block until the upload is fully done — turning a
  // "mid-upload cancel" test into a "post-upload cancel" no-op.
  //
  // Genuine mid-upload assertion: gate `uploadPart` for the first part so the
  // upload is provably in flight (we wait on `partStartedPromise`), THEN cancel
  // the reader, THEN release the gate. The fact that `result` still resolves
  // proves the cancellation did not interrupt the upload fiber. Code-review
  // M1 (Story 11.6, 2026-05-23) — addresses Codex finding.
  it.effect(
    "11.6-INT-006 (F#33) — cancel events reader WHILE upload is in flight: result still resolves",
    () =>
      Effect.gen(function* () {
        let resolvePartStarted!: () => void
        const partStartedPromise = new Promise<void>((r) => {
          resolvePartStarted = r
        })
        let releaseGate!: () => void
        const gate = new Promise<void>((r) => {
          releaseGate = r
        })

        const { events, result, getProgress } = uploadMultipart({
          stream: slowStream(4, 10, 1), // 40 bytes total
          chunkSize: 10,
          uploadPart: async (n) => {
            if (n === 1) {
              resolvePartStarted()
              await gate
            }
            return `etag-${n}`
          },
          completeUpload: () => {},
        })

        // Wait until uploadPart(1) has actually started — proves "mid-upload".
        yield* Effect.promise(() => partStartedPromise)

        // Cancel the reader while upload is provably in flight.
        const reader = events.getReader()
        yield* Effect.promise(() => reader.cancel())

        // Release the gate so the upload can complete.
        releaseGate()

        // Upload completes despite the cancelled consumer.
        const res = yield* Effect.promise(() => result)
        expect(res._tag).toBe("UploadCompleted")
        expect(res.totalParts).toBe(4)

        // Progress reflects all 40 bytes uploaded.
        const finalProgress = yield* Effect.promise(() => getProgress())
        expect(finalProgress.bytesUploaded).toBe(40)
      }),
  )

  // --- 11.6-INT-007 (F#34) — getProgress() (Promise form) before initiate ----
  // F#34's scenario requires a genuine `initiate` boundary — calling
  // `getProgress()` BEFORE initiate resolves must return 0. The earlier version
  // of this test omitted `initiate`, removing the boundary it claimed to lock.
  //
  // Genuine assertion: provide a GATED `initiate` callback, call `getProgress()`
  // while initiate is still pending, assert 0, then release the gate and assert
  // the final value flows through. Code-review M2 (Story 11.6, 2026-05-23) —
  // addresses Codex finding.
  it.effect(
    "11.6-INT-007 (F#34) — getProgress() Promise form returns 0 bytes while initiate is pending",
    () =>
      Effect.gen(function* () {
        let releaseInitiate!: () => void
        const initiateGate = new Promise<void>((r) => {
          releaseInitiate = r
        })

        const { result, getProgress } = uploadMultipart({
          stream: fromBytes(new Uint8Array(25).fill(1)),
          chunkSize: 25,
          initiate: async () => {
            await initiateGate
            return { uploadId: "the-upload-id" }
          },
          uploadPart: () => "etag",
          completeUpload: () => {},
          totalBytes: 25,
        })

        // Promise-form call BEFORE initiate resolves — must return 0 bytes.
        const before = yield* Effect.promise(() => getProgress())
        expect(before.bytesUploaded).toBe(0)

        // Release initiate so the upload can proceed.
        releaseInitiate()

        yield* Effect.promise(() => result)

        const after = yield* Effect.promise(() => getProgress())
        expect(after.bytesUploaded).toBe(25)
      }),
  )

  // --- 11.6-INT-008 (F#35) — getProgress() (Promise form) after completion ---
  // The existing F#35 test asserts post-completion via `getProgress.effect`.
  // This is the Promise-form lock: after `result` resolves, `getProgress()`
  // returns the final bytesUploaded — never collapses back to 0 or `undefined`.
  it.effect(
    "11.6-INT-008 (F#35) — getProgress() Promise form returns final non-zero value after completion",
    () =>
      Effect.gen(function* () {
        const total = 30 // 3 parts × 10 bytes
        const { result, getProgress } = uploadMultipart({
          stream: fromBytes(new Uint8Array(total).fill(1)),
          chunkSize: 10,
          uploadPart: (n) => `etag-${n}`,
          completeUpload: () => {},
        })

        yield* Effect.promise(() => result)

        // Multiple post-completion reads stay at the final value.
        const r1 = yield* Effect.promise(() => getProgress())
        const r2 = yield* Effect.promise(() => getProgress())
        expect(r1.bytesUploaded).toBe(total)
        expect(r2.bytesUploaded).toBe(total)
      }),
  )

  // --- 11.6-INT-009 (F#36) — uploadId promise resolves even on upload failure
  // The `uploadId` Promise is a separate exposure path from `result`. Once
  // `initiate` succeeds and emits `UploadInitiated`, `uploadId` is resolved
  // with the real ID *before* any part is uploaded. A later part failure
  // therefore must NOT cause `uploadId` to reject — it has already settled.
  // This is the contract that lets callers persist `uploadId` for resume
  // *before* knowing the upload's eventual outcome.
  it.effect(
    "11.6-INT-009 (F#36) — uploadId resolves with the real ID even when a later part fails",
    () =>
      Effect.gen(function* () {
        const realUploadId = "upload-id-from-initiate"

        const { result, uploadId } = uploadMultipart({
          stream: fromBytes(new Uint8Array(20).fill(1)),
          chunkSize: 10,
          initiate: () => ({ uploadId: realUploadId }),
          // Reject ALL parts so the upload fails after initiate succeeds.
          uploadPart: () => Promise.reject(new Error("part PUT failed")),
          completeUpload: () => {},
        })

        // result rejects (suppressed here — we only assert uploadId behaviour).
        const resultExit = yield* Effect.exit(
          Effect.tryPromise({ try: () => result, catch: (e) => e }),
        )
        expect(resultExit._tag).toBe("Failure")

        // uploadId Promise STILL resolves with the real ID — never rejects.
        const id = yield* Effect.promise(() => uploadId)
        expect(id).toBe(realUploadId)
      }),
  )

  // --- 11.6-INT-027 (F#90 — latency lens) ------------------------------------
  // Not reading the events ReadableStream must NOT slow the upload. The events
  // stream is built lazily over the internal `collected` Promise; consumers
  // that ignore it should incur no producer-side backpressure. Compare wall-
  // time(noread) vs wall-time(read) for the same workload; ratio must be ≈ 1.
  // Paired with 11.2-INT-017 (cleanup lens) which locks the no-leak side.
  it.effect(
    "11.6-INT-027 (F#90 — latency lens) — not reading events does NOT slow the upload",
    () =>
      Effect.gen(function* () {
        const measure = () =>
          Effect.gen(function* () {
            const start = performance.now()
            const { result } = uploadMultipart({
              stream: slowStream(6, 10, 2), // 60 bytes, ~12ms work
              chunkSize: 10,
              uploadPart: (n) => `etag-${n}`,
              completeUpload: () => {},
            })
            yield* Effect.promise(() => result)
            return performance.now() - start
          })

        const measureWithRead = () =>
          Effect.gen(function* () {
            const start = performance.now()
            const { events, result } = uploadMultipart({
              stream: slowStream(6, 10, 2),
              chunkSize: 10,
              uploadPart: (n) => `etag-${n}`,
              completeUpload: () => {},
            })
            // Read all events alongside the upload.
            const reader = events.getReader()
            const drainEvents = (async () => {
              while (true) {
                const { done } = await reader.read()
                if (done) break
              }
            })()
            yield* Effect.all([
              Effect.promise(() => result),
              Effect.promise(() => drainEvents),
            ])
            return performance.now() - start
          })

        const noRead = yield* measure()
        const withRead = yield* measureWithRead()

        // Sanity floor: both ran some work.
        expect(noRead).toBeGreaterThan(0)
        expect(withRead).toBeGreaterThan(0)

        // Tolerant ratio assertion — production-grade backpressure should keep
        // these within a small factor. We use 5× to absorb CI/timer noise.
        const ratio = Math.max(noRead, withRead) / Math.min(noRead, withRead)
        expect(ratio).toBeLessThan(5)
      }),
  )

  // --- 11.6-INT-028 (F#33 — pre-event cancel) --------------------------------
  // Cancelling the events reader *before any event arrives* must not leak and
  // must not break the upload. Distinct timing from 11.6-INT-006 (mid-upload
  // cancel): here we cancel synchronously before the start() callback finishes
  // its `await collected`. The upload completes via the independent
  // `collected` Promise; getProgress still reflects total bytes.
  it.effect(
    "11.6-INT-028 (F#33 variant) — cancel events reader BEFORE any event arrives: no leak",
    () =>
      Effect.gen(function* () {
        const { events, result, getProgress } = uploadMultipart({
          stream: fromBytes(new Uint8Array(20).fill(1)),
          chunkSize: 10,
          uploadPart: (n) => `etag-${n}`,
          completeUpload: () => {},
        })

        // Cancel immediately — before the events stream's start() even reads.
        const reader = events.getReader()
        yield* Effect.promise(() => reader.cancel())

        // Upload still completes.
        const res = yield* Effect.promise(() => result)
        expect(res._tag).toBe("UploadCompleted")
        expect(res.totalParts).toBe(2)

        // Progress reflects full upload.
        const final = yield* Effect.promise(() => getProgress())
        expect(final.bytesUploaded).toBe(20)
      }),
  )
})
