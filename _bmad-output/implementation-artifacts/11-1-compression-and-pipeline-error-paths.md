# Story 11.1: Compression & Pipeline Error Paths

Status: done

## Story

As a library maintainer,
I want vitest-integration coverage for compression and pipeline error paths,
so that any user-supplied or environment-misconfigured `CompressionService` surfaces a typed `UploadError` and never causes a fiber DEFECT.

## Acceptance Criteria

1. **Given** a custom `CompressionService` that throws synchronously **When** `compress()` is added to the pipeline and an upload runs **Then** the failure surfaces as `PartUploadError` in the Effect error channel (test IDs 11.1-INT-001 covering F#17, 11.1-INT-004 covering F#71) and the upload fiber does not DEFECT.

2. **Given** `globalThis.CompressionStream` is `undefined` (unsupported environment) or polyfilled-undefined (Worker context) **When** `compress()` is invoked **Then** the upload fails via the typed Effect error channel — no unhandled exception (test IDs 11.1-INT-003 covering F#20, 11.1-INT-006 covering F#73).

3. **Given** a `CompressionService` whose returned `ReadableStream` errors asynchronously when read **When** an upload runs **Then** the stream-error path (`chunkStream`'s `Stream.fromReadableStream` → `Stream.mapError`) produces a typed `PartUploadError(0, 0, cause)` (test ID 11.1-INT-005 covering F#72).

4. **Given** an Effect-typed pipeline with the default `CompressionServiceLive` **When** the upload runs via `.effect` **Then** the Layer resolves correctly and produces the expected compressed output (test ID 11.1-INT-002 covering F#18).

## Tasks / Subtasks

- [x] Task 1: Decide the file landing zone (AC: #1-#4)
  - [x] Default to `packages/tranquilload-core/src/pipeline/compress-error-paths.test.ts` (co-located vitest-integration) OR `tests/integration/pipeline/compression-error-paths.test.ts` (cross-package) — the test design has no preference; prefer co-located unless a scenario crosses adapter boundaries
  - [x] If the existing `packages/tranquilload-core/src/pipeline/compress.test.ts` (or equivalent) already exists, extend it rather than create a new file
    - **Decision:** new file `compress-error-paths.test.ts`. The existing `compress.test.ts` holds unit-level tests of the `compress` Effect (Layer-stub failure path). The new file exercises the full upload pipeline (chunkStream → `Stream.mapError` → `PartUploadError`). Keeping them separate clarifies the test level (unit vs integration) at the filename layer.

- [x] Task 2: Write 11.1-INT-001 (F#17 — sync throw) (AC: #1)
  - [x] `Effect.gen` test using `@effect/vitest` `it.effect`
  - [x] Provide a Layer that overrides `CompressionService` with a stub whose `compress` throws synchronously
  - [x] Assert: `Effect.exit` is `Failure` carrying a `PartUploadError`; assert `error._tag === "PartUploadError"`
  - [x] **Defect refusal:** also assert `Cause.dieOption(exit.cause)._tag === "None"` and `Chunk.size(Cause.defects(...)) === 0` — locks the `safeLog`-analog contract that user-injected boundary throws never crash the fiber.

- [x] Task 3: Write 11.1-INT-002 (F#18 — Effect-typed pipeline with `CompressionServiceLive`) (AC: #4)
  - [x] Run a tiny upload via `uploadMultipart.effect` with the default Live layer
  - [x] Assert the resulting bytes round-trip through a `DecompressionStream` to the original input
    - **Note:** test compares decompressed bytes back to the 64-byte source (`new Uint8Array(64).map((_, i) => i % 251)`) to prove the pipeline is doing real compression work, not identity.

- [x] Task 4: Write 11.1-INT-003 (F#20 — absent `globalThis.CompressionStream`) (AC: #2)
  - [x] `vi.stubGlobal("CompressionStream", undefined)` (or equivalent) inside the test scope
  - [x] Assert the Promise rejects with a typed `PartUploadError` (or whatever variant the lib produces — confirm with `CompressionServiceLive`'s error mapping)
    - **Confirmed:** the lib produces `CompressionUnavailableError` (not `PartUploadError`) at the `compress` Effect resolution step — the Layer fails before the Transform is even called. Asserted accordingly; AC #2's "fails via the typed Effect error channel" holds.
  - [x] Restore the global in `afterEach` (via `vi.unstubAllGlobals()`)

- [x] Task 5: Write 11.1-INT-004 / 11.1-INT-005 (F#71 sync / F#72 async) (AC: #1, #3)
  - [x] Two parameterized cases over `{ kind: "sync-throw" | "async-reject" }`
  - [x] Confirm both shapes normalize to the same `_tag` variant (`PartUploadError`, `partNumber: 0`, `attempt: 0`)

- [x] Task 6: Write 11.1-INT-006 (F#73 — Worker-context polyfilled-undefined) (AC: #2)
  - [x] Simulate a Worker-like environment by stubbing `globalThis.CompressionStream` to `undefined` AND blocking the fallback path
    - Uses `Object.defineProperty(globalThis, "CompressionStream", { value: undefined, configurable: true, writable: true })` to explicitly install `undefined` as the property value (the polyfill pattern), distinct from `vi.stubGlobal` (which also assigns `undefined` but is captured for `vi.unstubAllGlobals`). Restored via cached `PropertyDescriptor` in `afterEach`.
  - [x] If the lib has a Worker-aware code path, exercise it; otherwise confirm parity with 11.1-INT-003
    - **Confirmed parity:** `CompressionServiceLive` uses `typeof cs === "undefined"` which catches both shapes (missing global and explicit `undefined`). No separate Worker-aware code path; the existing check is robust.

- [x] Task 7: Triptyque verification (build + test + typecheck)
  - [x] `pnpm turbo build` green (3.979s; 4 of 4 successful)
  - [x] `pnpm vitest run --filter @tranquilload/core` green (163 tests across 19 files; +6 new)
  - [x] `pnpm turbo typecheck` green (5.535s; 5 of 5 successful)
  - [x] Full repo recursive test sweep: 195 tests green (core: 163, adapters: 32) — no regressions

- [x] Task 8: Update traceability
  - [x] Add 11.1-INT-001 → 11.1-INT-006 rows to `_bmad-output/test-artifacts/traceability/traceability-report-epic-11.md` (created on first story; mirrors Epic 10 report shape: §1 epic rollup, §2 forward matrix per story, §3 reverse matrix per risk cluster, §4 real lib findings, §5 gate decision, §6 next update marker)
  - [x] Each row maps to its F#N from the brainstorming session

## Real Lib Finding (Story 11.1)

**Symptom:** Initial RED for 11.1-INT-001 (F#17) and 11.1-INT-004 (F#71) — a sync throw inside a user-injected `CompressionService.compress` produced a fiber DEFECT (raw Error propagated out of `Effect.gen`), not a typed `PartUploadError`.

**Fix:** `packages/tranquilload-core/src/pipeline/compress.ts` — wrap `svc.compress(stream, algorithm)` in `try/catch`. On sync throw, return a `ReadableStream` that immediately errors via `controller.error(cause)`. The error then propagates through `chunkStream`'s `Stream.fromReadableStream` → `Stream.mapError` → `PartUploadError(0, 0, cause)`. Mirrors the `safeLog` precedent (Story 10.1-INT-013, F#66) — never let a user-injected boundary callable defect the upload fiber.

**Behavior change:** purely additive; what was a fiber defect (unrecoverable) is now a typed `PartUploadError` (recoverable via `Effect.catchTag`, `Match.tag`, etc.). No existing test regressed.

**Out-of-scope by design:** the public `uploadMultipart` path where a user passes a raw `Transform` function directly via `options.pipeline: Transform` — that function is user-owned arbitrary code; the lib's contract only covers the `compress()` helper. A future story can wrap `options.pipeline(options.stream)` in `Effect.try` at the dual-API boundary if that becomes a contract.

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

Claude Opus 4.7 (`claude-opus-4-7`) — `bmad-dev-story` workflow.

### Debug Log References

- RED state confirmed before lib fix: `pnpm --filter @tranquilload/core test -- compress-error-paths` → 2 failed (11.1-INT-001, 11.1-INT-004), 4 passed. Raw `Error("svc sync throw")` thrown out of `Effect.gen` at `src/pipeline/compress.ts:8:59`.
- GREEN after lib fix: same command → 6 passed.
- Triptyque: `pnpm turbo build` (3.98s ✅), full repo recursive test (195 tests ✅), `pnpm turbo typecheck` (5.54s ✅).
- One incidental typecheck issue caught: `DecompressionStream` needed the same `as unknown as TransformStream<Uint8Array, Uint8Array>` cast that `CompressionServiceLive` uses (DOM vs `@types/node` lib mismatch). Cast applied at the test call-site only; no lib change needed.

### Completion Notes List

- ✅ All 6 story tests authored at integration level (`compress-error-paths.test.ts`), 100% pass, F#N prefix convention preserved (`11.1-INT-N (F#X) — ...`).
- ✅ Real lib finding shipped inline in `compress.ts` — `svc.compress(...)` is now defect-safe at the `compress()` boundary; documented under § Real Lib Finding above.
- ✅ Epic 11 traceability report created at `_bmad-output/test-artifacts/traceability/traceability-report-epic-11.md` — mirrors Epic 10 shape; will be appended to as 11.2–11.7 land.
- ✅ Sprint-status flipped `ready-for-dev → in-progress → review` for `11-1-compression-and-pipeline-error-paths`.
- ✅ No regression: 195 tests pass across `@tranquilload/core` (163) and `@tranquilload/adapters` (32). Epic 10 P1 coverage intact.
- 🔎 No new dependencies added.
- 🔎 D1/D2/D3 (`epics.md` Open Decisions) untouched — none affect 11.1.

### Change Log

| Date | Change | File(s) |
|---|---|---|
| 2026-05-22 | Story 11.1 implemented: 6 integration tests for compression error paths (F#17, F#18, F#20, F#71, F#72, F#73). | `packages/tranquilload-core/src/pipeline/compress-error-paths.test.ts` (new) |
| 2026-05-22 | **Real lib finding** — `compress()` Transform now wraps `svc.compress` in try/catch and returns a lazily-erroring stream so user-injected sync throws surface as `PartUploadError(0, 0, cause)` (via `chunkStream`'s `Stream.mapError`) instead of fiber defects. Mirrors the `safeLog` precedent (Story 10.1-INT-013). | `packages/tranquilload-core/src/pipeline/compress.ts` |
| 2026-05-22 | Created Epic 11 traceability report mirroring Epic 10 shape; populated Story 11.1 section. | `_bmad-output/test-artifacts/traceability/traceability-report-epic-11.md` (new) |
| 2026-05-22 | Sprint-status updated: `11-1-compression-and-pipeline-error-paths` → `review`. | `_bmad-output/implementation-artifacts/sprint-status.yaml` |
| 2026-05-22 | **Code review (bmad-code-review)** — 0 HIGH / 0 MEDIUM / 4 LOW findings. Fixed L1 (11.1-INT-003 now uses `delete` to genuinely probe the F#20 truly-absent-property shape, distinct from F#73's polyfilled-undefined; added `hasOwnProperty === false` setup assertion) + L2 (tightened AC #3 wording in story + epics.md to describe the actual `Stream.fromReadableStream` + `Stream.mapError` path, not `normalizeCallback`). L3 + L4 left as informational. Triptyque green post-fix (195 tests). Status → done. | `packages/tranquilload-core/src/pipeline/compress-error-paths.test.ts`, `_bmad-output/planning-artifacts/epics.md`, `_bmad-output/implementation-artifacts/11-1-compression-and-pipeline-error-paths.md` |

### File List

- `packages/tranquilload-core/src/pipeline/compress.ts` — modified (try/catch wrap around `svc.compress`)
- `packages/tranquilload-core/src/pipeline/compress-error-paths.test.ts` — new (6 integration tests)
- `_bmad-output/test-artifacts/traceability/traceability-report-epic-11.md` — new (Epic 11 traceability rollup)
- `_bmad-output/implementation-artifacts/sprint-status.yaml` — modified (status + last_updated)
- `_bmad-output/implementation-artifacts/11-1-compression-and-pipeline-error-paths.md` — modified (this file: status, tasks, dev agent record)

## Senior Developer Review (AI)

**Reviewer:** Claude Opus 4.7 (per `feedback_code_review_model.md` — Opus for dev AND review)
**Date:** 2026-05-22
**Outcome:** ✅ Approved with minor fixes — Story 11.1 → `done`.

### Findings summary

| Severity | Count | Status |
|---|---|---|
| HIGH | 0 | — |
| MEDIUM | 0 | — |
| LOW | 4 | L1 + L2 fixed inline; L3 + L4 left as informational (non-actionable) |

### AC validation

All 4 acceptance criteria verified against test evidence:

- **AC #1** (sync-throw → `PartUploadError`, no DEFECT): ✅ `11.1-INT-001` + `11.1-INT-004` — `Cause.dieOption._tag === "None"` defect-refusal locked
- **AC #2** (absent OR polyfilled-undefined CompressionStream): ✅ `11.1-INT-003` (truly-absent, `hasOwnProperty === false`) + `11.1-INT-006` (polyfilled-undefined, `hasOwnProperty === true`) — both shapes now distinctly probed
- **AC #3** (async-rejection → typed error): ✅ `11.1-INT-005` — erroring `ReadableStream.pull` → stream-error path → `PartUploadError(0, 0, cause)`
- **AC #4** (Effect-typed pipeline + Live): ✅ `11.1-INT-002` — DecompressionStream round-trip, byte-for-byte equality on 64-byte non-trivial input

### Action items (resolved)

- [x] [AI-Review][Low] L1 — `11.1-INT-003` shifted from `vi.stubGlobal("CompressionStream", undefined)` (which writes the property) to `delete` (which truly removes it). Added `hasOwnProperty === false` setup assertion to distinguish from `11.1-INT-006`. F#20 vs F#73 traceability now honest. `compress-error-paths.test.ts:121`
- [x] [AI-Review][Low] L2 — Tightened AC #3 wording in this story file and `epics.md` to describe the actual `Stream.fromReadableStream` + `Stream.mapError` path (no `normalizeCallback` involvement — that helper is for `(stream) => A | Promise<A> | Effect<A, E>` callbacks, not for the stream-error path). `11-1-compression-and-pipeline-error-paths.md` + `epics.md`

### Action items (deferred — informational)

- [ ] [AI-Review][Low] L3 — `compress.ts` try/catch may leave the source `ReadableStream` reference dangling if `svc.compress` throws before reading. JS GC handles cleanup; no observable leak. Story 11.2 (cleanup/resource-safety) is the natural place to revisit if it ever proves observable.
- [ ] [AI-Review][Low] L4 — `11.1-INT-006` description says "Worker-context"; it simulates the polyfilled-undefined shape that Workers might exhibit but doesn't run inside a Worker. Coverage is correct; framing is aspirational. No fix needed.

### Code quality assessment

- **Surgical fix in `compress.ts`** — minimal try/catch wrap, mirrors `safeLog` precedent in spirit (intercept user-boundary throw → typed channel) while correctly diverging in mechanism (lazily-erroring `ReadableStream` instead of `Effect.ignore`) because compression failures DO matter for the upload. Codified the generalized pattern in `project_defect_safe_user_boundary.md`.
- **Test quality** — surgical assertions throughout (`expect(failure.value._tag).toBe("PartUploadError")`, `partNumber: 0`, `attempt: 0`, exact cause-message match, defect-refusal pair via `Cause.dieOption._tag === "None"` + `Chunk.size(Cause.defects) === 0`). F#N prefix convention preserved per Story 10.1.
- **Traceability** — `traceability-report-epic-11.md` mirrors Epic 10 shape; forward + reverse matrices + real-lib-finding section in place for incremental updates as 11.2–11.7 land.
- **Triptyque** — green pre- and post-review-fix (build ✅ · 195 tests ✅ · typecheck ✅). No P1 regression.

### Verdict

Implementation is clean and complete. ACs honestly met. File List matches git reality. Story → `done`.
