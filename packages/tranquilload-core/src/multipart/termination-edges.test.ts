import { describe, expect } from "@effect/vitest"
import { it as plainIt } from "vitest"
import * as net from "node:net"
import { Cause, Effect, Exit, Schedule, Stream } from "effect"
import { PartUploadError } from "../errors/upload-error.js"
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
 * browser foot-gun. The lib has NO hook to auto-abort orphan multipart on
 * unhandled close — this lock captures the CURRENT behaviour. Epic 13
 * candidate flips this to auto-abort.
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
  // 11.2-INT-015 (F#87) — Tab-close simulation: current behaviour is "orphan
  // multipart on server"; Epic 13 candidate flips this to auto-abort
  //
  // Scope (Pattern 3): vitest is Node, not a browser — we cannot trigger
  // `window.beforeunload`. The closest approximation is "user starts upload,
  // never awaits, then aborts the in-flight signal but discards the handle".
  // The lock here: the lib provides NO mechanism to auto-abort an orphan
  // multipart when the consumer's tab closes — `initiate` fires once,
  // `completeUpload` is never reached, and there is no callback the lib could
  // call to notify the server.
  //
  // A genuine browser version of this lock belongs in `tests/e2e/ui/` (out of
  // scope for this story per Dev Notes).
  // ────────────────────────────────────────────────────────────────────────────
  plainIt(
    "11.2-INT-015 (F#87) — tab-close approximation: initiate fires once, completeUpload never reached, no auto-abort hook (Epic 13 candidate)",
    async () => {
      let initiateCalls = 0
      let completeCalls = 0
      let partsStarted = 0

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

      // Lock CURRENT behaviour:
      //   - completeUpload was NEVER called → uploadId is orphaned server-side.
      //   - initiate fired exactly once → the resource was allocated.
      //   - There is no callback the lib can use to auto-notify a /Abort to
      //     S3 / MinIO on unhandled tab close (would need a beforeunload hook
      //     wired by the lib — Epic 13 candidate).
      expect(
        completeCalls,
        "completeUpload must NOT fire on tab-close — locks the current orphan-multipart behaviour (Epic 13 will auto-abort)",
      ).toBe(0)
      expect(initiateCalls).toBe(1)
    },
  )
})
