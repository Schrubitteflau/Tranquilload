import { test, expect } from "@support/fixtures"
import { UploadPage } from "@support/page-objects/upload-page"
import { MiB } from "@support/helpers/file-factory"
import { bootstrapAppPage, resetChaos, setChaos } from "@support/helpers/persona"

/**
 * Story 11.4 — Persona B1: forgot to `await result` (11.4-E2E-004). AC #3.
 *
 * A developer fires `uploadMultipart()` and never awaits `result`. This test
 * LOCKS that the resulting failure is OBSERVABLE rather than silently swallowed:
 * the dangling rejected promise escapes to the global `unhandledrejection`
 * handler, which the test-app's `?forgotAwait=1` path logs. A regression that
 * swallowed the rejection (e.g. an internal `.catch(() => {})` on `result`)
 * would make this line disappear — that is the deterministic, cross-engine lock.
 *
 * (Page-level `pageerror` for promise rejections is browser-dependent, so we do
 * not gate on it; the window-listener log line is the portable surface.)
 */
test.describe("Persona B1 — forgot to await result (Story 11.4)", () => {
  test.afterEach(async ({ request }) => {
    await resetChaos(request)
  })

  test("11.4-E2E-004 — an unawaited failing upload surfaces a typed unhandled rejection", async ({
    page,
    baseURL,
    request,
    makeUploadBytes,
  }) => {
    test.slow()
    await bootstrapAppPage(page, baseURL, "?forgotAwait=1")
    await resetChaos(request)

    const upload = new UploadPage(page)
    const pageErrors: Error[] = []
    page.on("pageerror", (e) => pageErrors.push(e))

    // Guarantee a failure: fail far more /sign calls than the default 3-attempt
    // budget so part 1 exhausts and `result` rejects.
    await setChaos(request, { failSignNextN: 50 })

    const bytes = makeUploadBytes(10 * MiB, "incrementing")
    const filename = `p-b1-${Date.now()}.bin`
    await upload.setFile(filename, bytes)
    await expect(upload.modeMultipart).toBeChecked()
    await upload.startBtn.click()

    await expect(upload.log).toContainText(/UNHANDLED REJECTION:\s+\w*Error/, { timeout: 30_000 })
    await expect(upload.log).not.toContainText(/✅ Upload completed/)
  })
})
