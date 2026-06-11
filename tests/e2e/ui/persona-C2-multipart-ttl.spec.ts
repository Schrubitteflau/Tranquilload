import { AbortMultipartUploadCommand } from "@aws-sdk/client-s3"
import { test, expect } from "@support/fixtures"
import { UploadPage } from "@support/page-objects/upload-page"
import { MiB } from "@support/helpers/file-factory"
import { headObjectSize } from "@support/helpers/minio-client"
import {
  bootstrapAppPage,
  readResumeState,
  resetChaos,
  setChaos,
} from "@support/helpers/persona"

/**
 * Story 11.4 — Persona C2: MinIO multipart TTL (11.4-E2E-007). AC #6.
 *
 * Risk: R-P2-1 (DATA, HIGH — resume after MinIO TTL). The last uncovered HIGH
 * cluster in Epic 11.
 *
 * The persona abandons an upload long enough for MinIO to GC the multipart past
 * its TTL, then reloads and tries to resume. This test simulates the GC with an
 * out-of-band `AbortMultipartUpload`, then drives the test-app's resume path and
 * LOCKS the CURRENT behaviour:
 *   - reconcile fails — verified against MinIO, `ListParts` on an aborted
 *     uploadId throws `NoSuchUpload`, so the test-app's `/parts` returns 500 and
 *     the reconcile callback throws → the lib surfaces `ReconcileError`; and
 *   - `HEAD` on the key fails (the object never materialised).
 *
 * The library does NOT auto-detect the stale uploadId and re-initiate a fresh
 * multipart — that gap is flagged below as an Epic 13 candidate.
 *
 * Bypasses the `appPage` fixture: its `addInitScript(localStorage.clear)` would
 * wipe ResumeState on the reload this scenario depends on.
 */
test.describe("Persona C2 — MinIO multipart TTL (Story 11.4)", () => {
  test.afterEach(async ({ request }) => {
    await resetChaos(request)
  })

  test("11.4-E2E-007 — resume after MinIO GC'd the multipart fails at reconcile; object absent", async ({
    page,
    baseURL,
    request,
    minio,
    makeUploadBytes,
  }) => {
    test.slow()
    await bootstrapAppPage(page, baseURL)
    await resetChaos(request)

    const upload = new UploadPage(page)

    // Slow + serialize so we can capture ResumeState while genuinely mid-upload.
    await setChaos(request, { slowSignMs: 2000 })

    const bytes = makeUploadBytes(25 * MiB, "incrementing") // 5 parts
    const filename = `p-c2-${Date.now()}.bin`
    await upload.setFile(filename, bytes)
    await upload.concurrency.fill("1")
    await expect(upload.modeMultipart).toBeChecked()
    await upload.startBtn.click()

    // The lib persists ResumeState right after initiate resolves.
    await expect
      .poll(() => readResumeState(page), { timeout: 20_000, message: "ResumeState should appear" })
      .not.toBeNull()
    const state = await readResumeState(page)
    expect(state, "ResumeState should exist before reload").not.toBeNull()
    await expect(upload.startBtn).toBeDisabled() // genuinely in progress
    const { uploadId, key } = state!

    // Reload kills the in-progress fiber; ResumeState survives in localStorage.
    await page.reload()
    const upload2 = new UploadPage(page)
    await expect(upload2.resumeBanner).toBeVisible({ timeout: 10_000 })

    // Simulate MinIO GC'ing the abandoned multipart past its TTL.
    await minio.client.send(
      new AbortMultipartUploadCommand({ Bucket: minio.env.bucket, Key: key, UploadId: uploadId }),
    )

    // Clear chaos so the resume attempt isn't slowed by leftover config.
    await resetChaos(request)

    // Re-attach the same file (the File ref is lost on reload) and resume.
    await upload2.setFile(filename, bytes)
    await upload2.resumeBtn.click()

    // CURRENT behaviour: reconcile (ListParts) hits NoSuchUpload → ReconcileError.
    // Epic 13 candidate: auto-detect a stale/GC'd uploadId and auto-re-initiate
    // a fresh multipart instead of surfacing ReconcileError to the caller.
    await expect(upload2.log).toContainText(/❌\s+ReconcileError/, { timeout: 30_000 })
    await expect(upload2.log).not.toContainText(/✅ Upload completed/)

    // The object never materialised — a fresh start would be required.
    expect(
      await headObjectSize(minio.client, minio.env.bucket, key),
      "HEAD on the GC'd key must fail (object absent)",
    ).toBeNull()
  })
})
