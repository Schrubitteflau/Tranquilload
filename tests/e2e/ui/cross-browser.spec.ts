import { ListObjectsV2Command } from "@aws-sdk/client-s3"
import { test, expect } from "@support/fixtures"
import { UploadPage } from "@support/page-objects/upload-page"
import { assertObjectBytesEqual } from "@support/helpers/minio-client"
import { MiB } from "@support/helpers/file-factory"

/**
 * Story 10.4 — R2 Cross-browser smoke (Epic 10 BLOCKER, Score 9).
 *
 * Source of truth: `_bmad-output/test-artifacts/test-design-epic-10.md`
 *   - 10.4-E2E-001/002/003: multipart golden path on Chromium / Firefox / WebKit
 *   - 10.4-E2E-004: bufferMode (one-shot) on all three browsers
 *
 * Parametrization strategy: this spec lives in `tests/e2e/ui/` and the
 * Playwright config picks it up under `chromium-ui`, `firefox-ui`, and
 * `webkit-ui`. Each `test(...)` block therefore yields three test runs — one
 * per project — without manual fixtures. Test IDs 001/002/003 are denoted by
 * the project label in the report; the spec content is identical.
 *
 * Both code paths place the object at `uploads/<uuid>-<filename>` (multipart
 * uses CreateMultipartUploadCommand, oneshot uses PutObjectCommand with the
 * same key shape), so the lookup helper below works for both.
 */

async function findObjectKey(
  client: import("@aws-sdk/client-s3").S3Client,
  bucket: string,
  filename: string,
): Promise<string> {
  const list = await client.send(
    new ListObjectsV2Command({ Bucket: bucket, Prefix: "uploads/" }),
  )
  const match = (list.Contents ?? []).find((o) => o.Key?.endsWith(filename))
  if (!match?.Key) {
    throw new Error(
      `MinIO has no object ending with "${filename}" under uploads/ — got: ${(list.Contents ?? [])
        .map((o) => o.Key)
        .join(", ")}`,
    )
  }
  return match.Key
}

test.describe("R2 — Cross-browser smoke (Story 10.4, BLOCKER)", () => {
  // Note: we deliberately do NOT call `purgeUploads()` in beforeEach. Each
  // test produces a unique timestamped filename, so stale objects from prior
  // runs never collide with this run's assertions. Purge-per-test would also
  // race with sibling tests in other browsers (chromium-ui/firefox-ui/webkit-ui
  // all run in parallel against the same MinIO bucket) — a purge issued by
  // worker A's beforeEach can wipe the object worker B just uploaded and is
  // about to assert against. Unique filenames are the safe isolation mechanism.

  test("10.4-E2E-001/002/003 — multipart golden upload completes byte-equal", async ({
    appPage,
    minio,
    makeUploadBytes,
  }, testInfo) => {
    test.slow()
    const upload = new UploadPage(appPage)

    const bytes = makeUploadBytes(25 * MiB, "incrementing")
    const filename = `r2-multipart-${testInfo.project.name}-${Date.now()}.bin`

    await upload.setFile(filename, bytes)
    await expect(upload.modeMultipart).toBeChecked()
    await upload.startBtn.click()

    await expect(upload.log).toContainText(/✅ Upload completed/i, { timeout: 90_000 })

    const objectKey = await findObjectKey(minio.client, minio.env.bucket, filename)
    const verdict = await assertObjectBytesEqual(minio.client, minio.env.bucket, objectKey, bytes)
    expect(verdict, JSON.stringify(verdict)).toEqual({ ok: true })
  })

  test("10.4-E2E-004 — one-shot (bufferMode) upload completes byte-equal", async ({
    appPage,
    minio,
    makeUploadBytes,
  }, testInfo) => {
    const upload = new UploadPage(appPage)

    // 5 MiB is enough to be non-trivial but small enough that the one-shot
    // buffer path stays fast across all three browsers (multipart is the slow
    // path that owns the long budget).
    const bytes = makeUploadBytes(5 * MiB, "incrementing")
    const filename = `r2-oneshot-${testInfo.project.name}-${Date.now()}.bin`

    await upload.modeOneshot.check()
    await upload.setFile(filename, bytes)
    await upload.startBtn.click()

    await expect(upload.log).toContainText(/✅ Upload completed/i, { timeout: 30_000 })

    const objectKey = await findObjectKey(minio.client, minio.env.bucket, filename)
    const verdict = await assertObjectBytesEqual(minio.client, minio.env.bucket, objectKey, bytes)
    expect(verdict, JSON.stringify(verdict)).toEqual({ ok: true })
  })
})
