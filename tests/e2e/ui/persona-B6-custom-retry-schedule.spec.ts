import { test, expect } from "@support/fixtures"
import { UploadPage } from "@support/page-objects/upload-page"
import { MiB } from "@support/helpers/file-factory"
import { findUploadedKey, assertObjectBytesEqual } from "@support/helpers/minio-client"
import { bootstrapAppPage, resetChaos, setChaos } from "@support/helpers/persona"

/**
 * Story 11.4 — Persona B6: custom retrySchedule (11.4-E2E-006). AC #5.
 *
 * The persona supplies a custom `retrySchedule` (`Schedule.recurs(10)` with a
 * fixed 1s delay) and expects it honoured end-to-end. This test injects that
 * schedule via the test-app's `?retryRecurs=10&retryFixedMs=1000` toggle, fails
 * the first 5 /sign calls, and LOCKS two independent proofs:
 *   1. exactly 6 sign calls (5 failures + 1 success ⇒ 5 retries) — only
 *      reachable because recurs(10) > the default 3-attempt budget; and
 *   2. ≥4.5s wall time of pure backoff (5 × 1s fixed) — distinct from the
 *      default exponential (~0.3s), which would also fail outright.
 */
test.describe("Persona B6 — custom retrySchedule (Story 11.4)", () => {
  test.afterEach(async ({ request }) => {
    await resetChaos(request)
  })

  test("11.4-E2E-006 — custom retrySchedule (recurs(10) @ fixed 1s) honoured end-to-end", async ({
    page,
    baseURL,
    request,
    minio,
    makeUploadBytes,
  }) => {
    test.slow()
    await bootstrapAppPage(page, baseURL, "?retryRecurs=10&retryFixedMs=1000")
    await resetChaos(request)

    const upload = new UploadPage(page)

    // The part is retried once per failed /sign — count the POSTs.
    let signCount = 0
    page.on("request", (req) => {
      if (req.method() === "POST" && req.url().endsWith("/api/multipart/sign")) signCount++
    })

    // Fail the first 5 sign calls, then succeed on the 6th.
    await setChaos(request, { failSignNextN: 5 })

    const bytes = makeUploadBytes(5 * MiB, "incrementing") // exactly 1 part
    const filename = `p-b6-${Date.now()}.bin`
    await upload.setFile(filename, bytes)
    await upload.concurrency.fill("1")
    await expect(upload.modeMultipart).toBeChecked()

    const t0 = Date.now()
    await upload.startBtn.click()
    await expect(upload.log).toContainText(/✅ Upload completed/i, { timeout: 60_000 })
    const elapsed = Date.now() - t0

    expect(signCount, "expected exactly 5 retries (6 sign calls) under recurs(10)").toBe(6)
    expect(
      elapsed,
      `fixed 1s delays should make the retried part take ≥4.5s, got ${elapsed}ms`,
    ).toBeGreaterThanOrEqual(4500)

    const key = await findUploadedKey(minio.client, minio.env.bucket, filename)
    const verdict = await assertObjectBytesEqual(minio.client, minio.env.bucket, key, bytes)
    expect(verdict, JSON.stringify(verdict)).toEqual({ ok: true })
  })
})
