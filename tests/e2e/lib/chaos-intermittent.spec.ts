import { test, expect } from "@playwright/test"
import { ENGINES, runOnEngine } from "@support/helpers/chaos-engines.js"
import { driveMultipartInPage, installPutChaos } from "@support/helpers/lib-multipart-driver.js"
import {
  headObjectSize,
  loadMinioEnv,
  makeMinioClient,
} from "@support/helpers/minio-client.js"

/**
 * Story 11.5 — Intermittent chaos cluster (C#1, C#3, C#4, C#5, C#6).
 *
 * R-P2-3 (TECH, HIGH) — retry/abort semantics under realistic adversarial
 * conditions. These PW-Lib specs drive a REAL presigned multipart upload from
 * `bench.html` against MinIO and inject PUT-level failures via
 * `context.route` (the browser PUTs DIRECTLY to MinIO `:9000`, so the Fastify
 * `/api/chaos` endpoint cannot see them).
 *
 * Phase-accurate error mapping (lib contract, MEMORY: UploadError phase mapping):
 *   - part-phase failure, single attempt          → PartUploadError
 *   - part-phase failure, retries exhausted        → MaxRetriesExceededError(partNumber)
 *   - complete-phase failure (InvalidPart on /complete) → CompleteUploadError
 */

const MiB = 1024 * 1024
const CHUNK = 5 * MiB

const minioEnv = loadMinioEnv()
const minioClient = makeMinioClient(minioEnv)
test.afterAll(() => minioClient.destroy())

const uniq = (tag: string, engine: string) => `chaos-${tag}-${engine}-${Date.now()}.bin`

for (const [engine, browserType] of ENGINES) {
  test.describe(`R-P2-3 intermittent chaos [${engine}] (PW-Lib)`, () => {
    test(`11.5-E2E-001 (C#1) [${engine}] — intermittent PUT loss completes via retries`, async () => {
      test.slow()
      await runOnEngine(
        browserType,
        async ({ page, context }) => {
          // Deterministic stand-in for "30% of PUTs fail randomly": fail the
          // FIRST attempt of every part, then let the retry through. Chosen over
          // Math.random to keep the cross-browser matrix non-flaky while still
          // proving the lib recovers transient part-PUT loss via retries.
          await installPutChaos(context, async ({ route, attempt }) => {
            if (attempt === 1) {
              await route.abort("failed")
              return
            }
            await route.continue()
          })

          const filename = uniq("c1", engine)
          const totalBytes = 11 * MiB // 5 + 5 + 1 → 3 parts
          const result = await page.evaluate(driveMultipartInPage, {
            filename,
            totalBytes,
            chunkSize: CHUNK,
            maxConcurrency: 3,
          })

          expect(result.ok, `expected completion despite transient loss; error=${JSON.stringify(result.error)}`).toBe(true)
          expect(result.events).toContain("UploadCompleted")
          // Every part was retried exactly once (attempt 1 failed, attempt 2 ok).
          expect(result.partAttempts).toEqual({ "1": 2, "2": 2, "3": 2 })

          expect(result.key, "driver must surface the object key").toBeTruthy()
          const size = await headObjectSize(minioClient, minioEnv.bucket, result.key!)
          expect(size, `full object must be present on MinIO after retried completion (key=${result.key})`).toBe(totalBytes)
        },
        engine,
      )
    })

    test(`11.5-E2E-002 (C#3) [${engine}] — sustained outage exhausts the default schedule (tuning need)`, async () => {
      await runOnEngine(
        browserType,
        async ({ page, context }) => {
          // C#3 models an 8s offline window. The default schedule is 3 attempts
          // over ~300ms — far shorter than any multi-second outage. We inject a
          // SUSTAINED outage (every PUT fails) instead of sleeping 8s; the lib
          // exhausts in ~300ms, which PROVES the default schedule cannot survive
          // the 8s window. Tuning need (a longer/again-from-scratch schedule) is
          // captured here; the fix is an Epic 13 candidate.
          await installPutChaos(context, async ({ route }) => {
            await route.abort("failed")
          })

          const result = await page.evaluate(driveMultipartInPage, {
            filename: uniq("c3", engine),
            totalBytes: 6 * MiB, // 5 + 1 → 2 parts; part 1 exhausts first
            chunkSize: CHUNK,
            maxConcurrency: 1,
          })

          expect(result.ok).toBe(false)
          expect(result.error?._tag).toBe("MaxRetriesExceededError")
          expect(result.error?.partNumber).toBe(1)
          // Default schedule = 3 attempts (1 initial + 2 retries).
          expect(result.error?.totalAttempts).toBe(3)
          expect(result.partAttempts["1"]).toBe(3)
        },
        engine,
      )
    })

    test(`11.5-E2E-003 (C#4) [${engine}] — part-transport truncation maps to PartUploadError`, async () => {
      await runOnEngine(
        browserType,
        async ({ page, context }) => {
          // C#4: a partial/truncated transfer (connection reset mid-PUT). With a
          // single attempt the terminal error is exactly PartUploadError — the
          // part-phase variant the AC names (distinct from C#6's complete-phase
          // CompleteUploadError). The retried path is locked by C#5.
          await installPutChaos(context, async ({ route }) => {
            await route.abort("connectionreset")
          })

          const result = await page.evaluate(driveMultipartInPage, {
            filename: uniq("c4", engine),
            totalBytes: 6 * MiB,
            chunkSize: CHUNK,
            maxConcurrency: 1,
            retry: { delayMs: 1, recurs: 0 }, // single attempt → raw PartUploadError
          })

          expect(result.ok).toBe(false)
          expect(result.error?._tag).toBe("PartUploadError")
          expect(result.error?.partNumber).toBe(1)
          expect(result.partAttempts["1"]).toBe(1)
        },
        engine,
      )
    })

    test(`11.5-E2E-004 (C#5) [${engine}] — missing ETag in 200 OK maps to PartUploadError (retry attempted)`, async () => {
      await runOnEngine(
        browserType,
        async ({ page, context }) => {
          // C#5: MinIO answers 200 OK but the ETag header is absent. The user
          // callback throws ("missing ETag") → part-phase failure, retried under
          // the default schedule → terminal MaxRetriesExceededError (the
          // retry-exhaustion wrapper of PartUploadError, partNumber-tagged).
          await installPutChaos(context, async ({ route }) => {
            await route.fulfill({
              status: 200,
              headers: { "access-control-allow-origin": "*" }, // no ETag
            })
          })

          const result = await page.evaluate(driveMultipartInPage, {
            filename: uniq("c5", engine),
            totalBytes: 6 * MiB,
            chunkSize: CHUNK,
            maxConcurrency: 1,
          })

          expect(result.ok).toBe(false)
          expect(result.error?._tag).toBe("MaxRetriesExceededError")
          expect(result.error?.partNumber).toBe(1)
          expect(result.error?.totalAttempts).toBe(3) // retry attempted
          expect(result.partAttempts["1"]).toBe(3)
        },
        engine,
      )
    })

    test(`11.5-E2E-005 (C#6) [${engine}] — garbage ETag fails at /complete with CompleteUploadError`, async () => {
      await runOnEngine(
        browserType,
        async ({ page, context }) => {
          // C#6: MinIO returns 200 OK with a garbage ETag. The part appears to
          // succeed (PartCompleted is emitted) but the bytes never reach MinIO,
          // so CompleteMultipartUpload rejects the bogus part (InvalidPart) →
          // complete-phase failure → CompleteUploadError. We garble ONLY part 1
          // so the failure is unambiguously the invalid part at the complete
          // phase, not the part phase.
          await installPutChaos(context, async ({ route, partNumber }) => {
            if (partNumber === 1) {
              await route.fulfill({
                status: 200,
                headers: {
                  "access-control-allow-origin": "*",
                  "access-control-expose-headers": "ETag",
                  ETag: '"deadbeef"',
                },
              })
              return
            }
            await route.continue()
          })

          const result = await page.evaluate(driveMultipartInPage, {
            filename: uniq("c6", engine),
            totalBytes: 6 * MiB, // 2 parts; part 2 is real
            chunkSize: CHUNK,
            maxConcurrency: 1,
          })

          expect(result.ok).toBe(false)
          // Both parts ran through the part phase (the garbage ETag was accepted
          // by the callback for part 1)… proven via attempt counts because the
          // lib's event ReadableStream errors WITHOUT flushing buffered events on
          // the failure path (observed: events=[] on error — a possible Epic 13
          // candidate: flush emitted UploadEvents before surfacing the error).
          expect(result.partAttempts).toEqual({ "1": 1, "2": 1 })
          // …but the complete phase rejects the invalid part (InvalidPart → 500).
          expect(result.error?._tag).toBe("CompleteUploadError")
          expect(result.error?.causeMessage).toContain("complete failed")
        },
        engine,
      )
    })
  })
}
