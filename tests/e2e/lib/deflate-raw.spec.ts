import { test, expect, chromium, firefox, webkit, type BrowserType } from "@playwright/test"

/**
 * Story 10.4 — R2 Cross-browser `deflate-raw` probe (Epic 10 BLOCKER, Score 9).
 * Test ID: 10.4-E2E-005 (PW-Lib harness).
 *
 * Verifies that each of the three Playwright-bundled browsers exposes a
 * working `CompressionStream("deflate-raw")` in its DOM realm — the algorithm
 * Tranquilload defaults to when `compress("deflate-raw")` is added to the
 * pipeline.
 *
 * The `lib` Playwright project targets Chromium by default; here we launch
 * each browser engine explicitly so the three sub-cases run together under
 * `pnpm --filter @tranquilload/tests test:e2e:lib`. WebKit is allowed to
 * `test.skip()` if it genuinely does not support `deflate-raw` (historical
 * limitation per the Epic 10 test design risk-to-plan).
 */

interface DeflateRawProbe {
  exposesCompressionStream: boolean
  supportsDeflateRaw: boolean
  pipelineProducedBytes: number
  errorName?: string
  errorMessage?: string
}

async function probeDeflateRaw(browserType: BrowserType): Promise<DeflateRawProbe> {
  const browser = await browserType.launch()
  try {
    const page = await browser.newPage()
    await page.goto("about:blank")
    return await page.evaluate(async () => {
      const exposesCompressionStream = typeof (globalThis as { CompressionStream?: unknown }).CompressionStream === "function"
      if (!exposesCompressionStream) {
        return {
          exposesCompressionStream: false,
          supportsDeflateRaw: false,
          pipelineProducedBytes: 0,
        }
      }
      try {
        const Cs = (globalThis as unknown as { CompressionStream: new (alg: string) => unknown }).CompressionStream
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const cs = new Cs("deflate-raw")
        // Drive 1 KiB of zeros through the stream and count compressed bytes —
        // proves the algorithm is wired all the way through, not just that the
        // constructor accepted the string.
        const input = new Uint8Array(1024)
        const stream = new Response(input).body!.pipeThrough(cs as unknown as TransformStream<Uint8Array, Uint8Array>)
        const reader = stream.getReader()
        let total = 0
        for (;;) {
          const { value, done } = await reader.read()
          if (done) break
          if (value) total += value.byteLength
        }
        return {
          exposesCompressionStream: true,
          supportsDeflateRaw: true,
          pipelineProducedBytes: total,
        }
      } catch (e) {
        const err = e as { name?: string; message?: string }
        return {
          exposesCompressionStream: true,
          supportsDeflateRaw: false,
          pipelineProducedBytes: 0,
          errorName: err.name,
          errorMessage: err.message,
        }
      }
    })
  } finally {
    await browser.close()
  }
}

test.describe("R2 — `deflate-raw` cross-browser (PW-Lib)", () => {
  test("10.4-E2E-005 [chromium] — CompressionStream(deflate-raw) is available and produces bytes", async () => {
    const probe = await probeDeflateRaw(chromium)
    expect(probe.exposesCompressionStream, "CompressionStream must exist in Chromium realm").toBe(true)
    expect(
      probe.supportsDeflateRaw,
      `Chromium should accept "deflate-raw" — got ${probe.errorName}: ${probe.errorMessage}`,
    ).toBe(true)
    expect(probe.pipelineProducedBytes).toBeGreaterThan(0)
  })

  test("10.4-E2E-005 [firefox] — CompressionStream(deflate-raw) is available and produces bytes", async () => {
    const probe = await probeDeflateRaw(firefox)
    expect(probe.exposesCompressionStream, "CompressionStream must exist in Firefox realm").toBe(true)
    expect(
      probe.supportsDeflateRaw,
      `Firefox should accept "deflate-raw" — got ${probe.errorName}: ${probe.errorMessage}`,
    ).toBe(true)
    expect(probe.pipelineProducedBytes).toBeGreaterThan(0)
  })

  test("10.4-E2E-005 [webkit] — CompressionStream(deflate-raw) is available and produces bytes", async () => {
    const probe = await probeDeflateRaw(webkit)
    // WebKit historically lacked `deflate-raw`. If this assertion fails the
    // failure message becomes the documented limitation (per Epic 10
    // contingency for R2): consumers should fall back to `gzip` until WebKit
    // ships support, and the test should be downgraded to `test.skip()` with
    // a link to the failing browser-version notes.
    expect(probe.exposesCompressionStream, "CompressionStream must exist in WebKit realm").toBe(true)
    expect(
      probe.supportsDeflateRaw,
      `WebKit should accept "deflate-raw" — got ${probe.errorName}: ${probe.errorMessage}. ` +
        `If WebKit truly lacks this codec on the bundled version, downgrade this test to test.skip() ` +
        `with a documented version note (Epic 10 R2 contingency).`,
    ).toBe(true)
    expect(probe.pipelineProducedBytes).toBeGreaterThan(0)
  })
})
