---
stepsCompleted: ['step-01-load-context', 'step-02-discover-tests', 'step-03-map-criteria']
lastStep: 'step-03-map-criteria'
lastSaved: '2026-05-22'
mode: 'create'
scope: 'Epic 11 — P2 Nightly Coverage (per-story rollup; updated as stories land)'
sources:
  - '_bmad-output/test-artifacts/test-design-epic-11.md'
  - '_bmad-output/brainstorming/brainstorming-session-2026-05-17-001.md'
  - '_bmad-output/planning-artifacts/epics.md'
artifacts:
  vitest_test_files_added_this_epic: 1   # +1 with story 11.1
  playwright_spec_files_added_this_epic: 0
  brainstorming_p2_scenarios: 87
stories_landed: ['11.1']
stories_pending: ['11.2', '11.3', '11.4', '11.5', '11.6', '11.7']
gate_decision: 'IN-PROGRESS (1/7 stories landed)'
---

# Requirements Traceability — Epic 11 (P2 Nightly Coverage)

**Date:** 2026-05-22
**Author:** Grochonnou
**Status:** Draft — rolling per-story update

---

## 1. Executive Summary

Epic 11 traces ~87 P2 scenarios from `brainstorming-session-2026-05-17-001` (P2 subset) to concrete test IDs in `test-design-epic-11.md`, then to spec files on disk. This report is updated each time a story lands.

| Story | Plan | Implemented | Pass-on-CI | Lib finding |
|---|---:|---:|---:|---|
| **11.1** Compression & pipeline error paths | 6 tests | **6 ✅** | **6 ✅** | Yes — `compress.ts` wraps sync throws into stream-error path |
| **11.2** Layers/logger/cleanup | 18 tests | 0 | 0 | — |
| **11.3** Resume + reconcile edges | 6 tests | 0 | 0 | — |
| **11.4** Persona journeys | 7 tests | 0 | 0 | — |
| **11.5** Chaos cluster | 13 tests | 0 | 0 | — |
| **11.6** Stream/chunking/dual-mode | 28 tests | 0 | 0 | — |
| **11.7** Cross-browser + DIST + DOC | 11 tests | 0 | 0 | — |
| **TOTAL** | 89 (87 + 2 dup) | 6 (7%) | 6 | 1 lib finding so far |

---

## 2. Forward Matrix — Story 11.1 Test IDs → Status

### 2.1 — Story 11.1 (R-P2-5 HIGH, 6 tests)

| Test ID | Brainstorming origin | Spec path | Status | Notes |
|---|---|---|---|---|
| **11.1-INT-001** | F#17 — Compression sync throw → `PartUploadError` (no DEFECT) | `packages/tranquilload-core/src/pipeline/compress-error-paths.test.ts:65` | ✅ GREEN | Required lib fix in `compress.ts` (see §4 below) |
| **11.1-INT-002** | F#18 — Effect-typed pipeline + `CompressionServiceLive` round-trips | `packages/tranquilload-core/src/pipeline/compress-error-paths.test.ts:87` | ✅ GREEN | Round-trips via DecompressionStream |
| **11.1-INT-003** | F#20 — Absent `globalThis.CompressionStream` → typed error | `packages/tranquilload-core/src/pipeline/compress-error-paths.test.ts:121` | ✅ GREEN | `vi.stubGlobal('CompressionStream', undefined)` |
| **11.1-INT-004** | F#71 — `CompressionService` sync throw normalizes | `packages/tranquilload-core/src/pipeline/compress-error-paths.test.ts:159` | ✅ GREEN | Parametrized w/ INT-005 |
| **11.1-INT-005** | F#72 — `CompressionService` async rejection normalizes | `packages/tranquilload-core/src/pipeline/compress-error-paths.test.ts:159` | ✅ GREEN | Erroring `ReadableStream.pull` → chunkStream picks up |
| **11.1-INT-006** | F#73 — Worker-context polyfilled-undefined `CompressionStream` | `packages/tranquilload-core/src/pipeline/compress-error-paths.test.ts:206` | ✅ GREEN | Parity with INT-003; explicit `= undefined` vs missing |

**Story 11.1 coverage: 6/6 = 100% ✅.** Full triptyque (build + vitest + typecheck) green; full repo vitest sweep at 195 tests passing.

---

## 3. Reverse Matrix — P2 Brainstorming Scenarios → Test ID(s)

### 3.1 — R-P2-5 Compression error paths (F#17, F#18, F#20, F#71–F#73)

| Scenario | Covered by (live) | Planned (gap) |
|---|---|---|
| **F#17** Compression sync throw → `PartUploadError` | `compress-error-paths.test.ts` **11.1-INT-001** ✅ + `pipeline/compress.test.ts:51` (unit-level F#20/F#73) | — |
| **F#18** Effect-typed pipeline with Live | `compress-error-paths.test.ts` **11.1-INT-002** ✅ + `pipeline/compress.test.ts:29` (F#16 compression-actually-compresses) | — |
| **F#20** Absent `CompressionStream` global (integration) | `compress-error-paths.test.ts` **11.1-INT-003** ✅ + `pipeline/compress.test.ts:51` (unit-level) | — |
| **F#71** `CompressionService` sync throw | `compress-error-paths.test.ts` **11.1-INT-004** ✅ | — |
| **F#72** `CompressionService` async rejection | `compress-error-paths.test.ts` **11.1-INT-005** ✅ | — |
| **F#73** Worker-context polyfilled-undefined | `compress-error-paths.test.ts` **11.1-INT-006** ✅ + `pipeline/compress.test.ts:51` (unit-level shared with F#20) | — |

### 3.2 — R-P2-1 / R-P2-2 / R-P2-3 / R-P2-4 / R-P2-6+ — NOT YET COVERED

All other HIGH/MEDIUM/LOW P2 risks remain pending Stories 11.2 → 11.7. See `test-design-epic-11.md` § Coverage Matrix for the full scope.

---

## 4. Real Lib Findings (Epic 11)

This section is updated each time a story surfaces a library bug fixed inline (precedent: Story 10.1 `safeLog`).

### Finding #1 — Compression sync-throw → fiber DEFECT (Story 11.1)

- **Surfaced by:** 11.1-INT-001 (F#17) + 11.1-INT-004 (F#71) — RED before fix.
- **Symptom:** A user-injected `CompressionService` whose `compress()` throws synchronously caused an unguarded throw in `Effect.map(CompressionService, svc => stream => svc.compress(stream, alg))`. Inside an `Effect.gen`, that becomes a fiber DEFECT (unrecoverable), not a typed `UploadError`.
- **Fix:** `packages/tranquilload-core/src/pipeline/compress.ts` — wrap `svc.compress(stream, algorithm)` in a `try/catch`; on sync throw, return a `ReadableStream` that errors lazily on read. The error then flows through `chunkStream`'s `Stream.fromReadableStream` and `Stream.mapError` → `PartUploadError(0, 0, cause)`. Mirrors the `safeLog` boundary precedent (Story 10.1-INT-013, F#66).
- **Locked in by:** 11.1-INT-001 + 11.1-INT-004 — both assert `Cause.dieOption(exit.cause)._tag === "None"` to refuse defects, plus `_tag === "PartUploadError"`.
- **Out-of-scope (deliberately):** the public `uploadMultipart` path where a user passes a raw `Transform` function directly (`options.pipeline: Transform`) — that function is user-owned arbitrary code; the lib's contract only covers the `compress()` helper. If a future story needs that contract too, add an `Effect.try` around `options.pipeline(options.stream)` in the public dual-API entry point.

---

## 5. Gate Decision

**Status:** IN-PROGRESS (1/7 stories landed)
**Sub-gate for Story 11.1:** ✅ PASS — 6/6 tests green, real lib finding shipped, triptyque green.

Epic-level gate decision deferred until all 7 stories land. Per `test-design-epic-11.md` § Quality Gate Criteria:
- All 5 HIGH (Score=6) clusters covered? Story 11.1 covers R-P2-5; R-P2-1/2/3/4 still pending.
- ≥95% pass rate per story? Story 11.1 = 100% ✅.
- No P1 regression? Full repo sweep green (195 tests). ✅
- R-P2-4 (`simpleHttpUpload` duplex) status? Deferred to Story 11.7 (D1 in `epics.md`).
- R-P2-11 (`CircuitOpenError`) status? Waived pending Epic 13 (D2 in `epics.md`).

---

## 6. Next Update

After Story 11.2 (Layers/logger/cleanup) lands, update §1 totals, append §2.2 with 11.2-INT-001 → 11.2-INT-017 + 11.2-E2E-001, and append §4 with any new lib finding.
