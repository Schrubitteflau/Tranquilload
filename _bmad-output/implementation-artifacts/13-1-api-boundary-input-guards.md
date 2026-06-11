---
baseline_commit: 130156e118bf5fb54f296ae99eac30c6917fe7e3
---

# Story 13.1: API-Boundary Input Guards

Status: ready-for-dev

## Story

As a library maintainer,
I want pre-flight validation guards at the public API boundary for the documented input-edge gaps (non-integer `chunkSize`, oversized S3 key, S3 10k-part overflow, empty one-shot),
so that malformed configuration surfaces as a typed error/throw BEFORE any network request, instead of silently degrading or producing a corrupt/orphaned upload.

> **⚠️ This is a behaviour-CHANGING story, not a test-only lock.** Unlike Epic 11 (which *locked* current behaviour), each AC here *changes* library behaviour AND flips an existing locking test from "documents the gap / locks current behaviour" → "validates the fix". The dev MUST edit the named test files: remove the `// CURRENT BEHAVIOUR — Epic 13 candidate` / `locks current behaviour` comments and invert the assertion. Update the test description accordingly (keep the `F#N` / test-ID prefix).

## Acceptance Criteria

1. **Given** a non-integer `chunkSize` (e.g. `1024.7`) **When** `uploadMultipart` runs **Then** it fails fast with a typed validation error and uploads no part — by extending the existing guard at `packages/tranquilload-core/src/multipart/upload-stream.ts:148` (`!Number.isFinite(chunkSize) || chunkSize <= 0`, throws `TypeError`) to also reject `!Number.isInteger(chunkSize)`. Flips locking test `11.6-INT-015 (F#44)` in `packages/tranquilload-core/src/multipart/chunking-edges.test.ts` from "accepted, byte-fidelity preserved" → "rejected at the boundary with `TypeError`".

2. **Given** an S3 object key longer than 1024 chars **When** `s3MultipartUpload` is constructed / `initiate` is invoked **Then** it rejects pre-flight with `InitiateUploadError` BEFORE calling `createMultipartUpload` — by adding a key-length guard alongside the existing pre-flight `chunkSize < S3_MIN_PART_SIZE` guard at `packages/tranquilload-adapters/src/protocols/s3-multipart-upload.ts:36-40`. Guard lives in the **S3 adapter** (S3-specific 1024-byte limit), per the architecture rule "protocol constraints live in the adapter, never in the core". Flips locking test `11.7-INT-002 (G#19)` in `packages/tranquilload-adapters/src/protocols/s3-multipart-upload-filename-edges.test.ts` from "adapter does NOT pre-validate" → "pre-flight `InitiateUploadError` rejection, no `createMultipartUpload` call".

3. **Given** a caller whose `totalBytes / chunkSize` would exceed S3's 10,000-part maximum **When** the caller validates configuration **Then** a **caller-side helper** in `packages/tranquilload-adapters/src/resilience/optimal-part-size.ts` surfaces the overflow (throw or typed error) — the 10k limit is S3-specific and MUST NOT live in the protocol-agnostic core. **Additive** (new helper + new test), NOT a flip — `11.6-INT-013 (F#42)`'s 8-byte/chunkSize=1 case (8 parts) never reaches 10k, so it stays a valid unrelated lock. See **DD1**.

4. **Given** an empty source stream passed to `uploadOnce` **When** the upload runs **Then** behaviour follows the policy chosen in **DD2** — either rejects with a typed error OR preserves the current `UploadCompleted totalParts:1` (`packages/tranquilload-core/src/oneshot/upload.ts:43-45`) behind an explicit opt-in. Flips/refines locking test `11.6-INT-012 (F#39)` in `packages/tranquilload-core/src/oneshot/edges.test.ts`. **⚠️ This guard is NOT trivial — see Design Decisions DD2.**

## Tasks / Subtasks

- [ ] Task 1: Non-integer `chunkSize` guard (AC: #1)
  - [ ] Extend the guard at `upload-stream.ts:148` to `!Number.isFinite(chunkSize) || chunkSize <= 0 || !Number.isInteger(chunkSize)` and update the `TypeError` message to mention "positive finite integer"
  - [ ] Flip `chunking-edges.test.ts` 11.6-INT-015 (F#44): assert `uploadMultipart` throws/rejects `TypeError` for `chunkSize: 1024.7`, no `uploadPart` call; remove the "locks current behaviour" comment block
  - [ ] Confirm `chunkSize: 1` (11.6-INT-013) still passes unchanged (integer, valid)

- [ ] Task 2: >1024-char S3 key pre-flight guard (AC: #2)
  - [ ] Add a key-length guard next to the existing `chunkSize < S3_MIN_PART_SIZE` check (`s3-multipart-upload.ts:36`). S3's documented limit is **1024 bytes** (UTF-8), not 1024 chars — use a byte-length check (`new TextEncoder().encode(key).length > 1024`), document the byte-vs-char nuance
  - [ ] Throw `new InitiateUploadError(new Error("S3 object key exceeds 1024 bytes: <len>"))` — see **DD3** re: the existing sibling guard throwing plain `Error`
  - [ ] Flip `s3-multipart-upload-filename-edges.test.ts` 11.7-INT-002 (G#19): assert pre-flight `InitiateUploadError`, `createMultipartUpload` NOT called (mock call-counter = 0); remove the "Epic 13 candidate" comment
  - [ ] Confirm the special-char key test (11.7-INT-001) still passes unchanged

- [ ] Task 3: S3 10k-part caller-side helper (AC: #3) — see **DD1**
  - [ ] Add `assertS3PartCount(totalBytes: number, chunkSize: number): void` (or extend `computeOptimalPartSize`) in `optimal-part-size.ts` — throw when `Math.ceil(totalBytes / chunkSize) > 10_000`
  - [ ] Export it from the adapters barrel (check `packages/tranquilload-adapters/src/index.ts` export convention; `types` before `import`/`require` in package.json exports per MEMORY)
  - [ ] New test in `optimal-part-size.test.ts` (F#42-adjacent): `assertS3PartCount` throws at >10k, passes at exactly 10k and below
  - [ ] Update README/doctest if `computeOptimalPartSize` examples reference part-count (only if touched)

- [ ] Task 4: Empty one-shot policy (AC: #4) — **DD2 RESOLVED = (a) `allowEmpty` opt-in (2026-06-11, Project Lead)**
  - [ ] Add `allowEmpty?: boolean` to `UploadOnceOptions` (`oneshot/upload.ts` + `index.ts` dual-API), **default `true`** = current `totalParts:1` behaviour → **non-breaking**
  - [ ] Document the foot-gun in the option's TSDoc: "an empty source still emits a successful one-shot (one PUT regardless of byte count); set `allowEmpty: false` to reject zero-byte uploads"
  - [ ] When `allowEmpty: false` AND the source yields zero bytes, fail with a typed error BEFORE the PUT. Enforcement note: the lib never sees the bytes today (user owns `upload(stream)`), so rejection requires reading the FIRST chunk to test for done-with-zero-bytes (a bounded first-chunk peek, then re-prepend the chunk to the stream). This is a *minimal* peek — NOT the full tee/buffer of rejected option (b). If a clean re-prepend isn't achievable without risking backpressure, keep `allowEmpty:false` as documented-but-unenforced and record the limitation in Completion Notes (honest-scope, MEMORY Pattern 3)
  - [ ] Flip/refine `oneshot/edges.test.ts` 11.6-INT-012 (F#39): default arm (`allowEmpty` unset) still asserts `UploadCompleted totalParts:1`; add an `allowEmpty: false` arm asserting the typed rejection (or the documented limitation if enforcement is deferred)

- [ ] Task 5: Changesets (pre-1.0 PATCH — MEMORY: pre-1.0 peerDep changesets MUST be `patch`)
  - [ ] `@tranquilload/core` patch changeset (chunkSize guard; empty-one-shot if DD2 changes core)
  - [ ] `@tranquilload/adapters` patch changeset (S3 key guard; 10k helper)
  - [ ] Note in changeset: these reject previously-accepted-but-invalid input — technically breaking but pre-1.0 patch per the versioning rule

- [ ] Task 6: Triptyque verification (MEMORY: mandatory)
  - [ ] `pnpm turbo build` green
  - [ ] `pnpm -r test` green (core + adapters; updated + new tests)
  - [ ] `pnpm turbo typecheck` green

- [ ] Task 7: Traceability
  - [ ] Record the 4 flips/additions (start `traceability-report-epic-13.md` or note in the story) — note 11.6-INT-015, 11.7-INT-002, 11.6-INT-012 flipped; 10k helper test added

## Dev Notes

### Spec inputs

- Source: `_bmad-output/planning-artifacts/epics.md § Story 13.1` (acceptance criteria, quick-win tier)
- Backlog origin: `_bmad-output/implementation-artifacts/epic-11-retro-2026-06-11.md § Epic 13 Candidate Backlog` (4 items: >1024 key, 10k-part F#42, non-integer chunkSize F#44, empty one-shot F#39)
- Risk clusters: R-P2-7, R-P2-13, R-P2-14 (all surface-area edges)

### This story CHANGES behaviour (critical distinction from Epic 11)

Epic 11 wrote tests that LOCK current behaviour. Epic 13 stories FLIP those locks. For each guard, the existing test currently asserts the OLD (lenient/missing-guard) behaviour with an explicit `// Epic 13 candidate` / `locks current behaviour` comment. The dev's job: change the lib, then invert the assertion + strip the candidate comment. Do NOT add a second parallel test — edit the existing one (avoids the coverage-regression / duplication trap, per the Story 11.2/11.3 review lesson).

### Exact source sites (API-validation pass, 2026-06-11)

| Guard | Site | Current state | Change |
|---|---|---|---|
| Non-integer chunkSize | `core/src/multipart/upload-stream.ts:148` | `if (!Number.isFinite(chunkSize) || chunkSize <= 0) throw new TypeError(...)` | add `|| !Number.isInteger(chunkSize)` |
| >1024 S3 key | `adapters/src/protocols/s3-multipart-upload.ts:36` | pre-flight `chunkSize < S3_MIN_PART_SIZE` guard exists (throws plain `Error`); NO key check | add byte-length key guard throwing `InitiateUploadError` |
| 10k-part | `adapters/src/resilience/optimal-part-size.ts:21` (`computeOptimalPartSize`) | no part-count cap | add `assertS3PartCount` helper |
| Empty one-shot | `core/src/oneshot/upload.ts:30` (user owns `upload(stream)`), emit at `:43-45` (`totalParts: 1`) | lib NEVER sees bytes — hands raw stream to user callback | see DD2 |

- `InitiateUploadError` ctor: `new InitiateUploadError(cause: unknown)` (`core/src/errors/upload-error.ts:36`). Carries `cause`, `_tag`, fixed message "Failed to initiate multipart upload".

### Design decisions to resolve (call these out — do not silently pick)

- **DD1 — 10k guard placement.** The S3 adapter does NOT receive `totalBytes` (only `chunkSize`); only the *caller* knows the file size. So the 10k check CANNOT be auto-embedded in `s3MultipartUpload` — it MUST be a **caller-side helper** (`assertS3PartCount` / extended `computeOptimalPartSize`). Recommendation: standalone exported helper, caller invokes it. (This is why the epic says "caller-side".)
- **DD2 — empty one-shot — RESOLVED = (a) `allowEmpty` opt-in (2026-06-11, Project Lead).** The lib hands the raw `ReadableStream` to the user's `upload(stream)` callback and never reads the bytes itself, so it has no byte count to gate on. **Decision: add `allowEmpty?: boolean` defaulting to `true`** (current `totalParts:1` preserved, non-breaking) + document the foot-gun. `allowEmpty: false` enforcement uses a bounded first-chunk peek (NOT the rejected full-tee option b); if that can't be done cleanly without backpressure risk, keep it documented-but-unenforced and record the limitation (honest-scope). Rejected: (b) full tee/peek streaming change; (c) defer.
- **DD3 — error-type consistency.** The existing sibling guard (`chunkSize < S3_MIN_PART_SIZE`) throws plain `new Error`, but AC#2 wants `InitiateUploadError` for the key case. Throw `InitiateUploadError` for the new guard (per AC). Whether to also upgrade the existing chunkSize guard to a typed error is **out of scope** (separate cleanup) — flag it, don't fix it here.

### Critical patterns (MEMORY)

- **Pre-1.0 changesets MUST be `patch`** — `minor` + `workspace:^` peerDep = unwanted jump to 1.0.0. (`project_pre1_peerdep_changesets_trap.md`)
- **Surgical tests** — assert the EXACT error type/`_tag` and message, not just "throws". (`feedback_surgical_tests.md`)
- **Typecheck mandatory** — build + test + typecheck triptyque per story. (`feedback_typecheck_mandatory.md`)
- **F#N prefix** on test descriptions — preserve when flipping.
- **Export map order** — `types` before `import`/`require` if touching package.json exports for the new helper.
- **MinIO NOT required** — all four locking tests mock S3 / use stub callbacks; no Docker needed for this story. (Smoke against MinIO only if a doctest example is touched.)

### Files likely touched

- **Modified (lib):** `core/src/multipart/upload-stream.ts`, `adapters/src/protocols/s3-multipart-upload.ts`, `adapters/src/resilience/optimal-part-size.ts`, possibly `core/src/oneshot/upload.ts` + `oneshot/index.ts` (DD2-dependent), `adapters/src/index.ts` (export new helper)
- **Modified (tests):** `chunking-edges.test.ts` (flip 11.6-INT-015), `s3-multipart-upload-filename-edges.test.ts` (flip 11.7-INT-002), `optimal-part-size.test.ts` (new 10k test), `oneshot/edges.test.ts` (DD2-dependent)
- **Added:** 2 changesets (`.changeset/*.md`)
- **Modified:** this story file; sprint-status.yaml; traceability

### Out of scope

- Auto-embedding the 10k check inside `s3MultipartUpload` (adapter lacks `totalBytes` — DD1)
- Tee/peek streaming change for empty-one-shot (DD2 option b)
- Upgrading the existing `chunkSize < S3_MIN_PART_SIZE` guard to a typed error (DD3)
- The other 5 Epic 13 stories (13.2–13.6)

## References

- [Source: _bmad-output/planning-artifacts/epics.md § Story 13.1]
- [Source: _bmad-output/implementation-artifacts/epic-11-retro-2026-06-11.md § Epic 13 Candidate Backlog]
- [Source: _bmad-output/brainstorming/brainstorming-session-2026-05-17-001.md] — F#39, F#42, F#44, G#19
- [Locking tests: chunking-edges.test.ts (11.6-INT-015/013), s3-multipart-upload-filename-edges.test.ts (11.7-INT-002), oneshot/edges.test.ts (11.6-INT-012)]
- [MEMORY: project_pre1_peerdep_changesets_trap.md, feedback_surgical_tests.md, feedback_typecheck_mandatory.md]

## Dev Agent Record

### Agent Model Used

claude-opus-4-8 (Opus 4.8) — dev per the permanent Epics 6–9 rule (Opus for dev AND review).

### Debug Log References

### Completion Notes List

### Change Log

### File List
