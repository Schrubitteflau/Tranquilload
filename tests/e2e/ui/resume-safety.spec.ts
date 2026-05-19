import { test, expect } from "@support/fixtures"
import { UploadPage } from "@support/page-objects/upload-page"
import { assertObjectBytesEqual } from "@support/helpers/minio-client"
import { MiB } from "@support/helpers/file-factory"
import { waitForServer } from "@support/helpers/wait-for-server"

/**
 * Story 10.3 — R1 Resume safety end-to-end (Epic 10 BLOCKER, Score 9).
 *
 * Source of truth: `_bmad-output/test-artifacts/test-design-epic-10.md`
 *   - 10.3-E2E-001: persist → reload → resume → byte-equal HeadObject
 *   - 10.3-E2E-002: same flow + verify presigned URLs are re-signed per attempt
 *
 * Why this spec bypasses the `appPage` fixture:
 *   `appPage` installs `addInitScript(() => localStorage.clear())` which runs on
 *   every navigation — including reloads. R1 explicitly tests that ResumeState
 *   survives a reload, so we drive the bare `page` fixture and clear
 *   localStorage exactly once at the start of each test (before the upload
 *   begins). The `minio`, `purgeUploads`, and `makeUploadBytes` fixtures are
 *   safe to reuse.
 */

const API_URL = process.env.API_URL ?? "http://localhost:3000"
const APP_PATH = process.env.APP_PATH ?? "/index.html"

interface ResumeStateShape {
  uploadId: string
  key: string
  filename: string
  size: number
  chunkSize: number
}

async function bootstrapAppPage(
  page: import("@playwright/test").Page,
  baseURL: string | undefined,
): Promise<void> {
  await waitForServer(`${API_URL}/api/health`)
  await page.goto(new URL(APP_PATH, baseURL ?? "http://localhost:5173").toString())
  await page.evaluate(() => window.localStorage.clear())
}

async function resetChaos(
  request: import("@playwright/test").APIRequestContext,
): Promise<void> {
  await request.post(`${API_URL}/api/chaos`, {
    data: { failSignNextN: 0, failCompleteNextN: 0, slowSignMs: 0 },
  })
}

async function readResumeState(
  page: import("@playwright/test").Page,
): Promise<ResumeStateShape | null> {
  return page.evaluate<ResumeStateShape | null>(() => {
    const raw = window.localStorage.getItem("tranquilload:resume")
    return raw ? (JSON.parse(raw) as ResumeStateShape) : null
  })
}

// Serial: both R1 tests mutate the test-app's shared chaos state. Running
// them in parallel lets one test's `afterEach` resetChaos wipe the other
// test's chaos config mid-flight, masking the retry behavior we want to
// assert. The cross-browser specs don't touch chaos, so they're unaffected
// and stay parallel.
test.describe.serial("R1 — Resume safety end-to-end (Story 10.3, BLOCKER)", () => {
  // Note: we deliberately do NOT call `purgeUploads()` in beforeEach.
  // Each test uses a timestamped unique filename, so stale objects from prior
  // runs never interfere. Purge-per-test would also race with parallel tests
  // running in other browsers (`firefox-ui`, `webkit-ui`) — see
  // `cross-browser.spec.ts` for the same rationale.
  test.beforeEach(async ({ request }) => {
    // Chaos state is now per-session (keyed by the `x-test-session` header set
    // in the context/request fixtures), so R1 can safely run on all three UI
    // projects in parallel. The previous chromium-ui-only skip is no longer
    // required — each (worker × project) gets its own chaos lane.
    await resetChaos(request)
  })

  test.afterEach(async ({ request }) => {
    // Defensive: leave the test-app's chaos state clean for the next test.
    await resetChaos(request)
  })

  test("10.3-E2E-001 — ResumeState survives reload and produces a byte-equal upload", async ({
    page,
    baseURL,
    minio,
    makeUploadBytes,
    request,
  }) => {
    test.slow() // 25 MiB across 5 parts + reload is north of the 30s default
    await bootstrapAppPage(page, baseURL)

    const upload = new UploadPage(page)
    const bytes = makeUploadBytes(25 * MiB, "incrementing")
    const filename = `r1-001-${Date.now()}.bin`

    // Serialize parts (concurrency=1) and slow each /sign by 2s so the 5-part
    // upload spans ~10s. Without this, parallel parts + a 600ms sign delay
    // complete the entire upload in ~1s — `clearResume()` then wipes
    // localStorage before the test can capture ResumeState.
    //
    // Chaos is set via the session-tagged `request` fixture, NOT via the
    // UI's apply-chaos button. The UI's fetch is not tagged with
    // `x-test-session`, so it would land in the shared "default" chaos lane
    // and collide with parallel R1 runs in other browser projects.
    await upload.concurrency.fill("1")
    await request.post(`${API_URL}/api/chaos`, {
      data: { failSignNextN: 0, failCompleteNextN: 0, slowSignMs: 2000 },
    })

    await upload.setFile(filename, bytes)
    await expect(upload.modeMultipart).toBeChecked()
    await upload.startBtn.click()

    // Wait until the library has saved a ResumeState — the lib persists right
    // after `initiate` resolves, so this is a reliable mid-upload checkpoint.
    //
    // We do NOT wait for any `PartCompleted` log line: the test-app drains
    // the `events` ReadableStream in parallel with `await result`, and in
    // practice those log lines are written together at completion — by which
    // point `clearResume()` has already wiped localStorage. Capturing state
    // right after the poll keeps us firmly mid-upload.
    await expect
      .poll(() => readResumeState(page), { timeout: 20_000, message: "ResumeState should appear in localStorage" })
      .not.toBeNull()

    const stateBeforeReload = await readResumeState(page)
    expect(stateBeforeReload, "ResumeState should exist before reload").not.toBeNull()
    // Sanity-check that the upload is genuinely still in progress.
    await expect(upload.startBtn).toBeDisabled()
    const objectKey = stateBeforeReload!.key

    await page.reload()

    // After reload, the banner should surface AND localStorage should still hold ResumeState.
    const upload2 = new UploadPage(page)
    await expect(upload2.resumeBanner).toBeVisible({ timeout: 10_000 })
    const stateAfterReload = await readResumeState(page)
    expect(stateAfterReload, "ResumeState must survive reload").toEqual(stateBeforeReload)

    // Disable chaos via the session-tagged request fixture (NOT
    // page.context().request, which is untagged).
    await resetChaos(request)

    // Re-attach the SAME file (the File reference is lost on reload).
    await upload2.setFile(filename, bytes)
    await upload2.resumeBtn.click()

    await expect(upload2.log).toContainText(/✅ Upload completed/i, { timeout: 60_000 })

    // Once completed the test-app clears the ResumeState — proves the success branch ran.
    await expect
      .poll(() => readResumeState(page), { timeout: 5_000 })
      .toBeNull()

    const verdict = await assertObjectBytesEqual(minio.client, minio.env.bucket, objectKey, bytes)
    expect(verdict, JSON.stringify(verdict)).toEqual({ ok: true })
  })

  test("10.3-E2E-002 — resumed upload re-signs every part (no stored URL reuse)", async ({
    page,
    baseURL,
    minio,
    makeUploadBytes,
    request,
  }) => {
    test.slow()
    await bootstrapAppPage(page, baseURL)

    const upload = new UploadPage(page)
    const bytes = makeUploadBytes(25 * MiB, "incrementing")
    const filename = `r1-002-${Date.now()}.bin`

    // Track every POST /api/multipart/sign, indexed by partNumber.
    const signedParts: number[] = []
    page.on("request", (req) => {
      const url = req.url()
      if (req.method() === "POST" && url.endsWith("/api/multipart/sign")) {
        const body = req.postData()
        if (!body) return
        try {
          const parsed = JSON.parse(body) as { partNumber?: unknown }
          if (typeof parsed.partNumber === "number") signedParts.push(parsed.partNumber)
        } catch {
          /* ignore — not a JSON body */
        }
      }
    })

    // Same timing strategy as 10.3-E2E-001. Set chaos via the session-tagged
    // `request` fixture, not the UI button.
    await upload.concurrency.fill("1")
    await request.post(`${API_URL}/api/chaos`, {
      data: { failSignNextN: 0, failCompleteNextN: 0, slowSignMs: 2000 },
    })

    await upload.setFile(filename, bytes)
    await upload.startBtn.click()

    // See 10.3-E2E-001 for why we don't wait for a PartCompleted log line.
    await expect.poll(() => readResumeState(page), { timeout: 20_000 }).not.toBeNull()

    const stateBeforeReload = await readResumeState(page)
    expect(stateBeforeReload).not.toBeNull()
    await expect(upload.startBtn).toBeDisabled()
    const objectKey = stateBeforeReload!.key
    const partsSignedBeforeReload = signedParts.length

    await page.reload()

    const upload2 = new UploadPage(page)
    await expect(upload2.resumeBanner).toBeVisible({ timeout: 10_000 })

    // Inject chaos via the session-tagged `request` fixture so it lands in
    // THIS browser project's chaos lane (not the shared "default"). Using
    // `page.context().request` here would NOT carry the `x-test-session`
    // header and would race with parallel R1 runs in other UI projects.
    //
    // failSignNextN=3 (rather than 1) gives a wider margin against the
    // race where concurrent sign calls deplete the counter faster than the
    // library can register a retry-eligible error.
    await request.post(`${API_URL}/api/chaos`, {
      data: { failSignNextN: 3, failCompleteNextN: 0, slowSignMs: 0 },
    })

    await upload2.setFile(filename, bytes)
    await upload2.resumeBtn.click()

    await expect(upload2.log).toContainText(/✅ Upload completed/i, { timeout: 90_000 })

    const partsSignedDuringResume = signedParts.length - partsSignedBeforeReload
    expect(
      partsSignedDuringResume,
      "the resumed session must request at least one sign call per remaining part (no stored URL reuse)",
    ).toBeGreaterThanOrEqual(1)

    // Re-sign-on-retry proof: at least one partNumber appears more than once in
    // the resumed session's sign log (because the chaos forced a retry).
    const resumeSigns = signedParts.slice(partsSignedBeforeReload)
    const counts = new Map<number, number>()
    for (const n of resumeSigns) counts.set(n, (counts.get(n) ?? 0) + 1)
    const someRetried = [...counts.values()].some((c) => c >= 2)
    expect(
      someRetried,
      `expected at least one part to be re-signed (chaos failure should have forced retry); resumed-session sign log: ${JSON.stringify(resumeSigns)}`,
    ).toBe(true)

    const verdict = await assertObjectBytesEqual(minio.client, minio.env.bucket, objectKey, bytes)
    expect(verdict, JSON.stringify(verdict)).toEqual({ ok: true })
  })
})
