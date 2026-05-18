import { test as base, type Page } from "@playwright/test"
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

/**
 * Path Vite serves the harness at. The test-app's vite.config has
 * `root: "."` but its `index.html` lives in `public/`, so `/` returns 404
 * while `/index.html` works (Vite serves it verbatim from publicDir). If the
 * test-app is ever moved to the idiomatic layout (index.html at the project
 * root), set this back to "/".
 */
const APP_PATH = process.env.APP_PATH ?? "/index.html"

export const test = base.extend<TestAppFixtures>({
  appPage: async ({ page, baseURL }, use) => {
    await waitForServer(`${API_URL}/api/health`)

    await page.addInitScript(() => {
      try {
        window.localStorage.clear()
      } catch {
        /* origin not yet available — first navigation will retry */
      }
    })

    await page.goto(new URL(APP_PATH, baseURL ?? "http://localhost:5173").toString())
    await page.evaluate(() => window.localStorage.clear())

    await use(page)
  },
})

export { expect } from "@playwright/test"
