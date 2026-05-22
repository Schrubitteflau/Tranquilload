# Story 11.1: Compression & Pipeline Error Paths

Status: ready-for-dev

## Story

As a library maintainer,
I want vitest-integration coverage for compression and pipeline error paths,
so that any user-supplied or environment-misconfigured `CompressionService` surfaces a typed `UploadError` and never causes a fiber DEFECT.

## Acceptance Criteria

1. **Given** a custom `CompressionService` that throws synchronously **When** `compress()` is added to the pipeline and an upload runs **Then** the failure surfaces as `PartUploadError` in the Effect error channel (test IDs 11.1-INT-001 covering F#17, 11.1-INT-004 covering F#71) and the upload fiber does not DEFECT.

2. **Given** `globalThis.CompressionStream` is `undefined` (unsupported environment) or polyfilled-undefined (Worker context) **When** `compress()` is invoked **Then** the upload fails via the typed Effect error channel — no unhandled exception (test IDs 11.1-INT-003 covering F#20, 11.1-INT-006 covering F#73).

3. **Given** a `CompressionService` returning an async rejection **When** an upload runs **Then** the rejection is normalized via `normalizeCallback` and produces a typed `PartUploadError` (test ID 11.1-INT-005 covering F#72).

4. **Given** an Effect-typed pipeline with the default `CompressionServiceLive` **When** the upload runs via `.effect` **Then** the Layer resolves correctly and produces the expected compressed output (test ID 11.1-INT-002 covering F#18).

## Tasks / Subtasks

- [ ] Task 1: Decide the file landing zone (AC: #1-#4)
  - [ ] Default to `packages/tranquilload-core/src/pipeline/compress-error-paths.test.ts` (co-located vitest-integration) OR `tests/integration/pipeline/compression-error-paths.test.ts` (cross-package) — the test design has no preference; prefer co-located unless a scenario crosses adapter boundaries
  - [ ] If the existing `packages/tranquilload-core/src/pipeline/compress.test.ts` (or equivalent) already exists, extend it rather than create a new file

- [ ] Task 2: Write 11.1-INT-001 (F#17 — sync throw) (AC: #1)
  - [ ] `Effect.gen` test using `@effect/vitest` `it.effect`
  - [ ] Provide a Layer that overrides `CompressionService` with a stub whose `compress` throws synchronously
  - [ ] Assert: `Effect.exit` is `Failure` carrying a `PartUploadError`; assert `error._tag === "PartUploadError"`

- [ ] Task 3: Write 11.1-INT-002 (F#18 — Effect-typed pipeline with `CompressionServiceLive`) (AC: #4)
  - [ ] Run a tiny upload via `uploadMultipart.effect` with the default Live layer
  - [ ] Assert the resulting bytes round-trip through a `DecompressionStream` to the original input

- [ ] Task 4: Write 11.1-INT-003 (F#20 — absent `globalThis.CompressionStream`) (AC: #2)
  - [ ] `vi.stubGlobal("CompressionStream", undefined)` (or equivalent) inside the test scope
  - [ ] Assert the Promise rejects with a typed `PartUploadError` (or whatever variant the lib produces — confirm with `CompressionServiceLive`'s error mapping)
  - [ ] Restore the global in `afterEach`

- [ ] Task 5: Write 11.1-INT-004 / 11.1-INT-005 (F#71 sync / F#72 async) (AC: #1, #3)
  - [ ] Two parameterized cases over `{ kind: "sync-throw" | "async-reject" }`
  - [ ] Confirm both shapes normalize to the same `_tag` variant

- [ ] Task 6: Write 11.1-INT-006 (F#73 — Worker-context polyfilled-undefined) (AC: #2)
  - [ ] Simulate a Worker-like environment by stubbing `globalThis.CompressionStream` to `undefined` AND blocking the fallback path
  - [ ] If the lib has a Worker-aware code path, exercise it; otherwise confirm parity with 11.1-INT-003

- [ ] Task 7: Triptyque verification (build + test + typecheck)
  - [ ] `pnpm turbo build` green
  - [ ] `pnpm vitest run --filter @tranquilload/core` green (all 6 new tests)
  - [ ] `pnpm turbo typecheck` green

- [ ] Task 8: Update traceability
  - [ ] Add 11.1-INT-001 → 11.1-INT-006 rows to `_bmad-output/test-artifacts/traceability/traceability-report-epic-11.md` (create the file if needed, mirroring the Epic 10 report shape)
  - [ ] Each row maps to its F#N from the brainstorming session

## Dev Notes

### Spec inputs

- Source spec: `_bmad-output/test-artifacts/test-design-epic-11.md` § "Story 11.1 — Compression & pipeline error paths"
- Risk cluster: R-P2-5 (HIGH, Score 6)
- All 6 tests are VT (vitest-integration), ~1h/test mean.

### Project-assignment policy

Per `feedback_p2_default_to_lib.md`: pure library API, no DOM, no browser-specific API → VT is the cheapest level that answers the question. Do NOT escalate to PW-Lib unless the test genuinely needs a browser `CompressionStream` realm difference (it doesn't — sync/async throw shape is JS-engine-agnostic).

### Critical patterns

- **`safeLog` precedent (MEMORY):** A throwing logger does NOT crash the upload fiber (locked by Story 10.1-INT-013). Apply the same lens here for `CompressionService` — a throwing compressor must surface as `PartUploadError`, not a DEFECT. If during writing you discover the lib still has an unsafe call site, that's a real lib finding; raise it inline (precedent: Story 10.1 surfaced the `safeLog` fix).
- **Effect tests pattern:** `import { it, describe, expect } from "@effect/vitest"`, pattern `it.effect(...)`, layers via `Effect.provide`. Define receiver state OUTSIDE `Effect.gen` and pass `TestLayer` via nested `Effect.provide(Effect.gen(...), TestLayer)` — do NOT reference outer vars inside `pipe(Effect.provide(...))` (MEMORY: "Custom layer test pattern").
- **`normalizeCallback` double-wrapping (MEMORY):** Passing an Effect-typed callback to `uploadPart` causes double-wrapping. For these tests, when injecting a throwing/rejecting `compress`, use raw `throw` / `Promise.reject` rather than `Effect.fail` to avoid double-wrap noise.
- **F#N prefix convention (Story 10.1):** Each test description must start with `F#N — ...` to maintain bidirectional traceability. Example: `it.effect("F#17 — compression sync throw wraps as PartUploadError", ...)`.

### Files likely touched

- New / extended: `packages/tranquilload-core/src/pipeline/compress.test.ts` (or `tests/integration/pipeline/compression-error-paths.test.ts`)
- Possibly new: `_bmad-output/test-artifacts/traceability/traceability-report-epic-11.md`

### Out of scope

- Real-world WASM `CompressionService` swap (covered by Epic 13 if requested)
- Performance benchmarks against `globalThis.CompressionStream` (not in P2 scope)

## References

- [Source: _bmad-output/test-artifacts/test-design-epic-11.md § Story 11.1] — 6 net-new tests
- [Source: _bmad-output/brainstorming/brainstorming-session-2026-05-17-001.md] — F#17, F#18, F#20, F#71, F#72, F#73
- [Source: _bmad-output/planning-artifacts/epics.md § Story 11.1] — acceptance criteria
- [MEMORY: feedback_p2_default_to_lib.md] — VT is the default; only escalate when needed
- [MEMORY: project_test_framework_patterns.md] — `@effect/vitest` patterns, `it.effect`
- [MEMORY: feedback_surgical_tests.md] — assert exact error variant, not just "something failed"
- [MEMORY: feedback_typecheck_mandatory.md] — build + test + typecheck before marking done

## Dev Agent Record

### Agent Model Used

(to be filled by dev)

### Debug Log References

### Completion Notes List

### Change Log

### File List

## Senior Developer Review (AI)

(to be filled at review time)
