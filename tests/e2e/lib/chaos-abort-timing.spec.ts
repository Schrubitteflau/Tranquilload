import { test, expect } from "@playwright/test"
import { ENGINES, runOnEngine } from "@support/helpers/chaos-engines.js"
import { driveMultipartInPage, installApiDelay } from "@support/helpers/lib-multipart-driver.js"

/**
 * Story 11.5 — Abort-timing chaos cluster (C#18, C#19, C#20).
 *
 * R-P2-3 — teardown semantics when an abort fires in each multipart phase.
 * These lock the DOCUMENTED current behaviour; two of the three surface Epic 13
 * candidates (orphan-multipart cleanup on initiate-abort; clean late-stage
 * recovery on complete-abort).
 *
 * MEMORY: AbortSignal must be wired into user callbacks — the driver threads the
 * signal into every fetch, so an abort interrupts the in-flight request AND the
 * orchestration fiber (`Effect.raceFirst`).
 */

const MiB = 1024 * 1024
const CHUNK = 5 * MiB
const uniq = (tag: string, engine: string) => `chaos-${tag}-${engine}-${Date.now()}.bin`

for (const [engine, browserType] of ENGINES) {
  test.describe(`R-P2-3 abort-timing chaos [${engine}] (PW-Lib)`, () => {
    test(`11.5-E2E-011 (C#18) [${engine}] — abort during /initiate aborts cleanly (orphan-multipart gap documented)`, async () => {
      await runOnEngine(
        browserType,
        async ({ page, context }) => {
          // Hold /initiate in-flight so the abort lands during it.
          await installApiDelay(context, "/api/multipart/initiate", 2_000)

          const result = await page.evaluate(driveMultipartInPage, {
            filename: uniq("c18", engine),
            totalBytes: 6 * MiB,
            chunkSize: CHUNK,
            maxConcurrency: 1,
            abort: { when: "duringInitiate" },
          })

          expect(result.ok).toBe(false)
          // Aborting during initiate surfaces either AbortError (orchestration
          // fiber interrupted first) or InitiateUploadError (the aborted initiate
          // fetch throws first) — both are valid teardown outcomes for a request
          // interrupted before any uploadId reached the client.
          expect(["AbortError", "InitiateUploadError"]).toContain(result.error?._tag)
          // No part ever started; nothing completed.
          expect(result.completedParts).toBe(0)
          expect(result.partAttempts).toEqual({})
          // Epic 13 candidate: if the request reached the server before the abort,
          // MinIO may hold an ORPHAN multipart (the lib does not auto-abort it on
          // initiate-abort). Documented gap — not asserted here because creation
          // is timing-dependent (the route holds the request client-side).
        },
        engine,
      )
    })

    test(`11.5-E2E-012 (C#19) [${engine}] — abort between parts: partial progress, never completed`, async () => {
      test.slow()
      await runOnEngine(
        browserType,
        async ({ page }) => {
          // 3 parts, sequential. Abort fires the instant part 1's uploadPart
          // callback returns its ETag — i.e. BETWEEN part 1 and part 2.
          //
          // We trigger the abort from the CALLBACK, not the event stream: the
          // lib's event ReadableStream batches at completion and is torn down on
          // abort (MEMORY: "log batches events at completion"), so a drain-based
          // trigger never fires mid-upload and `events`/`completedParts` read
          // empty on the abort path. `partsCompletedViaCallback` is the reliable
          // partial-progress signal.
          const result = await page.evaluate(driveMultipartInPage, {
            filename: uniq("c19", engine),
            totalBytes: 11 * MiB,
            chunkSize: CHUNK,
            maxConcurrency: 1,
            abort: { when: "afterPartCallback", afterPart: 1 },
          })

          expect(result.ok).toBe(false)
          expect(result.error?._tag).toBe("AbortError")
          // Exactly one part landed (partial state) before the abort…
          expect(result.partsCompletedViaCallback).toBe(1)
          // …and the upload never completed.
          expect(result.events).not.toContain("UploadCompleted")
          // The orphan multipart (1 part on MinIO, never completed) is the
          // documented current behaviour; auto-abort on tab close is an Epic 13
          // candidate (F#87).
        },
        engine,
      )
    })

    test(`11.5-E2E-013 (C#20) [${engine}] — abort during /complete: no clean late-stage recovery (Epic 13 candidate)`, async () => {
      test.slow()
      await runOnEngine(
        browserType,
        async ({ page, context }) => {
          // All parts upload normally; only /complete is held in-flight so the
          // abort lands during the final commit.
          await installApiDelay(context, "/api/multipart/complete", 2_000)

          const result = await page.evaluate(driveMultipartInPage, {
            filename: uniq("c20", engine),
            totalBytes: 6 * MiB,
            chunkSize: CHUNK,
            maxConcurrency: 1,
            abort: { when: "duringComplete" },
          })

          expect(result.ok).toBe(false)
          // Either AbortError (fiber interrupted) or CompleteUploadError (the
          // aborted /complete fetch throws first) — both leave the upload in an
          // unrecoverable late state with NO clean recovery API.
          expect(["AbortError", "CompleteUploadError"]).toContain(result.error?._tag)
          expect(result.events).not.toContain("UploadCompleted")
          // Epic 13 candidate: a late-stage `/complete` abort has no recovery
          // path — the caller cannot resume or cleanly finalise (C#20).
        },
        engine,
      )
    })
  })
}
