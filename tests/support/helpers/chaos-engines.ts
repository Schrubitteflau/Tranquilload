import { chromium, firefox, webkit, type BrowserContext, type BrowserType, type Page } from "@playwright/test"

/**
 * Cross-browser matrix helper for the Story 11.5 chaos specs (PW-Lib).
 *
 * The `lib` Playwright project is Chromium-only by default, so cross-browser
 * chaos specs launch the three engines explicitly — mirroring the Epic 10
 * pattern in `deflate-raw-support-matrix.spec.ts` / `simple-http-upload-cross-browser.spec.ts`.
 *
 * During development, restrict the matrix with `CHAOS_ENGINES=chromium` (or a
 * comma list) to iterate fast; the nightly run leaves it unset → all 3 engines.
 */
const BASE_URL = process.env.BASE_URL ?? "http://localhost:5173"
export const BENCH_URL = `${BASE_URL}/bench.html`

export type EngineName = "chromium" | "firefox" | "webkit"

const ALL: ReadonlyArray<readonly [EngineName, BrowserType]> = [
  ["chromium", chromium],
  ["firefox", firefox],
  ["webkit", webkit],
]

const requested = process.env.CHAOS_ENGINES?.split(",")
  .map((s) => s.trim())
  .filter(Boolean)

export const ENGINES: ReadonlyArray<readonly [EngineName, BrowserType]> =
  requested && requested.length > 0 ? ALL.filter(([n]) => requested.includes(n)) : ALL

/**
 * Launch `browserType`, open the bench page (lib exposed on `window.__tlBench__`),
 * hand the caller a fresh `{ page, context }` to install chaos routes + drive
 * the upload, then tear the browser down. Routes installed inside `body` apply
 * to the subsequent upload requests (bench page load itself touches neither
 * `:9000` nor `/api/multipart/*`).
 */
export async function runOnEngine(
  browserType: BrowserType,
  body: (ctx: { page: Page; context: BrowserContext; engine: EngineName }) => Promise<void>,
  engine: EngineName,
): Promise<void> {
  const browser = await browserType.launch()
  try {
    const context = await browser.newContext({ baseURL: BASE_URL })
    const page = await context.newPage()
    await page.goto(BENCH_URL)
    await page.waitForFunction(
      () =>
        typeof (window as unknown as { __tlBench__?: { uploadMultipart?: unknown } }).__tlBench__
          ?.uploadMultipart === "function",
      undefined,
      { timeout: 15_000 },
    )
    await body({ page, context, engine })
  } finally {
    await browser.close()
  }
}
