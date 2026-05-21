import { test, expect } from "@support/fixtures"
import { UploadPage } from "@support/page-objects/upload-page"
import { MiB, makeBytes } from "@support/helpers/file-factory"

/**
 * Story 10.8-E2E-001 — Abort cancels in-flight fetches (F#82).
 *
 * R6 mitigation (Score 6): without explicit signal propagation from the lib
 * to the user's fetches, clicking Abort interrupts the orchestration fiber
 * but leaves in-flight PUTs running silently in the background (Effect's
 * fiber interruption does NOT cancel `Effect.tryPromise`-wrapped Promises).
 *
 * The lib's contract is "user wires their own AbortSignal into their
 * callbacks" — the test-app does this via `makeMultipartCallbacks(file, ctx,
 * signal)` (signal is `currentAbort.signal`). This test locks that
 * propagation down: after the user clicks Abort, at least one in-flight PUT
 * to MinIO must surface in the network log as `requestfailed` (cancelled),
 * NOT as a successful 200 response.
 *
 * Why the page.route delay: MinIO PUTs against localhost complete in <100ms.
 * Without an injected delay the abort always lands AFTER every in-flight PUT
 * has finished — the test would pass even with broken signal propagation
 * because nothing was actually in flight. The delay forces every PUT to
 * spend ~3s on the wire so Abort can hit one mid-flight.
 */

const API_URL = process.env.API_URL ?? "http://localhost:3000"

test.describe("Cleanup — Abort cancels in-flight fetches (Story 10.8, F#82)", () => {
  test.beforeEach(async ({ request }) => {
    await request.post(`${API_URL}/api/chaos`, {
      data: { failSignNextN: 0, failCompleteNextN: 0, slowSignMs: 0 },
    })
  })

  test("10.8-E2E-001 — clicking Abort surfaces at least one PUT as requestfailed (not 200)", async ({
    appPage,
  }) => {
    test.slow()

    // Inject ~2.5s delay on every MinIO PUT so Abort can land mid-flight.
    // The route handler simulates a slow upload by sleeping before forwarding;
    // an AbortError on the fetch causes the route to surface as requestfailed.
    await appPage.route(/\/uploads\//, async (route) => {
      await new Promise((r) => setTimeout(r, 2500))
      await route.continue()
    })

    interface PutOutcome {
      url: string
      status: "ok" | "failed"
      errorText?: string
      httpStatus?: number
    }
    const putOutcomes: PutOutcome[] = []

    appPage.on("response", (res) => {
      const req = res.request()
      if (req.method() === "PUT" && req.url().includes("/uploads/")) {
        putOutcomes.push({
          url: req.url(),
          status: "ok",
          httpStatus: res.status(),
        })
      }
    })
    appPage.on("requestfailed", (req) => {
      if (req.method() === "PUT" && req.url().includes("/uploads/")) {
        putOutcomes.push({
          url: req.url(),
          status: "failed",
          errorText: req.failure()?.errorText ?? "(unknown)",
        })
      }
    })

    const upload = new UploadPage(appPage)
    // 20 MiB / 5 MiB chunk = 4 parts. concurrency=2 keeps 2 in flight at any
    // moment, so a mid-flight abort will catch at least one PUT cancellable.
    const bytes = makeBytes(20 * MiB, "incrementing")
    const filename = `cleanup-d001-${Date.now()}.bin`

    await upload.setFile(filename, bytes)
    await upload.concurrency.fill("2")
    await expect(upload.modeMultipart).toBeChecked()
    await upload.startBtn.click()

    // Wait until the lib has dispatched at least one PUT (the response/route
    // listeners increment as soon as a request leaves the browser).
    await expect
      .poll(() => putOutcomes.length, {
        timeout: 15_000,
        message: "at least one MinIO PUT should be observed before abort",
      })
      .toBeGreaterThan(0)

    // Click Abort while PUTs are still in their 2.5s delay window.
    await upload.abortBtn.click()

    // Wait for the orchestration to surface the abort in the UI log.
    await expect(upload.log).toContainText(/abort/i, { timeout: 15_000 })

    // Give Playwright a moment to drain pending requestfailed events that
    // were triggered by the fetch abort.
    await appPage.waitForTimeout(1500)

    const failed = putOutcomes.filter((o) => o.status === "failed")
    const completed = putOutcomes.filter((o) => o.status === "ok")

    expect(
      failed.length,
      `expected ≥1 PUT to be cancelled by AbortSignal propagation; outcomes were ${JSON.stringify(putOutcomes, null, 2)}`,
    ).toBeGreaterThan(0)

    // Every failed PUT's errorText should look like an abort, not a network error.
    for (const f of failed) {
      expect(
        f.errorText ?? "",
        `PUT cancellation should look like an abort, got "${f.errorText}"`,
      ).toMatch(/abort|cancel/i)
    }

    // Sanity: any PUT that DID complete with 200 must have already finished
    // before Abort fired — that's fine. We just need ≥1 abort to prove
    // signal propagation works.
    for (const c of completed) {
      expect(c.httpStatus).toBeLessThan(400)
    }
  })
})
