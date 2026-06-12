---
baseline_commit: 88f7253
---

# Story 13.2: Resume & Reconcile Robustness

Status: done

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

- [x] Task 1: `reinitOnStale` predicate + reinit orchestration (AC: #1) — core
  - [x] Add `readonly reinitOnStale?: (cause: unknown) => boolean` to `UploadMultipartOptions` (`upload-stream.ts`), with TSDoc: opt-in; receives the **raw** reconcile rejection (pre-`ReconcileError`); return `true` to abandon the stale `uploadId` and re-initiate from part 1; **requires `initiate` to be present** (without it, a stale match falls through to `ReconcileError`).
  - [x] Destructure `reinitOnStale` in the options block (`upload-stream.ts:133-146`).
  - [x] **Reorder:** move the `runFreshInit` Effect definition (`:197-217`) ABOVE the reconcile block (`:189-195`) so it can be reused on reinit. (It has no dependency on `reconciledMap`.)
  - [x] Replace the eager reconcile (`:189-195`) with a reconcile Effect that yields `{ map, reinitEvent: Option<UploadInitiated> }`:
    - success → `{ map: new Map(parts...), reinitEvent: Option.none() }`
    - failure → in `catchAll((rawCause) => ...)`: if `reinitOnStale?.(rawCause) === true && initiate !== undefined`, run `runFreshInit` → `{ map: new Map() /* empty, fresh from part 1 */, reinitEvent: Option.some(event) }`; else `Effect.fail(new ReconcileError(rawCause))`. **Critical:** the predicate must see the RAW cause, so replace the current `Effect.mapError(... ReconcileError)` with a `catchAll` (the raw rejection flows through `normalizeCallback`'s error channel).
  - [x] Make `setupStream` reinit-aware: when `Option.isSome(reinitEvent)`, emit the captured `UploadInitiated` (refUploadId already set by `runFreshInit`) and SKIP both `runResumeSetup` and a second `runFreshInit` (no double-initiate). Branch order: reinit → resume → fresh-init → empty.
  - [x] Flip `resume-error-edges.test.ts` 11.3-INT-003 (F#12): add `initiate: () => ({ uploadId: "reinit-fresh-id" })` + `reinitOnStale: (cause) => (cause as { Code?: string })?.Code === "NoSuchUpload"`; invert assertions → upload completes, `uploadPartCalls === 2` (20 bytes / chunkSize 10), terminal event is `UploadCompleted` with `uploadId: "reinit-fresh-id"` and `totalParts: 2`; strip the `// CURRENT BEHAVIOUR — Epic 13 candidate` comment, keep the `11.3-INT-003 (F#12)` prefix, update the description to "...auto-reinitiates and completes from part 1".

- [x] Task 2: `resumeUploadId` adapter option (AC: #2) — S3 adapter (net-new, DD2)
  - [x] Add `readonly resumeUploadId?: string` to `S3MultipartUploadOptions` (`s3-multipart-upload.ts:20-26`), TSDoc: cross-session resume — seeds `storedUploadId` so `uploadPart` signs against the resumed `uploadId` when `initiate` is not called this session.
  - [x] Change `let storedUploadId = ""` (`:52`) → seed from the option: `let storedUploadId = options.resumeUploadId ?? ""` (destructure `resumeUploadId` in the `const { ... } = options` block at `:34` for consistency).
  - [x] Add a net-new test in `s3-multipart-upload.test.ts`: construct with `resumeUploadId: "resumed-upload-id"`, call `uploadPart(1, chunk)` WITHOUT calling `initiate`, assert `getPresignedUrl` was invoked with `(1, "resumed-upload-id")` (not `""`). Add a sibling assertion that the default (no `resumeUploadId`) still passes `""` to `getPresignedUrl` pre-`initiate` (guards the non-breaking default). Mock `fetch` to return an `ok` response with an `ETag` header (mirror the existing `uploadPart` tests' fetch stub).

- [x] Task 3: Re-tag the deferred lock (AC: #3) — DD3
  - [x] In `resume-error-edges.test.ts`, edit ONLY the comment block above 11.3-INT-005 (F#14): replace "Epic 13 candidate: detect/re-upload a GC'd reconciled part instead of failing at complete." with a one-to-two-line note that this is DEFERRED from Story 13.2 (DD3) for memory-safety (reconciled chunks are discarded after the skip, source stream is drained by complete phase) + protocol-agnostic-detection (core can't identify the S3 `InvalidPart` part) reasons. **Do NOT flip the assertion** — the test stays green, still locking `CompleteUploadError` at complete.

- [x] Task 4: Changesets (pre-1.0 PATCH)
  - [x] `.changeset/epic13-core-reinit-on-stale.md` — `@tranquilload/core` patch (opt-in `reinitOnStale`).
  - [x] `.changeset/epic13-adapters-resume-upload-id.md` — `@tranquilload/adapters` patch (opt-in `resumeUploadId`).
  - [x] Both note "opt-in, default behaviour unchanged"; pre-1.0 patch per the versioning rule.

- [x] Task 5: Triptyque verification
  - [x] `pnpm turbo build` green
  - [x] `pnpm -r test` green (core + adapters; note new counts)
  - [x] `pnpm turbo typecheck` green

- [x] Task 6: Traceability + docs
  - [x] Record below: 11.3-INT-003 flipped; resumeUploadId net-new test added; 11.3-INT-005 re-tagged (not flipped).
  - [x] Check whether the README documents `reconcileCompletedParts` / resume in a way that should mention `reinitOnStale` or the adapter `resumeUploadId`. If a README `ts` fenced block changes, the doctest harness re-checks it (smoke). If untouched, nothing to update.

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

- `pnpm vitest run src/multipart/resume-error-edges.test.ts` (focused) → 6/6 green on the first run, including the flipped two-arm 11.3-INT-003. No red-phase iteration needed — the reconcile→reinit restructure typed and behaved correctly first pass.
- `pnpm -r test` → core 206/206 (unchanged count: 11.3-INT-003 flipped in place, not duplicated), adapters 61/61 (+2 from the net-new resumeUploadId tests; `s3-multipart-upload.test.ts` 8→10).
- `pnpm turbo build` ✅ 2/2 · `pnpm turbo typecheck` ✅ 5/5.

### Completion Notes List

- **Second behaviour-CHANGING Epic 13 story — 2 of 3 epic sub-changes shipped, 1 deferred (DD3).** Both shipped changes are opt-in with defaults that preserve current behaviour → non-breaking → pre-1.0 patch.
- **AC#1 (core `reinitOnStale`):** added `reinitOnStale?: (cause: unknown) => boolean` to `UploadMultipartOptions`. Restructured the orchestration exactly per the story's control-flow section: moved `runFreshInit` above the reconcile; replaced the eager `mapError → ReconcileError` reconcile with a `reconcileSetup` Effect yielding `{ map, reinitEvent: Option<UploadInitiated> }` whose `catchAll` sees the **raw** rejection (so the predicate is protocol-agnostic) and — when `reinitOnStale(rawCause) && initiate` — runs `runFreshInit` (empty map, `Some(event)`); else re-wraps as `ReconcileError(rawCause)`. `setupStream` gained a leading `Option.isSome(reinitEvent)` branch that emits the captured `UploadInitiated` and skips a second initiate — **exactly one initiate per upload** invariant preserved.
- **AC#1 flip (11.3-INT-003 / F#12):** edited in place (no duplicate). Kept arm (a) = DEFAULT (no predicate) → `ReconcileError`, 0 PUTs (locks the non-breaking default); added arm (b) = opt-in `reinitOnStale` + `initiate` → `reinitCalls === 2`, a fresh `UploadInitiated{uploadId:"reinit-fresh-id"}`, terminal `UploadCompleted{uploadId:"reinit-fresh-id", totalParts:2}`. Surgical assertions on exact uploadId + part count.
- **AC#2 (adapter `resumeUploadId`):** net-new option on `S3MultipartUploadOptions`; `let storedUploadId = resumeUploadId ?? ""` seeds the closure so `uploadPart` signs against the resumed id without `initiate`. Net-new test (DD2 — no lock to flip): resume arm asserts `getPresignedUrl(2, "resumed-upload-id")`; default arm asserts `getPresignedUrl(1, "")` pre-initiate (non-breaking baseline). `completeUpload` needed no change — it already receives `uploadId` as a param from the core's `refUploadId`.
- **AC#3 (DEFERRED — DD3):** 11.3-INT-005 (F#14) NOT flipped — comment re-tagged to record the two blockers (reconciled chunks discarded + source drained by complete phase = unbounded retention; protocol-agnostic core can't identify S3's `InvalidPart` part). Recommended home: new spike-gated Story 13.7 or fold into 13.5. Test stays green, still locking `CompleteUploadError`-at-complete.
- **README untouched (deliberate, matches 13.1):** the cross-session-resume `ts` example is doctest-checked; the new options are opt-in and fully documented via TSDoc (visible in `.d.mts`/IDE). Adding them to the README would drag in the separate doctest tier (not part of this story's triptyque gate). Optional discoverability follow-up — flagged, not done.
- **Scope note:** e2e/integration tiers (`tests/`, MinIO/Playwright) NOT run — out of scope (both changes unit-level; S3 mocked, callbacks stubbed). Triptyque is the gate.
- **Reviewer flags:** (1) confirm the `reconcileSetup` `catchAll` two-arm conditional unifies cleanly and that R=never holds (typecheck passed, but worth a second look); (2) confirm the reinit path's single-initiate invariant under a `resumeFrom`-set resume (setupStream's `reinitEvent` branch fires before the `resumeFrom` branch, so refUploadId stays the FRESH id — not overwritten by the stale `resumeFrom.uploadId`); (3) confirm `Stream.make(reinitEvent.value)` after `Option.isSome` narrows correctly (no `getOrThrow` needed).

### Change Log

- 2026-06-12 — Story 13.2 dev (Opus 4.8): resume/reconcile robustness, 2 of 3 sub-changes. **Lib:** `upload-stream.ts` (opt-in `reinitOnStale` predicate + reconcile→reinit orchestration restructure: `runFreshInit` reordered, `reconcileSetup` Effect, reinit-aware `setupStream`); `s3-multipart-upload.ts` (opt-in `resumeUploadId` seeds `storedUploadId`). **Tests:** flipped 11.3-INT-003 (F#12) in place (default arm + reinit arm); re-tagged (not flipped) 11.3-INT-005 (F#14); +2 net-new adapter resume tests. **2 patch changesets.** Triptyque green (build 2/2, core 206/206, adapters 61/61, typecheck 5/5). DEFERRED sub-change 3 (DD3). No e2e (out of scope).
- 2026-06-12 — Story 13.2 review follow-ups (Opus 4.8, post independent review): applied 2 of 3 LOW findings. LOW-2 → added a TSDoc sentence to `reinitOnStale` documenting that reinit bypasses `resumeFrom` content-digest validation (correct-but-undocumented subtlety). LOW-3 → added arm (c) to 11.3-INT-003: a stale-`resumeFrom` reinit that captures `completeUpload`'s `uploadId` arg, directly locking invariant B (the fresh id wins over the stale resume id — a path the original reinit arm didn't exercise since it had no `resumeFrom`). LOW-1 (stylistic redundant guard) declined. Triptyque re-verified green (core 206/206, adapters 61/61, typecheck 5/5, build 2/2).

### File List

- **Modified (lib):** `packages/tranquilload-core/src/multipart/upload-stream.ts`
- **Modified (lib):** `packages/tranquilload-adapters/src/protocols/s3-multipart-upload.ts`
- **Modified (test):** `packages/tranquilload-core/src/multipart/resume-error-edges.test.ts`
- **Modified (test):** `packages/tranquilload-adapters/src/protocols/s3-multipart-upload.test.ts`
- **Added:** `.changeset/epic13-core-reinit-on-stale.md`
- **Added:** `.changeset/epic13-adapters-resume-upload-id.md`
- **Modified:** `_bmad-output/implementation-artifacts/13-2-resume-and-reconcile-robustness.md` (this file)
- **Modified:** `_bmad-output/implementation-artifacts/sprint-status.yaml` (13-2 → in-progress → review → done)
- **Modified:** `_bmad-output/planning-artifacts/epics.md` (§ Story 13.2 rescope note — done at story creation)

## Senior Developer Review (AI)

**Reviewer:** independent Opus 4.8 `code-reviewer` agent (fresh context — Codex unavailable; another Opus stands in per user direction).
**Date:** 2026-06-12
**Outcome:** ✅ **Approve** — 0 HIGH / 0 MEDIUM / 3 LOW (2 applied, 1 declined).

### Verdict

Clean, well-scoped behaviour-changing resume/reconcile story. The reviewer traced every correctness-critical invariant and all held: (A) **exactly-one-initiate** across all three paths (fresh / resume / reinit) — the reinit branch consumes `runFreshInit` inside `reconcileSetup`'s `catchAll`, and `setupStream`'s leading `Option.isSome(reinitEvent)` branch fires before both the `resumeFrom` and `initiate` branches, so neither runs a second time; (B) **refUploadId is the fresh id on reinit-during-resume** (`runResumeSetup` skipped, so it's never overwritten with the stale `resumeFrom.uploadId`); (C) **raw-cause exposure** — the predicate sees the raw rejection via `normalizeCallback`'s error channel, and the fail branch re-wraps `ReconcileError(rawCause)` identically, so the default path is byte-for-byte unchanged; (D) the `catchAll` ternary unifies to `Effect<{map,reinitEvent}, UploadError, never>` with `R = never`; (E) `Option.isSome` narrowing is sound. Tests are surgical, flipped in place (no duplicate / no coverage regression), and the DD3 deferral is technically justified (both blockers — discarded reconciled chunks + opaque S3 `InvalidPart` — are real).

### Findings & dispositions

- **LOW-1** (`upload-stream.ts` reconcile ternary): redundant `reinitOnStale !== undefined` guard vs the `?.` form. **Declined** — the explicit form is clearer about intent; no behavioural difference. (`receiving-code-review` skepticism: a pure style nit with no reachable failure mode.)
- **LOW-2** (`upload-stream.ts` `reinitOnStale` TSDoc): reinit silently bypasses `resumeFrom` content-digest validation — correct (the old upload + its digest no longer apply) but undocumented. **Applied** — added a TSDoc sentence making the bypass explicit.
- **LOW-3** (`resume-error-edges.test.ts` 11.3-INT-003): invariant B was proven only indirectly because the reinit arm had no `resumeFrom` set — so the "fresh id wins over a *stale* `resumeFrom.uploadId`" path was never exercised. **Applied** — added arm (c): a stale-`resumeFrom` reinit that captures `completeUpload`'s `uploadId` argument, directly locking invariant B end-to-end. (This was the sharpest finding — it exposed a genuine coverage gap, not a nit.)

**Dev decision:** applied LOW-2 + LOW-3, declined LOW-1. `receiving-code-review` skepticism applied in both directions — LOW-3 was upgraded from the reviewer's "optional test hardening" framing to a real gap worth closing (the original arm never set `resumeFrom`, so the most important invariant was under-tested). Triptyque re-verified green post-changes (core 206/206, adapters 61/61, typecheck 5/5, build 2/2); arm (c) lives in the same `it.effect` so core count holds at 206.
