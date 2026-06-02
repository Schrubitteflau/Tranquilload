---
stepsCompleted: ['step-01-load-context', 'step-02-discover-tests', 'step-03-map-criteria']
lastStep: 'step-03-map-criteria'
lastSaved: '2026-05-23'
mode: 'create'
scope: 'Epic 11 — P2 Nightly Coverage (per-story rollup; updated as stories land)'
sources:
  - '_bmad-output/test-artifacts/test-design-epic-11.md'
  - '_bmad-output/brainstorming/brainstorming-session-2026-05-17-001.md'
  - '_bmad-output/planning-artifacts/epics.md'
artifacts:
  vitest_test_files_added_this_epic: 11   # +1 with 11.1; +4 with 11.6; +5 with 11.2 (cleanup, layers-composition, compression-service-edges, termination-edges, testclock-schedule) + extensions to logger-service-integration; +1 with 11.3 (resume-error-edges)
  playwright_spec_files_added_this_epic: 1 # +1 with 11.2 (cleanup-heap-stability)
  brainstorming_p2_scenarios: 87
stories_landed: ['11.1', '11.2', '11.3', '11.6']
stories_pending: ['11.4', '11.5', '11.7']
gate_decision: 'IN-PROGRESS (4/7 stories landed)'
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
| **11.2** Layers/logger/cleanup | 18 tests | **18 ✅** (17 VT + 1 PW-Lib) | **18 ✅** | None — all 5 R-P2-2 HIGH-cluster tests passed against current lib on first run (ATDD red phase). 13 LOCK tests added on top. → **done** |
| **11.3** Resume + reconcile edges | 6 tests | **6 ✅** | **6 ✅** | None — pure surface-area locks; all 6 phase-accurate mapping IDs passed on first run, no lib change. 3 Epic 13 candidates surfaced inline. → **done** |
| **11.4** Persona journeys | 7 tests | 0 | 0 | — |
| **11.5** Chaos cluster | 13 tests | 0 | 0 | — |
| **11.6** Stream/chunking/dual-mode | 28 tests | **29 ✅** (28 IDs; 11.6-INT-018 split into clean + remainder lock) | **29 ✅** (post-review) | None — pure surface-area locks; all 28 IDs covered with no lib change. Codex review: 0H/4M/1L, all 5 fixed inline (test-design rigor only). → **done** |
| **11.7** Cross-browser + DIST + DOC | 11 tests (1 DEFERRED) | **10 ✅** (+1 DEFERRED to Epic 12) | **10 ✅** (D-001 MinIO leg skips; E2E-001 deferred) | None — surface-area/contract locks only. 3 Epic 13 candidates surfaced (simpleHttpUpload HTTP/1.1 transmission, >1024-char key pre-flight guard, request-stream fallback). → **review** |
| **TOTAL** | 89 (87 + 2 dup) | 69 (78%) | 69 | 1 lib finding so far |

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

### 2.2 — Story 11.2 (R-P2-2 HIGH + R-P2-8 MEDIUM, 18 tests)

| Test ID | Brainstorming origin | Spec path | Status | Notes |
|---|---|---|---|---|
| **11.2-INT-001** | F#65 — Recording-logger captures exact log-line sequence | `packages/tranquilload-core/src/services/logger-service-integration.test.ts:174` | ✅ GREEN | Extends Story 10.1 file; locks 3-part lifecycle order + level |
| **11.2-INT-002** | F#67 — Slow async logger does not scale upload latency | `packages/tranquilload-core/src/services/logger-service-integration.test.ts:202` | ✅ GREEN | Plain `it` (real Clock); `safeLog` fire-and-forget contract |
| **11.2-INT-003** | F#68 — Default `CompressionServiceLive` resolves on Node 22+ | `packages/tranquilload-core/src/services/compression-service-edges.test.ts:51` | ✅ GREEN | Node-side; browser-side covered by 10.4-E2E-005 (PW-Lib) |
| **11.2-INT-004** | F#69 — No-op CompressionService → size invariant | `packages/tranquilload-core/src/services/compression-service-edges.test.ts:74` | ✅ GREEN | Proves injection overrides default |
| **11.2-INT-005** | F#70 — Malformed CompressionService → corrupt object (trust boundary) | `packages/tranquilload-core/src/services/compression-service-edges.test.ts:115` | ✅ GREEN | Codifies no-checksum contract; Epic 13 candidate: optional ingest checksum |
| **11.2-INT-006** | F#75 — Custom `[upload:${id}]` prefix on every log line | `packages/tranquilload-core/src/services/logger-service-integration.test.ts:251` | ✅ GREEN | Public LoggerService injection point sufficient for per-upload tagging |
| **11.2-INT-007** | F#76 — `Layer.empty` → defect carries missing-service info | `packages/tranquilload-core/src/services/layers-composition.test.ts:42` | ✅ GREEN | Surgical defect-refusal inverted (we EXPECT a defect here) |
| **11.2-INT-008** | F#78 — `Schedule.exponential` via TestClock canonical pattern | `packages/tranquilload-core/src/multipart/testclock-schedule.test.ts:36` | ✅ GREEN | Canonical `it.effect` + `Effect.fork` + `TestClock.adjust` reference |
| **11.2-INT-009** | F#79 — `Layer.merge(Default, Override)` last-writer-wins | `packages/tranquilload-core/src/services/layers-composition.test.ts:90` | ✅ GREEN | `Layer.merge` is the right composition primitive (NOT pipe of provideLayer — that's first-writer-wins) |
| **11.2-INT-010** | F#80 — User Layer.scoped finalizer exactly-once across success/error/abort | `packages/tranquilload-core/src/multipart/cleanup.test.ts:50` | ✅ GREEN | ATDD red phase; gated callback for abort path |
| **11.2-INT-011** | F#81 — Concurrent uploads sharing one `Effect.provide` build the Layer once | `packages/tranquilload-core/src/services/layers-composition.test.ts:136` | ✅ GREEN | `Effect.suspend` per branch to give each upload its own ReadableStream |
| **11.2-INT-012** | F#83 — Source `ReadableStream.cancel` invoked on terminal uploadPart error | `packages/tranquilload-core/src/multipart/cleanup.test.ts:138` | ✅ GREEN | ATDD red phase; surgical defect-refusal |
| **11.2-INT-013** | F#85 — Pipeline mid-stream error cancels upstream source via `pipeThrough` | `packages/tranquilload-core/src/multipart/cleanup.test.ts:191` | ✅ GREEN | ATDD red phase; manual erroring TransformStream |
| **11.2-INT-014** | F#86 — TCP RST mid-PUT → `PartUploadError`, no hang | `packages/tranquilload-core/src/multipart/termination-edges.test.ts:42` | ✅ GREEN | Loopback `node:net` server that destroys connection; wall-clock < 5s |
| **11.2-INT-015** | F#87 — Tab-close approximation: orphan multipart (current behaviour) | `packages/tranquilload-core/src/multipart/termination-edges.test.ts:97` | ✅ GREEN | Epic 13 candidate: auto-abort orphan on unhandled close |
| **11.2-INT-016** | F#88 — Semaphore permit released on terminal error | `packages/tranquilload-core/src/multipart/cleanup.test.ts:264` | ✅ GREEN | ATDD red phase; wall-clock-settlement + `running===0` lock |
| **11.2-INT-017** | F#90 (cleanup lens) — Unread events stream closes cleanly | `packages/tranquilload-core/src/multipart/cleanup.test.ts:374` | ✅ GREEN | Pairs with 11.6-INT-027 (latency lens); no dangling controller |
| **11.2-E2E-001** | F#84 — 100 sequential uploads → flat heap on Chromium | `tests/e2e/lib/cleanup-heap-stability.spec.ts:35` | ✅ GREEN | ATDD red phase; bench harness at `examples/test-app/bench.{html,ts}` exposes `window.__tlBench__`; ≤ 1.5× heap ratio |

**Story 11.2 coverage: 18/18 = 100% ✅.** ATDD red phase exercised the 5 R-P2-2 HIGH-cluster tests (INT-010/012/013/016/E2E-001) before dev — **all 5 PASSED on first run against the current lib**, confirming the cleanup/resource-safety contract is already met. Same outcome shape as Story 11.6: no lib change, pure surface-area locks. Triptyque (build + vitest 197 core + 44 adapters + PW-Lib heap + typecheck) green. Two reusable patterns flagged inline: (1) `@effect/vitest` `it.effect` injects TestClock → tests with wall-clock `setTimeout` synchronization must use plain vitest `it` + `Effect.runPromise`; (2) `Layer.merge(Default, Override)` is the last-writer-wins primitive — chained `provideLayer` is first-writer-wins. Story → **done** (pending code-review).

### 2.3 — Story 11.3 (R-P2-6 MEDIUM, 6 tests)

| Test ID | Brainstorming origin | Spec path | Status | Notes |
|---|---|---|---|---|
| **11.3-INT-001** | F#5 — `PresignedUrlError` inside `uploadPart` wraps as `PartUploadError.cause`, retried uniformly | `packages/tranquilload-core/src/multipart/resume-error-edges.test.ts:41` | ✅ GREEN | Two-pronged: single-attempt → `PartUploadError.cause`; multi-attempt → 3 calls (no fail-fast) → `MaxRetriesExceededError.cause`. Codifies the design-gap; Epic 13 candidate: opt-in fail-fast on PresignedUrlError |
| **11.3-INT-002** | F#7 — 500 on `/parts` reconcile → `ReconcileError` before any PUT | `packages/tranquilload-core/src/multipart/resume-error-edges.test.ts:83` | ✅ GREEN | Adds call-counter (0 PUTs) over existing variant-only assertion |
| **11.3-INT-003** | F#12 — resume against deleted uploadId (S3 `NoSuchUpload`) | `packages/tranquilload-core/src/multipart/resume-error-edges.test.ts:111` | ✅ GREEN | Phase-accurate `ReconcileError`, S3-shaped cause preserved; locks no auto-reinit (Epic 13 candidate) |
| **11.3-INT-004** | F#13 — presigned URL expiry recovered via re-sign-per-attempt | `packages/tranquilload-core/src/multipart/resume-error-edges.test.ts:142` | ✅ GREEN | Effect-channel recovery path; complements Story 10.3-E2E-002 (real MinIO). Asserts UploadCompleted + 2 signs |
| **11.3-INT-005** | F#14 — stale reconciled part (GC'd) → `InvalidPart` at complete | `packages/tranquilload-core/src/multipart/resume-error-edges.test.ts:181` | ✅ GREEN | Divergence invisible mid-flight; surfaces as `CompleteUploadError`. Epic 13 candidate: detect/re-upload GC'd reconciled part |
| **11.3-INT-006** | F#15 — 0-parts reconcile == fresh start | `packages/tranquilload-core/src/multipart/resume-error-edges.test.ts:212` | ✅ GREEN | Equivalence proof: empty-reconcile vs no-reconcile produce identical PUT set; explicit `ceil(50/10)=5`. Cross-ref Story 7.2 |

**Story 11.3 coverage: 6/6 = 100% ✅.** All 6 are vitest-integration LOCKs of the phase-accurate `UploadError` mapping (reconcile→`ReconcileError`, uploadPart→`PartUploadError`/`MaxRetriesExceededError`, complete→`CompleteUploadError`). R-P2-6 is MEDIUM — all 6 passed on first run against the current lib; no lib change. Triptyque (build + vitest 204 core + 44 adapters + typecheck) green. **Independent Opus code-review (2026-06-02): ✅ Approve, 0 HIGH / 0 MEDIUM / 2 LOW** (both informational — reviewer explicitly advised against reworking them; no change applied). 3 Epic 13 candidates surfaced inline (don't re-flag): opt-in fail-fast on `PresignedUrlError` (INT-001), auto-reinit on stale uploadId (INT-003), detect/re-upload GC'd reconciled part (INT-005). Status → **done**.

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

**Story 11.6 coverage: 29/28 = 100%+ ✅ (clean + remainder split on 11.6-INT-018).** Triptyque (build + vitest 224 tests + typecheck) green pre- AND post-code-review. No lib fix surfaced — all 28 IDs are pure surface-area locks. **Codex code-review (2026-05-23): 0 HIGH / 4 MEDIUM / 1 LOW; all 5 addressed inline** (test-design rigor only — M1/M2 reworked to use gated callbacks for genuine timing boundaries; M3 reframed as URL-independence since Node `Blob.stream` is single-chunk regardless of size; M4 switched INT-023+INT-024 to surgical defect-refusal pattern using `Effect.runPromiseExit` + `Cause.dieOption`/`Cause.defects`; L1 tightened F#61 scope-note wording). Status → **done**.

### 2.7 — Story 11.7 (R-P2-4 HIGH + R-P2-11/12/14 LOW, 11 tests incl. 1 DEFERRED)

| Test ID | Brainstorming origin | Spec path | Status | Notes |
|---|---|---|---|---|
| **11.7-E2E-001** | F#10 — `CircuitOpenError` after 5 consecutive part failures in 10s | `tests/e2e/lib/circuit-open.spec.ts:20` (`test.fixme`) | ⏸️ DEFERRED (Epic 12) | Decision D2 — circuit-breaker not wired into the test-app path; `test.fixme` placeholder keeps the ID alive in traceability. No effort consumed in Epic 11. |
| **11.7-E2E-002** | F#40 / G#2 — `simpleHttpUpload` `ReadableStream` body across engines | `tests/e2e/lib/simple-http-upload-cross-browser.spec.ts:94,103,113,121` | ✅ GREEN (4 sub-tests) | Codifies R-P2-4 / Decision D1. **Empirical finding:** stream-body `Request` CONSTRUCTION succeeds in all 3 engines (the historical construction gap has closed); the remaining gap is TRANSMISSION over HTTP/1.1 (request streams need HTTP/2) — Firefox/WebKit don't both transmit. Epic 13 candidate: flip the transmission matrix when the fix ships. |
| **11.7-E2E-003** | G#3 — `CompressionStream("deflate-raw")` support per browser | `tests/e2e/lib/deflate-raw-support-matrix.spec.ts:76` | ✅ GREEN | Locks the 3-engine matrix (all support `deflate-raw` today) + drives bytes through. README support-matrix section added (ADDITION only). Complements 10.4-E2E-005. |
| **11.7-X-001** | G#13 — Tree-shake proof (oneshot-only excludes multipart code) | `tests/integration/dist/tree-shake.test.ts:69,86,98,120` | ✅ GREEN (4 sub-tests) | Bundler-free: follows the emitted `oneshot.mjs` chunk-import closure; asserts zero multipart-only identifiers + effect-not-inlined (peer-dep contract) + closure < 80% of multipart closure. |
| **11.7-X-002** | G#15 — No `node:*` in browser bundle outside `fromNodeReadable` | `tests/integration/dist/no-node-imports.test.ts:81,96,114` | ✅ GREEN (3 sub-tests) | Case (a) 11 browser-safe entries → 0 `node:*`; case (b) `from-node-readable` closure confines `node:stream`; global invariant: `from-node-readable.mjs` is the ONLY node importer. |
| **11.7-INT-001** | G#17 — Special-char filenames (`# ? % + space café 🚀 RTL`) | `packages/tranquilload-adapters/src/protocols/s3-multipart-upload-filename-edges.test.ts:40,87` | ✅ GREEN (9 sub-tests) | Raw key reaches `createMultipartUpload` unchanged; presigner URL-encodes into the PUT URL; round-trip `decodeURIComponent` resolves the same name. Mocked S3 — no MinIO. |
| **11.7-INT-002** | G#19 — Filename > 1024 chars (S3 key limit) | `packages/tranquilload-adapters/src/protocols/s3-multipart-upload-filename-edges.test.ts:99` | ✅ GREEN (2 sub-tests) | **CURRENT-BEHAVIOUR lock + Epic 13 candidate:** the adapter does NOT pre-validate key length — it forwards the 1025-char key to `createMultipartUpload` and surfaces only S3's rejection (NOT mapped to `InitiateUploadError` inside the adapter; that mapping lives in core `uploadMultipart`). Epic 13: add a pre-flight `InitiateUploadError` guard. |
| **11.7-D-001** | G#25 — Resume example compiles + runs against MinIO | `tests/integration/docs/resume-example.test.ts:63` | ✅ GREEN (compile) / ⏭️ SKIP (MinIO run) | Compile-only assertion always runs (README resume block type-checks against `.d.mts`). The end-to-end MinIO run gracefully skips when MinIO is unreachable (it is, on this host) — `pnpm minio:up` (sudo) enables it; `MINIO_REQUIRED=1` makes it hard-fail. |
| **11.7-D-002** | G#27 — Compression example compiles + runs (size assertion) | `tests/integration/docs/compression-example.test.ts:41` | ✅ GREEN | README compression block compiles; `compress("deflate-raw")` resolved via published `CompressionServiceLive` shrinks 64 KiB of zeros to < 10% (proves real compression). Harness runs from the DIST fixture dir so bare `effect`/`@tranquilload/*` resolve as a downstream consumer's. |
| **11.7-D-003** | G#29 — Test-app README reproducibility (CI-runnable) | `tests/integration/docs/test-app-readme.test.ts:41,50,77,90` | ✅ GREEN (4 sub-tests) | Static/dry-run: every `pnpm <script>` in the test-app README maps to a real root/app script; setup commands present; `minio:up` compose file exists; core+adapters build scripts exist. |

**Story 11.7 coverage: 10/10 implemented GREEN + 1 DEFERRED tracked = 11/11 IDs.** 10 IDs are GREEN (E2E-002, E2E-003, X-001, X-002, INT-001, INT-002, D-001 compile, D-002, D-003); 11.7-E2E-001 is DEFERRED to Epic 12 (`test.fixme` placeholder, no effort consumed). 11.7-D-001's MinIO end-to-end leg gracefully skips (MinIO down on this host) — compile-only leg is GREEN. **No lib fix surfaced** — all locks are surface-area/contract codifications. Triptyque green: `pnpm turbo build` + (core 204 + adapters 55 + integration 23 + PW-Lib 5 green / 1 skip) + `pnpm turbo typecheck` 5/5. **3 Epic 13 candidates surfaced inline:** (1) `simpleHttpUpload` cross-browser streaming TRANSMISSION over HTTP/1.1 (E2E-002, R-P2-4 / Decision D1); (2) pre-flight `InitiateUploadError` guard for >1024-char keys (INT-002, R-P2-14); (3) per-engine buffered fallback / HTTP/2 negotiation for request streams (E2E-002). Status → **review** (pending independent code-review).

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

### 3.3 — R-P2-2 / R-P2-8 — STORY 11.2 COVERAGE

| Scenario | Covered by (live) | Planned (gap) |
|---|---|---|
| **F#65** Recording-logger lifecycle sequence | `services/logger-service-integration.test.ts` **11.2-INT-001** ✅ | — |
| **F#67** Slow async logger does not scale latency | `services/logger-service-integration.test.ts` **11.2-INT-002** ✅ | — |
| **F#68** Default `CompressionServiceLive` works in browser + Node | `services/compression-service-edges.test.ts` **11.2-INT-003** ✅ (Node side) + `tests/e2e/lib/deflate-raw.spec.ts` **10.4-E2E-005** ✅ (browser side, 3 engines) | Vitest browser-mode harness deferred (Epic 13) — Node + 3-engine PW-Lib together honestly discharge the axis |
| **F#69** No-op CompressionService → size invariant | `services/compression-service-edges.test.ts` **11.2-INT-004** ✅ | — |
| **F#70** Malformed CompressionService → corrupt object (trust boundary) | `services/compression-service-edges.test.ts` **11.2-INT-005** ✅ | Epic 13 candidate: optional ingest-checksum to surface compressor bugs |
| **F#75** Custom `[upload:${id}]` prefix on every log line | `services/logger-service-integration.test.ts` **11.2-INT-006** ✅ | — |
| **F#76** `Layer.empty` → typed defect | `services/layers-composition.test.ts` **11.2-INT-007** ✅ | — |
| **F#78** TestClock + `Schedule.exponential` canonical pattern | `multipart/testclock-schedule.test.ts` **11.2-INT-008** ✅ | — |
| **F#79** Layer last-writer-wins via `Layer.merge` | `services/layers-composition.test.ts` **11.2-INT-009** ✅ | — |
| **F#80** Layer.scoped finalizer exactly-once across success/error/abort | `multipart/cleanup.test.ts` **11.2-INT-010** ✅ | — |
| **F#81** Concurrent uploads share Layer instance (no double-init) | `services/layers-composition.test.ts` **11.2-INT-011** ✅ | — |
| **F#83** Source ReadableStream released on error | `multipart/cleanup.test.ts` **11.2-INT-012** ✅ | — |
| **F#84** 100 sequential uploads → flat heap (Chromium) | `tests/e2e/lib/cleanup-heap-stability.spec.ts` **11.2-E2E-001** ✅ | Firefox/WebKit deferred (no `performance.memory` equivalent) |
| **F#85** Pipeline error cancels upstream source | `multipart/cleanup.test.ts` **11.2-INT-013** ✅ | — |
| **F#86** TCP RST mid-PUT → `PartUploadError`, no hang | `multipart/termination-edges.test.ts` **11.2-INT-014** ✅ | Real S3 / MinIO RST coverage belongs to 11.5 chaos cluster |
| **F#87** Tab-close → orphan multipart (current behaviour) | `multipart/termination-edges.test.ts` **11.2-INT-015** ✅ | Epic 13 candidate: auto-abort on unhandled tab close (will flip this lock) |
| **F#88** Semaphore permit released on terminal error | `multipart/cleanup.test.ts` **11.2-INT-016** ✅ | — |
| **F#90** Events cleanup lens (unread closes cleanly) | `multipart/cleanup.test.ts` **11.2-INT-017** ✅ | Pairs with 11.6-INT-027 latency lens |

**Story 11.2 coverage: 18/18 = 100% ✅** — all 18 IDs covered. ATDD red phase proved R-P2-2 HIGH-cluster contract already met (no lib fix).

### 3.5 — R-P2-6 — STORY 11.3 COVERAGE

| Brainstorming F# | Test ID(s) | Notes |
|---|---|---|
| **F#5** PresignedUrlError in uploadPart → `PartUploadError.cause`, retried uniformly | `multipart/resume-error-edges.test.ts` **11.3-INT-001** ✅ | Design-gap lock; Epic 13 candidate: opt-in fail-fast |
| **F#7** 500 on `/parts` reconcile → `ReconcileError` before any PUT | `multipart/resume-error-edges.test.ts` **11.3-INT-002** ✅ | Call-counter proves 0 PUTs |
| **F#12** resume against deleted uploadId (`NoSuchUpload`) | `multipart/resume-error-edges.test.ts` **11.3-INT-003** ✅ | Phase-accurate `ReconcileError`; Epic 13 candidate: auto-reinit |
| **F#13** presigned URL expiry recovered via re-sign-per-attempt | `multipart/resume-error-edges.test.ts` **11.3-INT-004** ✅ | Complements 10.3-E2E-002 (real MinIO) |
| **F#14** stale reconciled part (GC'd) → `InvalidPart` at complete | `multipart/resume-error-edges.test.ts` **11.3-INT-005** ✅ | `CompleteUploadError`; Epic 13 candidate: detect/re-upload |
| **F#15** 0-parts reconcile == fresh start | `multipart/resume-error-edges.test.ts` **11.3-INT-006** ✅ | Empty-vs-no-reconcile equivalence proof |

**Story 11.3 coverage: 6/6 = 100% ✅** — all 6 phase-accurate mapping IDs covered. All passed on first run against the current lib (no lib fix). 3 Epic 13 candidates surfaced inline.

### 3.6 — R-P2-4 / R-P2-11 / R-P2-12 / R-P2-14 — STORY 11.7 COVERAGE

| Scenario | Risk | Test ID(s) | Status |
|---|---|---|---|
| F#40 / G#2 — `simpleHttpUpload` cross-browser streaming body | R-P2-4 (BUS, HIGH) | 11.7-E2E-002 (×4) | ✅ GREEN — codifies transmission gap (construction gap closed) |
| F#10 — `CircuitOpenError` (5 failures / 10s) | R-P2-11 (TECH, LOW) | 11.7-E2E-001 | ⏸️ DEFERRED to Epic 12 (`test.fixme`) |
| G#3 — `deflate-raw` per-browser support | R-P2-12 (OPS, LOW) | 11.7-E2E-003 | ✅ GREEN — 3-engine matrix + README addition |
| G#13 — Tree-shake (oneshot excludes multipart) | R-P2-14 (OPS, LOW) | 11.7-X-001 (×4) | ✅ GREEN |
| G#15 — No `node:*` in browser bundle | R-P2-14 | 11.7-X-002 (×3) | ✅ GREEN |
| G#17 — Special-char filenames | R-P2-14 | 11.7-INT-001 (×9) | ✅ GREEN |
| G#19 — >1024-char filename | R-P2-14 | 11.7-INT-002 (×2) | ✅ GREEN (current-behaviour lock; Epic 13 pre-flight guard candidate) |
| G#25 — Resume example doctest | R-P2-14 | 11.7-D-001 | ✅ GREEN (compile) / ⏭️ SKIP (MinIO run) |
| G#27 — Compression example doctest (size) | R-P2-14 | 11.7-D-002 | ✅ GREEN |
| G#29 — Test-app README reproducibility | R-P2-14 | 11.7-D-003 (×4) | ✅ GREEN |

**Story 11.7 coverage: 10/10 GREEN + 1 DEFERRED tracked = 11/11 IDs.** No lib fix. 3 Epic 13 candidates surfaced (simpleHttpUpload HTTP/1.1 transmission, >1024-char key pre-flight guard, request-stream per-engine fallback).

### 3.4 — R-P2-1 / R-P2-3 — NOT YET COVERED

Remaining HIGH/MEDIUM/LOW P2 risks pending Stories 11.4 / 11.5. See `test-design-epic-11.md` § Coverage Matrix for the full scope.

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

**Status:** IN-PROGRESS (4/7 stories landed `done`; 11.7 in `review`)
**Sub-gate for Story 11.1:** ✅ PASS — 6/6 tests green, real lib finding shipped, triptyque green, code-review approved (L1+L2 fixed inline, L3+L4 informational), status `done`.
**Sub-gate for Story 11.2:** ✅ PASS — 18/18 tests green (17 VT + 1 PW-Lib), ATDD red phase proved R-P2-2 HIGH contract already met (5/5 green on first run), triptyque green (build + 197 core + 44 adapters + 1 PW-Lib heap + typecheck), no lib fix needed, status `done` (pending code-review).
**Sub-gate for Story 11.6:** ✅ PASS — 29/28 tests green, triptyque green pre- AND post-Codex-review (build + 224 tests + typecheck), no lib fix needed, code-review 0H/4M/1L with all 5 addressed inline, status `done`.
**Sub-gate for Story 11.3:** ✅ PASS — 6/6 tests green, triptyque green (build + 204 core + 44 adapters + typecheck), R-P2-6 MEDIUM phase-accurate mapping locks all passed first run, no lib fix needed, 3 Epic 13 candidates surfaced inline, independent Opus code-review Approve 0H/0M/2L (informational, no change), status `done`.
**Sub-gate for Story 11.7:** ✅ PASS (pending independent code-review) — 10/10 implemented GREEN (+1 DEFERRED to Epic 12), triptyque green (build + core 204 + adapters 55 + integration 23 + PW-Lib 5 green/1 skip + typecheck 5/5), no lib fix needed. R-P2-4 cross-browser gap codified (E2E-002 — transmission, not construction); R-P2-11 CircuitOpen deferred (E2E-001 `test.fixme`); R-P2-12 deflate-raw matrix locked + README addition; R-P2-14 DIST tree-shake/no-node + filename edges + doctest extensions all green. D-001 MinIO end-to-end leg skips (MinIO down on host); 3 Epic 13 candidates surfaced. Status → `review`.

Epic-level gate decision deferred until all 7 stories land. Per `test-design-epic-11.md` § Quality Gate Criteria:
- All 5 HIGH (Score=6) clusters covered? Story 11.1 covers R-P2-5; Story 11.2 covers R-P2-2; R-P2-1/3/4 still pending.
- ≥95% pass rate per story? 11.1 = 100% ✅; 11.2 = 100% ✅; 11.3 = 100% ✅; 11.6 = 100% ✅.
- No P1 regression? Full repo sweep green (249 tests = 204 core + 44 adapters + 1 PW-Lib heap, up from 242 after 11.3). ✅
- R-P2-4 (`simpleHttpUpload` duplex) status? ✅ Codified by Story 11.7-E2E-002 — empirically, the construction-level gap has closed in all 3 engines; the remaining gap is HTTP/1.1 TRANSMISSION (Epic 13 candidate, D1 in `epics.md`).
- R-P2-11 (`CircuitOpenError`) status? Deferred to Epic 12 via Story 11.7-E2E-001 `test.fixme` placeholder (D2 in `epics.md`).

---

## 6. Next Update

Story 11.7 landed (`review`). Remaining: 11.5 (chaos, needs MinIO + per-session chaos endpoint) and 11.4 (PW-UI personas, highest per-test cost). After each lands, append the matching §2.x + §3.x entries and bump §1 totals.
