# Story 11.6: Stream/Chunking + One-Shot Edges + Events/Progress Dual-Mode

Status: ready-for-dev

## Story

As a library maintainer,
I want vitest-integration coverage across stream/chunking edges, one-shot upload edges, `getProgress()` corner cases, `networkMultiplier` extrema, `computeOptimalPartSize` round-trip, File/Buffer/Node `Readable` sources, and the events-stream lifecycle,
so that all 28 documented surface-area edges from the brainstorming F# block are locked behaviour and no regression slips into a v0.1.x patch release.

## Acceptance Criteria

1. **Given** edge stream/chunking inputs (zero-byte file F#24, mid-read source error F#25, concurrency saturation F#28, chunkSize=1 F#42, chunkSize > totalBytes F#43, non-integer chunkSize F#44) **When** the upload runs **Then** behaviour matches the documented contract — typed error or graceful single-part — for each input (test IDs 11.6-INT-001 → 11.6-INT-003, 11.6-INT-013 → 11.6-INT-015).

2. **Given** one-shot edges (sync `completeUpload` F#30, Effect-typed `initiate` failure F#31, abort mid-stream F#37, server 4xx F#38, empty stream F#39) **When** `uploadOnce` runs **Then** each edge produces the documented result — typed error or success (test IDs 11.6-INT-004, 11.6-INT-005, 11.6-INT-010 → 11.6-INT-012).

3. **Given** events/progress dual-mode (cancelled events reader F#33, `getProgress()` before initiate F#34, `getProgress()` after completion F#35, `uploadId` promise resolving even on later failure F#36, events-stream-not-read latency F#90) **When** the upload runs **Then** no leak, no surprise zero, no slow-down (test IDs 11.6-INT-006 → 11.6-INT-009, 11.6-INT-027, 11.6-INT-028).

4. **Given** `networkMultiplier` with no samples (F#46) or saturated slow conditions (F#47) **When** the factor is sampled **Then** the documented floor (1.0 on no samples; 0.1 on saturated slow — below S3 floor, user must clamp) is asserted (test IDs 11.6-INT-016, 11.6-INT-017).

5. **Given** `computeOptimalPartSize` invoked with a range of inputs (F#50) **When** the resulting `chunkSize` flows through `uploadMultipart` **Then** actual PUT body sizes round-trip the calculation (test ID 11.6-INT-018).

6. **Given** File / Buffer / Node `Readable` source edges (empty File F#53, revoked blob URL F#54, MIME parity F#55, backpressure under slow consumer F#57, ENOENT on `createReadStream` F#58, `Readable.destroy(err)` F#59, paused Readable auto-resume F#60, Buffer no-realloc F#61) **When** the upload runs **Then** each adapter edge surfaces the documented behaviour (test IDs 11.6-INT-019 → 11.6-INT-026).

## Tasks / Subtasks

- [ ] Task 1: File layout (AC: all — 28 tests, high count, low cost mean ~0.5h/test)
  - [ ] Group by domain: `packages/tranquilload-core/src/multipart/chunking-edges.test.ts` (F#24, F#25, F#28, F#42, F#43, F#44), `packages/tranquilload-core/src/oneshot/edges.test.ts` (F#30, F#31, F#37, F#38, F#39), `packages/tranquilload-core/src/progress/getprogress-edges.test.ts` (F#33, F#34, F#35, F#36, F#90), `packages/tranquilload-adapters/src/resilience/network-multiplier.test.ts` (F#46, F#47), `packages/tranquilload-adapters/src/resilience/optimal-part-size.test.ts` (F#50), `packages/tranquilload-adapters/src/sources/*.test.ts` (F#53-F#61)
  - [ ] Extend existing test files where possible (most of these areas already have a base test suite from Epics 2-8)

- [ ] Task 2: Chunking edges (6 tests, AC: #1)
  - [ ] 11.6-INT-001 / F#24: zero-byte file → S3 rejects empty parts list; assert `CompleteUploadError`
  - [ ] 11.6-INT-002 / F#25: source stream errors mid-read → `PartUploadError(0, 0, cause)` with the original cause preserved
  - [ ] 11.6-INT-003 / F#28: under throttling, count exactly N PUTs in flight; assert N === `maxConcurrency`
  - [ ] 11.6-INT-013 / F#42: chunkSize=1 byte; assert NO crash, parts count = totalBytes (also surfaces S3 10k part limit at tiny files — capture as Epic 13 candidate if so)
  - [ ] 11.6-INT-014 / F#43: chunkSize > totalBytes → 1 part, body === whole file
  - [ ] 11.6-INT-015 / F#44: non-integer chunkSize 1024.7 → either rounded down, rounded to int, or rejected; lock CURRENT behaviour

- [ ] Task 3: One-shot edges (5 tests, AC: #2)
  - [ ] 11.6-INT-004 / F#30: sync `completeUpload: () => ({ ok: true })` (no Promise wrapper) works
  - [ ] 11.6-INT-005 / F#31: Effect-typed `initiate` that fails → `InitiateUploadError` with `cause` === original typed error
  - [ ] 11.6-INT-010 / F#37: one-shot abort mid-stream → `AbortError`
  - [ ] 11.6-INT-011 / F#38: one-shot server returns 4xx → `CompleteUploadError`
  - [ ] 11.6-INT-012 / F#39: empty stream → either succeeds with empty body or errors; lock behaviour

- [ ] Task 4: Events / getProgress dual-mode (6 tests, AC: #3)
  - [ ] 11.6-INT-006 / F#33: cancel `events` reader mid-upload → no leak (assert upload continues to completion)
  - [ ] 11.6-INT-007 / F#34: call `getProgress()` BEFORE `initiate` resolves → returns 0
  - [ ] 11.6-INT-008 / F#35: call `getProgress()` AFTER completion → returns the final value (not 0)
  - [ ] 11.6-INT-009 / F#36: cause an upload failure; assert `uploadId` promise STILL resolves (not rejected) — codifies that `uploadId` exposure is independent of upload outcome
  - [ ] 11.6-INT-027 / F#90 (latency lens): don't read the events stream at all; assert upload total wall-time matches the read-events variant (no backpressure stall) — paired with 11.2-INT-017 (cleanup lens)
  - [ ] 11.6-INT-028 / F#33 variant: cancel events reader BEFORE any event arrives → no leak

- [ ] Task 5: `networkMultiplier` + `computeOptimalPartSize` (3 tests, AC: #4, #5)
  - [ ] 11.6-INT-016 / F#46: brand-new `networkMultiplier` with no samples → factor === 1.0 (control)
  - [ ] 11.6-INT-017 / F#47: 10 saturated-slow samples → factor === 0.1 (floor — note this is below S3's 5MiB minimum, user must clamp at the call site)
  - [ ] 11.6-INT-018 / F#50: `computeOptimalPartSize({ totalBytes: 100MB, targetPartCount: 10, minPartSize: 5MB })` → 10MB; pass through `uploadMultipart`; assert each PUT body size === 10MB (last part may be smaller)

- [ ] Task 6: File / Buffer / Node Readable source edges (8 tests, AC: #6)
  - [ ] 11.6-INT-019 / F#53: empty `File` (browser); pairs with 11.6-INT-001
  - [ ] 11.6-INT-020 / F#54: revoke `URL.createObjectURL(file)` mid-read; assert error path
  - [ ] 11.6-INT-021 / F#55: PNG bytes, UTF-8 text, multi-byte chars → all round-trip
  - [ ] 11.6-INT-022 / F#57: slow consumer (artificial delay in `uploadPart`) under backpressure → heap stays flat (sample `process.memoryUsage().heapUsed` periodically; the no-monotonic-growth assertion)
  - [ ] 11.6-INT-023 / F#58: `createReadStream` of `/tmp/does-not-exist`; assert ENOENT propagates as `PartUploadError`
  - [ ] 11.6-INT-024 / F#59: `Readable.destroy(new Error("boom"))` mid-stream; assert phase-accurate error
  - [ ] 11.6-INT-025 / F#60: paused Node `Readable` → `Readable.toWeb` auto-resumes; upload completes
  - [ ] 11.6-INT-026 / F#61: Buffer source; assert no re-allocation (use a sentinel Buffer or `Buffer.byteLength` invariant)

- [ ] Task 7: Triptyque verification
  - [ ] `pnpm turbo build` green
  - [ ] `pnpm vitest run` green (28 new tests)
  - [ ] `pnpm turbo typecheck` green

- [ ] Task 8: Traceability update
  - [ ] Append 11.6-INT-001 → 11.6-INT-028 rows to `_bmad-output/test-artifacts/traceability/traceability-report-epic-11.md`

## Dev Notes

### Spec inputs

- Source spec: `_bmad-output/test-artifacts/test-design-epic-11.md` § "Story 11.6 — Stream/chunking + one-shot edges + events/progress dual-mode"
- Risk clusters: R-P2-7 (DATA, MEDIUM, Score 4 — stream/chunking edges) + R-P2-13 (BUS, LOW, Score 2 — one-shot edges)
- 28 vitest-integration tests, ~0.5h/test mean — high count, low cost. The volume is in F#-block coverage, not in setup complexity.

### Critical patterns

- **`node:stream` isolation (MEMORY):** only `from-node-readable.ts` (and its test file) may import `node:stream`. F#58, F#59, F#60 tests must live in or alongside `packages/tranquilload-adapters/src/sources/from-node-readable.test.ts` to honour this boundary.
- **`UploadError` phase mapping (MEMORY):** F#25 mid-read → `PartUploadError(0, 0, cause)` — note the use of `cause` rather than top-level error.
- **`uploadId` independence (F#36):** locks the contract that `uploadId` is exposed via the `initiate` resolution path, regardless of upload outcome. Important for cross-session resume.
- **Heap-stability lens (F#57):** node-side equivalent of 11.2-E2E-001 (PW-Lib `performance.memory`). Use `process.memoryUsage().heapUsed` + `global.gc()` between samples (run vitest with `--expose-gc`). Tune threshold for noise.
- **F#N prefix:** every test description starts with `F#N — ...`.

### Cross-references

- F#33 lives in both Task 4 entries (11.6-INT-006 and 11.6-INT-028) — same scenario, different timing (mid-upload vs pre-event). The test design treats these as 2 tests; that's intentional.
- F#90 has two lenses: latency lens in this story (11.6-INT-027), cleanup lens in Story 11.2 (11.2-INT-017). The pairing is intentional.

### Files likely touched

- New / extended:
  - `packages/tranquilload-core/src/multipart/chunking-edges.test.ts`
  - `packages/tranquilload-core/src/oneshot/edges.test.ts`
  - `packages/tranquilload-core/src/progress/getprogress-edges.test.ts`
  - `packages/tranquilload-adapters/src/resilience/network-multiplier.test.ts` (extend)
  - `packages/tranquilload-adapters/src/resilience/optimal-part-size.test.ts` (extend)
  - `packages/tranquilload-adapters/src/sources/from-node-readable.test.ts` (extend)
  - `packages/tranquilload-adapters/src/sources/from-file.test.ts` (extend)
- Updated: traceability report

### Out of scope

- 10k S3 part limit handling (F#42 may surface this as an Epic 13 candidate — flag inline, do not fix here)
- Re-allocation of Buffer in adapters (F#61 locks the contract; an actual fix is Epic 13 if it surfaces)

## References

- [Source: _bmad-output/test-artifacts/test-design-epic-11.md § Story 11.6] — 28 net-new tests
- [Source: _bmad-output/brainstorming/brainstorming-session-2026-05-17-001.md] — F#24, F#25, F#28, F#30, F#31, F#33-F#39, F#42-F#44, F#46, F#47, F#50, F#53-F#55, F#57-F#61, F#90
- [Source: _bmad-output/planning-artifacts/epics.md § Story 11.6] — acceptance criteria
- [MEMORY: feedback_surgical_tests.md] — exact `_tag` assertion
- [MEMORY: project_test_framework_patterns.md] — `@effect/vitest` patterns
- [MEMORY: feedback_typecheck_mandatory.md] — build + test + typecheck
- [Source: _bmad-output/planning-artifacts/epics.md § Story 8.2] — `node:stream` isolation contract

## Dev Agent Record

### Agent Model Used

(to be filled by dev)

### Debug Log References

### Completion Notes List

### Change Log

### File List

## Senior Developer Review (AI)

(to be filled at review time)
