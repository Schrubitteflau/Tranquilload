import { test, expect } from "@support/fixtures"
import { UploadPage } from "@support/page-objects/upload-page"

/**
 * Framework-setup smoke test (Story 10.2).
 *
 * Given the test-app harness boots and the upload UI renders
 *  When the smoke test loads `/`
 *  Then key UI elements are visible and idle
 *
 * Story 10.3 (Resume) and 10.4 (Cross-browser) replace this with real E2E flows.
 * Until then, this verifies the Playwright + test-app wiring is healthy.
 */
test.describe("framework smoke (PW-UI)", () => {
  test("upload harness renders and is idle", async ({ appPage }) => {
    const upload = new UploadPage(appPage)

    await expect(upload.fileInput).toBeVisible()
    await expect(upload.startBtn).toBeVisible()
    await expect(upload.modeMultipart).toBeChecked()
    await expect(upload.progressText).toHaveText(/idle/i)
  })

  test("MinIO is reachable from the test runner", async ({ minio }) => {
    const res = await fetch(`${minio.env.endpoint}/minio/health/live`, {
      signal: AbortSignal.timeout(5_000),
    })
    expect(res.ok, "MinIO /health/live should return 2xx — is `pnpm minio:up` running?").toBe(true)
  })
})
