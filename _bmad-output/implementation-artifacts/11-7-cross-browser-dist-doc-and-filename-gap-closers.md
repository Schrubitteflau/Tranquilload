---
baseline_commit: 147903a309b4054a86cc1f4dd7d60ed0d390b8ae
---

# Story 11.7: Cross-Browser + DIST + DOC + Filename Gap-Closers

Status: review

## Story

As a library maintainer,
I want mixed-harness coverage for cross-browser streaming body behaviour, DIST tree-shaking + `node:*` boundary, doctest extensions, and filename edges,
so that the bundle/runtime contract holds across all 3 browsers and the README examples stay reproducible.

## Acceptance Criteria

1. **Given** F#10 / `CircuitOpenError` — circuit-breaker not yet wired in the lib (R-P2-11, per Decision D2) **When** Epic 11 nightly runs **Then** test ID 11.7-E2E-001 is recorded as **DEFER to Epic 12** with no effort consumed in Epic 11; the entry remains in the traceability matrix for tracking.

2. **Given** `simpleHttpUpload` currently lacking `duplex: 'half'` (R-P2-4, per Decision D1 — codify the gap) **When** the test runs across Chromium / Firefox / WebKit **Then** the spec documents the current cross-browser gap explicitly; the same spec validates the fix once the Epic 13 candidate ships (test ID 11.7-E2E-002).

3. **Given** `CompressionStream` `deflate-raw` algorithm support varies (older WebKit lacks the algo, R-P2-12) **When** the smoke spec runs **Then** the support matrix is documented in the README and the spec catches a regression on supported browsers (test ID 11.7-E2E-003).

4. **Given** the built bundles in `packages/*/dist/` **When** DIST validation runs (extends Epic 10's `tests/integration/dist/` harness) **Then** a oneshot-only import excludes multipart code from the final bundle (test ID 11.7-X-001 — tree-shake proof, G#13), and no `node:*` import appears in the browser bundle outside the `fromNodeReadable` boundary (test ID 11.7-X-002, G#15).

5. **Given** special-character (`#`, `?`, `%`, `+`, ` `, `café`, `🚀`, RTL) and >1024-char filenames (R-P2-14) **When** the S3 key path is built **Then** sanitization holds for special chars (test ID 11.7-INT-001 covering G#17) and the >1024-char case fails with `InitiateUploadError` (test ID 11.7-INT-002 covering G#19).

6. **Given** the README resume example, compression example, and test-app setup script **When** the doctest harness runs (extends Epic 10's `spawnSync(process.execPath, ...)` harness) **Then** each example compiles and executes end-to-end — size assertion for compression (G#27), CI-runnable for test-app README (G#29), and resume example completes against MinIO (G#25) (test IDs 11.7-D-001 → 11.7-D-003).

## Tasks / Subtasks

- [x] Task 1: File layout (AC: all)
  - [x] PW-Lib: `tests/e2e/lib/simple-http-upload-cross-browser.spec.ts` (11.7-E2E-002), `tests/e2e/lib/deflate-raw-support-matrix.spec.ts` (11.7-E2E-003)
  - [x] PW-Lib deferred placeholder: `tests/e2e/lib/circuit-open.spec.ts` with `test.fixme(...)` and a comment citing Epic 12 (11.7-E2E-001 — keeps the test ID alive in traceability)
  - [x] DIST: `tests/integration/dist/tree-shake.test.ts`, `tests/integration/dist/no-node-imports.test.ts`
  - [x] DOC: `tests/integration/docs/resume-example.test.ts`, `tests/integration/docs/compression-example.test.ts`, `tests/integration/docs/test-app-readme.test.ts`
  - [x] VT: `packages/tranquilload-adapters/src/protocols/s3-multipart-upload-filename-edges.test.ts` (new file alongside the existing s3-multipart test)

- [x] Task 2: 11.7-E2E-001 — F#10 CircuitOpen (DEFERRED) (AC: #1)
  - [x] Created `tests/e2e/lib/circuit-open.spec.ts` with a `test.fixme(...)` and the Epic 12 / Decision D2 comment
  - [x] Test ID locked in traceability (§2.7 + §3.6) — Epic 12 implementers have the exact wire-up note
  - [x] Effort: placeholder only

- [x] Task 3: 11.7-E2E-002 — `simpleHttpUpload` cross-browser (AC: #2)
  - [x] Drove the streamed-body + `duplex:'half'` path from PW-Lib (no test-app UI) across Chromium / Firefox / WebKit
  - [x] CURRENT BEHAVIOUR — **empirical finding**: stream-body `Request` CONSTRUCTION succeeds in all 3 engines (the historical construction gap has closed); the real gap is TRANSMISSION over HTTP/1.1. Reframed the spec to probe BOTH construction (locked green per engine) and transmission (locked NOT-uniformly-green) — Pattern 3 honest-scope.
  - [x] Codifies R-P2-4 / Decision D1 / Epic 13 candidate comment present; transmission matrix flips when the fix ships

- [x] Task 4: 11.7-E2E-003 — `deflate-raw` support matrix (AC: #3)
  - [x] Probes `CompressionStream("deflate-raw")` per engine + drives bytes through; locks the 3-engine matrix
  - [x] README support-matrix section ADDED (addition only)

- [x] Task 5: 11.7-X-001 — Tree-shake proof (DIST) (AC: #4)
  - [x] Bundler-free closure-walk from `dist/oneshot.mjs` (tsdown emits per-entry bundles + shared chunks) — the DIST harness is bundler-free, so this matches it instead of pulling in esbuild
  - [x] Asserts the oneshot closure excludes `uploadMultipart` / `uploadMultipartEffect` / `chunkStream` / `makeCircuitBreaker` / `CircuitBreaker`, plus effect-not-inlined (peer-dep contract) + closure < 80% of multipart closure
  - [x] `effect` is NOT bundled — peer-dep contract holds (no Epic 13 finding here)

- [x] Task 6: 11.7-X-002 — No `node:*` in browser bundle (DIST) (AC: #4)
  - [x] Closure-walk over 11 browser-safe entries (core + adapters) → 0 `node:*` (case a)
  - [x] `from-node-readable` closure confines `node:stream`; global invariant proves it's the ONLY node importer (case b)

- [x] Task 7: 11.7-INT-001 — Special-char filenames (AC: #5)
  - [x] Parameterized over `[# ? % + " " café 🚀 "نص عربي"]`; raw key reaches `createMultipartUpload`, presigner URL-encodes into the PUT URL, round-trip `decodeURIComponent` resolves the same name
  - [x] Mocked S3 client + fetch — no MinIO needed

- [x] Task 8: 11.7-INT-002 — Filename > 1024 chars (AC: #5)
  - [x] `key = "a".repeat(1025)` — **the adapter does NOT pre-validate**: locked the CURRENT behaviour (forwards to `createMultipartUpload`; surfaces only S3's rejection, NOT mapped to `InitiateUploadError` in the adapter). `// CURRENT BEHAVIOUR — Epic 13 candidate` comment present.
  - [x] Epic 13 candidate flagged in report + traceability (pre-flight `InitiateUploadError` guard)

- [x] Task 9: 11.7-D-001 — Resume example doctest (AC: #6)
  - [x] Extended the shared doctest harness (`spawnSync`) — extracted `doctest-harness.ts` to reuse Story 10.6's compile + harness pipeline
  - [x] Compile-only leg always runs (README resume block type-checks against `.d.mts`); MinIO end-to-end leg `isMinioReachable()`-gated → graceful skip with clear reason (MinIO down on host)

- [x] Task 10: 11.7-D-002 — Compression example doctest (AC: #6)
  - [x] README compression block compiles; `compress("deflate-raw")` resolved via published `CompressionServiceLive` shrinks 64 KiB → < 10% (output < input proven, with strict ratio)

- [x] Task 11: 11.7-D-003 — Test-app README reproducibility (AC: #6)
  - [x] Static/dry-run: every `pnpm <script>` in the test-app README maps to a real root/app script; setup commands present; `minio:up` compose file exists; core+adapters build scripts exist

- [x] Task 12: Verification
  - [x] vitest green: adapters 55 (11 new filename edges) + core 204 (unchanged) + integration 23 (DIST 9+7 new, DOC 7 incl. 4 new)
  - [x] `playwright test --project=lib` green: E2E-002 (×4) + E2E-003 (×1) passed, E2E-001 skipped (DEFERRED `test.fixme`)
  - [x] `pnpm turbo typecheck` green (5/5); new e2e specs type-clean (pre-existing e2e/ui `@support/*` errors are outside the typecheck gate)

- [x] Task 13: Traceability update
  - [x] Appended §2.7 forward-matrix (all 11 IDs) + §3.6 reverse-matrix + bumped §1 totals (59 → 69) + §5 sub-gate + §6 next-update

## Dev Notes

### Spec inputs

- Source spec: `_bmad-output/test-artifacts/test-design-epic-11.md` § "Story 11.7 — Cross-browser + DIST + DOC + filename gap-closers"
- Risk clusters: R-P2-4 (BUS, HIGH, Score 6 — simpleHttpUpload duplex) + R-P2-11 (TECH, LOW, Score 2 — CircuitOpen deferred) + R-P2-12 (OPS, LOW, Score 2 — deflate-raw portability) + R-P2-14 (OPS, LOW, Score 2 — filename + DIST gap-closers)
- 11 total: 3 PW-Lib (1 DEFERRED) + 2 DIST + 3 DOC + 3 VT (incl. 1 deferred entry)

### Decision recap

- **D1 (R-P2-4):** Codify gap in Story 11.7-E2E-002 — test documents current cross-browser failure; flips to validate the fix when Epic 13 lands. Epic 11 exit criterion allows WAIVER + Epic 13 ticket.
- **D2 (R-P2-11):** Defer F#10 / CircuitOpen to Epic 12. Listed here with `test.fixme(...)` placeholder for traceability.

### Critical patterns

- **Vitest can't dynamic-import freshly-emitted /tmp files (MEMORY):** the Story 10.6 doctest harness uses `spawnSync(process.execPath, [harnessPath])` because Vite's `loadAndTransform` blocks dynamic imports outside the project root. Extend that pattern, don't reinvent it.
- **README fenced `ts` blocks are tsc-checked (MEMORY):** Story 10.6 compiled every targeted README example against `.d.mts`. Comment-only arrow bodies must be `() => { /* x */ }`. Free-variable bindings like `file`, `s3Client`, `localStorage` are injected via wrapper parameter types.
- **`node:stream` isolation (MEMORY):** the no-`node:*`-in-browser test (11.7-X-002) directly enforces this. Confirm `from-node-readable.ts` is the ONLY exception in the bundle.
- **Effect's peer-dep contract (MEMORY, Story 10):** the tree-shake test (11.7-X-001) must NOT bundle `effect` into the user's bundle — peer dep contract. If it does, that's an Epic 13 finding.

### Files likely touched

- New: 9 spec files (2 PW-Lib + 1 deferred placeholder + 2 DIST + 3 DOC + 1 VT, possibly 2 VT split)
- Possibly extended: existing doctest harness in `tests/integration/docs/` from Epic 10
- Updated: traceability report
- Possibly modified: README (if 11.7-E2E-003 surfaces an undocumented browser-support gap)

### Out of scope

- The actual `duplex: 'half'` fix in `simpleHttpUpload` (Epic 13 candidate — codified here, fixed there)
- Circuit-breaker wire-up (Epic 13)
- README rewrites (only ADDITIONS for the deflate-raw support matrix are in scope)

## References

- [Source: _bmad-output/test-artifacts/test-design-epic-11.md § Story 11.7] — 11 net-new tests + 1 deferred
- [Source: _bmad-output/brainstorming/brainstorming-session-2026-05-17-001.md] — F#10, F#40, G#2, G#3, G#13, G#15, G#17, G#19, G#25, G#27, G#29
- [Source: _bmad-output/planning-artifacts/epics.md § Story 11.7 + § Open Decisions D1, D2] — acceptance criteria + decisions
- [MEMORY: project_doctest_harness_patterns.md] — `spawnSync` pattern for fresh-emitted files
- [MEMORY: project_effect_peer_dep_contract.md] — peer dep contract; relevant for tree-shake
- [MEMORY: project_test_framework_patterns.md] — Playwright projects
- [MEMORY: feedback_typecheck_mandatory.md] — build + test + typecheck

## Dev Agent Record

### Agent Model Used

claude-opus-4-8

### Debug Log References

- DOC harness `effect` resolution: the compression doctest harness imports bare `effect` + `@tranquilload/core/*`. Node resolves a harness file's bare imports relative to the harness FILE, not cwd. Fixed by adding an optional `cwd` param to `runHarness` and writing the harness INTO the DIST fixture dir (which has `effect` + the packed packages installed) when a non-default cwd is given. `__doctest-harness-<id>.mjs` placed in `cwd`.
- DOC compile preludes: README resume/compression blocks assume `uploadMultipart` + the `s3` adapter object are already in scope. The `...s3` spread injects `chunkSize + initiate + uploadPart + completeUpload` — i.e. the `s3MultipartUpload` RETURN type, not a `Pick<UploadMultipartOptions, ...>` (which omits the required `chunkSize`). Fixed both preludes to `declare const s3: ReturnType<typeof s3MultipartUpload>` and injected the `uploadMultipart` import for the resume block.
- E2E-002 empirical correction: initial assumption was that Firefox/WebKit throw synchronously on `new Request(url, { body: stream, duplex: "half" })`. PW run proved they CONSTRUCT successfully (`requestConstructed: true`). Reframed the spec (Pattern 3) to lock construction-green per engine + a separate transmission-gap test (streamed PUT over HTTP/1.1 does NOT uniformly transmit).

### Completion Notes List

- **10/11 IDs GREEN, 1 DEFERRED.** No lib code changed — every test is a surface-area / contract lock.
- **11.7-E2E-001** — DEFERRED to Epic 12 (`test.fixme`, Decision D2). Tracked in traceability, zero effort consumed.
- **11.7-E2E-002** — GREEN (4 sub-tests). Empirical finding: the streamed-body CONSTRUCTION gap has closed in all 3 engines; the remaining R-P2-4 gap is TRANSMISSION over HTTP/1.1 (Epic 13 candidate).
- **11.7-E2E-003** — GREEN. 3-engine `deflate-raw` matrix locked; README support-matrix section added (addition only).
- **11.7-X-001 / X-002** — GREEN (4 + 3 sub-tests). Bundler-free closure walk over tsdown's emitted per-entry bundles + shared chunks. `effect` is NOT inlined (peer-dep contract holds — no Epic 13 finding). `from-node-readable.mjs` is the ONLY `node:*` importer.
- **11.7-INT-001** — GREEN (9 sub-tests). Special-char key round-trip via presigner `encodeURIComponent`.
- **11.7-INT-002** — GREEN (2 sub-tests). **Epic 13 candidate confirmed:** the adapter does NOT pre-validate >1024-char keys; it forwards them to S3 and surfaces only S3's rejection (not mapped to `InitiateUploadError` in the adapter). Current behaviour locked.
- **11.7-D-001** — GREEN (compile) / SKIP (MinIO run). MinIO is down on this host; the compile-only leg passes. `pnpm minio:up` (sudo) enables the end-to-end leg; `MINIO_REQUIRED=1` makes it hard-fail.
- **11.7-D-002** — GREEN. README compression example compiles + `compress("deflate-raw")` shrinks 64 KiB of zeros to < 10%.
- **11.7-D-003** — GREEN (4 sub-tests). Static reproducibility check of the test-app README setup sequence.
- **Triptyque:** `pnpm turbo build` ✅ · vitest (core 204 + adapters 55 + integration 23) ✅ · PW-Lib 5 green / 1 skip ✅ · `pnpm turbo typecheck` 5/5 ✅.
- **3 Epic 13 candidates:** (1) `simpleHttpUpload` cross-browser streaming TRANSMISSION over HTTP/1.1; (2) pre-flight `InitiateUploadError` guard for >1024-char keys; (3) per-engine buffered fallback / HTTP/2 negotiation for request streams.

### Change Log

- 2026-06-02 — Story 11.7 dev. 9 new spec files (2 PW-Lib cross-browser + 1 PW-Lib deferred placeholder + 2 DIST + 3 DOC + 1 VT) + 1 extracted shared DOC harness module. README addition (deflate-raw support matrix). Traceability §2.7 + §3.6 + §1/§5/§6 updates. No lib change. Status ready-for-dev → review.

### File List

New:
- `tests/e2e/lib/circuit-open.spec.ts` (11.7-E2E-001 DEFERRED)
- `tests/e2e/lib/simple-http-upload-cross-browser.spec.ts` (11.7-E2E-002)
- `tests/e2e/lib/deflate-raw-support-matrix.spec.ts` (11.7-E2E-003)
- `tests/integration/dist/tree-shake.test.ts` (11.7-X-001)
- `tests/integration/dist/no-node-imports.test.ts` (11.7-X-002)
- `tests/integration/docs/doctest-harness.ts` (shared harness extracted from Story 10.6's doctest.test.ts)
- `tests/integration/docs/resume-example.test.ts` (11.7-D-001)
- `tests/integration/docs/compression-example.test.ts` (11.7-D-002)
- `tests/integration/docs/test-app-readme.test.ts` (11.7-D-003)
- `packages/tranquilload-adapters/src/protocols/s3-multipart-upload-filename-edges.test.ts` (11.7-INT-001 + 11.7-INT-002)

Modified:
- `README.md` (added deflate-raw browser support matrix — addition only)
- `_bmad-output/test-artifacts/traceability/traceability-report-epic-11.md` (§2.7, §3.6, §1, §5, §6)
- `_bmad-output/implementation-artifacts/sprint-status.yaml` (11.7 → in-progress → review)
- `_bmad-output/implementation-artifacts/11-7-cross-browser-dist-doc-and-filename-gap-closers.md` (frontmatter baseline_commit, status, tasks, Dev Agent Record)

## Senior Developer Review (AI)

(to be filled at review time)
