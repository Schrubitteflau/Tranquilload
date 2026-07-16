import { test, expect } from "@playwright/test"
import { ENGINES, runOnEngine } from "@support/helpers/chaos-engines.js"
import { driveMultipartInPage, installPutChaos } from "@support/helpers/lib-multipart-driver.js"
import { headObjectSize, loadMinioEnv, makeMinioClient } from "@support/helpers/minio-client.js"

/**
 * Story 11.5 — Simultaneous chaos cluster (C#7, C#8).
 *
 * R-P2-3 (TECH, HIGH) — concurrent-failure + interrupt semantics.
 *   - C#7: two parts fail at the same time → each retries with INDEPENDENT
 *     state (no shared-counter leakage across the concurrent retry loops).
 *   - C#8: an abort fired while a part is parked in exponential backoff wins
 *     IMMEDIATELY — `Effect.raceFirst` interrupts the backoff sleep rather than
 *     waiting it out (MEMORY: `Effect.raceFirst` not `Effect.race`). A
 *     regression to `Effect.race` would let the (here: 10s) backoff settle.
 */

const MiB = 1024 * 1024
const CHUNK = 5 * MiB

const minioEnv = loadMinioEnv()
const minioClient = makeMinioClient(minioEnv)
test.afterAll(() => minioClient.destroy())

const uniq = (tag: string, engine: string) => `chaos-${tag}-${engine}-${Date.now()}.bin`

for (const [engine, browserType] of ENGINES) {
  test.describe(`R-P2-3 simultaneous chaos [${engine}] (PW-Lib)`, () => {
    test(`11.5-E2E-006 (C#7) [${engine}] — parts 2 and 3 fail simultaneously, retry independently, complete`, async () => {
      test.slow()
      await runOnEngine(
        browserType,
        async ({ page, context }) => {
          // Fail the FIRST attempt of parts 2 AND 3 at the same time (all parts
          // run concurrently at maxConcurrency=3). Each must recover on its own
          // retry without corrupting the other's attempt state.
          await installPutChaos(context, async ({ route, partNumber, attempt }) => {
            if ((partNumber === 2 || partNumber === 3) && attempt === 1) {
              await route.abort("failed")
              return
            }
            await route.continue()
          })

          const filename = uniq("c7", engine)
          const totalBytes = 11 * MiB // 3 parts
          const result = await page.evaluate(driveMultipartInPage, {
            filename,
            totalBytes,
            chunkSize: CHUNK,
            maxConcurrency: 3,
          })

          expect(result.ok, `expected completion; error=${JSON.stringify(result.error)}`).toBe(true)
          expect(result.events).toContain("UploadCompleted")
          // Independent retry state: part 1 never failed (1 attempt); parts 2 & 3
          // each retried exactly once (2 attempts). No cross-part counter leak.
          expect(result.partAttempts).toEqual({ "1": 1, "2": 2, "3": 2 })

          const size = await headObjectSize(minioClient, minioEnv.bucket, result.key!)
          expect(size, `full object present after simultaneous-failure recovery (key=${result.key})`).toBe(totalBytes)
        },
        engine,
      )
    })

    test(`11.5-E2E-007 (C#8) [${engine}] — abort during backoff wins immediately (raceFirst, not race)`, async () => {
      await runOnEngine(
        browserType,
        async ({ page, context }) => {
          // Every PUT fails, so part 1 enters the retry backoff. We supply a
          // LONG (10s) spaced backoff so the abort-vs-backoff race is
          // unambiguous: if raceFirst works, the upload rejects within a few ms
          // of abort(); a regression to Effect.race would block ~10s.
          await installPutChaos(context, async ({ route }) => {
            await route.abort("failed")
          })

          const result = await page.evaluate(driveMultipartInPage, {
            filename: uniq("c8", engine),
            totalBytes: 6 * MiB,
            chunkSize: CHUNK,
            maxConcurrency: 1,
            retry: { delayMs: 10_000, recurs: 3, kind: "spaced" },
            abort: { when: "firstPartFailure" },
          } as const)

          expect(result.ok).toBe(false)
          expect(result.error?._tag).toBe("AbortError")
          // Only the first attempt ran — the abort interrupted the 10s backoff
          // before a second attempt could fire.
          expect(result.partAttempts["1"]).toBe(1)
          // The clinching assertion: abort latency is a tiny fraction of the 10s
          // backoff. We allow a generous 2s ceiling for slow CI engines; a
          // regression to Effect.race would measure ~10s.
          expect(result.abortLatencyMs).not.toBeNull()
          expect(
            result.abortLatencyMs!,
            `abort must interrupt the 10s backoff immediately, got ${result.abortLatencyMs}ms`,
          ).toBeLessThan(2_000)
        },
        engine,
      )
    })
  })
}
