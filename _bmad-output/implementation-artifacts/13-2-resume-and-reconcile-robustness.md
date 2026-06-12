---
baseline_commit: 88f7253
---

# Story 13.2: Resume & Reconcile Robustness

Status: ready-for-dev

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a library maintainer,
I want the resume/reconcile path to recover from two documented stale-state gaps (a deleted/GC'd `uploadId` reported as `NoSuchUpload`, and the S3 adapter not threading a resumed `uploadId` into part signing),
so that a cross-session resume against drifted server-side state recovers gracefully instead of dead-ending in `ReconcileError` or signing presigned URLs against an empty `uploadId`.

> **⚠️ This is a behaviour-CHANGING story, not a test-only lock.** Like Story 13.1 (and unlike Epic 11, which *locked* current behaviour), AC#1 *changes* library behaviour AND flips an existing locking test from "documents the gap" → "validates the fix". The dev MUST edit the named test file in place: strip the `// CURRENT BEHAVIOUR — Epic 13 candidate` comment, invert the assertion, keep the `F#N` / test-ID prefix. Do NOT add a parallel test (coverage-regression / duplication trap, per the 11.2/11.3 review lesson). AC#2 is **net-new** (no existing lock to flip — see DD2).

> **🔻 Scope note (decided 2026-06-12, Project Lead, via API-validation pass).** Epic 13.2's epic-level AC named **three** sub-changes. This story ships **two** (AC#1 `reinitOnStale`, AC#2 `resumeUploadId`) and **DEFERS the third** — "detect/re-upload a GC'd reconciled part" (flips 11.3-INT-005 / F#14) — because it carries a genuine memory-safety + protocol-agnostic-detection tension that makes it *not* a quick-win flip (see **DD3 — Deferred** and `epics.md § Story 13.2`). `11.3-INT-005` stays a LOCK; the dev only **re-tags its comment** to point at the deferral (no flip).

## Acceptance Criteria

1. **Given** a persisted `uploadId` the server reports as `NoSuchUpload` (deleted / GC'd) on the resume reconcile, **and** an opt-in `reinitOnStale` predicate plus an `initiate` callback are supplied, **When** the upload runs **Then** the lib auto-reinitiates a fresh multipart from part 1 and completes (emitting a fresh `UploadInitiated` for the new `uploadId`), instead of failing with `ReconcileError`. With **no** `reinitOnStale` (default), the current fail-fast `ReconcileError` is preserved. Flips locking test `11.3-INT-003 (F#12)` in `packages/tranquilload-core/src/multipart/resume-error-edges.test.ts` from "surfaces `ReconcileError`, no auto-reinit (`uploadPartCalls === 0`)" → "re-initiates and completes from part 1 (`uploadPartCalls === 2`, terminal `UploadCompleted`)". Corroborated by persona `11.4-E2E-007 (C2)`.

2. **Given** a cross-session resume where the consumer never calls `initiate` in the new session, **When** `s3MultipartUpload` signs presigned URLs inside `uploadPart`, **Then** it threads a caller-supplied `resumeUploadId` option (new on `S3MultipartUploadOptions`) into `getPresignedUrl(partNumber, uploadId)` instead of the empty `storedUploadId = ""` closure (`packages/tranquilload-adapters/src/protocols/s3-multipart-upload.ts:52`, set only inside `initiate`). With **no** `resumeUploadId` (default), behaviour is unchanged (`storedUploadId` starts `""`, set by `initiate` as today). **Net-new** adapter test (no existing lock to flip — see DD2), proving `getPresignedUrl` receives the real `resumeUploadId` without any `initiate` call.

3. **(DEFERRED — DD3, not implemented this story.)** The epic-level "re-upload a GC'd reconciled part" sub-change is descoped to a follow-up spike. The dev's only action: **re-tag** the existing comment on locking test `11.3-INT-005 (F#14)` in `resume-error-edges.test.ts` from "Epic 13 candidate: detect/re-upload a GC'd reconciled part" → "DEFERRED from Story 13.2 (DD3) — memory-safety + protocol-agnostic-detection tension; see Story 13.2 Dev Notes". The test stays GREEN and unflipped (still locks the current `CompleteUploadError`-at-complete behaviour).

## Tasks / Subtasks

- [ ] Task 1: `reinitOnStale` predicate + reinit orchestration (AC: #1) — core
  - [ ] Add `readonly reinitOnStale?: (cause: unknown) => boolean` to `UploadMultipartOptions` (`upload-stream.ts`), with TSDoc: opt-in; receives the **raw** reconcile rejection (pre-`ReconcileError`); return `true` to abandon the stale `uploadId` and re-initiate from part 1; **requires `initiate` to be present** (without it, a stale match falls through to `ReconcileError`).
  - [ ] Destructure `reinitOnStale` in the options block (`upload-stream.ts:133-146`).
  - [ ] **Reorder:** move the `runFreshInit` Effect definition (`:197-217`) ABOVE the reconcile block (`:189-195`) so it can be reused on reinit. (It has no dependency on `reconciledMap`.)
  - [ ] Replace the eager reconcile (`:189-195`) with a reconcile Effect that yields `{ map, reinitEvent: Option<UploadInitiated> }`:
    - success → `{ map: new Map(parts...), reinitEvent: Option.none() }`
    - failure → in `catchAll((rawCause) => ...)`: if `reinitOnStale?.(rawCause) === true && initiate !== undefined`, run `runFreshInit` → `{ map: new Map() /* empty, fresh from part 1 */, reinitEvent: Option.some(event) }`; else `Effect.fail(new ReconcileError(rawCause))`. **Critical:** the predicate must see the RAW cause, so replace the current `Effect.mapError(... ReconcileError)` with a `catchAll` (the raw rejection flows through `normalizeCallback`'s error channel).
  - [ ] Make `setupStream` reinit-aware: when `Option.isSome(reinitEvent)`, emit the captured `UploadInitiated` (refUploadId already set by `runFreshInit`) and SKIP both `runResumeSetup` and a second `runFreshInit` (no double-initiate). Branch order: reinit → resume → fresh-init → empty.
  - [ ] Flip `resume-error-edges.test.ts` 11.3-INT-003 (F#12): add `initiate: () => ({ uploadId: "reinit-fresh-id" })` + `reinitOnStale: (cause) => (cause as { Code?: string })?.Code === "NoSuchUpload"`; invert assertions → upload completes, `uploadPartCalls === 2` (20 bytes / chunkSize 10), terminal event is `UploadCompleted` with `uploadId: "reinit-fresh-id"` and `totalParts: 2`; strip the `// CURRENT BEHAVIOUR — Epic 13 candidate` comment, keep the `11.3-INT-003 (F#12)` prefix, update the description to "...auto-reinitiates and completes from part 1".

- [ ] Task 2: `resumeUploadId` adapter option (AC: #2) — S3 adapter (net-new, DD2)
  - [ ] Add `readonly resumeUploadId?: string` to `S3MultipartUploadOptions` (`s3-multipart-upload.ts:20-26`), TSDoc: cross-session resume — seeds `storedUploadId` so `uploadPart` signs against the resumed `uploadId` when `initiate` is not called this session.
  - [ ] Change `let storedUploadId = ""` (`:52`) → seed from the option: `let storedUploadId = options.resumeUploadId ?? ""` (destructure `resumeUploadId` in the `const { ... } = options` block at `:34` for consistency).
  - [ ] Add a net-new test in `s3-multipart-upload.test.ts`: construct with `resumeUploadId: "resumed-upload-id"`, call `uploadPart(1, chunk)` WITHOUT calling `initiate`, assert `getPresignedUrl` was invoked with `(1, "resumed-upload-id")` (not `""`). Add a sibling assertion that the default (no `resumeUploadId`) still passes `""` to `getPresignedUrl` pre-`initiate` (guards the non-breaking default). Mock `fetch` to return an `ok` response with an `ETag` header (mirror the existing `uploadPart` tests' fetch stub).

- [ ] Task 3: Re-tag the deferred lock (AC: #3) — DD3
  - [ ] In `resume-error-edges.test.ts`, edit ONLY the comment block above 11.3-INT-005 (F#14): replace "Epic 13 candidate: detect/re-upload a GC'd reconciled part instead of failing at complete." with a one-to-two-line note that this is DEFERRED from Story 13.2 (DD3) for memory-safety (reconciled chunks are discarded after the skip, source stream is drained by complete phase) + protocol-agnostic-detection (core can't identify the S3 `InvalidPart` part) reasons. **Do NOT flip the assertion** — the test stays green, still locking `CompleteUploadError` at complete.

- [ ] Task 4: Changesets (pre-1.0 PATCH)
  - [ ] `.changeset/epic13-core-reinit-on-stale.md` — `@tranquilload/core` patch (opt-in `reinitOnStale`).
  - [ ] `.changeset/epic13-adapters-resume-upload-id.md` — `@tranquilload/adapters` patch (opt-in `resumeUploadId`).
  - [ ] Both note "opt-in, default behaviour unchanged"; pre-1.0 patch per the versioning rule.

- [ ] Task 5: Triptyque verification
  - [ ] `pnpm turbo build` green
  - [ ] `pnpm -r test` green (core + adapters; note new counts)
  - [ ] `pnpm turbo typecheck` green

- [ ] Task 6: Traceability + docs
  - [ ] Record below: 11.3-INT-003 flipped; resumeUploadId net-new test added; 11.3-INT-005 re-tagged (not flipped).
  - [ ] Check whether the README documents `reconcileCompletedParts` / resume in a way that should mention `reinitOnStale` or the adapter `resumeUploadId`. If a README `ts` fenced block changes, the doctest harness re-checks it (smoke). If untouched, nothing to update.

## Dev Notes

### Spec inputs

- Source: `_bmad-output/planning-artifacts/epics.md § Story 13.2` (acceptance criteria, quick-win tier; sub-change 3 descoped 2026-06-12).
- Backlog origin: `_bmad-output/implementation-artifacts/epic-11-retro-2026-06-11.md § Epic 13 Candidate Backlog`.
- Genealogy: `brainstorming-session-2026-05-17-001.md` — F#12, F#14.
- Risk cluster: R-P2-6 (resume + reconcile). Persona corroboration: `11.4-E2E-007 (C2)`.

### This story CHANGES behaviour (critical distinction from Epic 11)

Epic 11 wrote tests that LOCK current behaviour. Epic 13 stories FLIP those locks. AC#1's existing test (11.3-INT-003) currently asserts the OLD (no-reinit) behaviour with an explicit `// CURRENT BEHAVIOUR — Epic 13 candidate` comment; the dev changes the lib, then inverts the assertion + strips the comment IN PLACE. AC#2 is net-new (no lock exists — DD2). AC#3 is deferred (re-tag only — DD3).

### Exact source sites (API-validation pass, 2026-06-12)

| Change | Site | Current state | Change |
|---|---|---|---|
| `reinitOnStale` option | `core/src/multipart/upload-stream.ts:45-121` (`UploadMultipartOptions`) | no such option | add `readonly reinitOnStale?: (cause: unknown) => boolean` |
| reinit orchestration | `upload-stream.ts:189-195` (eager reconcile → `reconciledMap`) + `:197-217` (`runFreshInit`) + `:236-241` (`setupStream`) | reconcile `mapError → ReconcileError`, fails the stream; `runFreshInit` only used by fresh-init `setupStream` branch | reorder `runFreshInit` above reconcile; reconcile `catchAll` → reinit-or-fail; `setupStream` reinit branch |
| `resumeUploadId` option | `adapters/src/protocols/s3-multipart-upload.ts:20-26` (`S3MultipartUploadOptions`) + `:52` (`let storedUploadId = ""`) | option absent; `storedUploadId` starts `""`, set only in `initiate` | add option; `let storedUploadId = options.resumeUploadId ?? ""` |

- `ReconcileError` ctor: `new ReconcileError(cause: unknown)` (`core/src/errors/upload-error.ts`). The current reconcile path wraps via `Effect.mapError((cause) => new ReconcileError(cause))` — replacing that with `catchAll` exposes the **raw** `cause` to the predicate (then re-wrap on the fail branch).
- `runFreshInit` returns `UploadInitiated` and already: sets `refUploadId`, captures `getContentDigest` (if present), returns the event. Reusing it on reinit gives correct fresh-id wiring + observability for free. It maps initiate failures → `InitiateUploadError`, which is the correct phase for a reinit-initiate failure.
- The reconciled-skip branch is `makeUploadOne` `:248-260`: a reconciled part forwards the etag and is NOT PUT. On reinit we pass an EMPTY `reconciledMap`, so every part (1..n) is uploaded fresh — exactly the AC#1 "from part 1" semantics.

### Design decisions (call these out — do not silently re-pick)

- **DD1 — `reinitOnStale` is a PREDICATE, not a boolean (RESOLVED, 2026-06-12).** The core is protocol-agnostic and MUST NOT sniff `cause.Code === "NoSuchUpload"` (S3-specific) — same architecture rule that kept 13.1's key/10k guards in the adapter. So staleness detection is **caller-supplied**: `(cause: unknown) => boolean`. The caller (who knows their protocol) decides what "stale/GC'd" means. Default `undefined` → current fail-fast. **`reinitOnStale` requires `initiate`** to create the fresh multipart; if the predicate matches but `initiate` is absent, the lib falls through to `ReconcileError` (current behaviour) rather than throwing — keeping the option purely additive. Document this requirement in the TSDoc. (Considered + rejected: a pre-flight `if (reinitOnStale && !initiate) throw` — it would reject valid configs where reconcile never goes stale; the fall-through is less surprising.)
- **DD2 — AC#2 is NET-NEW, not a flip.** `s3-multipart-upload.test.ts` only exercises `uploadPart` AFTER `initiate` (so `storedUploadId` is already set); there is no existing lock asserting the empty-`storedUploadId`-on-resume gap. So AC#2 ADDS a test (resume-without-initiate path). This is the one place the epic's "flip the lock in place" framing does not apply. Prefer an **option** (`resumeUploadId`) over a setter: idempotent, no extra mutable surface, set once at construction.
- **DD3 — sub-change 3 DEFERRED (RESOLVED, 2026-06-12, Project Lead).** "Re-upload a GC'd reconciled part" is NOT a quick-win flip:
  1. **Protocol-agnostic detection** — S3's `InvalidPart` at `/complete` does not cleanly tell the *core* which part is missing; the core can't parse S3 error strings (architecture rule).
  2. **Consumed bytes** — reconciled parts are *skipped*; their source chunk is pulled then discarded (`makeUploadOne:248-260`). By the complete phase (`finalEffect`, after `partsStream` fully drains) the source `ReadableStream` is exhausted, so "re-upload it" requires having **retained** the reconciled chunk(s) → an unbounded memory cost on a near-complete large resume (the same memory-safety tension that got 13.6 spike-gated).
  Therefore it needs an opt-in retention design + a caller predicate to identify the stale part — a follow-up spike, NOT this story. `11.3-INT-005 (F#14)` stays a LOCK; only its comment is re-tagged (Task 3). Recommended home: a new spike-gated Story 13.7 ("Reconciled-part integrity & re-upload") or fold into 13.5 (Observability & Integrity). Captured in `epics.md § Story 13.2` rescope note.

### Critical patterns (MEMORY)

- **Pre-1.0 changesets MUST be `patch`** — `minor` + `workspace:^` peerDep = unwanted jump to 1.0.0. (`project_pre1_peerdep_changesets_trap.md`)
- **Surgical tests** — assert the EXACT error type/`_tag`, the exact `uploadPartCalls`, the exact terminal `uploadId`/`totalParts` — not just "completes". (`feedback_surgical_tests.md`)
- **Typecheck mandatory** — build + test + typecheck triptyque per story. (`feedback_typecheck_mandatory.md`)
- **F#N prefix** on test descriptions — preserve when flipping 11.3-INT-003.
- **Don't duplicate the flipped test** — edit 11.3-INT-003 in place (11.2/11.3 review lesson; reaffirmed by 13.1).
- **MinIO NOT required** — 11.3-INT-003 stubs callbacks (no MinIO); the adapter test mocks `fetch` + `getPresignedUrl` (no real S3). Mirror 13.1: no Docker needed for this story.
- **`reconciledMap` const → restructure** — it becomes the `.map` field of the reconcile Effect's result; keep the rest of `makeUploadOne`'s reconciled-skip logic untouched.

### Reconcile / reinit control-flow (the meaty part of AC#1)

Current (`upload-stream.ts`, inside the outer `Effect.gen` in `Stream.unwrap`):
```
reconciledMap = reconcile ? Map(await reconcile()) : Map()   // mapError → ReconcileError, fails stream on reject
runFreshInit  = Effect(initiate → set refUploadId → capture digest → emit UploadInitiated)
setupStream   = resumeFrom ? drain(runResumeSetup) : initiate ? fromEffect(runFreshInit) : empty
```
Target:
```
runFreshInit  = (moved up)
{ reconciledMap, reinitEvent } = reconcile
   ? normalizeCallback(reconcile).pipe(
       map(parts => ({ map: Map(parts), reinitEvent: none })),
       catchAll(rawCause =>
         reinitOnStale?.(rawCause) && initiate
           ? runFreshInit.pipe(map(ev => ({ map: Map() /*empty*/, reinitEvent: some(ev) })))
           : fail(new ReconcileError(rawCause))))
   : { map: Map(), reinitEvent: none }
setupStream   = isSome(reinitEvent) ? Stream.make(reinitEvent.value)         // fresh UploadInitiated; refUploadId already set
              : resumeFrom          ? drain(runResumeSetup)
              : initiate            ? fromEffect(runFreshInit)
              : empty
```
Invariant to preserve: exactly ONE initiate per upload. Reinit consumes `runFreshInit` in the reconcile step, so `setupStream` must NOT run it again (the `reinitEvent` branch fires first). The default path (no `reinitOnStale`, or predicate false) is byte-for-byte the current behaviour — the `catchAll` fail branch reproduces today's `ReconcileError(rawCause)`.

### Files likely touched

- **Modified (lib):** `packages/tranquilload-core/src/multipart/upload-stream.ts` (option + reinit orchestration), `packages/tranquilload-adapters/src/protocols/s3-multipart-upload.ts` (option + `storedUploadId` seed).
- **Modified (tests):** `packages/tranquilload-core/src/multipart/resume-error-edges.test.ts` (flip 11.3-INT-003; re-tag 11.3-INT-005), `packages/tranquilload-adapters/src/protocols/s3-multipart-upload.test.ts` (net-new resume test).
- **Added:** 2 changesets (`.changeset/*.md`).
- **Modified:** this story file; `sprint-status.yaml`; `epics.md § Story 13.2` (rescope note); traceability.

### Out of scope

- Sub-change 3 (re-upload GC'd reconciled part) — DEFERRED (DD3); 11.3-INT-005 re-tagged only.
- Threading `resumeUploadId` into `completeUpload` — not needed: `completeUpload(uploadId, parts)` already receives the uploadId as a param from the core's `refUploadId` (set from `resumeFrom.uploadId` on resume). The gap is ONLY the `uploadPart` → `getPresignedUrl` signing path.
- A pre-flight throw when `reinitOnStale` is set without `initiate` (DD1 — fall-through chosen instead).
- MinIO / Playwright / e2e tiers (all changes unit-level; S3 mocked). Triptyque is the gate.
- The other Epic 13 stories (13.3–13.6) and the deferred 13.7 spike.

## References

- [Source: _bmad-output/planning-artifacts/epics.md § Story 13.2]
- [Source: _bmad-output/implementation-artifacts/epic-11-retro-2026-06-11.md § Epic 13 Candidate Backlog]
- [Source: _bmad-output/brainstorming/brainstorming-session-2026-05-17-001.md] — F#12, F#14
- [Locking tests: resume-error-edges.test.ts (11.3-INT-003 flip, 11.3-INT-005 re-tag); s3-multipart-upload.test.ts (net-new resume)]
- [Precedent: _bmad-output/implementation-artifacts/13-1-api-boundary-input-guards.md — flip-the-lock pattern, DD structure]
- [MEMORY: project_pre1_peerdep_changesets_trap.md, feedback_surgical_tests.md, feedback_typecheck_mandatory.md]

## Dev Agent Record

### Agent Model Used

claude-opus-4-8 (Opus 4.8) — dev per the permanent Epics 6–9 rule (Opus for dev AND review).

### Debug Log References

### Completion Notes List

### Change Log

### File List
