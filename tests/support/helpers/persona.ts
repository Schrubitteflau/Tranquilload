import type { APIRequestContext, Page } from "@playwright/test"
import { waitForServer } from "./wait-for-server.js"

/**
 * Shared helpers for the Story 11.4 persona-journey PW-UI specs.
 *
 * Several personas bypass the `appPage` fixture because they either need debug
 * query params (`?forgotAwait=1`, `?probeGetProgressFromPartOne=1`,
 * `?retryRecurs=…&retryFixedMs=…`) or must survive a `page.reload()` with
 * ResumeState intact — and `appPage` installs `addInitScript(localStorage.clear)`
 * which would wipe that state on every navigation. These helpers give those
 * specs the same "navigate + clear once" bootstrap without the reload footgun.
 */

const API_URL = process.env.API_URL ?? "http://localhost:3000"
const APP_PATH = process.env.APP_PATH ?? "/"

export interface ResumeStateShape {
  uploadId: string
  key: string
  filename: string
  size: number
  chunkSize: number
}

/**
 * Navigate the bare `page` to the test-app (optionally with a `?…` debug query
 * string) and clear localStorage exactly once — NOT in an addInitScript, so it
 * does not re-run on reload (R1/C2 need ResumeState to survive the reload).
 * The `page` fixture override in `test-app.fixture` has already installed the
 * `x-test-session` fetch monkey-patch via addInitScript, so chaos set through
 * the session-tagged `request` fixture lands in this page's lane.
 */
export async function bootstrapAppPage(
  page: Page,
  baseURL: string | undefined,
  search = "",
): Promise<void> {
  await waitForServer(`${API_URL}/api/health`)
  await page.goto(new URL(`${APP_PATH}${search}`, baseURL ?? "http://localhost:5173").toString())
  await page.evaluate(() => window.localStorage.clear())
}

/** Read the test-app's persisted ResumeState (or `null` if none). */
export async function readResumeState(page: Page): Promise<ResumeStateShape | null> {
  return page.evaluate<ResumeStateShape | null>(() => {
    const raw = window.localStorage.getItem("tranquilload:resume")
    return raw ? (JSON.parse(raw) as ResumeStateShape) : null
  })
}

/** Zero the chaos state for this session via the session-tagged request fixture. */
export async function resetChaos(request: APIRequestContext): Promise<void> {
  await request.post(`${API_URL}/api/chaos`, {
    data: { failSignNextN: 0, failCompleteNextN: 0, slowSignMs: 0 },
  })
}

/** Set chaos fields for this session (only the provided fields are changed). */
export async function setChaos(
  request: APIRequestContext,
  data: Partial<{ failSignNextN: number; failCompleteNextN: number; slowSignMs: number }>,
): Promise<void> {
  await request.post(`${API_URL}/api/chaos`, { data })
}

// URL matcher for the upload "tunnel": the test-app API (`/api/…`, whether the
// relative path or the proxied absolute URL) plus MinIO presigned PUTs (`:9000`).
// Vite/HMR/page-asset traffic is deliberately excluded so only the upload drops.
const UPLOAD_NET = /\/api\/|:9000/

/**
 * Simulate a network outage scoped to the upload traffic — a portable stand-in
 * for `context.setOffline` (whose WebKit support is uneven). `route.abort()`
 * with the default error code is supported on all three engines and surfaces to
 * the page as a generic fetch network failure, exactly like a dropped tunnel.
 *
 * NOTE: Playwright only intercepts requests that START after the route is
 * registered; in-flight requests are not retroactively aborted.
 */
export async function dropUploadNetwork(page: Page): Promise<void> {
  await page.route(UPLOAD_NET, (route) => route.abort())
}

/** Restore connectivity by removing all page routes registered above. */
export async function restoreUploadNetwork(page: Page): Promise<void> {
  await page.unrouteAll({ behavior: "ignoreErrors" })
}
