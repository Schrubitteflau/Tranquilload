import { test, expect } from "@playwright/test"
import { ENGINES, runOnEngine } from "@support/helpers/chaos-engines.js"
import { driveMultipartInPage, installPutChaos } from "@support/helpers/lib-multipart-driver.js"

/**
 * Story 11.7 / Epic 12 — 11.7-E2E-001 (F#10) — R-P2-11 circuit breaker.
 *
 * The circuit breaker (`circuitBreaker: { threshold, cooldown }`) is implemented
 * and unit/integration-locked in the core since Epic 3 (Story 3.4:
 * `circuit-breaker.test.ts` + `upload-stream.test.ts` "with circuitBreaker").
 * Epic 12 wires it into the PW-Lib driver and proves the end-to-end contract
 * across all three engines against real MinIO.
 *
 * HONEST SCOPE — threshold=1. Through the streaming API the breaker only trips
 * deterministically at `threshold: 1`: the first part whose retries exhaust opens
 * the circuit, emits `CircuitOpen`, and fails the upload with `CircuitOpenError`.
 * `threshold > 1` is NOT reachable — `Stream.mapEffect` fails the stream on the
 * first sub-threshold `PartUploadError` before a second part can accumulate a
 * consecutive failure (empirically verified; the integration test concedes the
 * same: "only 1 part completes its failure cycle before Stream.mapEffect
 * terminates the stream"). The original brainstorming wording ("5 consecutive
 * failures") assumed an accumulation path the architecture does not provide;
 * threshold=1 (stop on the first exhausted part, short-circuit the rest) is the
 * only well-defined — and arguably the canonical — semantics for an
 * all-parts-required multipart upload. Multi-part accumulation stays a
 * documented limitation (a future core epic, only if a real caller needs it).
 *
 * Chaos: every presigned part PUT to MinIO is aborted, so part 1's single
 * attempt (retry recurs:0) exhausts immediately → breaker opens.
 */

const MiB = 1024 * 1024
const CHUNK = 5 * MiB

const uniq = (engine: string) => `circuit-open-${engine}-${Date.now()}.bin`

for (const [engine, browserType] of ENGINES) {
  test.describe(`R-P2-11 — CircuitOpen cross-browser (PW-Lib) [${engine}]`, () => {
    test(`11.7-E2E-001 (F#10) [${engine}] — threshold=1 opens circuit on first part failure → CircuitOpen event + CircuitOpenError`, async () => {
      await runOnEngine(
        browserType,
        async ({ context, page }) => {
          // Every part PUT fails — with recurs:0 each part gets a single attempt,
          // so part 1 exhausts immediately and the threshold=1 breaker opens.
          await installPutChaos(context, async ({ route }) => {
            await route.abort("failed")
          })

          const result = await page.evaluate(driveMultipartInPage, {
            filename: uniq(engine),
            totalBytes: 11 * MiB, // 3 parts (5 + 5 + 1) — proves the object is multi-part
            chunkSize: CHUNK,
            maxConcurrency: 1,
            retry: { delayMs: 1, recurs: 0 }, // single attempt per part
            circuitBreaker: { threshold: 1, cooldown: 10_000 },
          })

          // The upload fails with the breaker's typed error, not a raw part error.
          expect(result.ok, `error=${JSON.stringify(result.error)}`).toBe(false)
          expect(result.error?._tag).toBe("CircuitOpenError")
          expect(result.error?.failedParts).toBe(1)

          // The CircuitOpen event is flushed before the error (Story 13.5).
          expect(result.events).toContain("CircuitOpen")

          // No part ever landed on MinIO — the object stays incomplete.
          expect(result.partsCompletedViaCallback).toBe(0)
        },
        engine,
      )
    })
  })
}
