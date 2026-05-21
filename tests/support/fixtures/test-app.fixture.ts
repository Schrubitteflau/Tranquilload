import { test as base, type Page, type TestInfo } from "@playwright/test"
import { waitForServer } from "../helpers/wait-for-server.js"

export interface TestAppFixtures {
  /**
   * Pre-navigated page with localStorage cleared so each test starts from a
   * known clean state (no leftover ResumeState from a previous run).
   *
   * Use this instead of `page` whenever your test interacts with the test-app UI.
   */
  appPage: Page
}

const API_URL = process.env.API_URL ?? "http://localhost:3000"

const APP_PATH = process.env.APP_PATH ?? "/"

/**
 * Header the test-app's server reads to scope chaos state per Playwright
 * session. Without this, parallel workers across projects (chromium-ui /
 * firefox-ui / webkit-ui) all mutate the same chaos singleton and stomp on
 * each other's config. With it, each (worker × project) gets an isolated
 * chaos lane.
 *
 * Keep in sync with `examples/test-app/server/index.ts` (SESSION_HEADER).
 */
const SESSION_HEADER = "x-test-session"

const sessionFor = (testInfo: TestInfo): string =>
  `pw-w${testInfo.workerIndex}-${testInfo.project.name}`

/**
 * Install a `window.fetch` monkey-patch in the page that injects the session
 * header on requests to the test-app API host ONLY.
 *
 * Approach rationale:
 * - `context.setExtraHTTPHeaders` would also send the header to MinIO's
 *   presigned PUT URLs → MinIO rejects with SignatureDoesNotMatch.
 * - `context.route()` adds a Playwright network round-trip per request, and
 *   in practice mishandled streaming/JSON POSTs in our setup.
 * - In-page fetch patching is surgical: it only touches requests whose URL
 *   contains `:3000`, the test-app API origin. MinIO PUTs to `:9000` go
 *   through untouched.
 *
 * Runs on EVERY navigation (including reloads in R1), so the patch survives
 * `page.reload()`. Does NOT clear localStorage — that's an explicit one-shot
 * step where needed (so R1's ResumeState survives the reload).
 */
export async function injectSessionHeaderPatch(
  page: Page,
  testInfo: TestInfo,
): Promise<void> {
  await page.addInitScript(
    (args: { sid: string; header: string }) => {
      const orig = window.fetch.bind(window)
      window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
        let url = ""
        if (typeof input === "string") url = input
        else if (input instanceof URL) url = input.href
        else url = input.url
        // main.ts uses RELATIVE URLs like "/api/multipart/sign", which Vite
        // proxies to :3000. We can't filter on `:3000` because the URL is
        // relative; matching `/api/` covers both relative paths and absolute
        // URLs to the test-app, and MinIO PUTs to presigned :9000 URLs don't
        // include `/api/`.
        if (url.includes("/api/")) {
          const headers = new Headers(
            init?.headers ?? (input instanceof Request ? input.headers : undefined),
          )
          headers.set(args.header, args.sid)
          return orig(input, { ...init, headers })
        }
        return orig(input, init)
      }) as typeof window.fetch
    },
    { sid: sessionFor(testInfo), header: SESSION_HEADER },
  )
}

export const test = base.extend<TestAppFixtures>({
  // Override `page` to install the fetch monkey-patch before any user script
  // runs. Applies to all tests that use `page` directly (R1) or `appPage`.
  page: async ({ page }, use, testInfo) => {
    await injectSessionHeaderPatch(page, testInfo)
    await use(page)
  },

  // The standalone `request` fixture is used for chaos reset / mutation in
  // R1's beforeEach/afterEach and within the test bodies. It never hits MinIO,
  // so a flat `extraHTTPHeaders` is safe.
  request: async ({ playwright }, use, testInfo) => {
    const ctx = await playwright.request.newContext({
      extraHTTPHeaders: { [SESSION_HEADER]: sessionFor(testInfo) },
    })
    await use(ctx)
    await ctx.dispose()
  },

  appPage: async ({ page, baseURL }, use) => {
    await waitForServer(`${API_URL}/api/health`)

    // localStorage.clear must NOT be in addInitScript (would clear on reload
    // and wipe R1's ResumeState). Done explicitly post-navigation here.
    await page.goto(new URL(APP_PATH, baseURL ?? "http://localhost:5173").toString())
    await page.evaluate(() => window.localStorage.clear())

    await use(page)
  },
})

export { expect } from "@playwright/test"
