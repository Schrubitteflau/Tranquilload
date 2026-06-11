---
baseline_commit: 792b037
---

# Story 13.1: API-Boundary Input Guards

Status: done

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

- [x] Task 1: Non-integer `chunkSize` guard (AC: #1)
  - [x] Extended the guard at `upload-stream.ts:148` to `!Number.isFinite(chunkSize) || chunkSize <= 0 || !Number.isInteger(chunkSize)`; message now "positive finite integer"
  - [x] Flipped `chunking-edges.test.ts` 11.6-INT-015 (F#44): plain `it` asserting `uploadMultipartEffect` throws `TypeError` (sync, at construction) for `chunkSize: 1024.7`, 0 `uploadPart` calls; old byte-fidelity lock removed
  - [x] `chunkSize: 1` (11.6-INT-013) still passes (integer, valid). Also updated 3 pre-existing message-regex assertions in `upload-stream.test.ts` (negative/NaN/Infinity) `number` → `integer`

- [x] Task 2: >1024-byte S3 key pre-flight guard (AC: #2)
  - [x] Added a byte-length guard (`new TextEncoder().encode(key).length > 1024`) next to the existing `chunkSize < S3_MIN_PART_SIZE` check at construction; documented the byte-vs-char nuance in a comment
  - [x] Throws `new InitiateUploadError(new Error("S3 object key exceeds the 1024-byte limit: <len> bytes"))` (DD3: new guard uses the typed error; existing sibling chunkSize guard left as plain `Error` — out of scope)
  - [x] Flipped `s3-multipart-upload-filename-edges.test.ts` 11.7-INT-002 (G#19): test 1 asserts construction throws `InitiateUploadError` + `createMultipartUpload` not called; test 2 repurposed as a 1024-byte boundary test (passes through)
  - [x] Special-char key test (11.7-INT-001) still passes unchanged

- [x] Task 3: S3 10k-part caller-side helper (AC: #3) — DD1
  - [x] Added `assertS3PartCount(totalBytes, chunkSize): void` + `S3_MAX_PARTS = 10_000` in `optimal-part-size.ts` — throws `RangeError` when `Math.ceil(totalBytes / chunkSize) > 10_000`, `TypeError` on bad chunkSize
  - [x] Ships through the existing `@tranquilload/adapters/optimalPartSize` entry (same file → tsdown entry); no package.json change needed
  - [x] 4 new tests in `optimal-part-size.test.ts`: within-limit, exactly-10k boundary, >10k RangeError, bad-chunkSize TypeError
  - [x] No README/doctest reference to part-count — nothing to update

- [x] Task 4: Empty one-shot policy (AC: #4) — DD2 = (a) `allowEmpty` opt-in
  - [x] Added `allowEmpty?: boolean` to `UploadOnceOptions` (flows through `uploadOnce` public API via the existing `...options` spread), default `true` → non-breaking
  - [x] TSDoc documents the one-shot foot-gun + the `allowEmpty: false` opt-out
  - [x] Implemented enforcement via a bounded first-chunk peek (`peekNonEmpty`, demand-driven `pull`, skips leading zero-length chunks, re-prepends the first non-empty chunk). Empty → `CompleteUploadError`. **Enforcement WORKS** — no honest-scope fallback needed
  - [x] `oneshot/edges.test.ts` 11.6-INT-012: default arm preserved (`totalParts:1`); +2 arms — `allowEmpty:false` empty → `CompleteUploadError`, callback NOT invoked; `allowEmpty:false` non-empty → peek re-prepends, byte-fidelity preserved, completes

- [x] Task 5: Changesets (pre-1.0 PATCH)
  - [x] `.changeset/epic13-core-input-guards.md` — `@tranquilload/core` patch (chunkSize guard + allowEmpty)
  - [x] `.changeset/epic13-adapters-s3-guards.md` — `@tranquilload/adapters` patch (S3 key guard + assertS3PartCount)
  - [x] Both note the reject-previously-accepted-input nuance; pre-1.0 patch per the versioning rule

- [x] Task 6: Triptyque verification
  - [x] `pnpm turbo build` green (2/2)
  - [x] `pnpm -r test` green — core 206/206, adapters 59/59
  - [x] `pnpm turbo typecheck` green (5/5)

- [x] Task 7: Traceability
  - [x] Recorded below (Completion Notes): 11.6-INT-015, 11.7-INT-002, 11.6-INT-012 flipped; assertS3PartCount tests added. Epic 13 traceability report deferred to first review (no `traceability-report-epic-13.md` scaffold yet)

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

- `pnpm -r test` (1st run): 3 FAIL in `upload-stream.test.ts` — pre-existing negative/NaN/Infinity chunkSize tests asserted the old `/positive finite number/` message; my message change to "integer" broke the regex. Fixed (regex → `/positive finite integer/`); values still correctly rejected.
- `pnpm -r test` (2nd run): ✅ core 206/206, adapters 59/59.
- `pnpm turbo build` ✅ 2/2 · `pnpm turbo typecheck` ✅ 5/5.

### Completion Notes List

- **First behaviour-CHANGING Epic 13 story — all 4 guards landed, 3 locking tests flipped + 1 helper added.** Unlike Epic 11's surface-area locks, this story changed the lib AND inverted the existing assertions (no duplicate tests).
- **Guard 1 (non-integer chunkSize):** extended the existing sync `TypeError` guard at `upload-stream.ts:148` with `!Number.isInteger`. The guard throws at construction (when `uploadMultipartEffect(options)` is evaluated), so 11.6-INT-015 flipped to a plain `it` with `expect(construct).toThrow(TypeError)` + `/positive finite integer/` + 0 uploadPart calls.
- **Guard 2 (>1024-byte key):** byte-length guard (`TextEncoder`) at `s3MultipartUpload` construction, throwing `InitiateUploadError` before any SDK call. 11.7-INT-002's two tests: test-1 flipped to assert construction throws + `createMultipartUpload` not called; test-2 (formerly "S3 rejects oversized key" — now unreachable with a pre-flight guard) repurposed as a 1024-byte boundary pass-through test.
- **Guard 3 (10k-part):** new `assertS3PartCount` + `S3_MAX_PARTS` in `optimal-part-size.ts` (DD1: caller-side, since the adapter never receives `totalBytes`). `RangeError` on overflow, `TypeError` on bad chunkSize. Ships via the existing `./optimalPartSize` entry — no package.json change. **Additive** (4 new tests), not a flip — 11.6-INT-013's 8-byte case never reaches 10k.
- **Guard 4 (empty one-shot, DD2 = a):** `allowEmpty?: boolean` (default `true`, non-breaking) on `UploadOnceOptions`. `allowEmpty: false` enforcement implemented via `peekNonEmpty` — a **bounded** first-chunk peek (demand-driven `pull`, re-prepends the first non-empty chunk, skips leading zero-length chunks). Empty → `CompleteUploadError`. The honest-scope fallback (documented-but-unenforced) was NOT needed — enforcement works, proven by the byte-fidelity arm. The peek runs ONLY on the opt-in path; the default path is byte-for-byte untouched (zero regression risk).
- **DD3:** new key guard uses `InitiateUploadError` per AC; the existing sibling `chunkSize < S3_MIN_PART_SIZE` guard still throws plain `Error` — upgrading it is out of scope (flagged).
- **Traceability flips:** 11.6-INT-015 (F#44), 11.7-INT-002 (G#19), 11.6-INT-012 (F#39) flipped from "documents gap" → "validates fix"; `assertS3PartCount` tests added (F#42-adjacent). No `traceability-report-epic-13.md` scaffolded yet — defer to review/retro.
- **Scope note:** e2e/integration tiers (`tests/`, MinIO/Playwright) NOT run — out of scope per the story (all 4 guards are unit-level; S3 mocked). Triptyque (build+test+typecheck) is the gate for this story.
- **Reviewer flags:** (1) verify the `peekNonEmpty` cancel/error propagation is sound (reader lock release on cancel); (2) confirm `InitiateUploadError` at construction-time (vs initiate-phase) is acceptable semantically; (3) the boundary repurpose of 11.7-INT-002 test-2 — confirm it still adds incremental value over test-1.

### Change Log

- 2026-06-11 — Story 13.1 dev (Opus 4.8): 4 API-boundary guards. **Lib:** `upload-stream.ts` (non-integer chunkSize), `s3-multipart-upload.ts` (>1024-byte key → InitiateUploadError), `optimal-part-size.ts` (assertS3PartCount + S3_MAX_PARTS), `oneshot/upload.ts` (allowEmpty opt-in + peekNonEmpty). **Tests:** flipped 11.6-INT-015, 11.7-INT-002 (×2), 11.6-INT-012 (default + 2 arms); added 4 assertS3PartCount tests; fixed 3 message regexes in upload-stream.test.ts. **2 patch changesets.** Triptyque green (build 2/2, core 206/206, adapters 59/59, typecheck 5/5). No e2e (out of scope).

### File List

- **Modified (lib):** `packages/tranquilload-core/src/multipart/upload-stream.ts`
- **Modified (lib):** `packages/tranquilload-core/src/oneshot/upload.ts`
- **Modified (lib):** `packages/tranquilload-adapters/src/protocols/s3-multipart-upload.ts`
- **Modified (lib):** `packages/tranquilload-adapters/src/resilience/optimal-part-size.ts`
- **Modified (test):** `packages/tranquilload-core/src/multipart/chunking-edges.test.ts`
- **Modified (test):** `packages/tranquilload-core/src/multipart/upload-stream.test.ts`
- **Modified (test):** `packages/tranquilload-core/src/oneshot/edges.test.ts`
- **Modified (test):** `packages/tranquilload-adapters/src/protocols/s3-multipart-upload-filename-edges.test.ts`
- **Modified (test):** `packages/tranquilload-adapters/src/resilience/optimal-part-size.test.ts`
- **Added:** `.changeset/epic13-core-input-guards.md`
- **Added:** `.changeset/epic13-adapters-s3-guards.md`
- **Modified:** `_bmad-output/implementation-artifacts/13-1-api-boundary-input-guards.md` (this file)
- **Modified:** `_bmad-output/implementation-artifacts/sprint-status.yaml` (13-1 → in-progress → review → done)

## Senior Developer Review (AI)

**Reviewer:** independent Opus 4.8 `code-reviewer` agent (fresh context — Codex unavailable; another Opus stands in per user direction).
**Date:** 2026-06-11
**Outcome:** ✅ **Approve** — 0 HIGH / 0 MEDIUM / 4 LOW (all informational, no change recommended).

### Verdict

Clean, well-scoped behaviour-changing guard story. All four guards correct; the 10k boundary math is pinned on both sides (10_000 passes, 10_001 throws); no default behaviour changed (peek runs only on the `allowEmpty:false` opt-in path); the flipped tests assert the new behaviour with exact error types + messages (not tautologies). The dev's three scrutiny flags all hold: (A) `peekNonEmpty` releases the reader lock on every reachable path (done → `releaseLock`, cancel → `reader.cancel` which releases per spec, error → source already dead), no new hang/leak vs the default path, and the byte-fidelity arm proves the re-prepend is non-corrupting; (B) throwing `InitiateUploadError` at construction is defensible for a pre-flight config fault and consistent with the sibling guard's construction-time throw; (C) the repurposed 11.7-INT-002 test-2 adds real incremental value (pins `>` vs `>=` and proves the key forwards uncorrupted). Tests were edited in place (not duplicated) — no coverage-regression trap.

### Findings (all LOW / informational — no change applied)

- **LOW-1** (`oneshot/upload.ts` peek error path): the `pull` error path doesn't explicitly `releaseLock()` if `reader.read()` rejects after the first chunk — but the source is already dead in that case, so no functional leak/hang; consistent with native stream semantics. No change.
- **LOW-2** (`oneshot/upload.ts` cancel): `cancel` calls `reader.cancel(reason)` without `releaseLock()` — correct, `cancel()` implicitly releases the lock per the Streams spec. No change.
- **LOW-3** (`s3-multipart-upload.ts` DD3): new key guard throws typed `InitiateUploadError` while the sibling chunkSize guard throws plain `Error` at the same site — asymmetric but explicitly scoped out (DD3); chunkSize-guard upgrade flagged for a future cleanup. No change.
- **LOW-4** (`optimal-part-size.ts`): `assertS3PartCount` doesn't reject non-integer chunkSize (unlike the core guard) — different responsibility (part-count vs format); the core integer guard is the authoritative format gate. No change.

**Dev decision: no changes applied** — concur with the reviewer. `receiving-code-review` skepticism applied: all 4 LOWs are informational with no reachable failure mode, and the reviewer self-policed against padding. A clean 0H/0M on a small, well-scoped guard story is the expected outcome. Triptyque re-verified green post-review (core 206/206, adapters 59/59).
