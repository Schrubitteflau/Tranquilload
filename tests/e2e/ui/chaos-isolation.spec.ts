import { test, expect } from "@support/fixtures"

const API_URL = process.env.API_URL ?? "http://localhost:3000"

/**
 * Chaos session-isolation audit (Epic 11 prerequisite from Epic 10 retro).
 *
 * Background: the test-app's `/api/chaos` endpoint keys its state by the
 * `x-test-session` header (since 2026-05-19). Each Playwright (worker × project)
 * gets its own session string `pw-w<workerIdx>-<projectName>` so parallel
 * runs on chromium-ui / firefox-ui / webkit-ui do not stomp on each other.
 *
 * Past failure mode (pre-refactor): a singleton chaos object on the server.
 * One project's `failCompleteNextN > 0` poisoned the others' lanes, producing
 * confusing intermittent failures (see project_dev_server_stale_state).
 *
 * This audit explicitly stresses cross-session isolation under all three
 * UI browser projects in parallel. Designed to be re-run with
 * `playwright test --grep "chaos isolation audit" --repeat-each=50`.
 * If isolation regresses, the assertions below catch:
 *   - own-session overwritten by a sibling worker (write→yield→read mismatch)
 *   - "default" session polluted by an audit worker
 *   - newly-named session inheriting non-zero state from an unrelated lane
 */
test.describe("chaos isolation audit (multi-project parallel)", () => {
  test("per-session chaos is preserved under parallel contention", async ({ request }, testInfo) => {
    const sessionTag = `pw-w${testInfo.workerIndex}-${testInfo.project.name}`

    // Fingerprint encodes worker + project so cross-leaks are detectable.
    // Project char code → small number; multiply worker idx by 1000 to avoid collision.
    const projectFingerprint = testInfo.project.name.charCodeAt(0) % 100
    const fingerprint = (testInfo.workerIndex + 1) * 1000 + projectFingerprint
    const completeFingerprint = fingerprint + 7

    // Step 1: write fingerprint to OUR session via the request fixture
    // (which carries `x-test-session: pw-w<idx>-<project>` automatically).
    const writeResp = await request.post(`${API_URL}/api/chaos`, {
      data: {
        failSignNextN: fingerprint,
        failCompleteNextN: completeFingerprint,
        slowSignMs: 0,
      },
    })
    expect(writeResp.ok(), "initial chaos write must succeed").toBe(true)

    // Step 2: yield briefly so other parallel workers have a window to write
    // their own chaos config concurrently. Randomized jitter to avoid
    // lock-step synchronization that would hide races.
    await new Promise((r) => setTimeout(r, 25 + Math.random() * 75))

    // Step 3: read OUR session back. Must equal the exact fingerprint we wrote
    // — anything else means a sibling worker's write leaked into our lane.
    const mineResp = await request.get(`${API_URL}/api/chaos`)
    expect(mineResp.ok()).toBe(true)
    const mine = await mineResp.json()
    expect(mine, `session ${sessionTag} chaos must not be overwritten by another worker`).toMatchObject({
      failSignNextN: fingerprint,
      failCompleteNextN: completeFingerprint,
      slowSignMs: 0,
    })

    // Step 4: probe the shared "default" session via a header-less fetch.
    // No audit worker writes to "default", so it must remain zeroed. If it
    // ever shows non-zero values, some test forgot to set the session header
    // or the server lookup fell through to default.
    const defResp = await fetch(`${API_URL}/api/chaos`, {
      headers: { "x-test-session": "default" },
    })
    const def = await defResp.json()
    expect(def, `"default" session must not inherit chaos from audit worker ${sessionTag}`).toMatchObject({
      failSignNextN: 0,
      failCompleteNextN: 0,
      slowSignMs: 0,
    })

    // Step 5: probe a brand-new, never-written session id. Must start at zero
    // — proves `getChaos` does not return a polluted entry on first access.
    const freshSid = `audit-probe-fresh-${sessionTag}-${Date.now()}-${Math.random()}`
    const freshResp = await fetch(`${API_URL}/api/chaos`, {
      headers: { "x-test-session": freshSid },
    })
    const fresh = await freshResp.json()
    expect(fresh, "newly-named session must initialize to zero chaos").toMatchObject({
      failSignNextN: 0,
      failCompleteNextN: 0,
      slowSignMs: 0,
    })
  })

  // Reset our session after each iteration so subsequent --repeat-each runs
  // start from a known-zero baseline (and we leave no garbage for cleanup-
  // sensitive specs that follow).
  test.afterEach(async ({ request }) => {
    await request
      .post(`${API_URL}/api/chaos`, {
        data: { failSignNextN: 0, failCompleteNextN: 0, slowSignMs: 0 },
      })
      .catch(() => {
        /* swallow — best-effort cleanup, next test sets values anyway */
      })
  })
})
