import { test, expect, chromium, firefox, webkit, type BrowserType } from "@playwright/test"

/**
 * Story 11.7 — 11.7-E2E-003 (G#3) — `deflate-raw` support MATRIX across
 * Chromium / Firefox / WebKit (PW-Lib harness).
 *
 * Complements the existing 10.4-E2E-005 per-engine probe (`deflate-raw.spec.ts`)
 * by locking an explicit support MATRIX in a single test run, so a regression
 * (a browser silently dropping `deflate-raw`) is caught and the README support
 * matrix stays honest. R-P2-12 (OPS, LOW) — older WebKit historically lacked
 * the algorithm; the README's "deflate-raw support matrix" section documents
 * the current state.
 *
 * The probe both CONSTRUCTS `CompressionStream("deflate-raw")` and drives bytes
 * through it (constructor acceptance alone is insufficient — some engines have
 * accepted the string but failed downstream).
 */

interface MatrixEntry {
  engine: "chromium" | "firefox" | "webkit"
  exposesCompressionStream: boolean
  supportsDeflateRaw: boolean
  producedBytes: number
  errorName?: string
}

async function probe(
  engine: MatrixEntry["engine"],
  browserType: BrowserType,
): Promise<MatrixEntry> {
  const browser = await browserType.launch()
  try {
    const page = await browser.newPage()
    await page.goto("about:blank")
    const r = await page.evaluate(async () => {
      const exposes =
        typeof (globalThis as { CompressionStream?: unknown }).CompressionStream === "function"
      if (!exposes) {
        return { exposes: false, supports: false, bytes: 0 }
      }
      try {
        const Cs = (globalThis as unknown as {
          CompressionStream: new (alg: string) => unknown
        }).CompressionStream
        const cs = new Cs("deflate-raw")
        const input = new Uint8Array(1024)
        const out = new Response(input).body!.pipeThrough(
          cs as unknown as TransformStream<Uint8Array, Uint8Array>,
        )
        const reader = out.getReader()
        let total = 0
        for (;;) {
          const { value, done } = await reader.read()
          if (done) break
          if (value) total += value.byteLength
        }
        return { exposes: true, supports: true, bytes: total }
      } catch (e) {
        const err = e as { name?: string }
        return { exposes: true, supports: false, bytes: 0, errorName: err.name }
      }
    })
    return {
      engine,
      exposesCompressionStream: r.exposes,
      supportsDeflateRaw: r.supports,
      producedBytes: r.bytes,
      errorName: (r as { errorName?: string }).errorName,
    }
  } finally {
    await browser.close()
  }
}

test.describe("R-P2-12 — `deflate-raw` support matrix (PW-Lib)", () => {
  test("11.7-E2E-003 (G#3) — deflate-raw support matrix is locked across all 3 engines", async () => {
    const matrix: MatrixEntry[] = [
      await probe("chromium", chromium),
      await probe("firefox", firefox),
      await probe("webkit", webkit),
    ]

    // The matrix is the documented contract (mirrors the README support matrix).
    // All three Playwright-bundled engines currently ship `deflate-raw`.
    // If a future browser version drops it, this assertion fails with the exact
    // engine + error name — downgrade that engine to a documented `gzip`
    // fallback in the README and relax the row here (Epic 10 R2 contingency).
    for (const entry of matrix) {
      expect(
        entry.exposesCompressionStream,
        `${entry.engine}: CompressionStream must be exposed`,
      ).toBe(true)
      expect(
        entry.supportsDeflateRaw,
        `${entry.engine}: expected deflate-raw support — got error ${entry.errorName}. ` +
          `If this engine genuinely lacks deflate-raw, document the fallback in ` +
          `the README support matrix and relax this row.`,
      ).toBe(true)
      expect(
        entry.producedBytes,
        `${entry.engine}: deflate-raw pipeline must produce compressed bytes`,
      ).toBeGreaterThan(0)
    }
  })
})
