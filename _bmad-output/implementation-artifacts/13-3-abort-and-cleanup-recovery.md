---
baseline_commit: cf0f278
---

# Story 13.3: Abort & Cleanup Recovery

Status: review

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a library maintainer,
I want a teardown/cleanup contract — an opt-in `abortUpload(uploadId)` callback the orchestrator invokes when an upload is torn down *after* `initiate` but *before* the complete phase, plus a documented late-stage recovery contract for an abort *during* `/complete` —
so that an aborted or abandoned multipart does not silently leave an orphan on the server, and a late-stage abort has a deterministic, documented recovery path instead of a possibly-destructive auto-abort.

> **⚠️ This is a behaviour-CHANGING story, not a test-only lock.** Like Stories 13.1 / 13.2 / 13.4, the new behaviour is **opt-in** and its default preserves current behaviour byte-for-byte (no `abortUpload` ⇒ the current orphan-on-teardown behaviour is unchanged → non-breaking → pre-1.0 patch). AC#1 flips the existing locking test `11.2-INT-015 (F#87)` **in place** (strip the `Epic 13 candidate` framing, add the opt-in `abortUpload` assertion, keep the `F#87` prefix) and is further locked by **net-new surgical unit tests**. The two named E2E/MinIO locks (`11.5-E2E-011`, `11.5-E2E-013`) are **re-tagged, not flipped** (DD2 — same honest-scope move as 13.4).

> **🔧 Scope decided 2026-06-15 (Project Lead, via design / API-validation spike — this story is spike-gated).** Three forks confirmed before dev: (1) **trigger scope = ANY teardown** (abort OR part-failure) after initiate & before complete-phase, guarded by *phase* not *cause* → core stays protocol-agnostic (DD1); (2) the two named PW-Lib/MinIO E2E locks are **re-tagged, not flipped** — the deterministic callback behaviour is locked at the **unit tier** (DD2); (3) AC#2 ships as a **phase guard + documented recovery contract**, NO new public API surface — the existing `resumeState` (uploadId + parts) is the recovery state (DD3). A fourth implementation decision: `abortUpload` errors are **best-effort/ignored** so a cleanup failure never masks the real abort/part error (DD4). No new error type — `AbortError` is already a `UploadError` union member and exported (DD5).

## Acceptance Criteria

1. **Given** an opt-in `abortUpload: (uploadId: string) => void | Promise<void> | Effect.Effect<void, UploadError>` callback is supplied, **When** the upload is torn down *after* `initiate` has produced a `uploadId` and *before* the complete phase is entered (i.e. an abort fires mid-part, or a part exhausts its retry budget), **Then** the lib invokes `abortUpload(uploadId)` exactly once on teardown so the consumer can clean up the server-side multipart (e.g. S3 `AbortMultipartUpload`) — instead of the current "orphan multipart on server, no auto-abort hook". With **no** `abortUpload` (default), the current orphan-on-teardown behaviour is preserved byte-for-byte. The callback fires on **any** such teardown (abort or part-failure), guarded by *phase* (uploadId set AND complete-phase not entered), never by inspecting the failure cause — keeping the core protocol-agnostic (DD1). `abortUpload` errors are swallowed (best-effort) so they cannot mask the real upload error (DD4). Flips locking test `11.2-INT-015 (F#87)` in `packages/tranquilload-core/src/multipart/termination-edges.test.ts` in place (add the opt-in `abortUpload` assertion; keep `completeCalls === 0` + `initiateCalls === 1`); the named E2E lock `11.5-E2E-011 (C#18)` is **re-tagged, not flipped** (DD2). Locked further by net-new surgical unit tests `13.3-INT-001..004`.

2. **Given** an abort fires *during* `/complete` (all parts uploaded; `completeUpload` in-flight), **When** the upload tears down, **Then** the lib does **NOT** invoke `abortUpload` (the multipart may have landed server-side — auto-aborting it would destroy a success), and surfaces a deterministic, documented recovery state: the failure is `AbortError` or `CompleteUploadError`, and the consumer's already-resolved `resumeState` (uploadId + the completed parts) is the recovery handle. The recovery contract — *retry `completeUpload` (S3 `CompleteMultipartUpload` is effectively idempotent for the same part set) OR probe via reconcile/HEAD before deciding* — is documented in the `abortUpload` TSDoc (no new public API; DD3). Locked by net-new unit test `13.3-INT-002 (C#20)` (asserts `abortUpload` is NOT called when `completeUpload` fails); the named E2E lock `11.5-E2E-013 (C#20)` is **re-tagged, not flipped** (DD2).

## Tasks / Subtasks

- [x] Task 1: `abortUpload` option + TSDoc (AC: #1, #2) — core `upload-stream.ts`
  - [x] Add `readonly abortUpload?: (uploadId: string) => void | Promise<void> | Effect.Effect<void, UploadError>` to `UploadMultipartOptions` (alongside `failFast`/`reinitOnStale`, the other opt-in policy knobs). TSDoc must cover: opt-in best-effort teardown cleanup; fires once with the active `uploadId` when the upload is torn down after `initiate` and before the complete phase (abort OR part-failure); **does NOT fire** once the complete phase is entered (the multipart may have landed — see AC#2 recovery contract) and does NOT fire when no `uploadId` was ever created (pre-initiate teardown); errors are swallowed (best-effort) so cleanup failure never masks the real upload error; default `undefined` preserves the current orphan-on-teardown behaviour.
  - [x] TSDoc must also document the **tab-close caveat** (symmetric with the `AbortSignal must be wired into user callbacks` MEMORY): on a *graceful* abort/failure the lib runs `abortUpload` via an Effect finalizer; on a *true* browser tab-close the JS context is gone and no async cleanup can run — for that case wire `abortUpload` to `navigator.sendBeacon`/`fetch(..., {keepalive:true})` in your own `beforeunload`. The lib gives you the hook; it cannot resurrect a dead context.
  - [x] TSDoc must document the **AC#2 late-stage recovery contract**: if an abort lands during `/complete`, `abortUpload` is deliberately NOT called; the upload fails with `AbortError`/`CompleteUploadError`; recover via the resolved `resumeState` (uploadId + parts) by retrying `completeUpload` or reconcile-probing first.
  - [x] Destructure `abortUpload` in the options block (`upload-stream.ts:205-221`).

- [x] Task 2: Phase tracking ref (AC: #1, #2) — core `upload-stream.ts`
  - [x] Add `const refCompleting = yield* Ref.make(false)` next to the other refs (`refUploadId` etc., ~`upload-stream.ts:263`).
  - [x] In `finalEffect` (`upload-stream.ts:508-525`), set it **first**, before reading parts / calling `completeUpload`: `yield* Ref.set(refCompleting, true)`. This is the phase-3 boundary — once we begin the complete phase, the teardown finalizer must never auto-abort (the multipart may complete server-side).
  - [x] (No new flag for "completed": on success the stream terminates with `completing === true`, so the guard already skips the callback. `refUploadId` + `refCompleting` are sufficient for the 3-phase model.)

- [x] Task 3: Teardown finalizer via `Stream.ensuring` (AC: #1, #2) — core `upload-stream.ts`
  - [x] Build a total (never-failing) cleanup effect that closes over `refUploadId`, `refCompleting`, `abortUpload`, `logger`:
    ```ts
    const abortCleanup = Effect.gen(function* () {
      const uploadId = yield* Ref.get(refUploadId)
      const completing = yield* Ref.get(refCompleting)
      // Phase 2 only: initiated (uploadId set) AND complete phase NOT entered.
      if (uploadId !== "" && !completing) {
        yield* normalizeCallback(() => abortUpload!(uploadId)).pipe(Effect.ignore)
        yield* safeLog(logger, "info", `Abort cleanup invoked for upload ${uploadId}`)
      }
    })
    ```
    `Effect.ignore` makes the callback best-effort (DD4); `safeLog` is already ignore-wrapped → `abortCleanup` is `Effect<void, never>`, valid for `Stream.ensuring`.
  - [x] Apply it to the returned stream **only when `abortUpload` is set**, so the default path is byte-for-byte unchanged:
    ```ts
    const body = Stream.concat(setupStream, partsStream.pipe(Stream.concat(Stream.fromEffect(finalEffect))))
    return abortUpload === undefined ? body : body.pipe(Stream.ensuring(abortCleanup))
    ```
  - [x] `Stream.ensuring` runs the finalizer when the stream's scope closes — on success, failure, AND interruption — uninterruptibly. The phase guard (not the termination kind) decides whether `abortUpload` actually fires. Confirm `Stream.ensuring` exists on effect `3.19.19` at typecheck.

- [x] Task 4: Flip `11.2-INT-015 (F#87)` in place (AC: #1) — `termination-edges.test.ts`
  - [x] Strip the `Epic 13 candidate` framing from the block comment (`:117-130`) and the test title (`:133`); reframe to: `abortUpload` is now opt-in (shipped 13.3) — supplying it makes the lib auto-invoke cleanup on teardown; the DEFAULT (no `abortUpload`) still leaves an orphan (current behaviour, still locked by the existing assertions).
  - [x] Add an `abortUpload` callback to the existing `uploadMultipart({...})` call: `let abortCalls = 0; let abortedId = ""; abortUpload: (id) => { abortCalls += 1; abortedId = id }`.
  - [x] Keep `completeCalls === 0` and `initiateCalls === 1` (the orphan/allocation invariants are unchanged). **Add** assertions: `abortCalls === 1` and `abortedId === "orphan-tab-close-test"` (the lib invoked cleanup with the active uploadId on abort). Keep the `F#87` prefix; do NOT duplicate the test.

- [x] Task 5: Net-new surgical unit tests (AC: #1, #2) — `termination-edges.test.ts`
  - [x] `13.3-INT-001 (C#18)` — **happy path: no false-positive cleanup.** A small upload (`initiate` + 2 parts + `completeUpload`) runs to `UploadCompleted` with an `abortUpload` supplied; assert `abortCalls === 0` (the complete phase was entered → finalizer guard skips). Locks "successful upload never triggers cleanup".
  - [x] `13.3-INT-002 (C#20)` — **complete-phase guard (AC#2).** `initiate` + parts succeed, but `completeUpload` throws (simulating an abort during `/complete`); assert the result rejects with `CompleteUploadError` AND `abortCalls === 0` (the multipart may have landed — the lib must NOT auto-abort it). Locks the AC#2 deterministic guard.
  - [x] `13.3-INT-003 (C#18, DD1)` — **part-failure teardown fires cleanup.** `initiate` succeeds; `uploadPart` always throws (no signal); with `retrySchedule: Schedule.recurs(1)` the part exhausts its budget → `MaxRetriesExceededError`; assert `abortCalls === 1` and `abortedId === <uploadId>`. Locks DD1 (any teardown, not just abort).
  - [x] `13.3-INT-004 (C#18)` — **pre-initiate guard: nothing to clean up.** No `initiate` callback (uploadId stays `""`); `uploadPart` throws on part 1; assert the upload fails AND `abortCalls === 0` (no uploadId was ever created). Locks the phase-1 guard.
  - [x] Use the existing `tinyStream` helper + raw `throw`/sync callbacks (avoid the `normalizeCallback` double-wrap — pass raw `throw`, NOT Effect-typed callbacks). These are deterministic and need no MinIO / TestClock (abort via `AbortController`; part-failure via throwing `uploadPart`).

- [x] Task 6: Re-tag the two E2E/MinIO locks (AC: #1, #2, DD2) — `tests/e2e/lib/chaos-abort-timing.spec.ts`
  - [x] `11.5-E2E-011 (C#18)` (`:24-55`): edit ONLY the comment + title — replace the "Epic 13 candidate: ... the lib does not auto-abort it on initiate-abort" note with: `abortUpload` **shipped (opt-in) in Story 13.3**; this E2E lock now guards the **non-breaking default** — with no `abortUpload`, an initiate-abort still leaves a (timing-dependent) orphan. Keep the assertions (`result.ok === false`, error ∈ {AbortError, InitiateUploadError}, `completedParts === 0`).
  - [x] `11.5-E2E-013 (C#20)` (`:93-121`): edit ONLY the comment + title — replace "no clean late-stage recovery (Epic 13 candidate)" with: Story 13.3 documents the late-stage recovery contract (resumeState + retry/probe) and the teardown finalizer deliberately does NOT auto-abort during `/complete`; this spec now guards the **non-breaking default** error surface. Keep the assertions (error ∈ {AbortError, CompleteUploadError}, no `UploadCompleted`).
  - [x] `11.5-E2E-012 (C#19)` (`:57-91`): its comment references "auto-abort on tab close is an Epic 13 candidate (F#87)" — lightly re-tag that one comment line to "shipped opt-in in 13.3" (no assertion change). (Optional tidy — keep if cheap.)

- [x] Task 7: Changeset (pre-1.0 PATCH)
  - [x] `.changeset/epic13-core-abort-cleanup.md` — `@tranquilload/core` patch: opt-in `abortUpload` teardown-cleanup callback (fires on post-initiate/pre-complete teardown; documented late-stage `/complete`-abort recovery contract; default behaviour unchanged). pre-1.0 patch per the versioning rule. (No adapter change this story — the option is core; the consumer wires it to their backend's abort, e.g. the S3 adapter's host app calling `AbortMultipartUpload`.)

- [x] Task 8: Triptyque verification
  - [x] `pnpm turbo build` green
  - [x] `pnpm -r test` green (core: termination-edges 11.2-INT-015 flipped in place + 4 net-new `13.3-INT-001..004`; adapters unchanged)
  - [x] `pnpm turbo typecheck` green

- [x] Task 9: Traceability + docs
  - [x] Record below: `11.2-INT-015 (F#87)` flipped (abortUpload arm added); `13.3-INT-001..004 (C#18/C#20)` net-new; `11.5-E2E-011 (C#18)` + `11.5-E2E-013 (C#20)` re-tagged (not flipped); `11.5-E2E-012 (C#19)` comment lightly re-tagged.
  - [x] README: leave untouched (matches 13.1/13.2/13.4) — the recovery contract + tab-close caveat live in the `abortUpload` TSDoc (visible in `.d.mts`/IDE), keeping the change out of the separate doctest tier. Optional discoverability follow-up — flag, don't do.

## Dev Notes

### Spec inputs

- Source: `_bmad-output/planning-artifacts/epics.md § Story 13.3` (acceptance criteria; spike-gated; risk clusters R-P2-3 + R-P2-9).
- Backlog origin: `_bmad-output/implementation-artifacts/epic-11-retro-2026-06-11.md § Epic 13 Candidate Backlog`.
- Genealogy: `brainstorming-session-2026-05-17-001.md` — F#87 (tab-close orphan multipart), C#18 (initiate-abort cleanup), C#20 (complete-abort recovery).

### This story CHANGES behaviour (critical distinction from Epic 11)

Epic 11 wrote tests that LOCK current behaviour. Epic 13 stories FLIP those locks (or add the capability + a new lock). AC#1's existing test (`11.2-INT-015`) currently asserts the OLD (no auto-abort) behaviour with an explicit `Epic 13 candidate` comment; the dev adds the lib hook, keeps the default-behaviour invariants (completeUpload not called, initiate once), adds the opt-in `abortUpload` assertion, and strips the comment IN PLACE. The new option is opt-in with a default that preserves current behaviour → non-breaking → pre-1.0 patch.

### The mechanism (design spike, 2026-06-15)

**Current abort path (no finalizer):** `Effect.raceFirst(partEffect, fromAbortSignal(signal))` at the per-part site (`upload-stream.ts:455`/`:476`). When the signal aborts, `fromAbortSignal` produces `Effect.fail(AbortError)`; `raceFirst` yields that failure and interrupts the loser part. The `AbortError` propagates up the stream and the whole upload fails. **No finalizer runs — none is registered** (confirmed: zero `ensuring`/`onInterrupt`/`Scope`/`addFinalizer`/`acquireRelease` in core src). `initiate` already stored the `uploadId` in `refUploadId`; nothing tears it down → orphan multipart. That is exactly the F#87 gap.

**The fix:** register a teardown finalizer with `Stream.ensuring(abortCleanup)` on the inner stream (inside the `Stream.unwrap(Effect.gen(...))`, so it closes over the refs). `Stream.ensuring`'s finalizer runs on success, failure, AND interruption, uninterruptibly. `abortCleanup` reads the phase refs and invokes the caller's `abortUpload(uploadId)` only in **phase 2** (initiated, not yet completing) — see the 3-phase model.

**3-phase teardown model (the crux — separates AC#1 from AC#2):**

| Phase | State | Teardown action |
|---|---|---|
| 1. pre-initiate | `uploadId === ""` | nothing — no id to abort (matches the E2E note that initiate-abort orphans are timing-dependent & unknowable client-side) |
| 2. initiated, not completing | `uploadId !== "" && completing === false` | **invoke `abortUpload(uploadId)`** ← AC#1 orphan cleanup (abort OR part-failure) |
| 3. complete phase entered | `completing === true` | **do NOT abort** — the multipart may have landed; deleting it would destroy a success ← AC#2 |

`refCompleting` is set true at the **top** of `finalEffect`, *before* `completeUpload` is invoked, so a failure/abort during `/complete` is already in phase 3 → the guard skips. On success the stream terminates in phase 3 too → guard skips (no false-positive cleanup).

### Exact source sites (design spike, 2026-06-15)

| Change | Site | Current state | Change |
|---|---|---|---|
| `abortUpload` option | `core/src/multipart/upload-stream.ts:45-193` (`UploadMultipartOptions`) | no such option | add `readonly abortUpload?: (uploadId: string) => void \| Promise<void> \| Effect.Effect<void, UploadError>` + thorough TSDoc |
| destructure | `upload-stream.ts:205-221` | — | add `abortUpload` to the destructure |
| `refCompleting` | `upload-stream.ts:~263` (refs block) | absent | `const refCompleting = yield* Ref.make(false)` |
| set completing | `upload-stream.ts:508-525` (`finalEffect`) | reads uploadId/parts → completeUpload | add `yield* Ref.set(refCompleting, true)` as the FIRST line |
| teardown finalizer | `upload-stream.ts:527` (the returned `Stream.concat`) | no finalizer | `abortUpload === undefined ? body : body.pipe(Stream.ensuring(abortCleanup))` |

- `normalizeCallback(() => abortUpload!(uploadId))` normalizes the three callback forms (sync/Promise/Effect) exactly like `initiate`/`uploadPart`/`completeUpload`; `.pipe(Effect.ignore)` makes it best-effort.
- Effect version: `3.19.19` (peer `>=3.19.19`). `Stream.ensuring` and `Ref.set`/`Ref.get` all exist in this version — confirm at typecheck.

### Design decisions (call these out — do not silently re-pick)

- **DD1 — trigger scope = ANY teardown (abort OR part-failure), guarded by PHASE not CAUSE (RESOLVED 2026-06-15, Project Lead).** The finalizer fires on any post-initiate/pre-complete teardown, deciding solely on the phase refs (`uploadId !== "" && !completing`) — it NEVER inspects the failure cause. This keeps the core protocol-agnostic (symmetric with `reinitOnStale`/`failFast` from 13.2/13.4) and is strictly more useful than abort-only: a part that exhausts its retry budget *also* leaves an orphan multipart, and the same cleanup applies. (Considered + rejected: abort-only — narrower, would require the finalizer to type-check the cause for `AbortError`, leaking error-shape knowledge into the orchestration; the Project Lead chose any-teardown.)
- **DD2 — AC#1/#2 are locked at the UNIT tier; `11.5-E2E-011` + `11.5-E2E-013` are RE-TAGGED, not flipped (RESOLVED 2026-06-15, Project Lead).** The epic named two E2E flips, but both are **PW-Lib/MinIO chaos specs** (`tests/e2e/lib/chaos-abort-timing.spec.ts`, need MinIO + 3 browser engines + Playwright, driven via `page.evaluate(driveMultipartInPage, ...)`). The `abortUpload` callback is a runtime function that **cannot be serialized across the `page.evaluate` boundary** (same constraint that blocked the `Duration` flip in 13.4 DD2). The specs currently lock the **non-breaking default** (orphan remains / no clean recovery), which 13.3 **preserves** — flipping them would destroy that lock. And the deterministic callback behaviour belongs at the unit tier. So: ship `abortUpload` in core, lock it with the flipped `11.2-INT-015` + net-new surgical unit tests (`13.3-INT-001..004`, no MinIO), and re-tag the E2E specs to record the candidate shipped and they now guard the non-breaking default. (Note: the test-app server *does* expose `/api/multipart/abort` — flipping the E2E *is* feasible — but the cost/benefit + the spec's own "orphan creation is timing-dependent" caveat make the unit tier the right lock. Same honest-scope move as 13.4 DD2 + Story 11.6 Pattern 3.)
- **DD3 — AC#2 ships as a phase GUARD + documented recovery contract, NO new public API (RESOLVED 2026-06-15, Project Lead).** A late-stage `/complete` abort is unrecoverable-by-deletion: the multipart may have landed, so the lib must NOT auto-abort it (the `refCompleting` guard). The "deterministic recovery state" the AC asks for is the **already-resolved `resumeState`** (uploadId + completed parts) — the consumer retries `completeUpload` (S3 `CompleteMultipartUpload` is effectively idempotent for the same part set) or reconcile-probes (ListParts/HEAD) before deciding. This is a **documentation** deliverable (TSDoc on `abortUpload`) + the guard — no new callback/result type. (Considered + rejected: an `onCompleteInterrupted` hook or a typed "indeterminate" terminal state — more API surface + tests + blast radius for a state the consumer can already reconstruct from `resumeState`.)
- **DD4 — `abortUpload` errors are best-effort / ignored.** The cleanup callback is wrapped in `Effect.ignore`: if the consumer's abort request itself fails, that error is swallowed so it cannot mask the real upload failure (the `AbortError`/`PartUploadError` that triggered teardown is what the caller needs). Mirrors the `safeLog` user-boundary philosophy (Story 10.1) — a user callback on the teardown path must not crash or shadow the primary error. (The cleanup is logged via `safeLog` for observability.)
- **DD5 — no new error type.** `AbortError` is already a `UploadError` union member (`upload-error.ts:137`) and exported (`errors/index.ts`). `abortUpload`'s Effect form returns `Effect.Effect<void, UploadError>` for symmetry with the other callbacks, but its error is ignored (DD4), so nothing new enters the channel and the 6-location exhaustive-switch is untouched.

### Critical patterns (MEMORY)

- **Pre-1.0 changesets MUST be `patch`** — `minor` + `workspace:^` peerDep = unwanted jump to 1.0.0. (`project_pre1_peerdep_changesets_trap.md`)
- **Surgical tests** — assert the EXACT call count (`abortCalls === 1`/`=== 0`), the exact `uploadId` passed, the exact error `_tag`/`instanceof` — not just "fails". (`feedback_surgical_tests.md`)
- **normalizeCallback double-wrapping** — pass raw `throw`/Promise rejections from test callbacks, NOT Effect-typed callbacks (avoids `normalizeCallback` + `mapError` double-wrap). (MEMORY)
- **`.finally()` on a rejected Promise re-propagates** — the F#87 test already does `handle.result.catch(() => {})`; keep suppressing the intentional rejection. (MEMORY)
- **AbortSignal must be wired into user callbacks** — the finalizer interrupts/runs on the orchestration fiber; an in-flight `fetch` inside `uploadPart`/`completeUpload` keeps running unless the consumer wired the signal. `abortUpload` cleans up the *server resource*; it does not cancel the consumer's in-flight requests. Document the tab-close caveat (sendBeacon/keepalive). (MEMORY)
- **Typecheck mandatory** — build + test + typecheck triptyque per story. (`feedback_typecheck_mandatory.md`)
- **F#N / test-ID prefix** — preserve `F#87` when flipping `11.2-INT-015`; tag net-new tests `13.3-INT-00N (C#18/C#20)`.
- **Don't duplicate the flipped test** — edit `11.2-INT-015` in place.
- **MinIO NOT required** — all changes unit-level; `initiate`/`uploadPart`/`completeUpload` stubbed, abort via `AbortController`, part-failure via throwing `uploadPart`. The re-tagged E2E specs are nightly PW-Lib chaos specs; we touch only their comments/titles. Triptyque is the gate.

### Why `Stream.ensuring`, not `Effect.onInterrupt` / `onError` (the meaty part of AC#1)

The abort manifests as a **typed failure** (`AbortError` from `fromAbortSignal` winning the `raceFirst`), not a raw interruption, so `Effect.onInterrupt` would miss the abort path. The finalizer must run on success (to *skip* cleanup), failure (abort/part-failure → cleanup), AND interruption — that's exactly `ensuring`'s contract. Applying it at the **Stream** level (`Stream.ensuring`) ties the finalizer to the stream's scope, which closes when `runCollect`/`runDrain` settles in the public wrapper — so the cleanup runs before the error is surfaced to the consumer. The phase guard (not the termination kind) decides whether `abortUpload` actually fires, which is why a successful upload (phase 3) and a pre-initiate failure (phase 1) both correctly skip it. (Reviewer should confirm: finalizer attached only when `abortUpload` set; guard is `uploadId !== "" && !completing`; cleanup is total/`never`-error.)

### Files likely touched

- **Modified (lib):** `packages/tranquilload-core/src/multipart/upload-stream.ts` (`abortUpload` option + `refCompleting` ref + `finalEffect` set-completing + `Stream.ensuring` finalizer).
- **Modified (test):** `packages/tranquilload-core/src/multipart/termination-edges.test.ts` (flip `11.2-INT-015`, add net-new `13.3-INT-001..004`), `tests/e2e/lib/chaos-abort-timing.spec.ts` (re-tag `11.5-E2E-011` + `11.5-E2E-013` + light `11.5-E2E-012` comment).
- **Added:** 1 changeset (`.changeset/epic13-core-abort-cleanup.md`).
- **Modified:** this story file; `sprint-status.yaml`.

### Out of scope

- Flipping `11.5-E2E-011` / `11.5-E2E-013` / any MinIO / Playwright / e2e tier work (DD2 — re-tag only).
- A new error type (DD5 — `AbortError` already covers it) or any change to the `UploadError` union.
- A dedicated late-stage recovery API (`onCompleteInterrupted`, typed indeterminate state) — DD3: guard + documented contract, recovery via existing `resumeState`.
- Auto-threading the signal into the consumer's `fetch`, or cancelling in-flight requests on teardown (same `tryPromise`/AbortSignal caveat as 13.4 — documented, not a change).
- A `beforeunload`/`sendBeacon` wiring inside the lib (consumer-side per the tab-close caveat — the lib provides the hook, not the browser plumbing).
- An S3-adapter `abortMultipartUpload` helper — the consumer wires `abortUpload` to their backend (the test-app already has `/api/multipart/abort`). Could be a tiny adapter ergonomics follow-up; flag, don't do.
- The other Epic 13 stories (13.5 / 13.6 spike-gated) and the deferred 13.7 spike.

## References

- [Source: _bmad-output/planning-artifacts/epics.md § Story 13.3]
- [Source: _bmad-output/implementation-artifacts/epic-11-retro-2026-06-11.md § Epic 13 Candidate Backlog]
- [Source: _bmad-output/brainstorming/brainstorming-session-2026-05-17-001.md] — F#87, C#18, C#20
- [Locking tests: termination-edges.test.ts (11.2-INT-015 flip + 13.3-INT-001..004 net-new); chaos-abort-timing.spec.ts (11.5-E2E-011 + 11.5-E2E-013 re-tag)]
- [Precedent: 13-4-resilience-policies-and-timeouts.md — flip-the-lock + API-validation-during-creation + DD2 (unit-tier lock, E2E re-tag) + protocol-agnostic predicate philosophy]
- [Mechanism reference: upload-stream.ts (raceFirst abort path :455/:476; refs :263; finalEffect :508-525; returned stream :527)]
- [MEMORY: project_pre1_peerdep_changesets_trap.md, feedback_surgical_tests.md, feedback_typecheck_mandatory.md, project-defect-safe-user-boundary (safeLog), "AbortSignal must be wired into user callbacks"]

## Dev Agent Record

### Agent Model Used

claude-opus-4-8 (Opus 4.8) — dev per the permanent Epics 6–9 rule (Opus for dev AND review).

### Debug Log References

- `pnpm vitest run src/multipart/termination-edges.test.ts` (focused) → 6/6 green first run (2 existing F#86/F#87 + 4 net-new `13.3-INT-001..004`). The flipped `11.2-INT-015 (F#87)` passes with the new `abortCalls === 1` / `abortedId === "orphan-tab-close-test"` arm added in place. No red-phase iteration needed.
- Full triptyque: `pnpm turbo build` ✅ 2/2 · `pnpm turbo typecheck` ✅ 5/5 (confirms `Stream.ensuring` + the `abortUpload` callback-union type on effect 3.19.19) · `pnpm -r test` ✅ core 213/213 (209→213, +4 abort-cleanup), adapters 61/61 (unchanged — no adapter change this story). `upload-error.test.ts` 45/45 unchanged (no new error type — DD5).
- Red-phase reasoning (not reverted): without the `Stream.ensuring` finalizer the flipped F#87 + `13.3-INT-003` would see `abortCalls === 0` (no hook) → fail the `toBe(1)` assertions; with the finalizer but WITHOUT the `refCompleting` phase guard, `13.3-INT-002` (complete-phase) would see `abortCalls === 1` → fail the `toBe(0)` assertion (proves the phase-3 guard is load-bearing, not incidental). Both arms genuinely exercise the new behaviour.

### Completion Notes List

- **First spike-gated Epic 13 story; the design / API-validation pass was run during creation (4th time it earned its keep) and resolved 5 design decisions before dev.** The new option is opt-in with a default that preserves current behaviour byte-for-byte → non-breaking → pre-1.0 patch.
- **AC#1 (core `abortUpload` teardown finalizer):** added `abortUpload?: (uploadId) => void | Promise<void> | Effect.Effect<void, UploadError>` to `UploadMultipartOptions`. The returned stream is wrapped in `Stream.ensuring(abortCleanup)` **only when `abortUpload` is set** (default path byte-for-byte unchanged). `abortCleanup` reads `refUploadId` + the new `refCompleting` flag and invokes the callback only in **phase 2** (uploadId set AND complete phase not entered), via `normalizeCallback(...).pipe(Effect.ignore)` (best-effort, DD4) + a `safeLog` line. The finalizer runs on success/failure/interruption; the **phase guard** (not the termination kind) decides whether it fires — so a successful upload (phase 3), a `/complete`-phase teardown (phase 3) and a pre-initiate teardown (phase 1) all correctly skip it.
- **AC#1 lock (DD2 — unit tier, E2E re-tagged):** flipped `11.2-INT-015 (F#87)` in place (added `abortUpload`; assert `abortCalls === 1` + `abortedId === "orphan-tab-close-test"`; kept `completeCalls === 0` + `initiateCalls === 1`; stripped the "Epic 13 candidate" framing; kept the `F#87` prefix; no duplicate). Added 4 net-new surgical units `13.3-INT-001..004` (no MinIO, no TestClock — abort via the existing handle pattern, part-failure via throwing `uploadPart`): happy-path no-fire, complete-phase guard no-fire (C#20), part-failure fires (DD1 any-teardown), pre-initiate no-fire. Re-tagged (comments/titles only) `11.5-E2E-011 (C#18)` + `11.5-E2E-013 (C#20)` + lightly the `11.5-E2E-012 (C#19)` comment — assertions untouched.
- **AC#2 (complete-phase guard + documented recovery contract, DD3 — no new API):** `refCompleting` is set at the **top** of `finalEffect` (before `completeUpload`), so an abort/failure during `/complete` is already phase-3 → the finalizer does NOT auto-abort the (possibly-landed) multipart. The recovery contract (recover via the resolved `resumeState` by retrying `completeUpload` or reconcile-probing) is documented in the `abortUpload` TSDoc. `13.3-INT-002` locks the guard (completeUpload throws → `CompleteUploadError`, `abortCalls === 0`).
- **No new error type (DD5):** `abortUpload`'s Effect form returns `Effect<void, UploadError>` for symmetry, but its error is ignored (DD4); `AbortError` (already a union member + exported) covers the abort path. The `UploadError` union + the 6-location exhaustive switch are untouched (`upload-error.test.ts` 45/45 unchanged).
- **No adapter change this story** — the option is core-only; the consumer wires `abortUpload` to their backend's abort (the test-app already exposes `/api/multipart/abort`; the S3 adapter host app would call `AbortMultipartUpload`). adapters 61/61 unchanged. 1 pre-1.0 patch changeset (`epic13-core-abort-cleanup.md`).
- **README untouched (deliberate, matches 13.1/13.2/13.4):** the recovery contract + tab-close caveat live in the thorough `abortUpload` TSDoc (visible in `.d.mts`/IDE), keeping the change out of the separate doctest tier. Optional discoverability follow-up — flagged, not done. An S3-adapter `abortMultipartUpload` ergonomics helper is a possible tiny follow-up — flagged, not done.
- **Scope note:** e2e/integration tiers (`tests/`, MinIO/Playwright) NOT run — out of scope (all changes unit-level; callbacks stubbed). The re-tagged E2E specs are nightly PW-Lib chaos specs; only comments/titles touched (no assertion change). Triptyque is the gate.
- **Reviewer flags:** (1) confirm the `Stream.ensuring` finalizer is attached ONLY when `abortUpload` is set (non-breaking default); (2) confirm the phase guard `uploadId !== "" && !completing` is correct and `refCompleting` is set BEFORE `completeUpload` runs (so a `/complete`-abort never auto-deletes); (3) confirm the cleanup is total (`Effect<void, never>` via `Effect.ignore` + `safeLog`) so the finalizer cannot fail or mask the real error (DD4); (4) confirm `13.3-INT-002` genuinely proves the guard (without `refCompleting` it would fire) and the F#87 flip is in place (no duplicate, `F#87` kept).

### Change Log

- 2026-06-15 — Story 13.3 CREATED (ready-for-dev). Spike-gated story authored with the design / API-validation pass run during creation (4th time the pass earned its keep). Three scope forks resolved by the Project Lead via AskUserQuestion before dev: DD1 (any-teardown, phase-guarded — not abort-only), DD2 (lock at unit tier, re-tag the two E2E/MinIO specs — not flip), DD3 (AC#2 = guard + documented recovery contract via existing resumeState — no new public API). Plus DD4 (best-effort/ignored cleanup errors) + DD5 (no new error type — AbortError already in union). Mechanism: `Stream.ensuring` teardown finalizer + `refCompleting` phase ref; opt-in `abortUpload` callback, default byte-for-byte unchanged → 1 pre-1.0 patch changeset (core only).
- 2026-06-15 — Story 13.3 dev (Opus 4.8): both ACs. **Lib:** `upload-stream.ts` (opt-in `abortUpload` option + thorough TSDoc; `refCompleting` phase ref set at the top of `finalEffect`; `Stream.ensuring(abortCleanup)` teardown finalizer attached only when `abortUpload` set; phase-2-only best-effort invocation via `normalizeCallback(...).pipe(Effect.ignore)`). **Tests:** flipped `11.2-INT-015 (F#87)` in place (added abortUpload arm); +4 net-new `13.3-INT-001..004 (C#18/C#20)` surgical units; re-tagged (not flipped) `11.5-E2E-011 (C#18)` + `11.5-E2E-013 (C#20)` + light `11.5-E2E-012 (C#19)` comment. **1 patch changeset** (core only). Triptyque green (build 2/2, core 213/213, adapters 61/61, typecheck 5/5). DDs: DD1 any-teardown/phase-guarded, DD2 unit-tier lock + E2E re-tag, DD3 AC#2 guard+docs (no new API), DD4 best-effort cleanup, DD5 no new error type. No e2e run (out of scope).

### File List

- **Modified (lib):** `packages/tranquilload-core/src/multipart/upload-stream.ts` (`abortUpload` option + TSDoc; `refCompleting` ref; set-completing in `finalEffect`; `Stream.ensuring` teardown finalizer)
- **Modified (test):** `packages/tranquilload-core/src/multipart/termination-edges.test.ts` (flip `11.2-INT-015 (F#87)`; net-new `13.3-INT-001..004`)
- **Modified (test):** `tests/e2e/lib/chaos-abort-timing.spec.ts` (re-tag `11.5-E2E-011` + `11.5-E2E-013` + light `11.5-E2E-012` comment — no assertion changes)
- **Added:** `.changeset/epic13-core-abort-cleanup.md`
- **Modified:** `_bmad-output/implementation-artifacts/13-3-abort-and-cleanup-recovery.md` (this file)
- **Modified:** `_bmad-output/implementation-artifacts/sprint-status.yaml` (13-3 → review)
