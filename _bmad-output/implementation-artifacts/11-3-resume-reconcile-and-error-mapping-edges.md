---
baseline_commit: cdadbc70ccd51203ae55ae9741ac9a8f44eaab79
---

# Story 11.3: Resume + Reconcile + Error-Mapping Edges

Status: done

## Story

As a library maintainer,
I want vitest-integration coverage for the resume + reconcile error-mapping edges that fell out of Epic 10's P1 scope,
so that every documented resume-failure mode (deleted uploadId, expired presigned URL, stale reconcile, 0-parts reconcile, presigned-URL failure inside `uploadPart`, 500 on `/parts`) maps to a phase-accurate `UploadError` variant.

## Acceptance Criteria

1. **Given** the adapter throws inside `uploadPart` because of a presigned-URL failure (`PresignedUrlError`) **When** the upload runs **Then** the failure wraps as `PartUploadError.cause` and retry semantics apply uniformly (test ID 11.3-INT-001 covering F#5 — codifies the design-gap surfaced by the brainstorming).

2. **Given** the resume call hits a 500 on the `/parts` reconcile endpoint **When** the upload starts **Then** the failure surfaces as `ReconcileError` BEFORE any PUT is attempted (test ID 11.3-INT-002 covering F#7).

3. **Given** an `uploadId` that the server reports as `NoSuchUpload` (deleted) **When** the resume runs **Then** the error maps to a phase-accurate `UploadError` variant (test ID 11.3-INT-003 covering F#12).

4. **Given** a presigned URL that expires between sign and PUT **When** the resume runs with re-sign-per-attempt **Then** the upload recovers and completes (test ID 11.3-INT-004 covering F#13 — complements the existing Story 10.3-E2E-002 path with a phase-accurate Effect-channel error).

5. **Given** `reconcileCompletedParts` returns a result that becomes stale (the server deletes a part between `ListParts` and the next op) **When** the upload continues **Then** the lib detects the divergence and surfaces a typed error or re-uploads the affected part (test ID 11.3-INT-005 covering F#14).

6. **Given** `reconcileCompletedParts` returns an empty array for a known `uploadId` **When** the upload starts **Then** behaviour is identical to a fresh upload from part 1 (test ID 11.3-INT-006 covering F#15).

## Tasks / Subtasks

- [x] Task 1: File location (AC: all)
  - [x] Co-locate in `packages/tranquilload-core/src/multipart/resume-error-edges.test.ts` (or extend the existing resume test file from Epic 7 / Story 10.3)
  - [x] Use stubbed callbacks (`uploadPart`, `reconcileCompletedParts`, `initiate`, `completeUpload`) — no MinIO required for the AC mapping itself

- [x] Task 2: 11.3-INT-001 (F#5 — `PresignedUrlError` inside `uploadPart` → wraps as `PartUploadError.cause`) (AC: #1)
  - [x] Stub `uploadPart` to throw `new PresignedUrlError("expired")`
  - [x] Assert the surfaced error is `PartUploadError` with `cause` referencing the original `PresignedUrlError`
  - [x] Assert retry semantics apply (the part is retried per the schedule)

- [x] Task 3: 11.3-INT-002 (F#7 — `ReconcileError` from 500 on `/parts`) (AC: #2)
  - [x] Stub `reconcileCompletedParts` to reject with a 500-shaped error
  - [x] Assert the upload fails with `ReconcileError` and NO `uploadPart` call has happened (use a call counter)

- [x] Task 4: 11.3-INT-003 (F#12 — deleted uploadId / `NoSuchUpload`) (AC: #3)
  - [x] Stub `reconcileCompletedParts` to reject with an S3-shaped `NoSuchUpload` error
  - [x] Assert the surfaced variant is phase-accurate (likely `ReconcileError` with the original cause); document the chosen variant in the test description

- [x] Task 5: 11.3-INT-004 (F#13 — presigned URL expiry) (AC: #4)
  - [x] Stub `uploadPart` to reject the first attempt with a presigned-URL-expired error
  - [x] On retry, `getPresignedUrl` returns a fresh URL → success
  - [x] Assert the upload completes and the Effect error channel surfaces the FIRST failure as `PartUploadError` (not a hang)
  - [x] Cross-reference Story 10.3-E2E-002 for the E2E path

- [x] Task 6: 11.3-INT-005 (F#14 — stale reconcile result) (AC: #5)
  - [x] Stub `reconcileCompletedParts` to return `[{ partNumber: 3, etag: "..." }]`
  - [x] Stub the server to reject the complete-multipart call with `InvalidPart` for partNumber=3 (because the server already GC'd it)
  - [x] Assert the lib surfaces `CompleteUploadError` or retries part 3 with phase-accurate error — confirm CURRENT behaviour and lock it (or surface as gap if neither happens)

- [x] Task 7: 11.3-INT-006 (F#15 — 0-parts reconcile) (AC: #6)
  - [x] Stub `reconcileCompletedParts` to return `[]`
  - [x] Assert the upload uploads ALL parts (count = `Math.ceil(totalBytes / chunkSize)`) — i.e. identical to fresh upload
  - [x] Add a comment cross-referencing the Story 7.2 acceptance criterion that established this behaviour

- [x] Task 8: Triptyque verification
  - [x] `pnpm turbo build` green
  - [x] `pnpm vitest run --filter @tranquilload/core` green (6 new tests)
  - [x] `pnpm turbo typecheck` green

- [x] Task 9: Traceability update
  - [x] Append 11.3-INT-001 → 11.3-INT-006 rows to `_bmad-output/test-artifacts/traceability/traceability-report-epic-11.md`

## Dev Notes

### Spec inputs

- Source spec: `_bmad-output/test-artifacts/test-design-epic-11.md` § "Story 11.3 — Resume + reconcile + error mapping edges"
- Risk cluster: R-P2-6 (DATA, MEDIUM, Score 4 — resume edge variants)
- All 6 tests are VT (vitest-integration), ~1h/test mean

### Critical patterns

- **`UploadError` phase mapping (MEMORY):** `initiate` → `InitiateUploadError`; `reconcileCompletedParts` → `ReconcileError`; `uploadPart` → `PartUploadError`/`MaxRetriesExceededError`; `completeUpload` → `CompleteUploadError`. Each test must assert the phase-accurate variant.
- **`UploadError` union has 9 variants (MEMORY):** `PartUploadError | MaxRetriesExceededError | PresignedUrlError | InitiateUploadError | ReconcileError | CompleteUploadError | AbortError | CircuitOpenError | ResumeMismatchError`. `ResumeMismatchError` carries a `reason` discriminant.
- **`normalizeCallback` double-wrap (MEMORY):** in test callbacks, prefer raw `throw` / `Promise.reject` over `Effect.fail` to avoid the double-wrap noise.
- **`completeUpload` signature (MEMORY, breaking change 7.1):** `completeUpload(uploadId: string, parts: ReadonlyArray<CompletedPart>)` — first param is uploadId, second is parts. Test stubs must match.
- **F#N prefix:** every test description starts with `F#N — ...`.

### Real lib finding precedent

Story 10.1 surfaced the `safeLog` fix during test-writing. Story 11.3 may similarly surface lib gaps — e.g. F#14 (stale reconcile) may reveal that the lib has no graceful path for the `InvalidPart`-on-complete case. If so, surface as an Epic 13 candidate inline and lock the CURRENT behaviour in the test (with a `// CURRENT BEHAVIOUR — Epic 13 candidate: ...` comment).

### Files likely touched

- New or extended: `packages/tranquilload-core/src/multipart/resume-error-edges.test.ts`
- Updated: traceability report
- Possibly updated: Epic 13 candidate list (informal — track in MEMORY or `epic-11-retro-...md` if encountered)

### Out of scope

- E2E resume against real MinIO with expired URLs (covered by Story 10.3-E2E-002)
- Auto-`re-init` on `NoSuchUpload` (Epic 13 candidate from missing-feature backlog flag #5)

## References

- [Source: _bmad-output/test-artifacts/test-design-epic-11.md § Story 11.3] — 6 net-new tests
- [Source: _bmad-output/brainstorming/brainstorming-session-2026-05-17-001.md] — F#5, F#7, F#12-F#15
- [Source: _bmad-output/planning-artifacts/epics.md § Story 11.3] — acceptance criteria
- [Source: _bmad-output/planning-artifacts/epics.md § Story 7.2] — original resume semantics
- [MEMORY: feedback_surgical_tests.md] — assert the exact `_tag` variant
- [MEMORY: project_test_framework_patterns.md] — `@effect/vitest` patterns
- [MEMORY: feedback_typecheck_mandatory.md] — build + test + typecheck

## Dev Agent Record

### Agent Model Used

claude-opus-4-8 (Opus 4.8) — dev per Epics 6–9 permanent rule.

### Debug Log References

- `pnpm --filter @tranquilload/core exec vitest run src/multipart/resume-error-edges.test.ts` → 6/6 ✅ on first run.
- `pnpm turbo build` ✅ · `pnpm -r test` → 204 core + 44 adapters ✅ · `pnpm turbo typecheck` ✅.

### Completion Notes List

- **All 6 tests are surface-area LOCKs** of the lib's phase-accurate `UploadError` mapping. R-P2-6 is MEDIUM; ATDD red phase was effectively a confirmation — all 6 passed on first run against the current lib. **No lib change.** Same outcome shape as Stories 11.2 and 11.6.
- New file: `packages/tranquilload-core/src/multipart/resume-error-edges.test.ts` (6 `it.effect` tests). Co-located per Task 1; existing `upload-stream.test.ts` already held adjacent resume/reconcile tests, so each new test was scoped to a DISTINCT incremental angle (not duplicating the existing variant-only assertions):
  - **INT-001 (F#5):** two-pronged — single-attempt schedule (`recurs(0)`) surfaces `PartUploadError` with `cause === presigned`; multi-attempt schedule (`recurs(2)`) proves the `PresignedUrlError` is retried UNIFORMLY (3 calls, no fail-fast) → `MaxRetriesExceededError` with the same cause preserved. Distinct from the existing `Schedule.whileInput` test (which proves a caller CAN opt out — INT-001 proves the DEFAULT does not).
  - **INT-002 (F#7):** adds a `uploadPart` call-counter (0 PUTs) on top of the `ReconcileError` variant assertion the existing suite already had.
  - **INT-003 (F#12):** S3-shaped `NoSuchUpload` cause; phase-accurate `ReconcileError`; locks no-auto-reinit.
  - **INT-004 (F#13):** re-sign-per-attempt recovery — `uploadPart` re-signs inside the callback each attempt; first attempt rejects (expired), retry succeeds; asserts `UploadCompleted` + exactly 2 signs.
  - **INT-005 (F#14):** stale reconciled part (server GC'd part 3) only surfaces at complete → `CompleteUploadError(cause = InvalidPart)`; parts 1–2 PUT, part 3 trusted/skipped.
  - **INT-006 (F#15):** equivalence proof — empty-reconcile and no-reconcile-callback produce the identical PUT set; explicit `ceil(50/10)=5`; cross-ref Story 7.2.
- **3 Epic 13 candidates surfaced inline** (flagged in test comments + traceability §2.3/§3.5; do not re-flag): (1) opt-in fail-fast on `PresignedUrlError`; (2) auto-reinit on stale/deleted uploadId; (3) detect/re-upload a GC'd reconciled part instead of failing at complete.
- Core test count: 197 → 204 (+6 + ... exactly +6 net-new ⇒ 204 reported is 197 from 11.2's 197 baseline; actual is +6). Adapters unchanged (44). Traceability bumped 53 → 59 (4/7 stories landed).

### Change Log

- 2026-06-02 — Story 11.3 dev: added `packages/tranquilload-core/src/multipart/resume-error-edges.test.ts` (6 VT tests, 11.3-INT-001 → 006). No lib change. Triptyque green (build + 204 core + 44 adapters + typecheck). Traceability report §2.3, §3.5, §1 totals, §4/§5 sub-gate updated.

### File List

- **Added:** `packages/tranquilload-core/src/multipart/resume-error-edges.test.ts`
- **Modified:** `_bmad-output/test-artifacts/traceability/traceability-report-epic-11.md`
- **Modified:** `_bmad-output/implementation-artifacts/sprint-status.yaml` (11-3 → in-progress → review)
- **Modified:** `_bmad-output/implementation-artifacts/11-3-resume-reconcile-and-error-mapping-edges.md` (this file)

## Senior Developer Review (AI)

**Reviewer:** independent Opus 4.8 agent (fresh context — Codex unavailable; another Opus stands in per user direction 2026-06-02).
**Date:** 2026-06-02
**Outcome:** ✅ **Approve** — 0 HIGH / 0 MEDIUM / 2 LOW (informational only, no change recommended).

### Verdict

Six surgical, phase-accurate LOCK tests that each add a distinct incremental angle over the sibling `upload-stream.test.ts` suite (standout: INT-005's stale-reconciled-part → `CompleteUploadError`, previously untested). Assertions match the actual lib mapping; ordering claims are structurally sound (INT-002's "0 PUTs before ReconcileError" is structurally guaranteed by reconcile being yielded in setup `Effect.gen` before `partsStream` — not racy, no gated Promise needed); `Effect.flip` is the correct guard for typed-failure assertions (a defect would propagate as an unhandled failure, not silently pass); the three Epic 13 candidates are honestly flagged. Triptyque green, no lib change warranted.

### Findings

- **HIGH:** none.
- **MEDIUM:** none.
- **LOW-1 (informational):** INT-006(b) equivalence arm (`resume-error-edges.test.ts:228-243`) is near-constructive — the "no reconcile callback" arm trivially yields `[1,2,3,4,5]`, so the equivalence comparison is close to comparing a value with itself. The `ceil` formula + `UploadCompleted.totalParts` assertions carry the real weight. **No fix** — locking "empty array ≠ divergence" is legitimate.
- **LOW-2 (informational):** INT-001(a) lightly overlaps the existing `Schedule.whileInput` single-attempt path (both → `PartUploadError`, `cause===presigned`, 1 attempt). The load-bearing novelty lives in part (b) (`recurs(2)` → 3 calls → `MaxRetriesExceededError`, proving no fail-fast by default). Acceptable as the two-pronged setup. **No fix.**

Both LOW items are observations, not gaps; the reviewer explicitly advised AGAINST reworking them (coverage-regression trap, per the Story 11.2 lesson). **Dev decision: no changes applied** — concur with the reviewer. `receiving-code-review` skepticism applied: a clean 0H/0M with the reviewer self-policing against padding is the expected outcome for a MEDIUM-risk surface-area-lock story.
