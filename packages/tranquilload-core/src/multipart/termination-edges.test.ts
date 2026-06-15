import { describe, expect } from "@effect/vitest"
import { it as plainIt } from "vitest"
import * as net from "node:net"
import { Cause, Effect, Exit, Schedule, Stream } from "effect"
import { CompleteUploadError, MaxRetriesExceededError, PartUploadError } from "../errors/upload-error.js"
import { LoggerServiceLive } from "../services/logger-service.js"
import { uploadMultipart } from "./index.js"
import { uploadMultipartEffect } from "./upload-stream.js"

/**
 * Story 11.2 — Termination edges (AC #6, AC #7).
 *
 * INT-014 (F#86): TCP RST mid-PUT → `PartUploadError`, no hang. We spin a
 * loopback node:net server that destroys the socket on connect — the lib's
 * uploadPart fetches against it; the rejection must surface as
 * `PartUploadError` within a tight wall-clock budget.
 *
 * INT-015 (F#87): tab-close simulation — vitest-level approximation of the
 * browser foot-gun. Story 13.3 added the opt-in `abortUpload` teardown hook:
 * supplying it makes the lib auto-invoke cleanup with the active `uploadId` on
 * teardown (here, abort) so the orphan multipart can be aborted server-side.
 * The DEFAULT (no `abortUpload`) still orphans — both arms are locked below.
 */

const tinyStream = (bytes: number): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start(c) {
      c.enqueue(new Uint8Array(bytes).fill(1))
      c.close()
    },
  })

const realtimeSleep = (ms: number): Promise<void> =>
  new Promise(r => setTimeout(r, ms))

describe("Story 11.2 — termination edges (R-P2-2)", () => {
  // ────────────────────────────────────────────────────────────────────────────
  // 11.2-INT-014 (F#86) — Server kills TCP mid-PUT → PartUploadError, no hang
  //
  // Strategy: spin a loopback TCP server that immediately `socket.destroy()`s
  // every connection — Node's `fetch` surfaces this as `TypeError("fetch
  // failed", { cause: ECONNRESET / ... })`. The lib's `normalizeCallback` +
  // `mapError` boundary must turn that rejection into `PartUploadError` and
  // settle the upload within a tight wall-clock budget (no hang).
  //
  // Scope (Pattern 3): vitest cannot drive a real S3 / MinIO RST scenario —
  // that's 11.5's chaos cluster. INT-014 locks the local network-error
  // boundary, not the protocol-level RST handling.
  // ────────────────────────────────────────────────────────────────────────────
  plainIt(
    "11.2-INT-014 (F#86) — TCP RST mid-PUT surfaces as PartUploadError within a tight wall-clock budget (no hang)",
    async () => {
      // Loopback server that drops every connection — fetch sees ECONNRESET.
      const server = net.createServer(socket => {
        socket.destroy()
      })
      await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
      const addr = server.address() as net.AddressInfo
      const url = `http://127.0.0.1:${addr.port}/part`

      try {
        // Promise.race against a wall-clock sentinel — the test enforces its
        // OWN budget; otherwise a true hang would fall through to vitest's
        // default 5s timeout and never reach the assertion. Mirrors the
        // pattern used in 11.2-INT-016.
        const start = performance.now()
        const settled = await Promise.race([
          Effect.runPromise(
            Effect.exit(
              Stream.runDrain(
                uploadMultipartEffect({
                  stream: tinyStream(10),
                  chunkSize: 10,
                  uploadPart: async (_n, chunk) => {
                    const res = await fetch(url, {
                      method: "PUT",
                      body: chunk as unknown as BodyInit,
                    })
                    return res.headers.get("ETag") ?? "etag"
                  },
                  completeUpload: () => {},
                  retrySchedule: Schedule.recurs(0),
                }),
              ).pipe(Effect.provide(LoggerServiceLive)),
            ),
          ),
          new Promise<"WALL_CLOCK_TIMEOUT">(resolve =>
            setTimeout(() => resolve("WALL_CLOCK_TIMEOUT"), 5000),
          ),
        ])
        const elapsed = performance.now() - start

        expect(
          settled,
          `upload did NOT settle within 5s — TCP RST surfaced as a hang (elapsed=${elapsed.toFixed(1)}ms)`,
        ).not.toBe("WALL_CLOCK_TIMEOUT")

        const exit = settled as Exit.Exit<void, unknown>
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          const failure = Cause.failureOption(exit.cause)
          expect(failure._tag).toBe("Some")
          if (failure._tag === "Some") {
            expect(failure.value).toBeInstanceOf(PartUploadError)
            const err = failure.value as PartUploadError
            // partNumber should be 1 (mapError from uploadPart, not chunkStream)
            expect(err.partNumber).toBe(1)
            // The cause should be the fetch TypeError (or its wrapped form).
            expect(err.cause).toBeDefined()
          }
        }
      } finally {
        await new Promise<void>(resolve => server.close(() => resolve()))
      }
    },
  )

  // ────────────────────────────────────────────────────────────────────────────
  // 11.2-INT-015 (F#87) — Tab-close simulation: with the opt-in `abortUpload`
  // hook (Story 13.3) the lib auto-invokes cleanup on teardown; without it, the
  // multipart is orphaned (the non-breaking default — still locked here).
  //
  // Scope (Pattern 3): vitest is Node, not a browser — we cannot trigger
  // `window.beforeunload`. The closest approximation is "user starts upload,
  // never awaits, then aborts the in-flight signal but discards the handle".
  // The lock here: `initiate` fires once, `completeUpload` is never reached, and
  // the supplied `abortUpload` is invoked exactly once with the active uploadId
  // so the consumer can notify the server.
  //
  // A genuine browser version of this lock belongs in `tests/e2e/ui/` (out of
  // scope for this story per Dev Notes).
  // ────────────────────────────────────────────────────────────────────────────
  plainIt(
    "11.2-INT-015 (F#87) — tab-close approximation: initiate fires once, completeUpload never reached; opt-in abortUpload fires once with the active uploadId",
    async () => {
      let initiateCalls = 0
      let completeCalls = 0
      let partsStarted = 0
      let abortCalls = 0
      let abortedId = ""

      // Gated callback (Pattern 1 from project_test_timing_boundary_patterns.md):
      // we PROVE initiate has fired before asserting, instead of relying on a
      // fixed sleep that could under-shoot on a slow CI runner.
      let resolveInitiated: () => void = () => {}
      const initiated = new Promise<void>(r => {
        resolveInitiated = r
      })
      let resolvePartStarted: () => void = () => {}
      const partStarted = new Promise<void>(r => {
        resolvePartStarted = r
      })

      const ctrl = new AbortController()

      const handle = uploadMultipart({
        stream: tinyStream(50), // 5 parts × 10 bytes
        chunkSize: 10,
        initiate: () => {
          initiateCalls += 1
          resolveInitiated()
          return { uploadId: "orphan-tab-close-test" }
        },
        uploadPart: async (n) => {
          partsStarted += 1
          if (partsStarted === 1) resolvePartStarted()
          // Slow part — guarantees we can "close the tab" mid-upload.
          await realtimeSleep(80)
          return `etag-${n}`
        },
        completeUpload: () => {
          completeCalls += 1
        },
        abortUpload: (id) => {
          abortCalls += 1
          abortedId = id
        },
        signal: ctrl.signal,
        maxConcurrency: 1,
      })

      // Suppress unhandled-rejection noise; we are intentionally NOT awaiting.
      handle.result.catch(() => {})

      // Wait for initiate AND the first part to have started — gates prove
      // the timing rather than incidental scheduling.
      await initiated
      await partStarted

      expect(initiateCalls, "initiate should fire exactly once at upload start").toBe(1)
      expect(partsStarted, "at least one part should be in-flight before tab close").toBeGreaterThan(0)

      // Closest approximation to "tab closed mid-upload": abort the signal and
      // drop the handle reference. In a real browser, no further JS runs.
      ctrl.abort()

      // Let abort propagate; allow time well past `completeUpload` would have
      // fired if the upload had run to completion (5 parts × 80ms = 400ms).
      await realtimeSleep(150)

      // Lock behaviour (Story 13.3):
      //   - completeUpload was NEVER called → the upload did not finalise.
      //   - initiate fired exactly once → the resource was allocated.
      //   - the opt-in `abortUpload` hook fired exactly once with the active
      //     uploadId → the consumer can now notify a /Abort to S3 / MinIO on
      //     teardown (the orphan-multipart gap is closed when the hook is wired;
      //     the default — no hook — still orphans, per the other arms below).
      expect(
        completeCalls,
        "completeUpload must NOT fire on tab-close — the upload never finalised",
      ).toBe(0)
      expect(initiateCalls).toBe(1)
      expect(
        abortCalls,
        "abortUpload must fire exactly once on teardown so the orphan can be cleaned up",
      ).toBe(1)
      expect(
        abortedId,
        "abortUpload must receive the active uploadId from initiate",
      ).toBe("orphan-tab-close-test")
    },
  )
})

/**
 * Story 13.3 — Abort & cleanup recovery (R-P2-3 + R-P2-9).
 *
 * The opt-in `abortUpload(uploadId)` teardown hook fires once when an upload is
 * torn down AFTER initiate and BEFORE the complete phase (abort OR part-failure
 * — DD1, phase-guarded not cause-guarded). It deliberately does NOT fire on a
 * successful upload, during/after `/complete` (AC#2 guard — the multipart may
 * have landed), or before any uploadId exists (phase 1). These surgical units
 * lock all four phases deterministically — no MinIO, no TestClock.
 */
describe("Story 13.3 — abort & cleanup recovery (R-P2-3 + R-P2-9)", () => {
  // 13.3-INT-001 (C#18) — happy path: a successful upload never triggers cleanup
  // (the complete phase is entered → phase-3 guard skips the finalizer).
  plainIt(
    "13.3-INT-001 (C#18) — successful upload does NOT invoke abortUpload (no false-positive cleanup)",
    async () => {
      let abortCalls = 0
      const handle = uploadMultipart({
        stream: tinyStream(20), // 2 parts × 10 bytes
        chunkSize: 10,
        initiate: () => ({ uploadId: "happy-path" }),
        uploadPart: (n) => `etag-${n}`,
        completeUpload: () => {},
        abortUpload: () => {
          abortCalls += 1
        },
        maxConcurrency: 1,
      })

      const result = await handle.result
      expect(result._tag).toBe("UploadCompleted")
      expect(result.totalParts).toBe(2)
      expect(
        abortCalls,
        "abortUpload must NOT fire on a successful upload",
      ).toBe(0)
    },
  )

  // 13.3-INT-002 (C#20) — complete-phase guard: an abort/failure DURING /complete
  // must NOT auto-abort the multipart (it may have landed server-side). Recovery
  // is via resumeState (documented contract), not a destructive auto-delete.
  plainIt(
    "13.3-INT-002 (C#20) — failure during /complete does NOT invoke abortUpload (phase-3 guard)",
    async () => {
      let abortCalls = 0
      const handle = uploadMultipart({
        stream: tinyStream(20),
        chunkSize: 10,
        initiate: () => ({ uploadId: "complete-abort" }),
        uploadPart: (n) => `etag-${n}`,
        // Simulate an abort landing during the final commit: completeUpload throws.
        completeUpload: () => {
          throw new Error("aborted during complete")
        },
        abortUpload: () => {
          abortCalls += 1
        },
        maxConcurrency: 1,
      })

      let caught: unknown
      try {
        await handle.result
      } catch (err) {
        caught = err
      }
      expect(caught).toBeInstanceOf(CompleteUploadError)
      expect(
        abortCalls,
        "abortUpload must NOT fire once the complete phase is entered — the multipart may have landed",
      ).toBe(0)
    },
  )

  // 13.3-INT-003 (C#18, DD1) — any-teardown: a part exhausting its retry budget
  // (no abort signal) ALSO leaves an orphan, so the cleanup fires.
  plainIt(
    "13.3-INT-003 (C#18) — part-failure teardown invokes abortUpload with the uploadId (any teardown, not just abort)",
    async () => {
      let abortCalls = 0
      let abortedId = ""
      const handle = uploadMultipart({
        stream: tinyStream(20),
        chunkSize: 10,
        initiate: () => ({ uploadId: "part-failure" }),
        uploadPart: () => {
          throw new Error("part always fails")
        },
        completeUpload: () => {},
        abortUpload: (id) => {
          abortCalls += 1
          abortedId = id
        },
        // recurs(1) → 2 total attempts → MaxRetriesExceededError (deterministic,
        // no delay → no TestClock needed).
        retrySchedule: Schedule.recurs(1),
        maxConcurrency: 1,
      })

      let caught: unknown
      try {
        await handle.result
      } catch (err) {
        caught = err
      }
      expect(caught).toBeInstanceOf(MaxRetriesExceededError)
      expect(
        abortCalls,
        "abortUpload must fire on a part-failure teardown (orphan left behind)",
      ).toBe(1)
      expect(abortedId).toBe("part-failure")
    },
  )

  // 13.3-INT-004 (C#18) — phase-1 guard: with no initiate, no uploadId is ever
  // created, so there is nothing to clean up even when a part fails.
  plainIt(
    "13.3-INT-004 (C#18) — pre-initiate teardown does NOT invoke abortUpload (no uploadId to abort)",
    async () => {
      let abortCalls = 0
      const handle = uploadMultipart({
        stream: tinyStream(10), // 1 part
        chunkSize: 10,
        // No `initiate` → refUploadId stays "".
        uploadPart: () => {
          throw new Error("part fails, no uploadId exists")
        },
        completeUpload: () => {},
        abortUpload: () => {
          abortCalls += 1
        },
        retrySchedule: Schedule.recurs(0), // single attempt → PartUploadError
        maxConcurrency: 1,
      })

      let caught: unknown
      try {
        await handle.result
      } catch (err) {
        caught = err
      }
      expect(caught).toBeInstanceOf(PartUploadError)
      expect(
        abortCalls,
        "abortUpload must NOT fire when no uploadId was ever created (phase 1)",
      ).toBe(0)
    },
  )

  // 13.3-INT-005 (C#18) — resume-path teardown: a resumed upload's uploadId is
  // live (set by resumeFrom, not initiate), so a teardown during its part phase
  // fires abortUpload with the RESUMED uploadId. Documented interaction: with
  // both `resumeFrom` and `abortUpload` wired, a part-failure cleans up the
  // resumable multipart — abortUpload does not receive the cause, so it cannot
  // distinguish a user abort from a transient failure. (See abortUpload TSDoc.)
  plainIt(
    "13.3-INT-005 (C#18) — resume-path part-failure invokes abortUpload with the resumed uploadId",
    async () => {
      let abortCalls = 0
      let abortedId = ""
      const handle = uploadMultipart({
        stream: tinyStream(10), // 1 part
        chunkSize: 10,
        // Resume: uploadId comes from resumeFrom, NOT initiate.
        resumeFrom: {
          version: 1,
          uploadId: "resumed-id",
          chunkSize: 10,
          contentDigestCaptured: false,
        },
        uploadPart: () => {
          throw new Error("resumed part fails")
        },
        completeUpload: () => {},
        abortUpload: (id) => {
          abortCalls += 1
          abortedId = id
        },
        retrySchedule: Schedule.recurs(0),
        maxConcurrency: 1,
      })

      let caught: unknown
      try {
        await handle.result
      } catch (err) {
        caught = err
      }
      expect(caught).toBeInstanceOf(PartUploadError)
      expect(
        abortCalls,
        "abortUpload fires on a resumed upload's teardown (the resumed uploadId is live)",
      ).toBe(1)
      expect(abortedId).toBe("resumed-id")
    },
  )
})
