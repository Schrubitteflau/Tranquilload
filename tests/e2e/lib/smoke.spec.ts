import { test, expect } from "@playwright/test"

/**
 * Framework-setup smoke test (Story 10.2) — PW-Lib variant.
 *
 * PW-Lib runs library-direct probes that don't need the test-app UI. Story 10.4-E2E-005
 * uses this pattern to verify `CompressionStream` accepts `deflate-raw` per browser.
 *
 * NOTE on secure contexts:
 *   `crypto.subtle` requires a secure context (HTTPS or http://localhost). It is
 *   NOT available on `about:blank` in headless browsers. The library code runs
 *   in the test-app (http://localhost:5173 → secure context), so this is not a
 *   real gap — but the smoke probe must avoid relying on it. The real
 *   `crypto.subtle` validation happens implicitly when Story 10.3 resumes an
 *   upload (content-digest verification).
 */
test.describe("framework smoke (PW-Lib)", () => {
  test("browser exposes streaming + compression primitives", async ({ page }) => {
    await page.goto("about:blank")

    const probes = await page.evaluate(() => ({
      hasCompressionStream: typeof CompressionStream === "function",
      hasReadableStream: typeof ReadableStream === "function",
      hasWritableStream: typeof WritableStream === "function",
      hasTransformStream: typeof TransformStream === "function",
    }))

    expect(probes.hasCompressionStream, "CompressionStream missing — Story 10.4-E2E-005 will fail").toBe(true)
    expect(probes.hasReadableStream).toBe(true)
    expect(probes.hasWritableStream).toBe(true)
    expect(probes.hasTransformStream).toBe(true)
  })
})
