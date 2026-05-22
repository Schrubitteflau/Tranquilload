# Story 11.2: Layers, Logger, Cleanup & Resource Safety

Status: ready-for-dev

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

- [ ] Task 1: Plan the file layout (AC: all)
  - [ ] VT tests split across `packages/tranquilload-core/src/services/`, `packages/tranquilload-core/src/multipart/`, and `packages/tranquilload-core/src/pipeline/` co-located test files
  - [ ] PW-Lib heap test in `tests/e2e/lib/cleanup-heap-stability.spec.ts` (Chromium-only — `performance.memory` is non-standard)

- [ ] Task 2: Logger lifecycle tests — 11.2-INT-001 (F#65), 11.2-INT-002 (F#67), 11.2-INT-006 (F#75) (AC: #1, #8)
  - [ ] Recording logger via `LoggerService` Layer that pushes into an outer-scope `received[]` array
  - [ ] Lock the EXACT sequence of log lines for a happy-path multipart upload (locks regressions across logger refactors)
  - [ ] Slow logger: inject `await new Promise(r => setTimeout(r, 50))` per log line; assert upload total wall-time does NOT scale linearly with log-line count
  - [ ] Custom prefix: inject a logger that prepends `[upload:${id}]`; assert prefix appears on every line

- [ ] Task 3: Layer composition tests — 11.2-INT-007 (F#76), 11.2-INT-009 (F#79), 11.2-INT-011 (F#81) (AC: #2, #3)
  - [ ] `Layer.empty` → expect a clear `RuntimeException` from Effect (not a generic crash) — confirm error message is actionable
  - [ ] Last-writer-wins: stack `CompressionServiceLive` then a user override; resolve the Tag and confirm the override is used
  - [ ] Concurrent `.effect`: run 2 uploads in parallel sharing a `Layer.memoize`d service; assert the service constructor fires exactly once

- [ ] Task 4: Cleanup tests — 11.2-INT-010 (F#80), 11.2-INT-012 (F#83), 11.2-INT-013 (F#85), 11.2-INT-016 (F#88), 11.2-INT-017 (F#90) (AC: #4, #8)
  - [ ] Layer finalizer with a counter `Ref`; run scope to closure (success + error + abort paths); assert counter increments exactly 3 times across the 3 paths (or once per scope close)
  - [ ] Source stream release: attach a `cancel` spy to the source `ReadableStream`; force an error mid-upload; assert `cancel` was called
  - [ ] Pipeline upstream cancel: same pattern, but error injected from the pipeline stage
  - [ ] Semaphore permit leak: run an upload with `maxConcurrency=2`, force ALL parts to fail terminally; verify the semaphore permits return to baseline after error (probe `Semaphore.available`)
  - [ ] Events-stream not read does NOT slow uploads (cleanup-lens variant of F#90; latency-lens variant lives in 11.6)

- [ ] Task 5: TCP RST + tab-close — 11.2-INT-014 (F#86), 11.2-INT-015 (F#87) (AC: #6, #7)
  - [ ] TCP RST: use the test-app chaos endpoint OR a node:net mock to inject RST mid-PUT; assert `PartUploadError` not a hang (timeout < 5s)
  - [ ] Tab close: simulate by aborting the AbortController WITHOUT awaiting `result`; assert orphan multipart exists server-side (current behaviour); add a `// Epic 13 candidate: auto-abort on unhandled close` comment for the future flip

- [ ] Task 6: Compression-service edges — 11.2-INT-003 (F#68), 11.2-INT-004 (F#69), 11.2-INT-005 (F#70) (AC: #8)
  - [ ] Parameterized over `{ env: "browser-via-vitest-browser-mode", env: "node" }` — confirm default `CompressionServiceLive` works both ways
  - [ ] No-op compressor → object size === source size (proves injection overrides the default)
  - [ ] Malformed compressor → upload "succeeds" with corrupt object — codifies the no-checksum trust boundary

- [ ] Task 7: TestClock pattern — 11.2-INT-008 (F#78) (AC: #8)
  - [ ] Use `@effect/vitest` `it.effect` with `Effect.fork` + `TestClock.adjust("Xms")` to test `Schedule.exponential` retry timing
  - [ ] Reference MEMORY: "TestClock for time-based Schedules" pattern

- [ ] Task 8: PW-Lib heap stability — 11.2-E2E-001 (F#84) (AC: #5)
  - [ ] New spec `tests/e2e/lib/cleanup-heap-stability.spec.ts`, Chromium-only (`test.skip(({ browserName }) => browserName !== "chromium", ...)`)
  - [ ] Run 100 sequential `uploadMultipart` calls in a single page context
  - [ ] Sample `performance.memory.usedJSHeapSize` at start, after 50, after 100
  - [ ] Assert the trend is flat (last sample < 1.5× first sample — tunable based on noise floor)
  - [ ] Trigger GC between samples via `--enable-precise-memory-info` + `gc()` or `window.gc()` (Playwright launchOption `args: ['--js-flags=--expose-gc']`)

- [ ] Task 9: Triptyque verification
  - [ ] `pnpm turbo build` green
  - [ ] `pnpm vitest run` green (17 new VT tests)
  - [ ] `pnpm exec playwright test --project=lib tests/e2e/lib/cleanup-heap-stability.spec.ts` green (Chromium PASS, Firefox/WebKit SKIP)
  - [ ] `pnpm turbo typecheck` green

- [ ] Task 10: Traceability update
  - [ ] Append 18 rows (11.2-INT-001 → 11.2-INT-017 + 11.2-E2E-001) to `_bmad-output/test-artifacts/traceability/traceability-report-epic-11.md`

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

(to be filled by dev)

### Debug Log References

### Completion Notes List

### Change Log

### File List

## Senior Developer Review (AI)

(to be filled at review time)
