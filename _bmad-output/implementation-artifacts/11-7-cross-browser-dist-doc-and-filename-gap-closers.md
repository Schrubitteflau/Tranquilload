# Story 11.7: Cross-Browser + DIST + DOC + Filename Gap-Closers

Status: ready-for-dev

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

- [ ] Task 1: File layout (AC: all)
  - [ ] PW-Lib: `tests/e2e/lib/simple-http-upload-cross-browser.spec.ts` (11.7-E2E-002), `tests/e2e/lib/deflate-raw-support-matrix.spec.ts` (11.7-E2E-003)
  - [ ] PW-Lib deferred placeholder: `tests/e2e/lib/circuit-open.spec.ts` with `test.fixme(...)` and a comment citing Epic 12 (11.7-E2E-001 — keeps the test ID alive in traceability)
  - [ ] DIST: `tests/integration/dist/tree-shake.test.ts`, `tests/integration/dist/no-node-imports.test.ts`
  - [ ] DOC: `tests/integration/docs/resume-example.test.ts`, `tests/integration/docs/compression-example.test.ts`, `tests/integration/docs/test-app-readme.test.ts`
  - [ ] VT: `packages/tranquilload-adapters/src/adapters/s3-multipart-upload-filename-edges.test.ts` (or extend existing s3-multipart test file)

- [ ] Task 2: 11.7-E2E-001 — F#10 CircuitOpen (DEFERRED) (AC: #1)
  - [ ] Create `tests/e2e/lib/circuit-open.spec.ts` with a `test.fixme("F#10 — CircuitOpenError after 5 consecutive part failures in 10s", ...)` and a TODO comment: `// DEFERRED to Epic 12 per Decision D2 in epics.md. Circuit-breaker wire-up is an Epic 13 prerequisite.`
  - [ ] Lock the test ID in traceability so future Epic 12 implementers know exactly what to wire
  - [ ] Effort: ~15 min (placeholder only)

- [ ] Task 3: 11.7-E2E-002 — `simpleHttpUpload` cross-browser (AC: #2)
  - [ ] Drive `simpleHttpUpload` from PW-Lib (no test-app UI), with a `ReadableStream` body
  - [ ] Run on Chromium / Firefox / WebKit
  - [ ] CURRENT BEHAVIOUR: at least one browser will fail because `fetch` rejects a streamed body without `duplex: 'half'`
  - [ ] Assert THE CURRENT behaviour — `expect(...).rejects.toThrow(/...duplex.../)` or similar; lock the gap
  - [ ] Add a clear comment: `// Codifies R-P2-4 / Decision D1 / Epic 13 candidate. Flip assertion to upload-completes when the duplex:'half' fix ships.`
  - [ ] Epic 11 exit criterion explicitly allows WAIVER + Epic 13 ticket

- [ ] Task 4: 11.7-E2E-003 — `deflate-raw` support matrix (AC: #3)
  - [ ] Smoke spec: create a `CompressionStream("deflate-raw")` in each browser; assert it either constructs or throws
  - [ ] Lock the per-browser support matrix and surface a console warning in the README
  - [ ] If WebKit lacks support, document it inline (G#3)

- [ ] Task 5: 11.7-X-001 — Tree-shake proof (DIST) (AC: #4)
  - [ ] Add a synthetic consumer file that ONLY imports `@tranquilload/core/oneshot`
  - [ ] Bundle it with `esbuild` or the test-app's bundler (whatever the DIST harness already uses)
  - [ ] Assert the resulting bundle does NOT contain identifiers that only exist in multipart code (e.g. `uploadMultipartEffect`, `chunkStream`, `CircuitBreaker`)
  - [ ] Set a generous size budget (e.g. bundle size < 50% of full-import bundle) to catch regressions

- [ ] Task 6: 11.7-X-002 — No `node:*` in browser bundle (DIST) (AC: #4)
  - [ ] Build the browser-targeting bundle of `@tranquilload/core` AND `@tranquilload/adapters` with `--platform=browser`
  - [ ] Grep the resulting bundle for `node:*` imports
  - [ ] Assert: zero matches, EXCEPT when the consumer explicitly imports `@tranquilload/adapters/fromNodeReadable` (allowed boundary)
  - [ ] Run two cases: (a) consumer doesn't import `fromNodeReadable` → 0 matches; (b) consumer DOES import it → matches confined to that one module

- [ ] Task 7: 11.7-INT-001 — Special-char filenames (AC: #5)
  - [ ] Parameterized vitest test over `[#, ?, %, +, " ", "café", "🚀", "نص عربي"]`
  - [ ] Call `s3MultipartUpload({ bucket, key: filename, ... })` and assert the key is URL-encoded correctly for the PUT URL
  - [ ] Round-trip: HEAD on the resulting object resolves the SAME filename back
  - [ ] Mock the S3 client / use chaos endpoint to avoid needing MinIO for the unit-level assertion

- [ ] Task 8: 11.7-INT-002 — Filename > 1024 chars (AC: #5)
  - [ ] Call `s3MultipartUpload({ bucket, key: "a".repeat(1025), ... })`
  - [ ] Assert the lib produces `InitiateUploadError` BEFORE attempting the request (S3 documented 1024-char key limit)
  - [ ] If the lib does NOT pre-validate, surface as Epic 13 candidate

- [ ] Task 9: 11.7-D-001 — Resume example doctest (AC: #6)
  - [ ] The Epic 10 doctest harness (`spawnSync(process.execPath, [harnessPath])` per MEMORY) compiles fenced `ts` blocks from the README against the published `.d.mts`
  - [ ] Extend to: extract the resume example, compile, and run against MinIO; assert the example completes a resume
  - [ ] MinIO requirement: skip if MinIO health check fails (mark as `test.skip` with a clear reason)

- [ ] Task 10: 11.7-D-002 — Compression example doctest (AC: #6)
  - [ ] Extract the README compression example; compile + run
  - [ ] Assert: output bytes are smaller than input bytes (proof compression actually happened); the size ratio is documented in the example

- [ ] Task 11: 11.7-D-003 — Test-app README reproducibility (AC: #6)
  - [ ] Parse `examples/test-app/README.md` for the setup command sequence
  - [ ] Run it in a CI sandbox (or assert each step's existence + correctness via a dry-run)
  - [ ] Assert: a fresh clone + the README sequence brings the test-app to a working state

- [ ] Task 12: Verification
  - [ ] `pnpm vitest run` green (3 new VT tests including filename edges)
  - [ ] `pnpm exec playwright test --project=lib tests/e2e/lib/simple-http-upload-cross-browser.spec.ts tests/e2e/lib/deflate-raw-support-matrix.spec.ts` green
  - [ ] `pnpm vitest run tests/integration/dist tests/integration/docs` green (2 DIST + 3 DOC tests)
  - [ ] `pnpm turbo typecheck` green

- [ ] Task 13: Traceability update
  - [ ] Append 11.7-E2E-001 (with DEFERRED flag) → 11.7-D-003 rows to `_bmad-output/test-artifacts/traceability/traceability-report-epic-11.md`

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

(to be filled by dev)

### Debug Log References

### Completion Notes List

### Change Log

### File List

## Senior Developer Review (AI)

(to be filled at review time)
