import { test, expect } from "@support/fixtures"
import { UploadPage } from "@support/page-objects/upload-page"
import { MiB } from "@support/helpers/file-factory"
import { bootstrapAppPage } from "@support/helpers/persona"

/**
 * Story 11.4 — Persona B5: getProgress() foot-gun (11.4-E2E-005). AC #4.
 *
 * Risk: R-P2-10 (BUS, getProgress foot-gun).
 *
 * The persona calls `getProgress()` from INSIDE their part-1 `uploadPart`
 * callback, expecting to see "5 MiB uploaded". But the library updates the
 * progress Ref AFTER `uploadPart` resolves (on the `PartCompleted` event), so a
 * read taken from within part 1's own callback — before any part has completed —
 * returns 0 bytes. This test LOCKS that documented timing foot-gun via the
 * test-app's `?probeGetProgressFromPartOne=1` toggle.
 *
 * MEMORY: "Ref.update post-uploadPart timing — `Ref.update` fires after
 * `uploadPart` resolves; getProgress() polled inside uploadPart for part 1 sees
 * 0 bytes." concurrency=1 guarantees no sibling part completes before the probe.
 */
test.describe("Persona B5 — getProgress() foot-gun (Story 11.4)", () => {
  test("11.4-E2E-005 — getProgress() inside part-1 uploadPart reads 0 bytes", async ({
    page,
    baseURL,
    makeUploadBytes,
  }) => {
    test.slow()
    await bootstrapAppPage(page, baseURL, "?probeGetProgressFromPartOne=1")

    const upload = new UploadPage(page)
    const bytes = makeUploadBytes(10 * MiB, "incrementing") // ≥2 parts so "part 1" is meaningful
    const filename = `p-b5-${Date.now()}.bin`
    await upload.setFile(filename, bytes)
    await upload.concurrency.fill("1") // part 1 strictly first; nothing completes before its probe
    await expect(upload.modeMultipart).toBeChecked()
    await upload.startBtn.click()

    // The probe line is written from inside part-1's uploadPart, BEFORE the
    // post-uploadPart Ref.update for part 1 — so it must read exactly 0 bytes.
    await expect(upload.log).toContainText(/part=1 → bytesUploaded=0\b/, { timeout: 30_000 })
    await expect(upload.log).not.toContainText(/bytesUploaded=[1-9]/)

    // The foot-gun is a read-timing gotcha, not a fault: the upload completes.
    await expect(upload.log).toContainText(/✅ Upload completed/i, { timeout: 30_000 })
  })
})
