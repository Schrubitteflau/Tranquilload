import { test, expect } from "@support/fixtures"
import { UploadPage } from "@support/page-objects/upload-page"
import { MiB } from "@support/helpers/file-factory"
import { findUploadedKey, assertObjectBytesEqual } from "@support/helpers/minio-client"
import { resetChaos, setChaos } from "@support/helpers/persona"

/**
 * Story 11.4 — Persona A2: screen lock (11.4-E2E-002). AC #1.
 *
 * The persona locks their phone mid-upload; the OS throttles the page's main
 * thread to a crawl. This test LOCKS that heavy throttling does NOT crash the
 * upload fiber or leak an unhandled rejection — the upload simply runs slow and
 * still lands byte-equal.
 *
 * Cross-engine strategy (D3 — run on all three, gate only the Chromium-only
 * API): on Chromium we throttle the main thread 20× via CDP
 * `Emulation.setCPUThrottlingRate` (the faithful screen-lock simulation). CDP
 * is unavailable on Firefox/WebKit, so there we substitute a server-side
 * slow-sign as a portable "degraded environment" stand-in. Both legs assert the
 * same invariant: no fiber crash, completes byte-equal.
 */
test.describe("Persona A2 — screen lock / CPU throttle (Story 11.4)", () => {
  test.beforeEach(async ({ request }) => {
    await resetChaos(request)
  })
  test.afterEach(async ({ request }) => {
    await resetChaos(request)
  })

  test("11.4-E2E-002 — heavy throttle does not crash the fiber; upload completes byte-equal", async ({
    appPage,
    request,
    minio,
    makeUploadBytes,
    browserName,
  }) => {
    test.slow()
    const upload = new UploadPage(appPage)

    const pageErrors: Error[] = []
    appPage.on("pageerror", (e) => pageErrors.push(e))

    const bytes = makeUploadBytes(10 * MiB, "incrementing")
    const filename = `p-a2-${browserName}-${Date.now()}.bin`
    await upload.setFile(filename, bytes)
    await upload.concurrency.fill("2")
    await expect(upload.modeMultipart).toBeChecked()

    // Apply the throttle AFTER file injection + config so it only covers the
    // upload (the "screen lock" happens mid-upload, not during file selection —
    // a 20× CPU throttle would otherwise stall setInputFiles itself).
    if (browserName === "chromium") {
      const cdp = await appPage.context().newCDPSession(appPage)
      await cdp.send("Emulation.setCPUThrottlingRate", { rate: 20 })
    } else {
      await setChaos(request, { slowSignMs: 400 })
    }

    await upload.startBtn.click()

    await expect(upload.log).toContainText(/✅ Upload completed/i, { timeout: 120_000 })

    expect(
      pageErrors,
      `throttled upload must not crash the fiber: ${pageErrors.map((e) => e.message).join(" | ")}`,
    ).toHaveLength(0)

    const key = await findUploadedKey(minio.client, minio.env.bucket, filename)
    const verdict = await assertObjectBytesEqual(minio.client, minio.env.bucket, key, bytes)
    expect(verdict, JSON.stringify(verdict)).toEqual({ ok: true })
  })
})
