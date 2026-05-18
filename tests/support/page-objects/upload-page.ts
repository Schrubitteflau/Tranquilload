import type { Page, Locator } from "@playwright/test"

/**
 * Page Object Model for `examples/test-app/`'s upload harness UI.
 *
 * Selectors target the `id` attributes from `public/index.html` directly —
 * the test-app is private to this repo, so renames will surface here and in
 * the harness HTML together.
 */
export class UploadPage {
  readonly page: Page

  // ---------- 1. File ----------
  readonly fileInput: Locator
  readonly fileInfo: Locator

  // ---------- 2. Mode + settings ----------
  readonly modeMultipart: Locator
  readonly modeOneshot: Locator
  readonly chunkSize: Locator
  readonly concurrency: Locator
  readonly compress: Locator

  // ---------- 3. Chaos ----------
  readonly chaosFailSign: Locator
  readonly chaosFailComplete: Locator
  readonly chaosSlowSign: Locator
  readonly applyChaos: Locator

  // ---------- 4. Actions ----------
  readonly startBtn: Locator
  readonly abortBtn: Locator
  readonly clearResumeBtn: Locator

  // ---------- 5. Resume banner ----------
  readonly resumeBanner: Locator
  readonly resumeInfo: Locator
  readonly resumeBtn: Locator
  readonly dismissResumeBtn: Locator

  // ---------- 6. Progress + log ----------
  readonly progressFill: Locator
  readonly progressText: Locator
  readonly uploadIdDisplay: Locator
  readonly log: Locator

  constructor(page: Page) {
    this.page = page

    this.fileInput = page.locator("#file")
    this.fileInfo = page.locator("#file-info")

    this.modeMultipart = page.locator('input[name="mode"][value="multipart"]')
    this.modeOneshot = page.locator('input[name="mode"][value="oneshot"]')
    this.chunkSize = page.locator("#chunk-size")
    this.concurrency = page.locator("#concurrency")
    this.compress = page.locator("#compress")

    this.chaosFailSign = page.locator("#chaos-fail-sign")
    this.chaosFailComplete = page.locator("#chaos-fail-complete")
    this.chaosSlowSign = page.locator("#chaos-slow-sign")
    this.applyChaos = page.locator("#apply-chaos")

    this.startBtn = page.locator("#start")
    this.abortBtn = page.locator("#abort")
    this.clearResumeBtn = page.locator("#clear-resume")

    this.resumeBanner = page.locator("#resume-banner")
    this.resumeInfo = page.locator("#resume-info")
    this.resumeBtn = page.locator("#resume")
    this.dismissResumeBtn = page.locator("#dismiss-resume")

    this.progressFill = page.locator("#progress-fill")
    this.progressText = page.locator("#progress-text")
    this.uploadIdDisplay = page.locator("#upload-id-display")
    this.log = page.locator("#log")
  }

  /** Inject a synthetic File of `bytes` into the file input. */
  async setFile(name: string, bytes: Uint8Array, mimeType = "application/octet-stream"): Promise<void> {
    await this.fileInput.setInputFiles({ name, mimeType, buffer: Buffer.from(bytes) })
  }

  /** Read current progress as a 0–100 number (from `width: NN%` style). */
  async progressPercent(): Promise<number> {
    const width = await this.progressFill.evaluate((el) => (el as HTMLElement).style.width)
    const match = width.match(/^([\d.]+)%/)
    return match ? Number(match[1]) : 0
  }
}
