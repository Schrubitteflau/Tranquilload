import { defineConfig, devices } from "@playwright/test"

/**
 * Tranquilload Playwright config.
 *
 * Project layout (matches Epic 10 test-design harness map):
 *   - chromium-ui / firefox-ui / webkit-ui → tests/e2e/ui/   (PW-UI, drives examples/test-app)
 *   - lib                                  → tests/e2e/lib/  (PW-Lib, library-direct, no UI navigation)
 *
 * Per-PR (CI): runs `chromium-ui` + `lib` (smoke).
 * Nightly:     runs the full 3-browser matrix.
 *
 * The `webServer` block auto-starts the test-app (Fastify backend on :3000 + Vite frontend on :5173).
 * MinIO is NOT auto-started here — start it once per session with `pnpm minio:up` (docker-compose
 * is in examples/test-app/). Rationale: docker startup is too slow for per-suite cost.
 */

const BASE_URL = process.env.BASE_URL ?? "http://localhost:5173"
const isCi = !!process.env.CI

export default defineConfig({
  testDir: ".",
  testMatch: ["e2e/**/*.spec.ts"],

  timeout: 60_000,
  expect: { timeout: 10_000 },

  fullyParallel: true,
  forbidOnly: isCi,
  retries: isCi ? 1 : 0,
  workers: isCi ? 2 : undefined,

  reporter: [
    ["list"],
    ["html", { outputFolder: "playwright-report", open: "never" }],
    ["junit", { outputFile: "test-results/junit.xml" }],
  ],

  use: {
    baseURL: BASE_URL,
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },

  projects: [
    {
      name: "chromium-ui",
      testDir: "e2e/ui",
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "firefox-ui",
      testDir: "e2e/ui",
      use: { ...devices["Desktop Firefox"] },
    },
    {
      name: "webkit-ui",
      testDir: "e2e/ui",
      use: { ...devices["Desktop Safari"] },
    },
    {
      name: "lib",
      testDir: "e2e/lib",
      use: { ...devices["Desktop Chrome"] },
    },
  ],

  webServer: process.env.SKIP_WEBSERVER
    ? undefined
    : {
        command: "pnpm --filter @tranquilload/test-app dev",
        url: `${BASE_URL}`,
        reuseExistingServer: !isCi,
        timeout: 120_000,
        stdout: "pipe",
        stderr: "pipe",
      },
})
