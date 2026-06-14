import { test, expect } from "@playwright/test"
import { ENGINES, runOnEngine } from "@support/helpers/chaos-engines.js"
import { driveMultipartInPage, installPutChaos } from "@support/helpers/lib-multipart-driver.js"
import { headObjectSize, loadMinioEnv, makeMinioClient } from "@support/helpers/minio-client.js"

/**
 * Story 11.5 — Degraded-network chaos cluster (C#12, C#13, C#15).
 *
 * R-P2-9 (BUS, MEDIUM) — behaviour under slow / high-latency / slow-loris
 * conditions.
 *
 * Scope (honest, per project_test_timing_boundary_patterns.md Pattern 3):
 * we emulate degraded transport with per-PUT `context.route` latency rather
 * than a true bandwidth shaper (CDP `Network.emulateNetworkConditions` is
 * Chromium-only; this matrix runs all 3 engines). The load-bearing lock is
 * "the lib has NO hardcoded client-side timeout that fires under slow
 * transport, and abort stays responsive regardless of latency" — independent
 * of the exact kbps profile.
 */

const MiB = 1024 * 1024
const CHUNK = 5 * MiB

const minioEnv = loadMinioEnv()
const minioClient = makeMinioClient(minioEnv)
test.afterAll(() => minioClient.destroy())

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const uniq = (tag: string, engine: string) => `chaos-${tag}-${engine}-${Date.now()}.bin`

for (const [engine, browserType] of ENGINES) {
  test.describe(`R-P2-9 degraded chaos [${engine}] (PW-Lib)`, () => {
    test(`11.5-E2E-008 (C#12) [${engine}] — slow transport: no premature timeout, upload completes`, async () => {
      test.slow()
      await runOnEngine(
        browserType,
        async ({ page, context }) => {
          // Slow-3G stand-in: ~400ms of added latency on every part PUT. No
          // client-side timeout should fire — the upload just completes slowly.
          await installPutChaos(context, async ({ route }) => {
            await sleep(400)
            await route.continue()
          })

          const filename = uniq("c12", engine)
          const totalBytes = 6 * MiB
          const result = await page.evaluate(driveMultipartInPage, {
            filename,
            totalBytes,
            chunkSize: CHUNK,
            maxConcurrency: 1,
          })

          expect(result.ok, `slow transport must still complete; error=${JSON.stringify(result.error)}`).toBe(true)
          expect(result.events).toContain("UploadCompleted")
          const size = await headObjectSize(minioClient, minioEnv.bucket, result.key!)
          expect(size).toBe(totalBytes)
        },
        engine,
      )
    })

    test(`11.5-E2E-009 (C#13) [${engine}] — abort stays responsive under high latency`, async () => {
      await runOnEngine(
        browserType,
        async ({ page, context }) => {
          // High latency: each PUT is stalled 5s. We abort the moment the first
          // PUT is dispatched — abort responsiveness matters more than upload
          // completion. A responsive abort rejects within a fraction of the 5s
          // latency, NOT after it.
          await installPutChaos(context, async ({ route }) => {
            await sleep(5_000)
            // The request is very likely already aborted by the page; continuing
            // a handled route throws — swallow it.
            await route.continue().catch(() => {})
          })

          const result = await page.evaluate(driveMultipartInPage, {
            filename: uniq("c13", engine),
            totalBytes: 6 * MiB,
            chunkSize: CHUNK,
            maxConcurrency: 1,
            abort: { when: "duringFirstPart" },
          })

          expect(result.ok).toBe(false)
          expect(result.error?._tag).toBe("AbortError")
          expect(result.abortLatencyMs).not.toBeNull()
          // Tighter ceiling than the C#8 backoff case (1s, not 2s): here there is
          // no backoff sleep to interrupt — just an in-flight fetch — so a
          // responsive abort rejects almost immediately. Sharper regression signal.
          expect(
            result.abortLatencyMs!,
            `abort must stay responsive under 5s latency, got ${result.abortLatencyMs}ms`,
          ).toBeLessThan(1_000)
        },
        engine,
      )
    })

    test(`11.5-E2E-010 (C#15) [${engine}] — slow-loris part still completes with no partTimeout (non-breaking default; partTimeout shipped opt-in in Story 13.4)`, async () => {
      test.slow()
      await runOnEngine(
        browserType,
        async ({ page, context }) => {
          // Slow-loris stand-in: part 1's transfer is trickled (here ~3s; a real
          // slow-loris drags 30s+). With NO `partTimeout` the upload STILL
          // completes — the lib does not abort a slow part. Story 13.4 shipped an
          // opt-in `partTimeout` to bound a pathologically slow part; this E2E
          // lock now guards the NON-BREAKING DEFAULT (no partTimeout → no
          // hardcoded client timeout). The deterministic partTimeout behaviour is
          // locked at the unit tier (upload-stream.test.ts 13.4-INT-001/002/003);
          // here we keep the "no hardcoded client timeout" default lock. We cap
          // the trickle at a few seconds to keep the nightly suite fast — the lock
          // is the default behaviour, not the exact trickle duration.
          await installPutChaos(context, async ({ route, partNumber }) => {
            if (partNumber === 1) await sleep(3_000)
            await route.continue()
          })

          const filename = uniq("c15", engine)
          const totalBytes = 6 * MiB
          const result = await page.evaluate(driveMultipartInPage, {
            filename,
            totalBytes,
            chunkSize: CHUNK,
            maxConcurrency: 1,
          })

          expect(result.ok, `slow-loris part must still complete; error=${JSON.stringify(result.error)}`).toBe(true)
          expect(result.events).toContain("UploadCompleted")
          const size = await headObjectSize(minioClient, minioEnv.bucket, result.key!)
          expect(size).toBe(totalBytes)
        },
        engine,
      )
    })
  })
}
