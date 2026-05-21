---
stepsCompleted: ['step-01-detect-mode', 'step-02-load-context', 'step-03-risk-and-testability', 'step-04-coverage-plan', 'step-05-generate-output']
lastStep: 'step-05-generate-output'
lastSaved: '2026-05-21'
mode: 'epic-level'
execution_mode: 'sequential'
epic_num: 11
epic_title: 'P2 Nightly Coverage'
source_matrix: '_bmad-output/brainstorming/brainstorming-session-2026-05-17-001.md'
source_subset: 'P2 (lines 450-458 of the brainstorming, ~85 scenarios)'
inputDocuments:
  - '_bmad-output/brainstorming/brainstorming-session-2026-05-17-001.md'
  - '_bmad-output/test-artifacts/test-design-epic-10.md'
  - '_bmad-output/implementation-artifacts/epic-10-retro-2026-05-21.md'
  - '_bmad-output/planning-artifacts/architecture.md'
  - 'docs/project-context.md'
related_specs:
  - '_bmad-output/test-artifacts/test-design-epic-10.md'
  - '_bmad-output/implementation-artifacts/epic-10-retro-2026-05-21.md'
related_memories:
  - 'feedback_p2_default_to_lib.md'
  - 'feedback_test_app_debug_runbook.md'
  - 'project_test_framework_patterns.md'
---

# Test Design: Epic 11 — P2 Nightly Coverage

**Date:** 2026-05-21
**Author:** Grochonnou
**Status:** Draft

---

## Executive Summary

**Scope:** Epic-level test design for Epic 11 — the second test-coverage epic, derived from the P2 subset (~85 scenarios) of `brainstorming-session-2026-05-17-001` after Epic 10 closed the P1 subset (42 scenarios) and shipped v0.1.2.

**Re-validation result (2026-05-21):** P2 set is **reusable as-is**. No P2 scenarios were obsoleted by Epic 10's library bug fixes (parts sort, safeLog, README peer-dep, Match.tag) or harness changes (per-session chaos, `pnpm test-app:reset`, idiomatic Vite layout). The 4 Epic 10 lib fixes all mapped to P1 scenarios; P2 is untouched.

**Policy applied:** `feedback_p2_default_to_lib.md` (Epic 10 retro action #3) — P2 specs default to `tests/integration/` (vitest) or `tests/e2e/lib/` (PW-Lib). Only escalate to `tests/e2e/ui/` when the spec genuinely needs the test-app DOM (chaos cluster + personas).

**Risk Summary:**
- Total risks identified (clusters scored): 14
- **🔴 Critical (Score=9, BLOCK):** 0 — by definition, P2 is below release-critical
- **🟠 High (Score 6-8, MITIGATE):** 5
- **🟡 Medium (Score 4-5, MONITOR):** 5
- **🟢 Low (Score 1-3, DOCUMENT):** 4
- **Critical categories:** TECH (cleanup leaks, simultaneous failures), DATA (resume edge variants, compression errors), BUS (cross-browser streaming)

**Coverage Summary:**
- **P2 net-new tests:** ~87 scenarios distributed across 7 stories
- **Estimated effort:** ~75–115 hours (~3–4.5 sprint-weeks for one dev — about 1.6× Epic 10's footprint, consistent with 2× scenario count and policy bias toward cheaper VT/PW-Lib levels)
- **Harness mix:** ~60% vitest-integration, ~22% PW-Lib (browser realm, no UI), ~10% PW-UI (chaos + personas only), ~8% DIST/DOC gap-closers extending Epic 10 infra

**Future epics (estimates unchanged from Epic 10 design):** Epic 12 (P3 Weekly) ~10–20h · Epic 13 (Library Hardening v1.x) ~30–50h.

---

## Not in Scope

| Item | Reasoning | Mitigation |
|---|---|---|
| **P1 scenarios (42)** | Closed by Epic 10; gated v0.1.2 release | Already shipped (4 lib bug fixes confirmed coverage worked) |
| **P3 scenarios (~48)** | Brainstorming priority bucket below nightly | Future Epic 12 — weekly / on-demand |
| **Missing-feature backlog (18 flags)** | Library/test-app gaps, not test scenarios | Future Epic 13 — Library Hardening v1.x (auto-re-init, Web Locks, `partTimeout`, chunkSize validation on resume, content-digest hook, etc.) |
| **Performance / SLA regression suite** | Library has no documented perf SLA | Reevaluate at v1.0 |
| **C#2 / C#9 / C#10 / C#11** (deferred chaos) | Need circuit-breaker + Web Locks impl first | Epic 13 prerequisites; cover in Epic 12 once features land |
| **Pact contract testing** | Library is not a microservice | N/A |

---

## Risk Assessment

**Method:** apply Probability × Impact scoring (1–9) to P2 scenario *clusters*. Per `tea` config `risk_threshold: p1`, Epic 11 inherits PASS gate semantics — no P2 cluster is automatically BLOCKING, but HIGH (6+) clusters require coverage before nightly can be declared green.

### Critical Risks (Score = 9) — none

By definition, P2 is below release-critical. The Epic 10 design captured the two true BLOCKERS (R1, R2). If a P2 cluster ever scored 9 during this exercise, it would be re-promoted to P1 — none did.

### High-Priority Risks (Score = 6) — MITIGATE

| Risk ID | Category | Description | P | I | Score | Mitigation | Story |
|---|---|---|---|---|---|---|---|
| R-P2-1 | DATA | **Resume after MinIO multipart TTL expiry** (P#C2) — uploadId still in localStorage but S3 multipart is GC'd; reconcile returns empty AND HEAD on the key fails. Current lib treats as fresh-start; if user re-uploads they get a different uploadId silently. | 2 | 3 | 6 | Story 11.4 — PW-UI persona test forces multipart abandonment + simulates TTL via manual `AbortMultipartUpload` on MinIO before reload | 11.4 |
| R-P2-2 | TECH | **Cleanup / resource-leak cluster** (F#83–F#88) — ReadableStream not released on error, pipeline error doesn't cancel upstream source, server-side TCP RST not propagated as `PartUploadError`, semaphore permit leaked on terminal error, tab-close orphans multipart | 2 | 3 | 6 | Story 11.2 — vitest-integration probes resource state after error termination | 11.2 |
| R-P2-3 | TECH | **Simultaneous-failure chaos** (C#7, C#8) — two parts fail at once exposes shared-state bugs in retry loops; abort during retry backoff must let `Effect.raceFirst` win immediately, not after backoff settles | 2 | 3 | 6 | Story 11.5 — PW-Lib chaos drives concurrent failure injection via the chaos endpoint | 11.5 |
| R-P2-4 | BUS | **`simpleHttpUpload` cross-browser streaming body** (G#2, F#40) — currently missing `duplex: 'half'`; flagged in brainstorming missing-feature backlog. WebKit/Firefox handle differently from Chromium. | 3 | 2 | 6 | Story 11.7 — PW-Lib cross-browser matrix; **also gates lib fix** (Epic 13 candidate) | 11.7 |
| R-P2-5 | DATA | **Compression error paths** (F#17, F#71–F#73) — sync throw, async rejection, polyfilled-`undefined` CompressionStream. Each must surface via Effect error channel, not crash the fiber. | 2 | 3 | 6 | Story 11.1 — vitest-integration tightens the `safeLog` analog for CompressionService boundary | 11.1 |

### Medium-Priority Risks (Score = 4) — MONITOR

| Risk ID | Category | Description | P | I | Score | Mitigation | Story |
|---|---|---|---|---|---|---|---|
| R-P2-6 | DATA | **Resume edge variants** (F#12–F#15) — deleted uploadId, expired presigned URL, stale reconcile, 0-parts reconcile | 2 | 2 | 4 | Story 11.3 — vitest-integration extends existing resume tests | 11.3 |
| R-P2-7 | DATA | **Stream/chunking edges** (F#24 zero-byte, F#25 mid-read error, F#42–F#44 chunkSize edges) | 2 | 2 | 4 | Story 11.6 — vitest-integration | 11.6 |
| R-P2-8 | TECH | **Layer composition edges** (F#76 empty Layer, F#79 last-writer-wins, F#80 finalizer, F#81 shared instance, F#78 TestClock) | 2 | 2 | 4 | Story 11.2 — vitest-integration; some reuse the Epic 10 singleton patterns | 11.2 |
| R-P2-9 | BUS | **Degraded-network chaos** (C#12 slow 3G, C#13 high-latency + low-BW, C#15 slow-loris) — no hardcoded timeouts must fire; surfaces need for `partTimeout` option | 2 | 2 | 4 | Story 11.5 — PW-Lib chaos; G#15 surfaces lib gap | 11.5 |
| R-P2-10 | BUS | **`getProgress` inside `uploadPart` part 1** (P#B5) — the documented foot-gun (`Ref.update` post-uploadPart timing in MEMORY) | 2 | 2 | 4 | Story 11.4 — PW-UI persona-developer locks the foot-gun behavior so doc + code stay in sync | 11.4 |

### Low-Priority Risks (Score 1–3) — DOCUMENT

| Risk ID | Category | Description | P | I | Score | Action |
|---|---|---|---|---|---|---|
| R-P2-11 | TECH | **CircuitOpenError** (F#10) — currently not wired; depends on Epic 13 circuit-breaker work | 1 | 2 | 2 | DOCUMENT; defer test to Epic 12 once wired |
| R-P2-12 | OPS | **`deflate-raw` portability** (G#3) — older WebKit lacks the algo | 2 | 1 | 2 | DOCUMENT in README algo support matrix; PW-Lib smoke catches |
| R-P2-13 | BUS | **One-shot edges** (F#37 abort mid-stream, F#38 server 4xx, F#39 empty stream) | 1 | 2 | 2 | DOCUMENT via Story 11.6 vitest-integration |
| R-P2-14 | OPS | **Filename + DIST gap-closers** (G#13 tree-shake, G#15 no node:* in browser bundle, G#17 special-char filenames, G#19 long filenames, G#25 + G#27 doctest extensions, G#29 test-app README reproducibility) | 1 | 2 | 2 | DOCUMENT via Story 11.7 (extends Epic 10's DIST/DOC harnesses) |

---

## Entry Criteria

- [x] Epic 10 closed (all 8 stories `done`, v0.1.2 published, retro committed `b0abea2`)
- [x] Test-app harness hardening landed (Epic 10 retro action #2: `pnpm test-app:reset`, Vite root fix, chaos isolation 150/150 PASS) — commit `b493bd0`
- [x] P2 brainstorming subset re-validated 2026-05-21 — no refresh needed
- [x] `feedback_p2_default_to_lib.md` policy + `feedback_test_app_debug_runbook.md` written and indexed in MEMORY
- [ ] MinIO must be reachable during nightly (`curl localhost:9000/minio/health/live`) — sudo required, hand off to user
- [ ] Epic 11 stories formalized in `sprint-status.yaml` + `epics.md` (next workflow: `bmad-create-epics-and-stories`)

## Exit Criteria

- [ ] All 7 stories `done` and signed-off
- [ ] Nightly run green: ≥95% of P2 tests pass across the matrix
- [ ] All HIGH (Score=6) risks have at least one passing test
- [ ] R-P2-4 (simpleHttpUpload duplex) either passes or is explicitly waived with an Epic 13 ticket created
- [ ] R-P2-11 (CircuitOpen) waived pending Epic 13 circuit-breaker work
- [ ] No P2 regression in the P1 nightly subset
- [ ] Coverage map (`test-coverage-map-epic-11.md`) generated and lives in `_bmad-output/test-artifacts/`

---

## Test Coverage Plan

### Project assignment policy

Per `feedback_p2_default_to_lib.md`: each scenario's harness is the **cheapest level that answers the question**:

| Harness | When to use | Cost per test | Survives test-app harness regressions? |
|---|---|---|---|
| **VT** (vitest-integration in `packages/*/src/`, `tests/integration/`) | Pure library API — no DOM, no browser-specific API | ~0.5–1h | ✅ Yes — doesn't touch test-app at all |
| **PW-Lib** (`tests/e2e/lib/`) | Needs browser realm (`CompressionStream`, `ReadableStream` semantics, `fetch + duplex`, AbortSignal browser timing) but NOT the test-app UI | ~1.5–2h | ✅ Yes — no UI navigation, fetch monkey-patch not in play |
| **PW-UI** (`tests/e2e/ui/`) | Genuinely needs the DOM: click buttons, observe progress bar, read log `<pre>`, persona-style flows that exercise the full user path | ~2–3h | ⚠️ Partial — covered by chaos session-isolation audit, but still touches Vite + test-app server |
| **DIST** / **DOC** | Build artifact + README integrity (extends Epic 10 harnesses) | ~0.5–1.5h | ✅ Yes — separate harnesses |

### Story Decomposition

| Story | Scope | Default harness | Net-new tests | Est. hours |
|---|---|---|---|---|
| **11.1** Compression & pipeline error paths | F#17, F#18, F#20, F#71–F#73 (6) | VT | 6 | 6–8h |
| **11.2** Layers, logger, cleanup & resource safety | F#65, F#67–F#70, F#75, F#76, F#78–F#81, F#83–F#88 (18) | VT (+1 PW-Lib for F#84 Chromium-only `performance.memory`) | 18 | 16–22h |
| **11.3** Resume + reconcile + error mapping edges | F#5, F#7, F#12–F#15 (6) | VT | 6 | 5–7h |
| **11.4** Persona journeys (UI flows) | P#A1, P#A2, P#A4, P#B1, P#B5, P#B6, P#C2 (7) | PW-UI | 7 | 14–20h |
| **11.5** Chaos cluster (intermittent + simultaneous + degraded) | C#1, C#3–C#8, C#12, C#13, C#15, C#18–C#20 (13) | PW-Lib (chaos endpoint, no UI nav) | 13 | 20–28h |
| **11.6** Stream/chunking + one-shot edges + events/progress dual-mode | F#24, F#25, F#28, F#30, F#31, F#33–F#39, F#42–F#44, F#46, F#47, F#50, F#53–F#55, F#57–F#61, F#90 (28) | VT | 28 | 14–20h |
| **11.7** Cross-browser + DIST + DOC + filename gap-closers | F#10, F#40, G#2, G#3, G#13, G#15, G#17, G#19, G#25, G#27, G#29 (11) | PW-Lib (G#2, G#3) + DIST (G#13, G#15) + DOC (G#25, G#27, G#29) + VT (G#17, G#19, F#10 deferred) | 11 | 12–18h |
| **Total** | **87 scenarios** | mixed | **87** | **75–115h** |

Note: 87 vs 85 from the brainstorming reflects two scenarios (F#10, F#40) that appear in both Phase 1 and Gap-closers; they're allocated once, not double-counted in story scope.

---

### Coverage Matrix — P2 Scenarios

**Legend:**
- **Level:** U=Unit · I=Integration · E=E2E · D=Doctest · X=DIST validation
- **Harness:** VT=vitest · PW-UI=Playwright against test-app · PW-Lib=Playwright library-direct (no UI) · DOC=doctest harness · DIST=DIST validation harness
- **Risk:** cluster score from Risk Assessment
- **Est:** hours per test (writing + review + CI integration)

#### Story 11.1 — Compression & pipeline error paths (R-P2-5, 6 tests)

| Test ID | Scenario | Level | Harness | Risk | Est |
|---|---|---|---|---|---|
| 11.1-INT-001 | F#17 — Compression throws → wraps as `PartUploadError` (Effect error channel, no fiber DEFECT) | I | VT | 6 | 1h |
| 11.1-INT-002 | F#18 — Effect-typed pipeline with `CompressionServiceLive` resolves correctly | I | VT | 4 | 0.5h |
| 11.1-INT-003 | F#20 — `globalThis.CompressionStream = undefined` → fails in Effect error channel | I | VT | 6 | 1.5h |
| 11.1-INT-004 | F#71 — CompressionService sync throw | I | VT | 6 | 1h |
| 11.1-INT-005 | F#72 — CompressionService async rejection | I | VT | 6 | 1h |
| 11.1-INT-006 | F#73 — Polyfilled-undefined CompressionStream (Worker context) | I | VT | 6 | 1.5h |

#### Story 11.2 — Layers, logger, cleanup & resource safety (R-P2-2, R-P2-8, 18 tests)

| Test ID | Scenario | Level | Harness | Risk | Est |
|---|---|---|---|---|---|
| 11.2-INT-001 | F#65 — User-injected recording logger (locks expected log lines for upload lifecycle) | I | VT | 4 | 1h |
| 11.2-INT-002 | F#67 — Slow logger → upload latency does NOT scale with log-line count | I | VT | 4 | 1h |
| 11.2-INT-003 | F#68 — Default CompressionService works in browser + Node 22 (parameterized) | I | VT | 4 | 1h |
| 11.2-INT-004 | F#69 — No-op CompressionService → object size = source size (proves injection overrides default) | I | VT | 4 | 0.5h |
| 11.2-INT-005 | F#70 — Malformed CompressionService output → upload "succeeds" with corrupt object (codifies no-checksum trust boundary) | I | VT | 4 | 1h |
| 11.2-INT-006 | F#75 — Custom LoggerLive with `[upload:${id}]` prefix | I | VT | 2 | 0.5h |
| 11.2-INT-007 | F#76 — `Layer.empty` provided → clear Effect runtime error (not silent crash) | I | VT | 4 | 1h |
| 11.2-INT-008 | F#78 — TestClock with `@effect/vitest` for `Schedule.exponential` (locks the pattern from MEMORY) | I | VT | 4 | 1h |
| 11.2-INT-009 | F#79 — User Layer stacked above `CompressionServiceLive` (last-writer-wins) | I | VT | 4 | 1h |
| 11.2-INT-010 | F#80 — Layer finalizer runs exactly once at scope close (including on error/abort) | I | VT | 4 | 1.5h |
| 11.2-INT-011 | F#81 — Two concurrent `.effect` programs share Layer instance (no double-init) | I | VT | 4 | 1.5h |
| 11.2-INT-012 | F#83 — Source ReadableStream released on error | I | VT | 6 | 1h |
| 11.2-E2E-001 | F#84 — 100 sequential uploads → flat heap (Chromium `performance.memory`) | E | PW-Lib | 6 | 2h |
| 11.2-INT-013 | F#85 — Pipeline error cancels upstream source (no dangling reader) | I | VT | 6 | 1h |
| 11.2-INT-014 | F#86 — Server kills TCP mid-PUT → `PartUploadError`, not hang | I | VT | 6 | 1.5h |
| 11.2-INT-015 | F#87 — Browser tab closed mid-upload → orphan multipart on MinIO (current behaviour; flips to auto-abort in Epic 13) | I | VT | 4 | 1h |
| 11.2-INT-016 | F#88 — Semaphore permit released on terminal error | I | VT | 6 | 1h |
| 11.2-INT-017 | F#90 — Not reading events stream does NOT slow uploads (Story 11.6 may also cover — keep here for cleanup lens) | I | VT | 4 | 0.5h |

#### Story 11.3 — Resume + reconcile + error mapping edges (R-P2-6, 6 tests)

| Test ID | Scenario | Level | Harness | Risk | Est |
|---|---|---|---|---|---|
| 11.3-INT-001 | F#5 — `PresignedUrlError` (adapter throws inside `uploadPart`) wraps as `PartUploadError.cause`; uniform retry (codifies the design-gap from brainstorming) | I | VT | 4 | 1h |
| 11.3-INT-002 | F#7 — `ReconcileError` (500 on `/parts` during resume) — fail before any PUT | I | VT | 4 | 1h |
| 11.3-INT-003 | F#12 — Resume against deleted uploadId (S3 `NoSuchUpload`) | I | VT | 4 | 1h |
| 11.3-INT-004 | F#13 — Resume after presigned URL expiry (re-sign per attempt; complements 10.3-E2E-002 with phase-accurate error path) | I | VT | 4 | 1h |
| 11.3-INT-005 | F#14 — Resume with stale reconcile result (part deleted between ListParts and next op) | I | VT | 4 | 1.5h |
| 11.3-INT-006 | F#15 — Reconcile returns 0 parts (= fresh start with that uploadId) | I | VT | 4 | 0.5h |

#### Story 11.4 — Persona journeys (UI flows) (R-P2-1, R-P2-10, 7 tests)

| Test ID | Scenario | Level | Harness | Risk | Est |
|---|---|---|---|---|---|
| 11.4-E2E-001 | P#A1 — Tunnel disconnect 30s mid-upload (default retry insufficient; documents tuning need) | E | PW-UI | 4 | 2.5h |
| 11.4-E2E-002 | P#A2 — Screen lock mid-upload (browser throttles/suspends JS, see [[project-test-framework-patterns]]) | E | PW-UI | 4 | 2h |
| 11.4-E2E-003 | P#A4 — Wi-Fi → 5G handoff (TCP connections die; tests reconnect resilience) | E | PW-UI | 4 | 2h |
| 11.4-E2E-004 | P#B1 — Forgot to `await result` → unhandled rejection surface (codifies the foot-gun) | E | PW-UI | 4 | 1.5h |
| 11.4-E2E-005 | P#B5 — `getProgress()` inside `uploadPart` for part 1 returns 0 (locks the MEMORY foot-gun) | E | PW-UI | 4 | 1.5h |
| 11.4-E2E-006 | P#B6 — Custom `retrySchedule: Schedule.recurs(10).pipe(Schedule.fixed("1 second"))` works end-to-end | E | PW-UI | 4 | 2h |
| 11.4-E2E-007 | P#C2 — Resume after MinIO multipart TTL — uploadId stale; reconcile empty AND HEAD fails; current lib treats as fresh; document behaviour OR mark as Epic 13 follow-up | E | PW-UI | 6 | 2.5h |

Tests in this story are the **only** ones that legitimately need PW-UI. All other P2 stories follow the lib-default policy.

#### Story 11.5 — Chaos cluster (R-P2-3, R-P2-9, 13 tests)

| Test ID | Scenario | Level | Harness | Risk | Est |
|---|---|---|---|---|---|
| 11.5-E2E-001 | C#1 — Flapping uploads (30% PUT failure, all retries succeed eventually) | E | PW-Lib | 4 | 2h |
| 11.5-E2E-002 | C#3 — Offline window 8s; exponential backoff insufficient (exposes tuning need) | E | PW-Lib | 4 | 1.5h |
| 11.5-E2E-003 | C#4 — Partial response truncation (`Content-Length` lies) | E | PW-Lib | 4 | 1.5h |
| 11.5-E2E-004 | C#5 — Missing ETag header in 200 OK → `PartUploadError` → retry | E | PW-Lib | 4 | 1.5h |
| 11.5-E2E-005 | C#6 — Garbage ETag → MinIO rejects on Complete with `InvalidPart` | E | PW-Lib | 4 | 1.5h |
| 11.5-E2E-006 | C#7 — Two parts fail at once (catches shared-state bugs between retry loops) | E | PW-Lib | 6 | 2.5h |
| 11.5-E2E-007 | C#8 — Abort during retry backoff (`Effect.raceFirst` must win immediately, not after backoff settles) | E | PW-Lib | 6 | 2.5h |
| 11.5-E2E-008 | C#12 — Slow 3G end-to-end (no hardcoded timeouts must fire) | E | PW-Lib | 4 | 2h |
| 11.5-E2E-009 | C#13 — High-latency + low-bandwidth (abort must stay responsive) | E | PW-Lib | 4 | 2h |
| 11.5-E2E-010 | C#15 — Slow-loris server (reveals need for client-side `partTimeout` option — Epic 13 flag) | E | PW-Lib | 4 | 2h |
| 11.5-E2E-011 | C#18 — Abort during `/initiate` (documents orphan-multipart gap) | E | PW-Lib | 4 | 1.5h |
| 11.5-E2E-012 | C#19 — Abort between part N and N+1 (partial state in `refParts`, never completed) | E | PW-Lib | 4 | 1.5h |
| 11.5-E2E-013 | C#20 — Abort during `/complete` (late-stage abort has no clean recovery API — Epic 13 flag) | E | PW-Lib | 4 | 1.5h |

All chaos tests run via the **`request` fixture's per-session chaos endpoint** (validated by `tests/e2e/ui/chaos-isolation.spec.ts` at 150/150 PASS). PW-Lib level — no test-app UI navigation, no `addInitScript` monkey-patch.

#### Story 11.6 — Stream/chunking + one-shot edges + events/progress dual-mode (R-P2-7, R-P2-13, 28 tests)

| Test ID | Scenario | Level | Harness | Risk | Est |
|---|---|---|---|---|---|
| 11.6-INT-001 | F#24 — Zero-byte file (S3 rejects empty parts list → lib errors before complete) | I | VT | 4 | 0.5h |
| 11.6-INT-002 | F#25 — Source stream errors mid-read → wrapped as `PartUploadError(0, 0, cause)` | I | VT | 4 | 0.5h |
| 11.6-INT-003 | F#28 — Concurrency saturation: exactly N PUTs in flight under throttling | I | VT | 4 | 1h |
| 11.6-INT-004 | F#30 — Synchronous `completeUpload` callback works | I | VT | 2 | 0.25h |
| 11.6-INT-005 | F#31 — Effect-typed `initiate` that fails — `cause` is the Effect's typed error | I | VT | 4 | 0.5h |
| 11.6-INT-006 | F#33 — Events reader cancelled mid-upload (no leak) | I | VT | 2 | 0.5h |
| 11.6-INT-007 | F#34 — `getProgress()` before initiate → 0 | I | VT | 2 | 0.25h |
| 11.6-INT-008 | F#35 — `getProgress()` after completion → final value | I | VT | 2 | 0.25h |
| 11.6-INT-009 | F#36 — `uploadId` promise resolves even when upload later fails | I | VT | 2 | 0.5h |
| 11.6-INT-010 | F#37 — One-shot abort mid-stream | I | VT | 2 | 0.5h |
| 11.6-INT-011 | F#38 — One-shot server 4xx → `CompleteUploadError` | I | VT | 2 | 0.5h |
| 11.6-INT-012 | F#39 — One-shot empty stream | I | VT | 2 | 0.25h |
| 11.6-INT-013 | F#42 — chunkSize=1 byte (hits S3 10k part limit at tiny files) | I | VT | 4 | 0.5h |
| 11.6-INT-014 | F#43 — chunkSize > totalBytes (single part = whole file) | I | VT | 4 | 0.5h |
| 11.6-INT-015 | F#44 — Non-integer chunkSize (float math drift) | I | VT | 4 | 0.5h |
| 11.6-INT-016 | F#46 — `networkMultiplier` with no samples → factor=1.0 (control) | I | VT | 2 | 0.5h |
| 11.6-INT-017 | F#47 — `networkMultiplier` saturated slow → factor=0.1 (below S3 floor — user must clamp) | I | VT | 2 | 0.5h |
| 11.6-INT-018 | F#50 — `computeOptimalPartSize` → actual PUT body sizes round-trip | I | VT | 4 | 0.5h |
| 11.6-INT-019 | F#53 — Empty File (couples with F#24) | I | VT | 2 | 0.25h |
| 11.6-INT-020 | F#54 — File blob URL revoked mid-read | I | VT | 4 | 1h |
| 11.6-INT-021 | F#55 — MIME parity (PNG / UTF-8 / multi-byte chars) | I | VT | 2 | 0.5h |
| 11.6-INT-022 | F#57 — Backpressure under slow consumer (heap stays flat) | I | VT | 4 | 1h |
| 11.6-INT-023 | F#58 — `createReadStream` of missing file → ENOENT propagates as `PartUploadError` | I | VT | 2 | 0.5h |
| 11.6-INT-024 | F#59 — `Readable.destroy(err)` mid-stream | I | VT | 4 | 0.5h |
| 11.6-INT-025 | F#60 — Paused Readable → auto-resume by `Readable.toWeb` | I | VT | 2 | 0.5h |
| 11.6-INT-026 | F#61 — Buffer source → no re-allocation | I | VT | 2 | 0.5h |
| 11.6-INT-027 | F#90 — Not reading events stream does NOT slow uploads (latency lens; cleanup-lens variant lives in 11.2) | I | VT | 2 | 0.25h |
| 11.6-INT-028 | F#33 — Events stream consumer cancelled before any event arrives | I | VT | 2 | 0.5h |

Heavy-on-count but lightweight per-test — each one is a tight vitest case (mean ~0.5h). The volume is in F#-block coverage, not in setup complexity.

#### Story 11.7 — Cross-browser + DIST + DOC + filename gap-closers (R-P2-4, R-P2-11, R-P2-12, R-P2-14, 11 tests)

| Test ID | Scenario | Level | Harness | Risk | Est |
|---|---|---|---|---|---|
| 11.7-E2E-001 | F#10 — `CircuitOpenError` (5 consecutive part failures in 10s) | E | PW-Lib | 2 | **DEFER to Epic 12** — circuit-breaker wiring is an Epic 13 prerequisite |
| 11.7-E2E-002 | F#40 / G#2 — `simpleHttpUpload` ReadableStream body across browsers (currently fails without `duplex: 'half'` fix — codifies the gap OR validates the fix if Epic 13 lands first) | E | PW-Lib | 6 | 2.5h |
| 11.7-E2E-003 | G#3 — `CompressionStream` `deflate-raw` support per browser (older WebKit lacks the algo — document support matrix) | E | PW-Lib | 2 | 1.5h |
| 11.7-X-001 | G#13 — Tree-shaking proof (oneshot-only import excludes multipart code from the bundle) | X | DIST | 2 | 2h |
| 11.7-X-002 | G#15 — No `node:*` imports in browser bundle (except behind `fromNodeReadable` boundary) | X | DIST | 2 | 1.5h |
| 11.7-INT-001 | G#17 — Special-char filename parameterized over `[# ? % +  café 🚀 RTL]` (S3 key sanitization) | I | VT | 2 | 1h |
| 11.7-INT-002 | G#19 — Filename > 1024 chars (S3 key limit → `InitiateUploadError`) | I | VT | 2 | 0.5h |
| 11.7-D-001 | G#25 — Resume example compiles & runs end-to-end (extends Epic 10's doctest harness) | D | DOC | 2 | 2h |
| 11.7-D-002 | G#27 — Compression example compiles & runs (size assertion) | D | DOC | 2 | 1.5h |
| 11.7-D-003 | G#29 — Test-app README setup reproducibility (CI-runnable script) | D | DOC | 2 | 2h |

11.7-E2E-001 (CircuitOpen) is **deferred** — the underlying lib feature isn't wired yet. Listed here for traceability; will move to Epic 12 once the wire-up lands.

---

### Coverage Summary by Harness

| Harness | Net-new tests | % of total |
|---|---|---|
| **VT** (vitest-integration) | 56 | 64% |
| **PW-Lib** (browser realm, no UI) | 18 | 21% |
| **PW-UI** (test-app DOM, persona-driven) | 7 | 8% |
| **DIST** (build artifact validation) | 2 | 2% |
| **DOC** (doctest harness) | 3 | 3% |
| **Deferred to Epic 12** | 1 | 1% |
| **Total Epic 11** | **87** | **100%** |

**Policy compliance:** 85% of P2 specs land in VT or PW-Lib (the lib-default per `feedback_p2_default_to_lib.md`). Only the 7 persona scenarios escalate to PW-UI — and they're the ones that genuinely test a user-journey flow that can only be measured via DOM interaction.

### Out-of-P2 Buckets (For Future Epics)

| Bucket | Source | Scenarios | Future Epic |
|---|---|---|---|
| P3 (Weekly/On-demand) | Brainstorming P3 | ~48 | Epic 12 |
| Missing-feature backlog | Brainstorming flags 1–18 | 18 | Epic 13 (Library Hardening v1.x) |
| Deferred chaos pending lib features | C#2 (correlation), C#9–C#11 (Web Locks / TTL / InvalidPart on retry) | 4 | Epic 12 once features land |

---

## Execution Order

### Smoke (<2 min, runs on every PR alongside P1)

- 11.6-INT-007/8 — `getProgress` before/after upload (5s)
- 11.7-X-001 — Tree-shake proof (30s) — gates accidental import regressions
- 11.7-D-003 — Test-app README reproducibility (45s) — gates onboarding drift

### Nightly Tier A — VT mass (10–15 min)

All ~56 VT tests run as part of nightly `turbo test`. Mean cost <1s each; expected total ~3 min including service boot. Tier A also catches any P1 regressions before tier B.

### Nightly Tier B — PW-Lib (15–25 min)

Stories 11.5 (chaos, 13 tests) + 11.7 (cross-browser, 3 tests) + 11.2-E2E-001 (heap stability). Run 3× (chromium / firefox / webkit), so effective spec count is ~51. With workers=4, expected ~15 min wall-time. Chaos isolation audit guarantees these don't trample each other (validated 2026-05-21).

### Nightly Tier C — PW-UI (20–30 min)

Story 11.4 personas (7 tests) × 3 browsers = 21 spec runs. Each is 2–3 min wall-time. Total ~20–25 min.

### Weekly / On-demand

- Story 11.7-E2E-001 (CircuitOpen) — deferred to Epic 12
- P3 scenarios — Epic 12
- Missing-feature flags — Epic 13

---

## Resource Estimates

### Test Development Effort

| Story | Tests | Hours/test | Total | Notes |
|---|---|---|---|---|
| **11.1** Compression error paths | 6 | 1.0 | 6–8h | All VT; tight surface |
| **11.2** Layers/logger/cleanup | 18 | 1.0 | 16–22h | 1 PW-Lib heap test is the cost outlier |
| **11.3** Resume edges | 6 | 1.0 | 5–7h | All VT; extends Epic 10's resume coverage |
| **11.4** Persona journeys | 7 | 2.5 | 14–20h | PW-UI; full test-app exercise per persona |
| **11.5** Chaos cluster | 13 | 1.7 | 20–28h | PW-Lib; chaos endpoint mature post-audit |
| **11.6** Stream/chunking/dual-mode | 28 | 0.5 | 14–20h | High count, low cost each |
| **11.7** Cross-browser + DIST + DOC | 11 | 1.3 | 12–18h | Mixed harness; DIST + DOC reuse Epic 10 infra |
| **Total** | **87 (+1 deferred)** | **mean ~1.0** | **75–115h** | ~3–4.5 sprint-weeks |

### Prerequisites (must be in place before story 1)

- ✅ `pnpm test-app:reset` script (commit `b493bd0`) — landed
- ✅ Per-session chaos endpoint (since 2026-05-19) — landed + 150/150 audit
- ✅ Vite root fix (`index.html` at project root) — landed in `b493bd0`
- ✅ `feedback_p2_default_to_lib.md` policy + `feedback_test_app_debug_runbook.md` runbook — written
- ⚠️ MinIO must be reachable for any test touching multipart Complete — user-managed (sudo)
- ⚠️ DIST harness extension for G#13 + G#15 — story 11.7 includes wiring time

### Tooling Dependencies (already available)

- vitest 3.x with `@effect/vitest` (`it.effect`, TestClock)
- Playwright 1.49+ with the existing `mergeTests` fixtures (`minio`, `test-app`, `upload-file`)
- The chaos endpoint via `request` fixture (`x-test-session` header auto-wired)
- `tests/e2e/lib/` PW-Lib project (already configured)
- Doctest harness via `spawnSync(process.execPath, [harnessPath])` from Epic 10
- DIST harness via `tests/integration/dist/*` from Epic 10

---

## Quality Gate Criteria

| Gate | Threshold | Enforcement |
|---|---|---|
| **P1 pass rate (regression)** | 100% (no Epic 10 regression) | Nightly fails on any P1 red |
| **P2 pass rate (story-by-story)** | ≥ 95% per story | Story can't merge below threshold |
| **HIGH (Score=6) cluster coverage** | All 5 clusters have ≥1 passing test | Epic-close criterion |
| **Cross-browser parity (Story 11.5/11.7)** | Multipart-golden + bufferMode green on Chromium + Firefox + WebKit | Story 11.5/11.7 close criterion |
| **R-P2-4 (`simpleHttpUpload` duplex)** | Either GREEN or explicitly WAIVED with Epic 13 ticket | Epic 11 close criterion |
| **R-P2-11 (CircuitOpen)** | WAIVED pending Epic 13 circuit-breaker wire-up | Documented |
| **Flake threshold** | < 2% over 7-day nightly window per spec | Auto-tag `@flaky`, demote to weekly until stable |
| **Coverage map** | `test-coverage-map-epic-11.md` exists; every F/C/P/G ID in P2 is either traced or marked DEFERRED with rationale | Epic-close criterion |

**Gate decision rules:**
- All 5 HIGH-risk clusters covered AND ≥95% pass rate per story AND no P1 regression → **PASS**
- HIGH-risk clusters covered but <95% on 1–2 stories → **CONCERNS** (release nightly green allowed; document failing specs)
- Any P1 regression OR HIGH-risk cluster uncovered → **FAIL**
- R-P2-4 / R-P2-11 status documented either way (waiver acceptable)

---

## Assumptions and Dependencies

### Assumptions

1. Epic 10's harness hardening (commit `b493bd0`) holds — no test-app harness regressions during Epic 11. If they appear, follow `feedback_test_app_debug_runbook.md` (curl probe → `pnpm test-app:reset` → single-worker repro).
2. MinIO stays at ≥99% nightly uptime (currently true under docker-compose).
3. The brainstorming session's P2 scope remains the source of truth — no mid-epic scope creep beyond explicit Epic 13 escalations.
4. Effect 3.x peer-dep contract stays stable (Tag identity, Layer composition semantics) — Epic 10 already locked the contract in `feedback_effect_peer_dep_contract.md`.
5. Playwright + browsers stay at 1.49+ (or newer compatible) — pinned in `tests/package.json`.

### Dependencies

1. **Internal — Epic 10:** all 8 stories `done`, retro committed. ✅ Met 2026-05-21.
2. **Internal — Epic 10 retro action #2:** test-app harness hardening. ✅ Met 2026-05-21 (commit `b493bd0`).
3. **Internal — Epic 10 retro actions #3 + #5:** P2 policy + debug runbook memories. ✅ Met 2026-05-21.
4. **External — Docker / MinIO:** user-managed (sudo). Required for any story touching multipart Complete.
5. **External — Epic 13 (Library Hardening) candidates:**
   - `simpleHttpUpload` `duplex: 'half'` fix → R-P2-4 (test passes only after fix)
   - Circuit-breaker wire-up → R-P2-11 (test deferred until then)
   - `partTimeout` option → R-P2-9 (test currently documents the absence)

### Risks to Plan

- **Risk:** Persona journey specs (Story 11.4) may flake due to browser throttling timing variance (especially WebKit P#A2 screen-lock simulation).
  - **Impact:** Story 11.4 slips by 1–2 weeks if WebKit timings prove unstable.
  - **Contingency:** Demote unstable persona specs to weekly tier; use `@flaky` tag mechanism; document the WebKit limitation in the algo support matrix already opened for G#3.
- **Risk:** Chaos cluster (Story 11.5) WebKit support for `route.abort('namenotresolved')` may regress.
  - **Impact:** C#17 (DNS failure) would slip but is P3, not in Epic 11 scope.
  - **Contingency:** N/A — not in Epic 11.
- **Risk:** Story 11.6 mean cost estimate (~0.5h) may be optimistic; some adapter-edge tests need new fixture data.
  - **Impact:** Story 11.6 overruns by 20–40%.
  - **Contingency:** Acceptable — Story 11.6 is the largest by count but lowest by risk; slip doesn't gate epic close.

---

## Follow-on Workflows (Manual)

- Run `bmad-create-epics-and-stories` to formalize Epic 11 + its 7 stories in `_bmad-output/planning-artifacts/epics.md` and `sprint-status.yaml`.
- Optionally run `bmad-testarch-atdd` for the HIGH-risk clusters (R-P2-1, R-P2-2, R-P2-3, R-P2-4, R-P2-5) to generate failing-first acceptance tests before implementation.
- During execution, generate the traceability matrix via `bmad-testarch-trace` to keep `_bmad-output/test-artifacts/traceability/` in sync.

---

## Interworking & Regression

| Component | Impact | Regression Scope |
|---|---|---|
| **@tranquilload/core** | New tests target existing public API surfaces (`uploadMultipart`, `uploadOnce`, pipelines, layers) | All Epic 10 P1 tests must continue passing; v0.1.2 contract is frozen for Epic 11 (no breaking changes) |
| **@tranquilload/adapters** | Stream/file/S3/HTTP adapter edges (F#5, F#40, F#51-class scenarios already in P1 but P2 extends with edge cases) | Existing adapter tests in `packages/tranquilload-adapters/src/**/*.test.ts` must continue passing |
| **examples/test-app** | Persona journey specs (Story 11.4) drive the full UI flow; chaos cluster (Story 11.5) hits the chaos endpoint at higher contention than today | Chaos isolation audit (`tests/e2e/ui/chaos-isolation.spec.ts`) must continue at 150/150 |
| **tests/** workspace | New `tests/e2e/lib/` specs for stories 11.5, 11.7; new `tests/e2e/ui/` specs for 11.4; many new `tests/integration/` or `packages/*/src/**/*.test.ts` files for VT-heavy stories | Existing 5 E2E specs (smoke, cross-browser, resume-safety, deflate-raw, cleanup, chaos-isolation) must continue passing |

---

## Appendix

### Knowledge Base References

- `risk-governance.md` — Risk classification framework (loaded same as Epic 10)
- `probability-impact.md` — Risk scoring methodology
- `test-levels-framework.md` — Test level selection
- `test-priorities-matrix.md` — P0–P3 prioritization

### Related Documents

- **Source brainstorming:** `_bmad-output/brainstorming/brainstorming-session-2026-05-17-001.md` (P2 scope on lines 450–458)
- **Prior epic design:** `_bmad-output/test-artifacts/test-design-epic-10.md`
- **Prior epic retro:** `_bmad-output/implementation-artifacts/epic-10-retro-2026-05-21.md`
- **Architecture:** `_bmad-output/planning-artifacts/architecture.md`
- **Project context:** `docs/project-context.md`

### Related MEMORY entries (Tranquilload-specific)

- `feedback_p2_default_to_lib.md` — policy informing project assignment
- `feedback_test_app_debug_runbook.md` — runbook when a UI matrix test goes red
- `project_test_framework_patterns.md` — fixture patterns + chaos endpoint usage
- `project_test_app_chaos_state.md` — per-session chaos endpoint design
- `project_dev_server_stale_state.md` — `pnpm test-app:reset` is the official escape hatch

---

**Generated by:** BMad TEA Agent — Test Architect module
**Workflow:** `_bmad/tea/testarch/bmad-testarch-test-design`
**Version:** 4.0 (BMad v6) — Epic-Level Mode
