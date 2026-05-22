# Story 11.3: Resume + Reconcile + Error-Mapping Edges

Status: ready-for-dev

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

- [ ] Task 1: File location (AC: all)
  - [ ] Co-locate in `packages/tranquilload-core/src/multipart/resume-error-edges.test.ts` (or extend the existing resume test file from Epic 7 / Story 10.3)
  - [ ] Use stubbed callbacks (`uploadPart`, `reconcileCompletedParts`, `initiate`, `completeUpload`) — no MinIO required for the AC mapping itself

- [ ] Task 2: 11.3-INT-001 (F#5 — `PresignedUrlError` inside `uploadPart` → wraps as `PartUploadError.cause`) (AC: #1)
  - [ ] Stub `uploadPart` to throw `new PresignedUrlError("expired")`
  - [ ] Assert the surfaced error is `PartUploadError` with `cause` referencing the original `PresignedUrlError`
  - [ ] Assert retry semantics apply (the part is retried per the schedule)

- [ ] Task 3: 11.3-INT-002 (F#7 — `ReconcileError` from 500 on `/parts`) (AC: #2)
  - [ ] Stub `reconcileCompletedParts` to reject with a 500-shaped error
  - [ ] Assert the upload fails with `ReconcileError` and NO `uploadPart` call has happened (use a call counter)

- [ ] Task 4: 11.3-INT-003 (F#12 — deleted uploadId / `NoSuchUpload`) (AC: #3)
  - [ ] Stub `reconcileCompletedParts` to reject with an S3-shaped `NoSuchUpload` error
  - [ ] Assert the surfaced variant is phase-accurate (likely `ReconcileError` with the original cause); document the chosen variant in the test description

- [ ] Task 5: 11.3-INT-004 (F#13 — presigned URL expiry) (AC: #4)
  - [ ] Stub `uploadPart` to reject the first attempt with a presigned-URL-expired error
  - [ ] On retry, `getPresignedUrl` returns a fresh URL → success
  - [ ] Assert the upload completes and the Effect error channel surfaces the FIRST failure as `PartUploadError` (not a hang)
  - [ ] Cross-reference Story 10.3-E2E-002 for the E2E path

- [ ] Task 6: 11.3-INT-005 (F#14 — stale reconcile result) (AC: #5)
  - [ ] Stub `reconcileCompletedParts` to return `[{ partNumber: 3, etag: "..." }]`
  - [ ] Stub the server to reject the complete-multipart call with `InvalidPart` for partNumber=3 (because the server already GC'd it)
  - [ ] Assert the lib surfaces `CompleteUploadError` or retries part 3 with phase-accurate error — confirm CURRENT behaviour and lock it (or surface as gap if neither happens)

- [ ] Task 7: 11.3-INT-006 (F#15 — 0-parts reconcile) (AC: #6)
  - [ ] Stub `reconcileCompletedParts` to return `[]`
  - [ ] Assert the upload uploads ALL parts (count = `Math.ceil(totalBytes / chunkSize)`) — i.e. identical to fresh upload
  - [ ] Add a comment cross-referencing the Story 7.2 acceptance criterion that established this behaviour

- [ ] Task 8: Triptyque verification
  - [ ] `pnpm turbo build` green
  - [ ] `pnpm vitest run --filter @tranquilload/core` green (6 new tests)
  - [ ] `pnpm turbo typecheck` green

- [ ] Task 9: Traceability update
  - [ ] Append 11.3-INT-001 → 11.3-INT-006 rows to `_bmad-output/test-artifacts/traceability/traceability-report-epic-11.md`

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

(to be filled by dev)

### Debug Log References

### Completion Notes List

### Change Log

### File List

## Senior Developer Review (AI)

(to be filled at review time)
