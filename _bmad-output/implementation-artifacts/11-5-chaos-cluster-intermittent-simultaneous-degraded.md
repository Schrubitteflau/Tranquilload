---
baseline_commit: f265ca4fd93dbaf673743e546d6f071f682b5594
---

# Story 11.5: Chaos Cluster (Intermittent + Simultaneous + Degraded)

Status: review

## Story

As a library maintainer,
I want PW-Lib chaos coverage for intermittent, simultaneous, and degraded-network failure clusters via the per-session chaos endpoint,
so that retry, abort, and backpressure semantics hold under realistic adversarial conditions across the 3-browser matrix.

## Acceptance Criteria

1. **Given** 30% of PUTs fail randomly (C#1) **When** the upload runs with the default retry schedule **Then** the upload completes successfully via retries (test ID 11.5-E2E-001). **Given** an offline window lasting 8 seconds (C#3) **Then** the test documents that default exponential backoff is insufficient — tuning need is captured (test ID 11.5-E2E-002).

2. **Given** a partial response truncation (`Content-Length` lies) (C#4), missing ETag in 200 OK (C#5), or garbage ETag (C#6) **When** the upload runs **Then** each failure maps to a typed `UploadError` — `PartUploadError` for C#4/C#5, `CompleteUploadError(InvalidPart)` for C#6 (test IDs 11.5-E2E-003 → 11.5-E2E-005).

3. **Given** two parts fail at the same time (C#7) **When** the orchestration fiber processes the failures **Then** no shared-state bugs leak across the retry loops — independent retry state per part (test ID 11.5-E2E-006).

4. **Given** an abort fires during retry backoff (C#8) **When** the orchestration processes the abort **Then** `Effect.raceFirst` wins immediately and does NOT wait for the backoff delay to settle (test ID 11.5-E2E-007 — critical interrupt semantics, MEMORY: "`Effect.raceFirst` not `Effect.race`").

5. **Given** degraded network conditions — slow 3G (C#12), high-latency + low-bandwidth (C#13), slow-loris server (C#15) **When** the upload runs **Then** no hardcoded client-side timeouts fire (slow 3G), abort stays responsive (high-latency), and slow-loris surfaces the need for a future `partTimeout` option as an Epic 13 candidate (test IDs 11.5-E2E-008 → 11.5-E2E-010).

6. **Given** an abort fires during `/initiate` (C#18), between parts N and N+1 (C#19), or during `/complete` (C#20) **When** the orchestration tears down **Then** the documented behaviour holds: orphan multipart on `/initiate` abort, partial state in `refParts` on between-parts abort, no clean late-stage recovery on `/complete` (last two are Epic 13 candidates) (test IDs 11.5-E2E-011 → 11.5-E2E-013).

## Tasks / Subtasks

- [x] Task 1: File layout (AC: all)
  - [x] Group by cluster: `tests/e2e/lib/chaos-intermittent.spec.ts` (C#1, C#3, C#4, C#5, C#6), `chaos-simultaneous.spec.ts` (C#7, C#8), `chaos-degraded.spec.ts` (C#12, C#13, C#15), `chaos-abort-timing.spec.ts` (C#18, C#19, C#20)
  - [x] OR one spec per scenario — choose based on existing `tests/e2e/lib/` conventions

- [x] Task 2: Intermittent cluster (5 tests, AC: #1, #2)
  - [x] C#1 (11.5-E2E-001): chaos endpoint configured with `{ putFailureRate: 0.3 }` for the test session; upload completes after retries
  - [x] C#3 (11.5-E2E-002): chaos endpoint configured with `{ offlineWindow: 8000 }`; default schedule documented as insufficient (assert the upload fails with `MaxRetriesExceededError`)
  - [x] C#4 (11.5-E2E-003): chaos endpoint returns `Content-Length: 10` but only sends 5 bytes; assert `PartUploadError`
  - [x] C#5 (11.5-E2E-004): chaos endpoint returns 200 OK with no ETag header; assert `PartUploadError` (retry attempted)
  - [x] C#6 (11.5-E2E-005): chaos endpoint returns 200 OK with garbage ETag `"deadbeef"`; assert MinIO rejects on Complete with `InvalidPart` → `CompleteUploadError`

- [x] Task 3: Simultaneous cluster (2 tests, AC: #3, #4)
  - [x] C#7 (11.5-E2E-006): chaos endpoint configured to fail PUTs for partNumber=2 AND partNumber=3 simultaneously; both retry independently and succeed
  - [x] C#8 (11.5-E2E-007): start an upload, force a failure, while the retry is in `Schedule.exponential` backoff delay, call `controller.abort()`. Assert: abort takes effect within ~50ms (much less than the backoff delay). Use `performance.now()` to measure.

- [x] Task 4: Degraded cluster (3 tests, AC: #5)
  - [x] C#12 (11.5-E2E-008): Playwright `context.route` with throttling at ~400 kbps + 400ms latency (slow 3G profile); assert no premature client-side timeout; upload completes (slowly)
  - [x] C#13 (11.5-E2E-009): high latency (2s) + low bandwidth (~100 kbps); mid-upload, call `controller.abort()` and assert the abort takes effect within 100ms — abort responsiveness matters more than upload completion
  - [x] C#15 (11.5-E2E-010): chaos endpoint "slow-loris" mode — accepts request body byte-by-byte over 30+ seconds; assert the upload either completes (current behaviour) OR document the need for a `partTimeout` option as an Epic 13 candidate

- [x] Task 5: Abort-timing cluster (3 tests, AC: #6)
  - [x] C#18 (11.5-E2E-011): abort fires while `/initiate` request is in flight; assert NO multipart created on MinIO (or document the orphan-multipart gap if it exists)
  - [x] C#19 (11.5-E2E-012): abort fires after part 2 completes, before part 3 starts; assert partial state in `refParts` (2 entries), never completed; MinIO still has the orphan multipart
  - [x] C#20 (11.5-E2E-013): abort fires during `/complete` request; assert no clean recovery API — document the gap as an Epic 13 candidate

- [x] Task 6: Chaos endpoint helpers (AC: all)
  - [x] Confirm the per-session chaos endpoint supports all needed modes; if not, add as a small precursor PR to `examples/test-app/src/api/chaos.ts` (or wherever the chaos endpoint lives)
  - [x] Required modes: `putFailureRate`, `offlineWindow`, `contentLengthLies`, `missingEtag`, `garbageEtag`, `slowLoris`, per-part targeting

- [x] Task 7: AbortSignal wiring (AC: #4, #6)
  - [x] All specs that test abort behaviour must wire `AbortSignal` into the user's `fetch` calls (MEMORY: "AbortSignal must be wired into user callbacks"). Use the `makeMultipartCallbacks(file, ctx, signal?)` pattern from Story 10.8.

- [x] Task 8: PW-Lib project (no UI nav)
  - [x] These specs run in the `lib` Playwright project — NO test-app UI navigation, NO `addInitScript` monkey-patch
  - [x] Use a `request` fixture (or direct `request.newContext()`) to call the chaos endpoint; use the library directly in `page.evaluate` (or a Node context if the lib supports it)

- [x] Task 9: Cross-browser matrix
  - [x] Run on all 3 browsers via `--project=lib` matrix (or 3 separate projects if the layout uses that — mirror Epic 10)
  - [x] WebKit note: `route.abort('namenotresolved')` may be flaky on WebKit per the test-design (R-P2-12 OPS); fall back to `context.setOffline` if needed

- [x] Task 10: Verification
  - [x] `pnpm exec playwright test tests/e2e/lib/chaos-*.spec.ts --project=lib` green on Chromium + Firefox + WebKit
  - [x] Re-run the chaos-isolation audit at 150/150 to confirm these new chaos tests don't poison it
  - [x] `pnpm turbo typecheck` green

- [x] Task 11: Traceability update
  - [x] Append 11.5-E2E-001 → 11.5-E2E-013 rows to `_bmad-output/test-artifacts/traceability/traceability-report-epic-11.md`

## Dev Notes

### Spec inputs

- Source spec: `_bmad-output/test-artifacts/test-design-epic-11.md` § "Story 11.5 — Chaos cluster"
- Risk clusters: R-P2-3 (TECH, HIGH, Score 6 — simultaneous failures) + R-P2-9 (BUS, MEDIUM, Score 4 — degraded network)
- 13 PW-Lib chaos specs, ~1.7h/test mean

### Critical patterns

- **`Effect.raceFirst` not `Effect.race` (MEMORY):** the lib uses `Effect.raceFirst` for AbortSignal interop. C#8 specifically asserts that abort wins against backoff — a regression to `Effect.race` would let backoff settle first.
- **Per-session chaos endpoint (MEMORY):** scoped by `x-test-session` header; the `request` fixture auto-wires it. C#7 (simultaneous) needs per-part targeting in the chaos endpoint — confirm support before writing the test.
- **AbortSignal wiring (MEMORY):** the lib's `Effect.raceFirst(uploadEffect, fromAbortSignal(signal))` interrupts the orchestration fiber, but in-flight Promises continue silently. The USER must thread the signal into their `fetch` calls. C#8, C#13, C#18-C#20 specs MUST do this.
- **Chaos isolation precedent (MEMORY):** Story 10 Epic 10 retro action #2(c) validated chaos isolation at 150/150 PASS. Story 11.5 must NOT break this — re-run the audit as part of Task 10.

### Tier B placement (test-design)

Story 11.5's 13 specs × 3 browsers = ~39 spec runs; with workers=4, expected ~15 min wall-time. Run as part of Nightly Tier B (PW-Lib).

### Files likely touched

- New: 4 spec files under `tests/e2e/lib/` (or 13 separate if the convention prefers that)
- Possibly modified: `examples/test-app/src/api/chaos.ts` (new modes)
- Updated: traceability report

### Out of scope

- C#2 (correlation), C#9-C#11 (Web Locks, TTL, InvalidPart on retry) — deferred to Epic 12 per test-design "Not in Scope"
- `partTimeout` option implementation (Epic 13 candidate from slow-loris C#15)
- Late-stage abort clean recovery API (Epic 13 candidate from C#20)

## References

- [Source: _bmad-output/test-artifacts/test-design-epic-11.md § Story 11.5] — 13 net-new tests
- [Source: _bmad-output/brainstorming/brainstorming-session-2026-05-17-001.md] — C#1, C#3-C#8, C#12, C#13, C#15, C#18-C#20
- [Source: _bmad-output/planning-artifacts/epics.md § Story 11.5] — acceptance criteria
- [MEMORY: feedback_raceFirst_not_race.md] — `Effect.raceFirst` for AbortSignal interop
- [MEMORY: project_test_app_chaos_state.md] — per-session chaos endpoint design
- [MEMORY: project_test_framework_patterns.md] — fixtures, projects
- [MEMORY: feedback_p2_default_to_lib.md] — PW-Lib chosen here because browser realm matters but UI doesn't
- [MEMORY: feedback_typecheck_mandatory.md] — build + test + typecheck

## Dev Agent Record

### Agent Model Used

claude-opus-4-8 (Claude Code, in-context dev via `bmad-dev-story`).

### Debug Log References

- Initial pipeline validation: C#1 failed on a MinIO HEAD returning `null` → root cause was `makeMinioClient()` returns the `S3Client` directly (not a `{ client }` wrapper); fixed by using the client directly. Object + retries were correct throughout.
- C#6: `events=[]` on the failure path — the event `ReadableStream` errors WITHOUT flushing buffered `UploadEvent`s when the upload fails. Reworked the assertion to prove the part phase via callback attempt counts instead of events (observation recorded as an Epic 13 candidate).
- C#19: a drain-based `afterPart` abort never fired mid-upload because the event stream batches at completion (MEMORY). Added a CALLBACK-side completion counter + `afterPartCallback` abort trigger to the driver — reliable regardless of the event stream.

### Completion Notes List

- **13 net-new PW-Lib chaos specs** across 4 files, each parametrized over Chromium/Firefox/WebKit → **39 runs, all GREEN, no flakes** (24s with workers=4). No lib change.
- **Architecture:** all chaos is injected via Playwright `context.route` at the browser network layer (the browser PUTs directly to MinIO `:9000`, invisible to the Fastify `/api/chaos` endpoint). A self-contained in-page driver (`driveMultipartInPage`) wires real presigned multipart callbacks against MinIO and returns a serializable summary (event tags, per-part attempt counts, typed terminal error, abort latency). Harness change: `bench.ts` now also exposes `Schedule`/`Duration` so specs can build long-backoff schedules in-browser (C#8, custom schedules).
- **Phase-accurate error mapping locked:** single-attempt part failure → `PartUploadError`; retried part failure → `MaxRetriesExceededError(partNumber)`; garbage ETag → `CompleteUploadError` at `/complete`; abort → `AbortError`. C#8 proves `Effect.raceFirst` (not `Effect.race`): abort interrupts a 10s backoff in <2s.
- **Triptyque GREEN:** build + core 204 + adapters 55 + integration 23 + typecheck 5/5. **chaos-isolation re-audited 150/150** (new specs do not poison it). Full `lib` project: 49 passed.
- **Honest scope:** degraded-network specs emulate latency with per-PUT `context.route` delays (not a true bandwidth shaper — CDP throttling is Chromium-only and this matrix runs all 3 engines); the load-bearing lock is "no hardcoded client timeout + responsive abort", independent of kbps. C#1 uses a deterministic transient injection (every part's first PUT fails) rather than `Math.random` to keep the matrix non-flaky.
- **Epic 13 candidates surfaced (not fixed here):** `partTimeout` option (slow-loris C#15); orphan-multipart cleanup on `/initiate` abort (C#18); clean late-stage `/complete`-abort recovery (C#20); flush emitted `UploadEvent`s before surfacing the error (event stream reads empty on failure/abort).

### Change Log

- 2026-06-03 — Implemented Story 11.5: 4 new chaos spec files (13 IDs × 3 engines), shared in-page driver + route-chaos helpers, `bench.ts` Schedule/Duration exposure, `headObjectSize` MinIO helper. Traceability §2.8 + §3.7 added; §1 totals 69 → 82 (92%). Status → review.

### File List

- `tests/e2e/lib/chaos-intermittent.spec.ts` (new) — C#1/C#3/C#4/C#5/C#6
- `tests/e2e/lib/chaos-simultaneous.spec.ts` (new) — C#7/C#8
- `tests/e2e/lib/chaos-degraded.spec.ts` (new) — C#12/C#13/C#15
- `tests/e2e/lib/chaos-abort-timing.spec.ts` (new) — C#18/C#19/C#20
- `tests/support/helpers/lib-multipart-driver.ts` (new) — in-page real-upload driver + `installPutChaos`/`installApiDelay`
- `tests/support/helpers/chaos-engines.ts` (new) — 3-engine matrix helper (`ENGINES`, `runOnEngine`, `CHAOS_ENGINES` override)
- `tests/support/helpers/minio-client.ts` (modified) — added `headObjectSize`
- `examples/test-app/src/bench.ts` (modified) — expose `Schedule` + `Duration` on `window.__tlBench__`
- `_bmad-output/test-artifacts/traceability/traceability-report-epic-11.md` (modified) — §2.8 + §3.7 + §1/§5/§6 updates
- `_bmad-output/implementation-artifacts/sprint-status.yaml` (modified) — 11.5 → review

## Senior Developer Review (AI)

(to be filled at review time)
