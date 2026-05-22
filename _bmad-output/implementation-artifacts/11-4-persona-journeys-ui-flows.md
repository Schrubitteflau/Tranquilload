# Story 11.4: Persona Journeys (UI Flows)

Status: ready-for-dev

## Story

As a library maintainer,
I want Playwright-UI persona journey specs that drive the full test-app DOM through realistic user-failure scenarios (tunnel disconnect, screen lock, Wi-Fi handoff, forgot-await, foot-gun `getProgress`, custom retry schedule, MinIO multipart TTL),
so that the documented foot-guns and persona-failures stay locked behaviour and do not silently regress.

## Acceptance Criteria

1. **Given** the test-app upload UI is loaded and a multipart upload is in flight **When** the network is dropped for 30 seconds (P#A1 tunnel disconnect) or the page is throttled to simulate a screen lock (P#A2) **Then** the default retry schedule proves insufficient for the 30s+ outage (test ID 11.4-E2E-001 — locks the tuning need into a test) and screen-lock throttling does not crash the upload fiber (test ID 11.4-E2E-002).

2. **Given** an upload that survives a Wi-Fi → 5G handoff (P#A4) **When** the underlying TCP connection dies and `fetch` errors **Then** retry resilience kicks in and the upload completes (test ID 11.4-E2E-003).

3. **Given** a developer who forgets to `await result` on `uploadMultipart()` (P#B1) **When** the upload fails **Then** the unhandled rejection surface is deterministic and documented (test ID 11.4-E2E-004).

4. **Given** an upload whose `uploadPart` callback for part 1 calls `getProgress()` inside itself (P#B5) **When** the call happens BEFORE the `Ref.update` post-uploadPart timing window **Then** the snapshot returns 0 bytes — locking the documented MEMORY foot-gun (test ID 11.4-E2E-005).

5. **Given** `retrySchedule: Schedule.recurs(10).pipe(Schedule.fixed("1 second"))` is supplied (P#B6) **When** transient failures occur **Then** the schedule is honoured end-to-end through the test-app (test ID 11.4-E2E-006).

6. **Given** an upload abandoned long enough for MinIO to GC the multipart (P#C2) **When** the user reloads the page and the test-app calls `reconcileCompletedParts` **Then** reconcile returns empty AND HEAD on the key fails — current behaviour is documented as fresh-start, with the gap surfaced as an Epic 13 candidate (test ID 11.4-E2E-007).

## Tasks / Subtasks

- [ ] Task 1: File layout (AC: all)
  - [ ] One spec file per persona: `tests/e2e/ui/persona-A1-tunnel-disconnect.spec.ts`, `persona-A2-screen-lock.spec.ts`, `persona-A4-wifi-handoff.spec.ts`, `persona-B1-forgot-await.spec.ts`, `persona-B5-progress-foot-gun.spec.ts`, `persona-B6-custom-retry-schedule.spec.ts`, `persona-C2-multipart-ttl.spec.ts`
  - [ ] OR one consolidated spec file `tests/e2e/ui/persona-journeys.spec.ts` with 7 `test()` blocks — choose based on existing test-app spec conventions (mirror Epic 10 e2e/ui layout)

- [ ] Task 2: P#A1 tunnel disconnect — 11.4-E2E-001 (AC: #1)
  - [ ] Start an upload via the test-app UI; verify progress > 0
  - [ ] Use `context.setOffline(true)` for 30 seconds (or `route` to block all matching URLs)
  - [ ] Restore connectivity
  - [ ] Assert the upload either fails with a typed error in the UI log OR retries indefinitely — capture CURRENT behaviour; document the tuning need
  - [ ] If the upload completes after restore, that's also valid CURRENT behaviour — lock it

- [ ] Task 3: P#A2 screen lock — 11.4-E2E-002 (AC: #1)
  - [ ] Throttle CPU heavily via CDP `Emulation.setCPUThrottlingRate` (e.g. `{ rate: 20 }`)
  - [ ] Run a multipart upload through it
  - [ ] Assert the upload either completes (slow) or fails cleanly — NO fiber crash, NO unhandled rejection in the UI log
  - [ ] WebKit note: CDP isn't available; use `page.evaluate` to inject artificial `setTimeout` delays in `uploadPart` instead (per D3 stabilization commitment — accept platform variance, demote spec only if proven flaky)

- [ ] Task 4: P#A4 Wi-Fi → 5G handoff — 11.4-E2E-003 (AC: #2)
  - [ ] Simulate TCP-connection death by `context.setOffline(true)` for 3-5 seconds mid-upload, then back online
  - [ ] Assert retry resilience: upload completes successfully

- [ ] Task 5: P#B1 forgot-await — 11.4-E2E-004 (AC: #3)
  - [ ] Trigger the test-app's `forgotAwait` mode (may require a test-app code path; if absent, add a minimal toggle behind a query param e.g. `?forgotAwait=1`)
  - [ ] Force a failure (chaos endpoint: PUT 500 always)
  - [ ] Assert the unhandled rejection appears in `page.on("pageerror", ...)` AND the UI log captures the dangling Promise
  - [ ] Lock that this is OBSERVABLE — a regression would silently swallow the rejection

- [ ] Task 6: P#B5 `getProgress` foot-gun — 11.4-E2E-005 (AC: #4)
  - [ ] The test-app must expose a debug toggle that calls `getProgress()` from inside `uploadPart` for part 1 (add if missing)
  - [ ] Poll the recorded value; assert it reads 0 (NOT the bytes uploaded so far)
  - [ ] Reference MEMORY: "Ref.update post-uploadPart timing: `Ref.update` fires after `uploadPart` resolves — `getProgress()` polled inside `uploadPart` for part 1 sees 0 bytes"

- [ ] Task 7: P#B6 custom retry schedule — 11.4-E2E-006 (AC: #5)
  - [ ] The test-app must accept a `retrySchedule` config (likely via query param JSON or fixture)
  - [ ] Configure `Schedule.recurs(10).pipe(Schedule.fixed("1 second"))`
  - [ ] Use chaos endpoint to fail PUTs 5 times then succeed
  - [ ] Assert: total wall-time of the retried part is ≥ 5s (5 × 1s fixed delay), upload completes, retry count in log = 5

- [ ] Task 8: P#C2 MinIO multipart TTL — 11.4-E2E-007 (AC: #6)
  - [ ] Start an upload; capture `uploadId` from localStorage
  - [ ] Manually call MinIO's `AbortMultipartUpload` via the `request` fixture (or `mc` via a helper) to simulate TTL expiry
  - [ ] Reload the page
  - [ ] Assert `reconcileCompletedParts` returns empty AND `HEAD` on the object fails → test-app starts fresh
  - [ ] Document CURRENT behaviour with a `// Epic 13 candidate: auto-detect stale uploadId + auto-re-init` comment

- [ ] Task 9: Fixture & test-app hooks (AC: all)
  - [ ] Confirm the per-session chaos endpoint (since 2026-05-19) is wired into the `request` fixture for ALL persona specs that need failure injection (P#A1, P#A4, P#B1, P#B6)
  - [ ] Use UNIQUE timestamped filenames per spec (MEMORY: "Never `purgeUploads()` per-test in a matrix run")
  - [ ] Resume-sensitive specs (P#C2) must bypass the `appPage` fixture's `addInitScript(localStorage.clear)` — use raw `page` + inline setup (MEMORY: "Resume tests bypass `appPage`")

- [ ] Task 10: Cross-browser matrix (AC: all)
  - [ ] Run on `chromium-ui`, `firefox-ui`, `webkit-ui`
  - [ ] D3 stabilization commitment: do NOT pre-emptively skip WebKit; tag with `@flaky` and demote to weekly ONLY for specific specs that prove unstable in actual nightly runs
  - [ ] For specs that depend on Chromium-only APIs (CDP, `performance.memory`), gate with `test.skip(({ browserName }) => ..., reason)`

- [ ] Task 11: Verification
  - [ ] `pnpm exec playwright test --project=chromium-ui tests/e2e/ui/persona-*.spec.ts` green
  - [ ] `pnpm exec playwright test --project=firefox-ui tests/e2e/ui/persona-*.spec.ts` green
  - [ ] `pnpm exec playwright test --project=webkit-ui tests/e2e/ui/persona-*.spec.ts` green (or document specific specs deferred to weekly with `@flaky` tag)
  - [ ] Re-run the chaos-isolation audit at 150/150 to confirm personas don't poison it: `pnpm exec playwright test tests/e2e/ui/chaos-isolation.spec.ts --repeat-each=50`

- [ ] Task 12: Traceability update
  - [ ] Append 11.4-E2E-001 → 11.4-E2E-007 rows to `_bmad-output/test-artifacts/traceability/traceability-report-epic-11.md`

## Dev Notes

### Spec inputs

- Source spec: `_bmad-output/test-artifacts/test-design-epic-11.md` § "Story 11.4 — Persona journeys (UI flows)"
- Risk clusters: R-P2-1 (DATA, HIGH, Score 6 — resume after MinIO TTL) + R-P2-10 (BUS, MEDIUM, Score 4 — `getProgress` foot-gun)
- 7 PW-UI persona specs, ~2-3h/test mean
- **This is the ONLY PW-UI story in Epic 11.** All other P2 stories follow the lib-default policy per `feedback_p2_default_to_lib.md`.

### Critical patterns

- **Chaos endpoint is per-session (MEMORY):** the request fixture auto-wires the `x-test-session` header. Don't use `applyChaos.click()` — the page-fetch path doesn't carry the session header.
- **Test-app fetch monkey-patch filters on PATH not PORT (MEMORY):** any new test-app endpoint must use `/api/...` path, MinIO PUTs `:9000` stay untouched.
- **`pnpm test-app:reset` (MEMORY):** if a UI matrix goes red, follow the debug runbook (`feedback_test_app_debug_runbook.md`): curl → reset → single-worker repro → lib investigation.
- **Test-app log batches at completion (MEMORY):** don't gate test progress on `PartCompleted` log text. Use `expect.poll(readResumeState)` + `expect(startBtn).toBeDisabled()` instead.
- **Resume tests bypass `appPage` (MEMORY):** P#C2 (and any spec that touches localStorage state across reloads) must use raw `page` + inline setup — the `appPage` fixture's `addInitScript(localStorage.clear)` would wipe state.
- **AbortSignal must be wired (MEMORY):** the test-app's `makeMultipartCallbacks(file, ctx, signal?)` (Story 10.8) is the canonical pattern. Personas with cancellation paths (P#A1, P#A2, P#A4) must use it.
- **Unique timestamped filenames (MEMORY):** never `purgeUploads()` per-test — parallel workers in sibling browsers will wipe objects mid-assertion.

### D3 stabilization commitment

Per the decision recorded in `epics.md` § "Open Decisions":

> Run 11.4 in the standard nightly tier; only demote individual specs to weekly via the `@flaky` tag if WebKit timings prove unstable in practice. The 150/150 chaos-isolation audit is the precedent the personas inherit.

In practice: do NOT pre-emptively `test.skip` on WebKit. If a specific spec proves consistently unstable in 5+ consecutive nightly runs, demote THAT spec (not the story).

### Test-app changes likely needed

Several persona scenarios may require small test-app additions (audit + add via PR if absent):
- `?forgotAwait=1` query toggle (P#B1)
- `?probeGetProgressFromPartOne=1` toggle (P#B5)
- Config injection for `retrySchedule` (P#B6) — likely via JSON in a query param or a fixture-managed config endpoint

Surface any such additions as a small precursor PR; do not block Story 11.4 on them, but cite them in the story File List.

### Files likely touched

- New: 7 spec files under `tests/e2e/ui/` (or 1 consolidated)
- Possibly modified: `examples/test-app/src/main.ts` (debug toggles)
- Updated: traceability report

### Out of scope

- Auto-re-init on stale uploadId (Epic 13 candidate flagged in P#C2)
- Auto-throttle adaptation for screen-lock (Epic 13)

## References

- [Source: _bmad-output/test-artifacts/test-design-epic-11.md § Story 11.4] — 7 net-new tests
- [Source: _bmad-output/brainstorming/brainstorming-session-2026-05-17-001.md] — P#A1, P#A2, P#A4, P#B1, P#B5, P#B6, P#C2
- [Source: _bmad-output/planning-artifacts/epics.md § Story 11.4 + § Open Decisions D3] — AC + stabilization commitment
- [MEMORY: feedback_test_app_debug_runbook.md] — UI matrix red → curl → reset → single-worker → lib
- [MEMORY: project_test_framework_patterns.md] — fixtures, projects, mergeTests
- [MEMORY: project_test_app_chaos_state.md] — per-session chaos endpoint
- [MEMORY: project_test_relative_url_filter.md] — fetch monkey-patch path filter
- [MEMORY: project_dev_server_stale_state.md] — `pnpm test-app:reset`
- [MEMORY: project_test_purge_race.md] — unique filenames > per-test purge
- [MEMORY: feedback_p2_default_to_lib.md] — exception: this story IS the PW-UI escalation

## Dev Agent Record

### Agent Model Used

(to be filled by dev)

### Debug Log References

### Completion Notes List

### Change Log

### File List

## Senior Developer Review (AI)

(to be filled at review time)
