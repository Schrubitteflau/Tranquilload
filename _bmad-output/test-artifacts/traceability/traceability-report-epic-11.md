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
  vitest_test_files_added_this_epic: 5   # +1 with 11.1; +4 with 11.6 (chunking-edges, dual-mode-edges, oneshot/edges, getprogress-edges)
  playwright_spec_files_added_this_epic: 0
  brainstorming_p2_scenarios: 87
stories_landed: ['11.1', '11.6']
stories_pending: ['11.2', '11.3', '11.4', '11.5', '11.7']
gate_decision: 'IN-PROGRESS (2/7 stories landed)'
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
| **11.1** Compression & pipeline error paths | 6 tests | **6 ✅** | **6 ✅** (post-review) | Yes — `compress.ts` wraps sync throws into stream-error path. Code review: 0H/0M/4L; L1+L2 fixed inline. → **done** |
| **11.2** Layers/logger/cleanup | 18 tests | 0 | 0 | — |
| **11.3** Resume + reconcile edges | 6 tests | 0 | 0 | — |
| **11.4** Persona journeys | 7 tests | 0 | 0 | — |
| **11.5** Chaos cluster | 13 tests | 0 | 0 | — |
| **11.6** Stream/chunking/dual-mode | 28 tests | **29 ✅** (28 IDs; 11.6-INT-018 split into clean + remainder lock) | **29 ✅** (pre-review) | None — pure surface-area locks; all 28 IDs covered with no lib change. → **review** |
| **11.7** Cross-browser + DIST + DOC | 11 tests | 0 | 0 | — |
| **TOTAL** | 89 (87 + 2 dup) | 35 (39%) | 35 | 1 lib finding so far |

---

## 2. Forward Matrix — Story Test IDs → Status

### 2.1 — Story 11.1 (R-P2-5 HIGH, 6 tests)

| Test ID | Brainstorming origin | Spec path | Status | Notes |
|---|---|---|---|---|
| **11.1-INT-001** | F#17 — Compression sync throw → `PartUploadError` (no DEFECT) | `packages/tranquilload-core/src/pipeline/compress-error-paths.test.ts:65` | ✅ GREEN | Required lib fix in `compress.ts` (see §4 below) |
| **11.1-INT-002** | F#18 — Effect-typed pipeline + `CompressionServiceLive` round-trips | `packages/tranquilload-core/src/pipeline/compress-error-paths.test.ts:87` | ✅ GREEN | Round-trips via DecompressionStream |
| **11.1-INT-003** | F#20 — Truly-absent `globalThis.CompressionStream` (property deleted, `hasOwnProperty === false`) → typed error | `packages/tranquilload-core/src/pipeline/compress-error-paths.test.ts:121` | ✅ GREEN | Post-review fix (L1): switched from `vi.stubGlobal(..., undefined)` to `delete` + setup assertion to genuinely distinguish F#20 from F#73 |
| **11.1-INT-004** | F#71 — `CompressionService` sync throw normalizes | `packages/tranquilload-core/src/pipeline/compress-error-paths.test.ts:159` | ✅ GREEN | Parametrized w/ INT-005 |
| **11.1-INT-005** | F#72 — `CompressionService` async rejection normalizes | `packages/tranquilload-core/src/pipeline/compress-error-paths.test.ts:159` | ✅ GREEN | Erroring `ReadableStream.pull` → chunkStream picks up |
| **11.1-INT-006** | F#73 — Worker-context polyfilled-undefined `CompressionStream` | `packages/tranquilload-core/src/pipeline/compress-error-paths.test.ts:206` | ✅ GREEN | Parity with INT-003; explicit `= undefined` vs missing |

**Story 11.1 coverage: 6/6 = 100% ✅. Code-review gate: PASS** (0 HIGH / 0 MEDIUM / 4 LOW; L1+L2 fixed, L3+L4 informational). Full triptyque (build + vitest + typecheck) green pre- and post-review-fix; full repo vitest sweep at 195 tests passing. Story → **done**.

### 2.6 — Story 11.6 (R-P2-7 MEDIUM + R-P2-13 LOW, 29 tests)

| Test ID | Brainstorming origin | Spec path | Status | Notes |
|---|---|---|---|---|
| **11.6-INT-001** | F#24 — Zero-byte file → completeUpload sees empty parts; user reject → `CompleteUploadError` | `packages/tranquilload-core/src/multipart/chunking-edges.test.ts:48` | ✅ GREEN | Defect-refusal lock (no fiber DEFECT) |
| **11.6-INT-002** | F#25 — Source stream errors mid-read → `PartUploadError(0, 0, cause)` | `packages/tranquilload-core/src/multipart/chunking-edges.test.ts:81` | ✅ GREEN | Mirrors compress-error-paths defect-refusal shape |
| **11.6-INT-003** | F#28 — Throttled concurrency: max-observed in-flight === maxConcurrency | `packages/tranquilload-core/src/multipart/chunking-edges.test.ts:116` | ✅ GREEN | Latch-based saturation gate; tightens F#26 lower bound |
| **11.6-INT-013** | F#42 — `chunkSize=1`: one part per byte, no crash | `packages/tranquilload-core/src/multipart/chunking-edges.test.ts:159` | ✅ GREEN | Epic 13 candidate: 10k-part-limit caller-side validation |
| **11.6-INT-014** | F#43 — `chunkSize > totalBytes`: 1 part, body length === totalBytes | `packages/tranquilload-core/src/multipart/chunking-edges.test.ts:192` | ✅ GREEN | Flush-path lock for sub-chunkSize files |
| **11.6-INT-015** | F#44 — Non-integer `chunkSize` 1024.7 (current-behaviour lock) | `packages/tranquilload-core/src/multipart/chunking-edges.test.ts:227` | ✅ GREEN | Epic 13 candidate: reject non-integer at API boundary |
| **11.6-INT-004** | F#30 — Sync `completeUpload` returning non-void value completes successfully | `packages/tranquilload-core/src/multipart/dual-mode-edges.test.ts:30` | ✅ GREEN | Locks normalizeCallback's `Effect.succeed(result)` widen path |
| **11.6-INT-005** | F#31 — Effect-typed `initiate` failure: `InitiateUploadError.cause === <original typed error>` | `packages/tranquilload-core/src/multipart/dual-mode-edges.test.ts:65` | ✅ GREEN | Boundary-preservation lock for typed-error recovery |
| **11.6-INT-010** | F#37 — One-shot abort mid-stream: result rejects with `AbortError`, events closes cleanly | `packages/tranquilload-core/src/oneshot/edges.test.ts:39` | ✅ GREEN | `Effect.raceFirst(uploadEffect, fromAbortSignal)` mid-flight |
| **11.6-INT-011** | F#38 — One-shot 4xx upload reject → `CompleteUploadError`; cause preserved | `packages/tranquilload-core/src/oneshot/edges.test.ts:78` | ✅ GREEN | `uploadOnceEffect` `mapError` non-AbortError → CompleteUploadError |
| **11.6-INT-012** | F#39 — One-shot empty stream → `UploadCompleted(totalParts: 1)` (current-behaviour lock) | `packages/tranquilload-core/src/oneshot/edges.test.ts:113` | ✅ GREEN | Epic 13 candidate: future stricter empty-stream policy |
| **11.6-INT-006** | F#33 — Cancel events reader mid-upload → upload still completes, no leak | `packages/tranquilload-core/src/progress/getprogress-edges.test.ts:31` | ✅ GREEN | Downstream consumer cancellation does not propagate |
| **11.6-INT-007** | F#34 — `getProgress()` Promise form before initiate returns 0 | `packages/tranquilload-core/src/progress/getprogress-edges.test.ts:62` | ✅ GREEN | Promise-form lock; Effect form already covered |
| **11.6-INT-008** | F#35 — `getProgress()` Promise form after completion returns final value | `packages/tranquilload-core/src/progress/getprogress-edges.test.ts:84` | ✅ GREEN | Multiple reads stable post-completion |
| **11.6-INT-009** | F#36 — `uploadId` resolves with real ID even when later part fails | `packages/tranquilload-core/src/progress/getprogress-edges.test.ts:111` | ✅ GREEN | Cross-session-resume independence contract |
| **11.6-INT-027** | F#90 — Events latency lens: not reading does NOT slow upload | `packages/tranquilload-core/src/progress/getprogress-edges.test.ts:140` | ✅ GREEN | Tolerant 5× ratio absorbs CI noise; paired with 11.2-INT-017 cleanup lens |
| **11.6-INT-028** | F#33 variant — Cancel events reader BEFORE any event arrives: no leak | `packages/tranquilload-core/src/progress/getprogress-edges.test.ts:182` | ✅ GREEN | Distinct timing from 11.6-INT-006 |
| **11.6-INT-016** | F#46 — `networkMultiplier` no samples → factor 1.0 (control) | `packages/tranquilload-adapters/src/resilience/network-multiplier.test.ts:65` | ✅ GREEN | Locks no-samples branch determinism vs option overrides |
| **11.6-INT-017** | F#47 — `networkMultiplier` 10 saturated-slow samples → 0.1 floor | `packages/tranquilload-adapters/src/resilience/network-multiplier.test.ts:84` | ✅ GREEN | Below S3 5MiB minimum; caller must clamp |
| **11.6-INT-018 (clean)** | F#50 — `computeOptimalPartSize` chunkSize round-trips into PUT body sizes | `packages/tranquilload-adapters/src/resilience/optimal-part-size.test.ts:69` | ✅ GREEN | Scaled-equivalent (1000/10/50) to avoid CI noise |
| **11.6-INT-018 (remainder)** | F#50 — Last PUT body === totalBytes % chunkSize | `packages/tranquilload-adapters/src/resilience/optimal-part-size.test.ts:107` | ✅ GREEN | Companion lock for last-part-may-be-smaller branch |
| **11.6-INT-019** | F#53 — Empty File yields totalBytes=0 and immediately-closing stream | `packages/tranquilload-adapters/src/sources/from-file.test.ts:40` | ✅ GREEN | Source-side pair to 11.6-INT-001 |
| **11.6-INT-020** | F#54 — Blob URL revoked mid-read: zero effect on fromFile stream | `packages/tranquilload-adapters/src/sources/from-file.test.ts:60` | ✅ GREEN | Locks URL-independence contract |
| **11.6-INT-021** | F#55 — PNG / UTF-8 / multi-byte content round-trips byte-identical | `packages/tranquilload-adapters/src/sources/from-file.test.ts:101` | ✅ GREEN | Parametrized across 3 content types |
| **11.6-INT-022** | F#57 — Backpressure under slow consumer: heap stays flat | `packages/tranquilload-adapters/src/sources/from-file.test.ts:148` | ✅ GREEN | 200KB / 1KB chunks; no-monotonic-growth assertion |
| **11.6-INT-023** | F#58 — ENOENT createReadStream → `PartUploadError(0, 0, ENOENT)` | `packages/tranquilload-adapters/src/sources/from-node-readable.test.ts:50` | ✅ GREEN | Full pipeline propagation lock |
| **11.6-INT-024** | F#59 — `Readable.destroy(err)` mid-stream → `PartUploadError`, no defect | `packages/tranquilload-adapters/src/sources/from-node-readable.test.ts:83` | ✅ GREEN | Mirrors F#25 at Node-source layer |
| **11.6-INT-025** | F#60 — Paused Readable auto-resumes via `Readable.toWeb` | `packages/tranquilload-adapters/src/sources/from-node-readable.test.ts:118` | ✅ GREEN | Confirms adapter does not require caller-side flow control |
| **11.6-INT-026** | F#61 — Buffer source: byteLength invariant preserved end-to-end | `packages/tranquilload-adapters/src/sources/from-node-readable.test.ts:144` | ✅ GREEN | byteLength + content invariants; avoids over-binding storage identity |

**Story 11.6 coverage: 29/28 = 100%+ ✅ (clean + remainder split on 11.6-INT-018).** Triptyque (build + vitest 224 tests + typecheck) green; no lib fix surfaced — all 28 IDs are pure surface-area locks. Status → **review**.

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

### 3.2 — R-P2-7 / R-P2-13 — STORY 11.6 COVERAGE

| Scenario | Covered by (live) | Planned (gap) |
|---|---|---|
| **F#24** Zero-byte file | `multipart/chunking-edges.test.ts` **11.6-INT-001** ✅ + `sources/from-file.test.ts` **11.6-INT-019** ✅ (source-side pair) | — |
| **F#25** Source stream errors mid-read | `multipart/chunking-edges.test.ts` **11.6-INT-002** ✅ | — |
| **F#28** Concurrency saturation | `multipart/chunking-edges.test.ts` **11.6-INT-003** ✅ | — |
| **F#30** Sync `completeUpload` non-void return | `multipart/dual-mode-edges.test.ts` **11.6-INT-004** ✅ | — |
| **F#31** Effect-typed `initiate` failure → cause preserved | `multipart/dual-mode-edges.test.ts` **11.6-INT-005** ✅ | — |
| **F#33** Cancel events reader (mid-upload + pre-event) | `progress/getprogress-edges.test.ts` **11.6-INT-006** ✅ + **11.6-INT-028** ✅ | — |
| **F#34** `getProgress()` Promise form before initiate | `progress/getprogress-edges.test.ts` **11.6-INT-007** ✅ (Effect form covered earlier by `getprogress.test.ts:129`) | — |
| **F#35** `getProgress()` Promise form after completion | `progress/getprogress-edges.test.ts` **11.6-INT-008** ✅ (Effect form + mid-upload covered earlier by `getprogress.test.ts:18`) | — |
| **F#36** `uploadId` promise resolves on later failure | `progress/getprogress-edges.test.ts` **11.6-INT-009** ✅ | — |
| **F#37** One-shot abort mid-stream | `oneshot/edges.test.ts` **11.6-INT-010** ✅ | — |
| **F#38** One-shot server 4xx → `CompleteUploadError` | `oneshot/edges.test.ts` **11.6-INT-011** ✅ | — |
| **F#39** One-shot empty stream | `oneshot/edges.test.ts` **11.6-INT-012** ✅ | — |
| **F#42** `chunkSize=1` | `multipart/chunking-edges.test.ts` **11.6-INT-013** ✅ | — |
| **F#43** `chunkSize > totalBytes` | `multipart/chunking-edges.test.ts` **11.6-INT-014** ✅ | — |
| **F#44** Non-integer `chunkSize` (current-behaviour lock) | `multipart/chunking-edges.test.ts` **11.6-INT-015** ✅ | Epic 13 candidate (reject non-integer chunkSize at API boundary) |
| **F#46** `networkMultiplier` no samples → factor 1.0 | `resilience/network-multiplier.test.ts` **11.6-INT-016** ✅ | — |
| **F#47** `networkMultiplier` saturated slow → 0.1 floor | `resilience/network-multiplier.test.ts` **11.6-INT-017** ✅ | — |
| **F#50** `computeOptimalPartSize` → PUT body round-trip | `resilience/optimal-part-size.test.ts` **11.6-INT-018** ✅ (clean) + **11.6-INT-018 (remainder)** ✅ | — |
| **F#53** Empty `File` (source pair to F#24) | `sources/from-file.test.ts` **11.6-INT-019** ✅ | — |
| **F#54** Blob URL revoked mid-read | `sources/from-file.test.ts` **11.6-INT-020** ✅ | — |
| **F#55** MIME parity (PNG / UTF-8 / multi-byte) | `sources/from-file.test.ts` **11.6-INT-021** ✅ | — |
| **F#57** Backpressure under slow consumer (heap-flat) | `sources/from-file.test.ts` **11.6-INT-022** ✅ | Pairs with PW-Lib 11.2-E2E-001 (performance.memory lens) |
| **F#58** ENOENT createReadStream → `PartUploadError` | `sources/from-node-readable.test.ts` **11.6-INT-023** ✅ | — |
| **F#59** `Readable.destroy(err)` mid-stream | `sources/from-node-readable.test.ts` **11.6-INT-024** ✅ | — |
| **F#60** Paused Readable auto-resumes via `Readable.toWeb` | `sources/from-node-readable.test.ts` **11.6-INT-025** ✅ | — |
| **F#61** Buffer source: byteLength invariant | `sources/from-node-readable.test.ts` **11.6-INT-026** ✅ | — |
| **F#90** Events latency lens (not-read = read wall-time) | `progress/getprogress-edges.test.ts` **11.6-INT-027** ✅ | Cleanup lens deferred to Story 11.2-INT-017 |

**Story 11.6 coverage: 29/28 = 100%+ ✅** (the +1 is the F#50 remainder companion lock; same scenario ID, two assertions).

### 3.3 — R-P2-1 / R-P2-2 / R-P2-3 / R-P2-4 / R-P2-6+ — NOT YET COVERED

All other HIGH/MEDIUM/LOW P2 risks remain pending Stories 11.2 / 11.3 / 11.4 / 11.5 / 11.7. See `test-design-epic-11.md` § Coverage Matrix for the full scope.

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

**Status:** IN-PROGRESS (2/7 stories landed; 11.1 `done`, 11.6 `review` pending code-review)
**Sub-gate for Story 11.1:** ✅ PASS — 6/6 tests green, real lib finding shipped, triptyque green, code-review approved (L1+L2 fixed inline, L3+L4 informational), status `done`.
**Sub-gate for Story 11.6:** ✅ PASS (pre-review) — 29/28 tests green (the +1 is the F#50 remainder companion), triptyque green (build + 224 tests + typecheck), no lib fix needed, status `review`.

Epic-level gate decision deferred until all 7 stories land. Per `test-design-epic-11.md` § Quality Gate Criteria:
- All 5 HIGH (Score=6) clusters covered? Story 11.1 covers R-P2-5; R-P2-1/2/3/4 still pending.
- ≥95% pass rate per story? 11.1 = 100% ✅; 11.6 = 100% ✅.
- No P1 regression? Full repo sweep green (224 tests, up from 195 after 11.6). ✅
- R-P2-4 (`simpleHttpUpload` duplex) status? Deferred to Story 11.7 (D1 in `epics.md`).
- R-P2-11 (`CircuitOpenError`) status? Waived pending Epic 13 (D2 in `epics.md`).

---

## 6. Next Update

After Story 11.6 code-review lands `done`, suggested next: Story 11.2 (Layers/logger/cleanup) — covers R-P2-2 (HIGH) with 17 VT + 1 PW-Lib heap test. When 11.2 lands, update §1 totals, append §2.2 with 11.2-INT-001 → 11.2-INT-017 + 11.2-E2E-001, and append §4 with any new lib finding.
