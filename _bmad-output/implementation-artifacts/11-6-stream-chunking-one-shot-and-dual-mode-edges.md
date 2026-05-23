# Story 11.6: Stream/Chunking + One-Shot Edges + Events/Progress Dual-Mode

Status: done

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

- [x] Task 1: File layout (AC: all — 28 tests, high count, low cost mean ~0.5h/test)
  - [x] Group by domain: `packages/tranquilload-core/src/multipart/chunking-edges.test.ts` (F#24, F#25, F#28, F#42, F#43, F#44), `packages/tranquilload-core/src/oneshot/edges.test.ts` (F#30, F#31, F#37, F#38, F#39), `packages/tranquilload-core/src/progress/getprogress-edges.test.ts` (F#33, F#34, F#35, F#36, F#90), `packages/tranquilload-adapters/src/resilience/network-multiplier.test.ts` (F#46, F#47), `packages/tranquilload-adapters/src/resilience/optimal-part-size.test.ts` (F#50), `packages/tranquilload-adapters/src/sources/*.test.ts` (F#53-F#61)
  - [x] Extend existing test files where possible (most of these areas already have a base test suite from Epics 2-8)

- [x] Task 2: Chunking edges (6 tests, AC: #1)
  - [x] 11.6-INT-001 / F#24: zero-byte file → S3 rejects empty parts list; assert `CompleteUploadError`
  - [x] 11.6-INT-002 / F#25: source stream errors mid-read → `PartUploadError(0, 0, cause)` with the original cause preserved
  - [x] 11.6-INT-003 / F#28: under throttling, count exactly N PUTs in flight; assert N === `maxConcurrency`
  - [x] 11.6-INT-013 / F#42: chunkSize=1 byte; assert NO crash, parts count = totalBytes (also surfaces S3 10k part limit at tiny files — capture as Epic 13 candidate if so)
  - [x] 11.6-INT-014 / F#43: chunkSize > totalBytes → 1 part, body === whole file
  - [x] 11.6-INT-015 / F#44: non-integer chunkSize 1024.7 → either rounded down, rounded to int, or rejected; lock CURRENT behaviour

- [x] Task 3: One-shot edges (5 tests, AC: #2)
  - [x] 11.6-INT-004 / F#30: sync `completeUpload: () => ({ ok: true })` (no Promise wrapper) works
  - [x] 11.6-INT-005 / F#31: Effect-typed `initiate` that fails → `InitiateUploadError` with `cause` === original typed error
  - [x] 11.6-INT-010 / F#37: one-shot abort mid-stream → `AbortError`
  - [x] 11.6-INT-011 / F#38: one-shot server returns 4xx → `CompleteUploadError`
  - [x] 11.6-INT-012 / F#39: empty stream → either succeeds with empty body or errors; lock behaviour

- [x] Task 4: Events / getProgress dual-mode (6 tests, AC: #3)
  - [x] 11.6-INT-006 / F#33: cancel `events` reader mid-upload → no leak (assert upload continues to completion)
  - [x] 11.6-INT-007 / F#34: call `getProgress()` BEFORE `initiate` resolves → returns 0
  - [x] 11.6-INT-008 / F#35: call `getProgress()` AFTER completion → returns the final value (not 0)
  - [x] 11.6-INT-009 / F#36: cause an upload failure; assert `uploadId` promise STILL resolves (not rejected) — codifies that `uploadId` exposure is independent of upload outcome
  - [x] 11.6-INT-027 / F#90 (latency lens): don't read the events stream at all; assert upload total wall-time matches the read-events variant (no backpressure stall) — paired with 11.2-INT-017 (cleanup lens)
  - [x] 11.6-INT-028 / F#33 variant: cancel events reader BEFORE any event arrives → no leak

- [x] Task 5: `networkMultiplier` + `computeOptimalPartSize` (3 tests, AC: #4, #5)
  - [x] 11.6-INT-016 / F#46: brand-new `networkMultiplier` with no samples → factor === 1.0 (control)
  - [x] 11.6-INT-017 / F#47: 10 saturated-slow samples → factor === 0.1 (floor — note this is below S3's 5MiB minimum, user must clamp at the call site)
  - [x] 11.6-INT-018 / F#50: `computeOptimalPartSize({ totalBytes: 100MB, targetPartCount: 10, minPartSize: 5MB })` → 10MB; pass through `uploadMultipart`; assert each PUT body size === 10MB (last part may be smaller)

- [x] Task 6: File / Buffer / Node Readable source edges (8 tests, AC: #6)
  - [x] 11.6-INT-019 / F#53: empty `File` (browser); pairs with 11.6-INT-001
  - [x] 11.6-INT-020 / F#54: revoke `URL.createObjectURL(file)` mid-read; assert error path
  - [x] 11.6-INT-021 / F#55: PNG bytes, UTF-8 text, multi-byte chars → all round-trip
  - [x] 11.6-INT-022 / F#57: slow consumer (artificial delay in `uploadPart`) under backpressure → heap stays flat (sample `process.memoryUsage().heapUsed` periodically; the no-monotonic-growth assertion)
  - [x] 11.6-INT-023 / F#58: `createReadStream` of `/tmp/does-not-exist`; assert ENOENT propagates as `PartUploadError`
  - [x] 11.6-INT-024 / F#59: `Readable.destroy(new Error("boom"))` mid-stream; assert phase-accurate error
  - [x] 11.6-INT-025 / F#60: paused Node `Readable` → `Readable.toWeb` auto-resumes; upload completes
  - [x] 11.6-INT-026 / F#61: Buffer source; assert no re-allocation (use a sentinel Buffer or `Buffer.byteLength` invariant)

- [x] Task 7: Triptyque verification
  - [x] `pnpm turbo build` green
  - [x] `pnpm vitest run` green (28 new tests)
  - [x] `pnpm turbo typecheck` green

- [x] Task 8: Traceability update
  - [x] Append 11.6-INT-001 → 11.6-INT-028 rows to `_bmad-output/test-artifacts/traceability/traceability-report-epic-11.md`

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

claude-opus-4-7 (Opus 4.7) — per `feedback_code_review_model.md`: Opus for dev AND review.

### Debug Log References

- `pnpm vitest run` (full repo sweep): 224/224 GREEN (core: 180; adapters: 44).
- `pnpm turbo build`: green (24 ESM files, ~25KB total in adapters dist).
- `pnpm turbo typecheck`: green across 5 packages after fixing one `Uint8Array<ArrayBufferLike>` → `BlobPart` cast in `from-file.test.ts` (TS lib variance, runtime-equivalent).

### Completion Notes List

- **Scope delivered: 29 tests across 28 IDs.** The +1 over the spec count is the F#50 remainder companion: 11.6-INT-018 splits into a *clean-multiple* case (`totalBytes % chunkSize === 0` → all PUT bodies = chunkSize) and a *remainder* case (`!== 0` → last PUT body is the remainder). Same scenario ID, two surface assertions — both lock the round-trip contract.
- **File layout deviation from Task 1 (justified):** the story's Task 1 places F#30 and F#31 in `oneshot/edges.test.ts`. F#30 (`completeUpload`) and F#31 (`initiate`) are *multipart* APIs — the one-shot path has no `completeUpload`/`initiate`. Created `multipart/dual-mode-edges.test.ts` to host F#30 + F#31 alongside the other multipart edges; `oneshot/edges.test.ts` carries only the genuinely one-shot cases (F#37 / F#38 / F#39). Test boundary remains clean; traceability §2.6 reflects the actual paths.
- **No lib finding.** All 28 IDs lock existing behaviour. The defect-safe-user-boundary pattern (`safeLog`, `compress()` from 11.1) was *probed* by F#25 (mid-read source error) and F#59 (`Readable.destroy(err)`) — both already propagate cleanly via `chunkStream`'s `Stream.mapError`, so no new boundary wrap was needed.
- **Surgical-test discipline applied.** Every defect-refusal test asserts `Cause.dieOption(exit.cause)._tag === "None"` AND `Chunk.size(Cause.defects(exit.cause)) === 0` — refusing fiber defects, mirroring Story 11.1 / 10.1-INT-013.
- **F#N prefix convention honored** — every new test description starts with `11.6-INT-NNN (F#NN) — ...` matching brainstorming-session-2026-05-17-001.
- **F#42 → Epic 13 candidate** (already flagged): chunkSize=1 on a multi-GB upload would exceed S3's 10k-part limit. Caller-side validation belongs to Epic 13.
- **F#44 → Epic 13 candidate** (already flagged): non-integer `chunkSize` (e.g. 1024.7) silently truncates via `Uint8Array.slice`'s ToIntegerOrInfinity coercion + compares as float. Locked CURRENT behaviour; a future API-boundary rejection is Epic 13.
- **F#39 → Epic 13 candidate** (already flagged): one-shot empty stream emits `UploadCompleted(totalParts: 1)` — a future stricter empty-stream policy is Epic 13.
- **Heap-stability lens (F#57)** uses a tolerant `last < first × 2 + 5MB` floor to absorb Node-internals noise; runs without `--expose-gc` (the helper falls back gracefully). The *exact* bound is locked separately by Story 11.2's PW-Lib heap test (11.2-E2E-001).
- **Triptyque green pre-review.** Ready for Opus → Opus code review per `feedback_code_review_model.md`.

### Change Log

- **2026-05-22 (dev):** Story 11.6 dev landed. 4 new test files + 4 extended test files; 29 net-new tests; 0 lib changes; traceability report §2.6 added + §1 totals bumped (6 → 35). Status: ready-for-dev → review.
- **2026-05-23 (code-review fixes):** Codex review returned 0H/4M/1L. All 4 MEDIUM + the 1 LOW addressed inline (test-design rigor only, no lib change). Triptyque green pre- and post-review-fix (build + 224 vitest + typecheck). Status: review → done. See § Senior Developer Review (AI).

### File List

- New:
  - `packages/tranquilload-core/src/multipart/chunking-edges.test.ts` (6 tests: 11.6-INT-001/002/003/013/014/015)
  - `packages/tranquilload-core/src/multipart/dual-mode-edges.test.ts` (2 tests: 11.6-INT-004/005)
  - `packages/tranquilload-core/src/oneshot/edges.test.ts` (3 tests: 11.6-INT-010/011/012)
  - `packages/tranquilload-core/src/progress/getprogress-edges.test.ts` (6 tests: 11.6-INT-006/007/008/009/027/028)
- Modified (extended):
  - `packages/tranquilload-adapters/src/resilience/network-multiplier.test.ts` (+2 tests: 11.6-INT-016/017)
  - `packages/tranquilload-adapters/src/resilience/optimal-part-size.test.ts` (+2 tests: 11.6-INT-018 clean + remainder)
  - `packages/tranquilload-adapters/src/sources/from-file.test.ts` (+4 tests: 11.6-INT-019/020/021/022)
  - `packages/tranquilload-adapters/src/sources/from-node-readable.test.ts` (+4 tests: 11.6-INT-023/024/025/026)
- Updated (artifact):
  - `_bmad-output/test-artifacts/traceability/traceability-report-epic-11.md` (§2.6 + §3.2 + §1 totals + §5 gate decision)
  - `_bmad-output/implementation-artifacts/sprint-status.yaml` (story key → in-progress, will be → review at close)
  - `_bmad-output/implementation-artifacts/11-6-stream-chunking-one-shot-and-dual-mode-edges.md` (Tasks → [x]; Dev Agent Record filled; Status → review)

## Senior Developer Review (AI)

**Reviewer:** Codex (OpenAI) — external second opinion, deliberate divergence from the `feedback_code_review_model.md` Opus→Opus preference for this story to stress-test the test-design rigor with a different model family.
**Review date:** 2026-05-23
**Verdict:** 0 HIGH · 4 MEDIUM · 1 LOW. All MEDIUM + LOW addressed inline; no lib code touched (the entire review surface was test-design rigor).

### Findings and resolutions

#### M1 — 11.6-INT-006 (F#33) — claimed "mid-upload" was actually "post-upload"

**Codex finding:** `multipart/index.ts:173` builds `events` as a buffered `ReadableStream` whose `start()` does `await collected` BEFORE enqueueing any event. The original test called `reader.read()` and got back an event — but that read only resolves AFTER the upload is complete, making the subsequent cancellation post-upload-no-op.

**Verification:** Confirmed by re-reading `index.ts:173-185`. The events stream is a final dump, not a live pipe.

**Fix:** Refactored to gate `uploadPart(1)` so the upload is provably in flight (we await `partStartedPromise`), THEN cancel the reader, THEN release the gate. The test now genuinely locks "cancellation during in-flight upload does not interrupt the upload fiber". `progress/getprogress-edges.test.ts:31`.

#### M2 — 11.6-INT-007 (F#34) — missing `initiate` boundary

**Codex finding:** F#34's scenario name is "before initiate" — but the test omitted the `initiate` callback. With no initiate, there's no "before initiate" boundary to be on the wrong side of; the test only locked "immediately after `uploadMultipart()` returns".

**Verification:** Confirmed — `uploadMultipart` only runs the initiate branch when `initiate` is provided.

**Fix:** Added a gated `initiate` callback (Promise gate held open). The test now calls `getProgress()` while initiate is PROVABLY pending, asserts 0, then releases the gate. `progress/getprogress-edges.test.ts:71`.

#### M3 — 11.6-INT-020 (F#54) — 8-byte file → single chunk → revoke is post-drain

**Codex finding:** With an 8-byte file, `Blob.stream()` returns the entire content in one chunk; the first `reader.read()` drains everything, and `URL.revokeObjectURL()` then runs after the stream is already finished. "Mid-read" is observationally vacuous.

**Verification:** Probed Node directly (`File.stream()` on 200KB / 1MB / 2MB / 4MB → still 1 chunk on Node ≥ 22). Genuine mid-read timing is NOT achievable from a vitest harness on this platform.

**Fix:** Reframed the test as **URL-independence for `fromFile(file)`** (Codex's other suggested option). The contract being locked is "`fromFile` reads from internal Blob storage, NOT from a blob URL — so revocation is decoupled from the stream regardless of timing". A future change introducing URL coupling would surface the break via the byte-fidelity assertion. Test title + comment updated to reflect this narrower lock honestly. `sources/from-file.test.ts:74`.

#### M4 — 11.6-INT-024 (F#59) + 11.6-INT-023 (F#58) — missing surgical defect-refusal

**Codex finding:** Both tests caught failures via the public `result` Promise. `Cause.squash` (called in `index.ts:154`) can mask a defect by surfacing it as a generic Error — `instanceof PartUploadError` would pass for a future regression that wraps a defect into a PartUploadError-shaped exception. This violates the surgical-test discipline (precedent: `compress-error-paths.test.ts:35` + Story 11.1 + 10.1-INT-013).

**Verification:** Confirmed by reading `multipart/index.ts:154` and recalling the helper in `pipeline/compress-error-paths.test.ts`. The risk is real, not theoretical.

**Fix:** Refactored BOTH tests (Codex's "consider the same treatment for 11.6-INT-023" suggestion applied) to use `uploadMultipart.effect` + `Stream.runCollect` + `Effect.runPromiseExit`, then assert `Cause.dieOption._tag === "None"` + `Chunk.size(Cause.defects) === 0` + typed `PartUploadError(0, 0, cause)`. Extracted a local `expectPartUploadError` helper to mirror the precedent. `sources/from-node-readable.test.ts:46`.

#### L1 — 11.6-INT-026 (F#61) — "no realloc" wording overpromises

**Codex finding:** Brainstorming F#61 says "no re-allocation", but the test only locks byteLength + content. Traceability should not imply allocation behavior is tested.

**Verification:** Test comment and `it()` title already said "byteLength invariant"; the traceability row already used "byteLength invariant". The actual mismatch was the gap between brainstorming wording (overpromise) and test scope (honest, narrower lock).

**Fix:** Tightened the comment to a "**Scope note**" that explicitly calls out the brainstorming-wording mismatch and explains *why* (storage-sharing identity would over-bind Node `Readable.toWeb` internals across versions). Added "narrower than 'no realloc'" parenthetical to the `it()` title for searchability. A strict allocation check is now a flagged Epic 13 candidate. `sources/from-node-readable.test.ts:171`.

### Post-fix triptyque

- `pnpm turbo build`: ✅ green (5 packages)
- `pnpm -r test`: ✅ 224/224 GREEN (core 180 + adapters 44)
- `pnpm turbo typecheck`: ✅ green (5 packages)

### Gate decision

**Approved.** All MEDIUM findings addressed inline with proper verification; L1 polished. Zero lib code changes — the review surface was entirely test-design rigor. The four code-review fixes strengthen Story 11.6's locks against future regressions (the M1/M2 gated-callback patterns and M4 surgical defect-refusal pattern are reusable templates for future stories). Story 11.6 → **done**.
