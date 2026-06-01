# Story 11.2: Layers, Logger, Cleanup & Resource Safety

Status: done

## Story

As a library maintainer,
I want vitest-integration + one PW-Lib heap-stability test covering layer composition, logger safety, and resource cleanup on all termination paths,
so that long-lived consumers do not leak streams, semaphores, or memory, and so layer-composition edge cases produce deterministic Effect errors instead of silent corruption.

## Acceptance Criteria

1. **Given** a user-injected recording logger **When** an upload runs through its lifecycle **Then** the expected sequence of log lines is captured deterministically (test ID 11.2-INT-001 covering F#65) and a slow logger does NOT scale upload latency with log-line count (test ID 11.2-INT-002 covering F#67).

2. **Given** a `Layer.empty` provided where the lib expects `CompressionServiceLive` or `LoggerServiceLive` **When** the upload runs **Then** the Effect runtime fails with a clear, typed error — no silent crash (test ID 11.2-INT-007 covering F#76).

3. **Given** a user Layer stacked above `CompressionServiceLive` **When** the upload resolves the Tag **Then** last-writer-wins semantics hold (test ID 11.2-INT-009 covering F#79). **Given** two concurrent `.effect` programs sharing a Layer **Then** the Layer instance is shared with no double-init (test ID 11.2-INT-011 covering F#81).

4. **Given** an upload that errors, aborts, or completes **When** the Effect scope closes **Then** the source `ReadableStream` reader is released (11.2-INT-012 covering F#83), the pipeline cancels the upstream source on error (11.2-INT-013 covering F#85), the semaphore permit is released on terminal error (11.2-INT-016 covering F#88), and Layer finalizers run exactly once (11.2-INT-010 covering F#80).

5. **Given** 100 sequential uploads in a Chromium PW-Lib runner **When** `performance.memory.usedJSHeapSize` is sampled before and after **Then** the heap stays flat — no monotonic growth indicating leaks (test ID 11.2-E2E-001 covering F#84).

6. **Given** a TCP RST during a PUT **When** the upload runs **Then** the failure surfaces as `PartUploadError`, not a hang (test ID 11.2-INT-014 covering F#86).

7. **Given** a browser tab closed mid-upload (simulated) **When** the test observes server-side state **Then** the current orphan-multipart behaviour is captured as a test (flips to auto-abort once Epic 13 lands) (test ID 11.2-INT-015 covering F#87).

8. **Given** ancillary layer + logger edges (custom `[upload:${id}]` prefix, TestClock pattern with `Schedule.exponential`, malformed `CompressionService` output, no-op compression parity, parameterized browser+Node default) **When** the tests run **Then** each behaviour is locked (test IDs 11.2-INT-003 → 11.2-INT-008 covering F#65, F#67, F#68, F#69, F#70, F#75, F#78; 11.2-INT-017 covering F#90 cleanup-lens).

## Tasks / Subtasks

- [x] Task 1: Plan the file layout (AC: all)
  - [x] VT tests split across `packages/tranquilload-core/src/services/`, `packages/tranquilload-core/src/multipart/`, and `packages/tranquilload-core/src/pipeline/` co-located test files
  - [x] PW-Lib heap test in `tests/e2e/lib/cleanup-heap-stability.spec.ts` (Chromium-only — `performance.memory` is non-standard)

- [x] Task 2: Logger lifecycle tests — 11.2-INT-001 (F#65), 11.2-INT-002 (F#67), 11.2-INT-006 (F#75) (AC: #1, #8)
  - [x] Recording logger via `LoggerService` Layer that pushes into an outer-scope `received[]` array
  - [x] Lock the EXACT sequence of log lines for a happy-path multipart upload (locks regressions across logger refactors)
  - [x] Slow logger: inject `await new Promise(r => setTimeout(r, 50))` per log line; assert upload total wall-time does NOT scale linearly with log-line count
  - [x] Custom prefix: inject a logger that prepends `[upload:${id}]`; assert prefix appears on every line

- [x] Task 3: Layer composition tests — 11.2-INT-007 (F#76), 11.2-INT-009 (F#79), 11.2-INT-011 (F#81) (AC: #2, #3)
  - [x] `Layer.empty` → expect a clear `RuntimeException` from Effect (not a generic crash) — confirm error message is actionable (defect carries the missing-service tag name)
  - [x] Last-writer-wins: `Layer.merge(LoggerServiceLive, RecordingLogger)` — the override wins (NOT chained `provideLayer`, which is first-writer-wins)
  - [x] Concurrent `.effect`: run 2 uploads in parallel sharing a `Layer.effect`-built service via a SINGLE `Effect.provide`; assert the service builder fires exactly once

- [x] Task 4: Cleanup tests — 11.2-INT-010 (F#80), 11.2-INT-012 (F#83), 11.2-INT-013 (F#85), 11.2-INT-016 (F#88), 11.2-INT-017 (F#90) (AC: #4, #8) — **completed in ATDD red phase**
  - [x] Layer finalizer with a counter; run scope to closure (success + error + abort paths); assert counter increments exactly 3 times
  - [x] Source stream release: attach a `cancel` spy to the source `ReadableStream`; force an error mid-upload; assert `cancel` was called
  - [x] Pipeline upstream cancel: same pattern via a manually-erroring `TransformStream`; assert `cancel` was called on the user source via `pipeThrough` back-propagation
  - [x] Semaphore permit leak probe: 6 parts × maxConcurrency=2, part 1 fails terminally; assert wall-clock settlement < 2s + `running===0` after upload settles (every part's `finally` ran)
  - [x] Events-stream cleanup lens: unread events stream closes cleanly after upload completes (paired with 11.6-INT-027 latency lens)

- [x] Task 5: TCP RST + tab-close — 11.2-INT-014 (F#86), 11.2-INT-015 (F#87) (AC: #6, #7)
  - [x] TCP RST: spin a loopback `node:net` server that destroys the socket on connect; assert `PartUploadError` + cause + wall-clock < 5s (no hang)
  - [x] Tab close: AbortController + dropped result handle approximation; assert `initiate` fired once, `completeUpload` NEVER fired → orphan multipart (Epic 13 candidate: auto-abort on unhandled close)

- [x] Task 6: Compression-service edges — 11.2-INT-003 (F#68), 11.2-INT-004 (F#69), 11.2-INT-005 (F#70) (AC: #8)
  - [x] Node-side: `CompressionServiceLive` resolves and round-trips through `CompressionStream("deflate-raw")` on Node 22+; browser-side covered by existing 10.4-E2E-005 (PW-Lib `deflate-raw.spec.ts`). Scope note: vitest browser-mode harness deferred to Epic 13.
  - [x] No-op compressor → object size === source size (proves injection overrides the default)
  - [x] Malformed compressor → upload "succeeds" with corrupt bytes — codifies the no-checksum trust boundary (Epic 13 candidate: optional ingest checksum)

- [x] Task 7: TestClock pattern — 11.2-INT-008 (F#78) (AC: #8)
  - [x] `@effect/vitest` `it.effect` with `Effect.fork` + `TestClock.adjust("Xms")` for `Schedule.exponential("100 millis").pipe(Schedule.compose(Schedule.recurs(5)))` — locks the canonical pattern for future time-dependent specs

- [x] Task 8: PW-Lib heap stability — 11.2-E2E-001 (F#84) (AC: #5) — **completed in ATDD red phase**
  - [x] New spec `tests/e2e/lib/cleanup-heap-stability.spec.ts`, Chromium-only (skip Firefox/WebKit)
  - [x] Bench harness: `examples/test-app/bench.html` + `examples/test-app/src/bench.ts` exposes `window.__tlBench__` for in-page `uploadMultipart` invocation without UI navigation
  - [x] 100 sequential in-memory uploads, samples at 0/50/100, GC forced via `window.gc()` (chromium launched with `--js-flags=--expose-gc --enable-precise-memory-info`)
  - [x] Heap ratio ≤ 1.5× baseline (mid + end sample both checked)

- [x] Task 9: Triptyque verification
  - [x] `pnpm turbo build` green
  - [x] `pnpm -r test` green (197 core + 44 adapters = 241 vitest tests, +13 net core vs Story 11.6)
  - [x] `pnpm exec playwright test --project=lib cleanup-heap-stability.spec.ts` green (Chromium PASS, Firefox/WebKit SKIP)
  - [x] `pnpm turbo typecheck` green

- [x] Task 10: Traceability update
  - [x] Appended 18 rows (11.2-INT-001 → 11.2-INT-017 + 11.2-E2E-001) to `_bmad-output/test-artifacts/traceability/traceability-report-epic-11.md` § 2.2 + § 3.3
  - [x] Bumped § 1 totals (35 → 53), gate decision (2/7 → 3/7 stories landed)

### Review Findings

All 9 findings verified on technical merit and addressed inline. Triptyque green pre- AND post-review (build + 198 core + 44 adapters + 1 PW-Lib heap + typecheck; +1 core test from the new INT-007b Layer.empty CompressionService variant).

- [x] [Review][Patch] Slow logger test does not return an async value, so it cannot catch awaited-logger regressions [packages/tranquilload-core/src/services/logger-service-integration.test.ts:204] — **Fixed:** `log: (...) => new Promise(r => setTimeout(r, 50))` now RETURNS the Promise; if safeLog regressed to `await`, the upload would scale linearly with log count.
- [x] [Review][Patch] "Exact sequence" logger test only checks partial shape, not the full deterministic sequence [packages/tranquilload-core/src/services/logger-service-integration.test.ts:183] — **Fixed:** set `maxConcurrency: 1` so part-completion logs emit in partNumber order, then `expect(messages).toEqual([...])` with the full ordered array.
- [x] [Review][Patch] Layer.empty missing-service test covers LoggerService only, not CompressionService [packages/tranquilload-core/src/services/layers-composition.test.ts:39] — **Fixed:** added INT-007b sibling that drives `compress("deflate-raw")` against `Layer.empty as Layer<CompressionService>` and asserts the defect mentions the missing tag. Original test renamed INT-007a.
- [x] [Review][Patch] Last-writer-wins test targets LoggerService instead of the specified CompressionServiceLive override path [packages/tranquilload-core/src/services/layers-composition.test.ts:110] — **Fixed:** INT-009 rewritten to `Layer.merge(CompressionServiceLive, UserCompression)` with a sentinel-byte override + byte-identity assertion proving the user override beat the default.
- [x] [Review][Patch] CompressionServiceLive browser+Node default is not newly parameterized under story 11.2 coverage [packages/tranquilload-core/src/services/compression-service-edges.test.ts:61] — **Partially addressed:** Node-side rigor lifted to a true round-trip (see Finding #9). Browser-side (vitest browser-mode) deferred — the 3-engine PW-Lib spec `10.4-E2E-005` discharges the cross-browser axis. Scope note tightened in the test comment.
- [x] [Review][Patch] TCP RST test can hang before reaching its elapsed-time assertion [packages/tranquilload-core/src/multipart/termination-edges.test.ts:62] — **Fixed:** wrapped the `Effect.runPromise` in `Promise.race` against a 5s sentinel + `expect(settled).not.toBe("WALL_CLOCK_TIMEOUT")`. The test now enforces its OWN budget instead of relying on vitest's default timeout. Mirrors the INT-016 pattern.
- [x] [Review][Patch] Tab-close simulation relies on a fixed 30 ms sleep instead of a start gate [packages/tranquilload-core/src/multipart/termination-edges.test.ts:154] — **Fixed:** added two Promise gates — `initiated` resolved by the `initiate` callback, `partStarted` resolved by the first `uploadPart` entry — and `await` both before asserting. Pattern 1 from `project_test_timing_boundary_patterns.md`.
- [x] [Review][Patch] Semaphore cleanup test does not prove two parts were concurrently in flight [packages/tranquilload-core/src/multipart/cleanup.test.ts:357] — **Fixed:** part 1 now `await`s a `part2Entered` gate (resolved when part 2 enters `uploadPart`) before throwing, PROVING 2-permit overlap at the moment of failure. Added `expect(maxObserved).toBeGreaterThanOrEqual(2)` lower-bound assertion. 500ms safety race on the gate so a broken semaphore (part 2 never starts) surfaces as a wall-clock timeout, not a hang.
- [x] [Review][Patch] CompressionServiceLive "working" test checks only non-empty bytes, not a round-trip [packages/tranquilload-core/src/services/compression-service-edges.test.ts:67] — **Fixed (same change as #5):** INT-003 now does deflate-raw → `DecompressionStream("deflate-raw")` round-trip on a 256-byte non-trivial source + byte-identity assertion against the source. A broken compress() returning garbage now fails this test.

## Dev Notes

### Spec inputs

- Source spec: `_bmad-output/test-artifacts/test-design-epic-11.md` § "Story 11.2 — Layers, logger, cleanup & resource safety"
- Risk clusters: R-P2-2 (TECH, HIGH, Score 6 — cleanup/resource leak) + R-P2-8 (TECH, MEDIUM, Score 4 — layer composition edges)
- 17 VT + 1 PW-Lib = 18 net-new tests, ~1h/test mean

### Critical patterns

- **`safeLog` precedent (MEMORY):** A throwing logger does NOT crash the upload fiber. The F#65 (recording logger) and F#67 (slow logger) tests should NOT inject a throwing logger — that's Story 10.1-INT-013's territory.
- **Custom layer test pattern (MEMORY):** define `received = []` outside `Effect.gen`, pass `TestLayer` via nested `Effect.provide(Effect.gen(...), TestLayer)`. Do NOT reference outer vars inside `pipe(Effect.provide(...))`.
- **Heap test gotcha:** `performance.memory.usedJSHeapSize` is Chromium-only and noisy. Use the 1.5× threshold (or higher — tune to noise floor). Hard equality will flake.
- **F#N prefix:** Every test description starts with `F#N — ...` per Story 10.1 convention.
- **Tab-close test caveat:** Simulating tab-close in vitest is approximate (vitest is Node, not a browser). The realistic version is in `tests/e2e/lib/` or PW-UI, but for AC #7 a vitest-level approximation (abort + drop reference) is sufficient — note the limitation in the test description.

### Files likely touched

- New / extended:
  - `packages/tranquilload-core/src/services/logger-service-lifecycle.test.ts` (or extend existing `logger-service-integration.test.ts` from Story 10.1)
  - `packages/tranquilload-core/src/services/compression-service-edges.test.ts`
  - `packages/tranquilload-core/src/multipart/cleanup.test.ts` (or extend existing)
  - `packages/tranquilload-core/src/layers/composition.test.ts` (likely new)
- New: `tests/e2e/lib/cleanup-heap-stability.spec.ts`
- Updated: traceability report

### Out of scope

- Auto-abort orphan multipart on tab close (Epic 13 candidate flagged in F#87 — only the CURRENT behaviour is locked here)
- Firefox/WebKit heap-stability variant (no equivalent of `performance.memory` — skip)

## References

- [Source: _bmad-output/test-artifacts/test-design-epic-11.md § Story 11.2] — 18 net-new tests
- [Source: _bmad-output/brainstorming/brainstorming-session-2026-05-17-001.md] — F#65, F#67-F#70, F#75, F#76, F#78-F#81, F#83-F#88, F#90
- [Source: _bmad-output/planning-artifacts/epics.md § Story 11.2] — acceptance criteria
- [MEMORY: project_test_framework_patterns.md] — fixture patterns
- [MEMORY: project_effect_peer_dep_contract.md] — Layer composition semantics, Tag-by-key lookup
- [MEMORY: feedback_typecheck_mandatory.md] — build + test + typecheck

## Dev Agent Record

### Agent Model Used

Claude Opus 4.7 (`claude-opus-4-7`) — dev + ATDD red phase. Per `feedback_code_review_model.md`, code-review (if invoked) should run on a different LLM (Codex recommended after Story 11.6's success with this combo).

### Debug Log References

- ATDD red phase: all 5 R-P2-2 HIGH-cluster tests (INT-010/012/013/016 + E2E-001) GREEN on first run against current lib — no lib fix surfaced. Same pattern as Story 11.6.
- Two test-design issues caught during dev:
  - INT-009 (last-writer-wins): chained `Stream.provideLayer(LayerA).provideLayer(LayerB)` is FIRST-writer-wins (LayerA's value used; LayerB no-ops because the requirement is already satisfied). Idiomatic last-writer-wins is `Layer.merge(Default, Override)`. Re-spec'd accordingly.
  - INT-011 (concurrent shared layer): each parallel upload needs its own `ReadableStream` instance (a Web ReadableStream can be consumed only once). Use `Effect.suspend(() => Stream.runDrain(uploadMultipartEffect({stream: tinyStream(20), ...})))` so the stream is built when each branch actually runs.
- `@effect/vitest` `it.effect` injects a TestClock. Tests using wall-clock `setTimeout` for synchronization (INT-010 Path C abort, INT-016 wall-clock settlement) must switch to plain vitest `it` + `Effect.runPromise` to get the default real-time Clock. INT-008 stays on `it.effect` because `TestClock.adjust` is precisely the pattern under test there.

### Completion Notes List

- **18 net-new tests** landed: 17 vitest-integration (VT) + 1 Playwright-Lib (PW-Lib heap). All 18 GREEN.
- **No lib change required.** ATDD red phase exercised the 5 R-P2-2 HIGH-cluster tests (INT-010/012/013/016 + E2E-001) before any dev work — all 5 passed against current lib on first run, confirming the cleanup/resource-safety contract is already correctly implemented. The remaining 13 tests are LOCK tests added by the dev phase (logger lifecycle, layer composition, compression edges, TestClock pattern, TCP RST, tab-close orphan, events cleanup lens).
- **Test-app harness extended** (`examples/test-app/bench.html` + `examples/test-app/src/bench.ts`) to expose `window.__tlBench__` for the heap-stability spec. The bench page is a non-UI route consumed only by `tests/e2e/lib/cleanup-heap-stability.spec.ts`.
- **Three reusable patterns from Story 11.6** (`project_test_timing_boundary_patterns.md`) applied: gated callback (INT-010 Path C `partStarted` Promise), surgical defect-refusal via `Effect.runPromiseExit` + `Cause.dieOption` + `Chunk.size(Cause.defects)` (INT-012/013/016), and honest scope (INT-016 wall-clock settlement is the narrower honest lock; E2E-001 1.5× heap threshold absorbs `performance.memory` coarseness; INT-003 Node-only side + reference to 10.4-E2E-005 for the browser axis).
- **Two new reusable patterns** surfaced in this story:
  1. `@effect/vitest` `it.effect` injects TestClock — tests with wall-clock `setTimeout` synchronization need plain `vitest` `it` + `Effect.runPromise`. Codified in INT-010 and INT-016. (Worth memorizing.)
  2. Layer composition: `Layer.merge(Default, Override)` is the last-writer-wins primitive. Chained `Stream.provideLayer(A).provideLayer(B)` is FIRST-writer-wins (B no-ops once A satisfies the requirement). Codified in INT-009.
- **2 Epic 13 candidates surfaced** (already flagged in test comments, don't re-flag):
  - F#87 — auto-abort orphan multipart on unhandled tab close (INT-015 currently locks the orphan behaviour; flip in Epic 13)
  - F#70 — optional ingest-side checksum to surface "compressor produced unreadable bytes" before upload completes (INT-005 codifies the current trust-boundary contract)

### Change Log

- 2026-05-23 — **Story 11.2 → done.** 13 VT + 1 PW-Lib added on top of the 4 VT (cleanup) already landed in ATDD red phase. Triptyque (`pnpm turbo build` + `pnpm -r test` + `pnpm turbo typecheck`) green, plus `pnpm exec playwright test --project=lib cleanup-heap-stability.spec.ts` green. Core test count 184 → 197 (+13). Traceability report bumped (35 → 53; 3/7 stories landed). No lib fix.
- 2026-05-23 — **Codex code-review fixes (test-design rigor only).** 9 findings addressed inline: slow-logger now returns Promise instead of discarding (#1), exact-sequence INT-001 uses maxConcurrency=1 + deep-equal full ordered array (#2), Layer.empty INT-007 split into 007a (LoggerService) + 007b (CompressionService) per AC #2 wording (#3), INT-009 rewritten to override CompressionServiceLive with sentinel bytes per AC #3 (#4), INT-003 lifted to full deflate-raw round-trip via DecompressionStream + byte-identity (#5+#9), INT-014 wrapped in Promise.race vs 5s sentinel so a hang fails the assertion (#6), INT-015 uses gated `initiated` + `partStarted` Promises instead of fixed 30ms sleep (#7), INT-016 gates part 1's failure on `part2Entered` to PROVE 2-permit overlap + adds `maxObserved >= 2` lower-bound (#8). Core test count: 197 → 198 (+1, from the new INT-007b). Triptyque green pre- AND post-review fixes. NO lib change.

### File List

**New**
- `packages/tranquilload-core/src/multipart/cleanup.test.ts` (5 tests: INT-010/012/013/016/017 — first 4 from ATDD red phase, INT-017 added by dev)
- `packages/tranquilload-core/src/services/layers-composition.test.ts` (3 tests: INT-007/009/011)
- `packages/tranquilload-core/src/services/compression-service-edges.test.ts` (3 tests: INT-003/004/005)
- `packages/tranquilload-core/src/multipart/termination-edges.test.ts` (2 tests: INT-014/015)
- `packages/tranquilload-core/src/multipart/testclock-schedule.test.ts` (1 test: INT-008)
- `tests/e2e/lib/cleanup-heap-stability.spec.ts` (1 spec: E2E-001 — from ATDD red phase)
- `examples/test-app/bench.html` (bench-page harness for E2E-001)
- `examples/test-app/src/bench.ts` (exposes `window.__tlBench__` to the bench page)

**Modified**
- `packages/tranquilload-core/src/services/logger-service-integration.test.ts` (+3 tests: INT-001/002/006 appended; import `plainIt` from `vitest` for the wall-clock latency test)
- `_bmad-output/test-artifacts/traceability/traceability-report-epic-11.md` (§ 2.2 added, § 3.3 added, § 1 totals + gate decision bumped)
- `_bmad-output/implementation-artifacts/sprint-status.yaml` (`11-2 → done`, `last_updated`)
- `_bmad-output/implementation-artifacts/11-2-layers-logger-cleanup-and-resource-safety.md` (Status, tasks, Dev Agent Record, File List, Change Log)

## Senior Developer Review (AI)

**Reviewer:** Codex (OpenAI) — per `feedback_code_review_model.md` recommendation to use a different LLM than the dev model (Opus 4.7).

**Outcome:** Approve with patches. **0 HIGH / 9 PATCH-level (test-design rigor) / 0 LOW.** No lib change required — all findings target test rigor.

**Findings & Resolutions** (verbatim list above in § Review Findings). Summary:

- 8 of 9 findings fully patched inline.
- 1 (#5 browser+Node parameterization) partially addressed: Node-side rigor lifted to a full round-trip (Finding #9 fix); browser-side deferred — the 3-engine PW-Lib spec `10.4-E2E-005` honestly discharges the cross-browser axis; vitest browser-mode harness deferred to Epic 13. Scope note in the test comment.

**Triptyque post-review:** build ✅ · 198 core + 44 adapters = 242 vitest tests ✅ · typecheck ✅ · `tests/e2e/lib/cleanup-heap-stability.spec.ts` (Chromium) ✅.

**Reusable patterns reinforced** (already in MEMORY.md):
- Pattern 1 (gated callback) applied to INT-015 + INT-016.
- Wall-clock-budget race pattern applied to INT-014 (matching INT-016's existing use).
- Honest scope (Pattern 3) explicit on INT-003 browser-side deferral.

**No regressions.** No lib code modified by this review pass — all changes are in test files + the story file's Review Findings + Change Log + this section. Story 11.2 remains `done`.
