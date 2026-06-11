import { test, expect } from "@support/fixtures"
import { UploadPage } from "@support/page-objects/upload-page"
import { MiB } from "@support/helpers/file-factory"
import { findUploadedKey, assertObjectBytesEqual } from "@support/helpers/minio-client"
import {
  bootstrapAppPage,
  setChaos,
  dropUploadNetwork,
  restoreUploadNetwork,
} from "@support/helpers/persona"

/**
 * Story 11.4 — Persona A4: Wi-Fi → 5G handoff (11.4-E2E-003). AC #2.
 *
 * The persona walks out of Wi-Fi range mid-upload; the TCP connection dies and
 * `fetch` errors for a few seconds until 5G takes over. This test LOCKS that a
 * TUNED retry schedule (`recurs(10)` with a fixed 1s delay, injected via the
 * test-app's `?retryRecurs=10&retryFixedMs=1000` toggle) bridges the gap and
 * the upload completes byte-equal — i.e. retry resilience kicks in.
 *
 * This is the counterpart to persona A1: A1 proves the DEFAULT schedule (3
 * attempts, <1s) cannot survive an outage; A4 proves the tuned schedule that A1
 * motivates does. Bypasses `appPage` because it needs the debug query param.
 *
 * Determinism: a per-sign 1.5s delay keeps a part genuinely in flight when the
 * outage starts (so the drop reliably interrupts a real part PUT rather than
 * racing a localhost-fast upload to completion).
 */
test.describe("Persona A4 — Wi-Fi → 5G handoff (Story 11.4)", () => {
  test("11.4-E2E-003 — tuned retry schedule survives a TCP handoff; upload completes byte-equal", async ({
    page,
    baseURL,
    request,
    minio,
    makeUploadBytes,
  }) => {
    test.slow()
    await bootstrapAppPage(page, baseURL, "?retryRecurs=10&retryFixedMs=1000")

    const upload = new UploadPage(page)
    const pageErrors: Error[] = []
    page.on("pageerror", (e) => pageErrors.push(e))

    // Slow each /sign so a part is provably mid-flight at outage time, and
    // serialize parts so the outage lands on a single in-flight part.
    await setChaos(request, { slowSignMs: 1500 })

    const bytes = makeUploadBytes(15 * MiB, "incrementing") // 3 parts of 5 MiB
    const filename = `p-a4-${Date.now()}.bin`
    await upload.setFile(filename, bytes)
    await upload.concurrency.fill("1")
    await upload.startBtn.click()

    // Initiate resolved → the outage will hit a PART, not initiate.
    await expect(upload.uploadIdDisplay).toContainText(/uploadId:/, { timeout: 20_000 })

    // The TCP connection dies for ~4s. The part in flight (and its retries)
    // fail; the tuned schedule keeps retrying at a 1s cadence.
    await dropUploadNetwork(page)
    await page.waitForTimeout(4000)
    await restoreUploadNetwork(page)

    // 5G takes over: the next retry succeeds and the upload finishes.
    await expect(upload.log).toContainText(/✅ Upload completed/i, { timeout: 60_000 })

    expect(
      pageErrors,
      `handoff recovery must not crash the fiber: ${pageErrors.map((e) => e.message).join(" | ")}`,
    ).toHaveLength(0)

    const key = await findUploadedKey(minio.client, minio.env.bucket, filename)
    const verdict = await assertObjectBytesEqual(minio.client, minio.env.bucket, key, bytes)
    expect(verdict, JSON.stringify(verdict)).toEqual({ ok: true })
  })
})
