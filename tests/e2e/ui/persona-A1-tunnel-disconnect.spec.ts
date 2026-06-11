import { test, expect } from "@support/fixtures"
import { UploadPage } from "@support/page-objects/upload-page"
import { MiB } from "@support/helpers/file-factory"
import {
  resetChaos,
  setChaos,
  dropUploadNetwork,
  restoreUploadNetwork,
} from "@support/helpers/persona"

/**
 * Story 11.4 — Persona A1: tunnel disconnect (11.4-E2E-001).
 *
 * Risk: R-P2-1 cluster (resilience tuning). AC #1.
 *
 * The persona starts an upload, then loses the network for a long outage (a
 * train tunnel). The library's DEFAULT retry schedule is 3 attempts with
 * ~100–300ms exponential backoff — orders of magnitude shorter than a 30s+
 * outage. This test LOCKS that the default schedule gives up fast and surfaces
 * a TYPED UploadError (not a hang, not a silent success, not a fiber crash),
 * codifying the tuning need that persona A4 then satisfies with a custom
 * schedule.
 *
 * We do not literally sleep 30s: a default-schedule upload abandons the part in
 * well under 1s, which is itself the proof that the default cannot bridge a
 * 30s+ gap. We drop the network and assert the fast typed failure, then restore.
 */
test.describe("Persona A1 — tunnel disconnect (Story 11.4)", () => {
  test.beforeEach(async ({ request }) => {
    await resetChaos(request)
  })
  test.afterEach(async ({ request }) => {
    await resetChaos(request)
  })

  test("11.4-E2E-001 — default retry schedule cannot survive a long outage; fails with a typed error", async ({
    appPage,
    request,
    makeUploadBytes,
  }) => {
    test.slow()
    const upload = new UploadPage(appPage)

    // Surface any fiber crash / unhandled rejection — the failure must be a
    // CLEAN typed error surfaced via `result`, never a page-level exception.
    const pageErrors: Error[] = []
    appPage.on("pageerror", (e) => pageErrors.push(e))

    // Slow each /sign so the upload is genuinely mid-flight (not finished)
    // before we drop, and serialize parts so exactly one part is in play.
    await setChaos(request, { slowSignMs: 800 })
    await upload.concurrency.fill("1")

    const bytes = makeUploadBytes(25 * MiB, "incrementing")
    const filename = `p-a1-${Date.now()}.bin`
    await upload.setFile(filename, bytes)
    await expect(upload.modeMultipart).toBeChecked()
    await upload.startBtn.click()

    // Wait until initiate has resolved (uploadId shown) so the outage hits a
    // PART upload, not initiate.
    await expect(upload.uploadIdDisplay).toContainText(/uploadId:/, { timeout: 20_000 })

    // Drop the tunnel. Every subsequent /sign + MinIO PUT fails immediately.
    await dropUploadNetwork(appPage)

    // The default schedule exhausts its ~3 attempts in well under 1s and
    // surfaces a typed UploadError in the UI log.
    await expect(upload.log).toContainText(
      /❌\s+(MaxRetriesExceededError|PartUploadError|PresignedUrlError|InitiateUploadError)/,
      { timeout: 30_000 },
    )
    await expect(upload.log).not.toContainText(/✅ Upload completed/)

    // Restore connectivity (the upload has already given up — no auto-recovery
    // with the default schedule, which is exactly the documented tuning gap).
    await restoreUploadNetwork(appPage)

    expect(
      pageErrors,
      `outage failure must be a clean typed error, not a fiber crash: ${pageErrors.map((e) => e.message).join(" | ")}`,
    ).toHaveLength(0)
  })
})
