---
baseline_commit: bbf2a45
---

# Story 13.4: Resilience Policies & Timeouts

Status: review

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a library maintainer,
I want two opt-in resilience knobs — a `partTimeout` bound on a pathologically slow part, and a fail-fast policy that skips the retry budget for a caller-classified unrecoverable error (e.g. `PresignedUrlError`) —
so that a slow-loris part cannot hang an upload indefinitely and an unrecoverable failure can short-circuit instead of burning the full retry budget.

> **⚠️ This is a behaviour-CHANGING story, not a test-only lock.** Like Stories 13.1 / 13.2, both ACs *add* opt-in library behaviour whose defaults preserve current behaviour (non-breaking → pre-1.0 patch). AC#2 flips an existing locking test **in place** (strip the `// Epic 13 candidate` framing, keep arms + add the new opt-in arm, keep the `F#5` prefix). AC#1 is locked by a **net-new surgical core unit test** (the epic's named lock is the wrong tier — see DD2).

> **🔧 Scope decided 2026-06-14 (Project Lead, via API-validation pass).** The epic-level AC named two flips: `11.3-INT-001` (F#5) **and** `11.5-E2E-010` (C#15). The API-validation pass found (a) `11.5-E2E-010` is a **PW-Lib E2E chaos spec** (`tests/e2e/lib/chaos-degraded.spec.ts`, needs MinIO + 3 browser engines) whose value is the *non-breaking default* lock that 13.4 **preserves** — flipping it is the wrong tier and would destroy that lock (DD2); and (b) the AC#2 fail-fast capability **already exists** via `retrySchedule` + `Schedule.whileInput` with an existing passing test, so AC#2 ships as **thin ergonomic sugar** over that, not a new capability (DD3). Both confirmed by Project Lead before dev.

## Acceptance Criteria

1. **Given** an opt-in `partTimeout: Duration.DurationInput` is supplied and a part's `uploadPart` attempt does not resolve within it, **When** the upload runs, **Then** that **attempt** fails with a typed timeout — a `PartUploadError(partNumber, attempt, PartTimeoutError)` — which feeds the existing `retrySchedule` exactly like any other transient part failure (so a bounded slow-loris part is retried per the schedule and, if every attempt times out, ultimately surfaces as `MaxRetriesExceededError` whose `cause` is the `PartTimeoutError`). With **no** `partTimeout` (default), the current "no hardcoded client timeout" behaviour is preserved byte-for-byte. The timeout wraps the **per-attempt** effect (`single`) inside `makeUploadOne`, *inside* the retry loop — NOT the outer part effect — because the AC requires it to "feed the existing `retrySchedule`" (which is typed `Schedule<unknown, PartUploadError>`). Locked by a **net-new** surgical core unit test (DD2); the E2E spec `11.5-E2E-010 (C#15)` is **re-tagged, not flipped** (it stays green, now explicitly guarding the non-breaking default).

2. **Given** an opt-in `failFast: (cause: unknown) => boolean` predicate, **When** a part's `uploadPart` fails and `failFast(err.cause)` returns `true`, **Then** the part fails immediately on that attempt **without consuming the retry budget** (e.g. `failFast: (cause) => cause instanceof PresignedUrlError`) — instead of the current "wraps as `PartUploadError.cause` and is retried uniformly". With **no** `failFast` (default), uniform retry per the schedule is preserved byte-for-byte. The predicate sees the **raw** `cause` (the original error thrown by `uploadPart`, e.g. the `PresignedUrlError`), keeping the core protocol-agnostic (symmetric with `reinitOnStale` — DD1). It composes orthogonally with `retrySchedule`: you can add fail-fast to the **default** exponential schedule without rebuilding it. Flips locking test `11.3-INT-001 (F#5)` in `packages/tranquilload-core/src/multipart/resume-error-edges.test.ts` — keep arms (a)+(b) (default = still retried uniformly), add arm (c) (opt-in `failFast` → 1 call, `PartUploadError`, retry budget untouched).

## Tasks / Subtasks

- [x] Task 1: `PartTimeoutError` typed error (AC: #1) — core errors
  - [x] Add `export class PartTimeoutError extends Error` to `packages/tranquilload-core/src/errors/upload-error.ts`: `readonly _tag = "PartTimeoutError"`, constructor `(readonly partNumber: number, readonly timeout: Duration.Duration)`, message `` `Part ${partNumber} timed out after ${Duration.toMillis(timeout)}ms` ``, `this.name = "PartTimeoutError"`. Import `Duration` from `effect`.
  - [x] **Do NOT add `PartTimeoutError` to the `UploadError` union** (DD4) — it is a **cause-only** error: it never appears in the error channel (the channel stays `PartUploadError`, then `MaxRetriesExceededError` after the budget). Adding it to the union would be incorrect (never matched there) and would trigger the documented 6-location exhaustive-switch churn for no benefit.
  - [x] Export `PartTimeoutError` from `packages/tranquilload-core/src/errors/index.ts` (so consumers can `err.cause instanceof PartTimeoutError`).

- [x] Task 2: `partTimeout` option + per-attempt wrapping (AC: #1) — core `upload-stream.ts`
  - [x] Add `readonly partTimeout?: Duration.DurationInput` to `UploadMultipartOptions`, with TSDoc: opt-in; bounds **each** `uploadPart` attempt (not the whole part); a timed-out attempt fails with `PartUploadError(cause: PartTimeoutError)` and feeds `retrySchedule`; default `undefined` → no client-side timeout (current behaviour). Note the underlying Promise is not cancelled (same caveat as abort — see the `AbortSignal` memory note); the timeout interrupts the orchestration fiber's wait.
  - [x] Import `Duration` from `effect`; destructure `partTimeout` in the options block (`upload-stream.ts:162-176`).
  - [x] Decode once near the top of the `Effect.gen`: `const partTimeoutDuration = partTimeout !== undefined ? Duration.decode(partTimeout) : undefined` (so the `PartTimeoutError` carries a real `Duration.Duration` and `timeoutFail` gets a stable value).
  - [x] In `makeUploadOne`'s `single` (`upload-stream.ts:326-334`): build the attempt effect, then conditionally wrap:
    ```ts
    const attemptEffect = normalizeCallback(() => uploadPart(partNumber, chunk)).pipe(
      Effect.mapError((cause): PartUploadError => new PartUploadError(partNumber, attempt, cause))
    )
    return yield* (partTimeoutDuration === undefined
      ? attemptEffect
      : attemptEffect.pipe(
          Effect.timeoutFail({
            duration: partTimeoutDuration,
            onTimeout: (): PartUploadError =>
              new PartUploadError(partNumber, attempt, new PartTimeoutError(partNumber, partTimeoutDuration)),
          })
        ))
    ```
    Error channel stays `Effect<string, PartUploadError>` → still feeds `retrySchedule` + `MaxRetriesExceededError` logic unchanged.

- [x] Task 3: `failFast` option + conditional retry (AC: #2) — core `upload-stream.ts`
  - [x] Add `readonly failFast?: (cause: unknown) => boolean` to `UploadMultipartOptions`, with TSDoc: opt-in; receives the **raw** `uploadPart` rejection (the `cause` inside `PartUploadError`); return `true` to fail the part immediately **without** consuming the retry budget; default `undefined` → uniform retry. Protocol-agnostic (caller classifies). Composes (AND) with `retrySchedule` — a part is retried only while the schedule recurs **and** `failFast` is false. `@example failFast: (cause) => cause instanceof PresignedUrlError`.
  - [x] Destructure `failFast` in the options block.
  - [x] In `makeUploadOne`, branch the retry to preserve the EXACT current path when `failFast` is unset:
    ```ts
    const retried = failFast === undefined
      ? Effect.retry(single, retrySchedule)
      : Effect.retry(single, {
          schedule: retrySchedule,
          while: (err: PartUploadError) => !failFast(err.cause),
        })
    const etag = yield* retried.pipe(Effect.catchAll(err => /* unchanged MaxRetriesExceededError logic */ ))
    ```
    When `failFast(err.cause)` is `true` on the first failure → `while` false → no retry → `totalAttempts === 1` → the existing `catchAll` returns the raw `PartUploadError` (cause preserved). Non-breaking default: when `failFast` is `undefined`, the schedule-only branch is byte-for-byte the current code.

- [x] Task 4: Flip `11.3-INT-001 (F#5)` in place (AC: #2) — `resume-error-edges.test.ts`
  - [x] Strip the `// Epic 13 candidate: an opt-in fail-fast policy ...` comment; reframe the block to: failFast is now opt-in (shipped 13.4); the DEFAULT is still uniform retry; `Schedule.whileInput` remains the advanced/equivalent path.
  - [x] Keep arms (a) single-attempt → `PartUploadError` and (b) multi-attempt → `MaxRetriesExceededError` UNCHANGED (these lock the **non-breaking default** — still retried uniformly).
  - [x] Add arm (c): `failFast: (cause) => cause instanceof PresignedUrlError` with `retrySchedule: Schedule.recurs(2)` (budget of 3); assert `failFastCalls === 1` (budget NOT consumed), result `instanceof PartUploadError`, `.attempt === 1`, `.cause === presigned` (the SAME `presigned` instance).
  - [x] Update the test title to e.g. `"11.3-INT-001 (F#5) — PresignedUrlError: retried uniformly by default; opt-in failFast skips the retry budget"`. Keep the `F#5` prefix. Do NOT duplicate the test.

- [x] Task 5: Net-new surgical `partTimeout` unit tests (AC: #1) — `upload-stream.test.ts`
  - [x] Import `PartTimeoutError`. Reuse the existing `Effect.fork` + `TestClock.adjust` + `Fiber.join` pattern (cf. the `"default schedule retries 3 total attempts"` test at `:216`) — deterministic, no real waiting, no MinIO.
  - [x] `13.4-INT-001 (C#15)` — single attempt times out: `partTimeout: "100 millis"`, `retrySchedule: Schedule.recurs(0)`, `uploadPart: () => new Promise<string>(() => {})` (never resolves), `calls++`. `fork` → `TestClock.adjust("1 second")` → `Fiber.join`. Assert `calls === 1`, result `instanceof PartUploadError`, `.attempt === 1`, `.partNumber === 1`, `.cause instanceof PartTimeoutError`.
  - [x] `13.4-INT-002 (C#15)` — repeated timeouts feed retrySchedule: `partTimeout: "100 millis"`, `retrySchedule: Schedule.recurs(2)` (3 total), same never-resolving `uploadPart`. `fork` → `TestClock.adjust("1 second")` → `Fiber.join`. Assert `calls === 3`, result `instanceof MaxRetriesExceededError`, `.totalAttempts === 3`, `.cause instanceof PartTimeoutError`.
  - [x] `13.4-INT-003 (C#15)` — non-breaking control: `partTimeout: "10 seconds"`, `uploadPart: () => "etag-1"` (resolves immediately, no fork needed — success wins the race before the timeout sleep). Assert terminal `UploadCompleted` present (partTimeout does not break the happy path).

- [x] Task 6: Re-tag `11.5-E2E-010 (C#15)` (AC: #1, DD2) — `tests/e2e/lib/chaos-degraded.spec.ts`
  - [x] Edit ONLY the comment + test title: replace "(partTimeout is an Epic 13 candidate)" / "bounding a pathologically slow part needs a `partTimeout` option (Epic 13 candidate)" with a note that `partTimeout` **shipped (opt-in) in Story 13.4**, and this E2E lock now guards the **non-breaking default** — with no `partTimeout`, a slow part still completes (no hardcoded client timeout). **Do NOT flip the assertion** — the test stays green, still asserting the default-behaviour completion. (Why not flip: DD2.)

- [x] Task 7: Changesets (pre-1.0 PATCH)
  - [x] `.changeset/epic13-core-part-timeout.md` — `@tranquilload/core` patch (opt-in `partTimeout` + `PartTimeoutError`).
  - [x] `.changeset/epic13-core-fail-fast.md` — `@tranquilload/core` patch (opt-in `failFast`).
  - [x] Both note "opt-in, default behaviour unchanged"; pre-1.0 patch per the versioning rule. (No adapter change this story — both options are core.)

- [x] Task 8: Triptyque verification
  - [x] `pnpm turbo build` green
  - [x] `pnpm -r test` green (core +3 partTimeout tests; 11.3-INT-001 count unchanged — arm added in place; adapters unchanged)
  - [x] `pnpm turbo typecheck` green

- [x] Task 9: Traceability + docs
  - [x] Record below: `11.3-INT-001 (F#5)` flipped (arm c added); `13.4-INT-001/002/003 (C#15)` net-new; `11.5-E2E-010 (C#15)` re-tagged (not flipped).
  - [x] README: only mention of `PresignedUrlError` is a `Match.tag` example (`README.md:265`); no retry/timeout docs there. The new options are documented via TSDoc (visible in `.d.mts`/IDE). Leave the README untouched (matches 13.1/13.2). Optional discoverability follow-up — flag, don't do.

## Dev Notes

### Spec inputs

- Source: `_bmad-output/planning-artifacts/epics.md § Story 13.4` (acceptance criteria, quick-win tier; risk clusters R-P2-6 + R-P2-9).
- Backlog origin: `_bmad-output/implementation-artifacts/epic-11-retro-2026-06-11.md § Epic 13 Candidate Backlog`.
- Genealogy: `brainstorming-session-2026-05-17-001.md` — F#5 (PresignedUrlError fail-fast), C#15 (slow-loris part / partTimeout).

### This story CHANGES behaviour (critical distinction from Epic 11)

Epic 11 wrote tests that LOCK current behaviour. Epic 13 stories FLIP those locks (or add the capability + a new lock). AC#2's existing test (`11.3-INT-001`) currently asserts the OLD (no fail-fast) behaviour with an explicit `// Epic 13 candidate` comment; the dev changes the lib, keeps the default arms, adds the opt-in arm, strips the comment IN PLACE. AC#1 is locked by net-new surgical unit tests (DD2). Both options are opt-in with defaults preserving current behaviour → non-breaking → pre-1.0 patch.

### Exact source sites (API-validation pass, 2026-06-14)

| Change | Site | Current state | Change |
|---|---|---|---|
| `partTimeout` option | `core/src/multipart/upload-stream.ts:45-149` (`UploadMultipartOptions`) | no such option | add `readonly partTimeout?: Duration.DurationInput` |
| per-attempt timeout | `upload-stream.ts:326-334` (`single`, inside `makeUploadOne`, inside the retry) | attempt = `normalizeCallback(uploadPart) → PartUploadError` | wrap in `Effect.timeoutFail` when `partTimeout` set → `PartUploadError(cause: PartTimeoutError)` |
| `failFast` option | `upload-stream.ts:45-149` | no such option | add `readonly failFast?: (cause: unknown) => boolean` |
| conditional retry | `upload-stream.ts:336-348` (`Effect.retry(single, retrySchedule)`) | retries on every `PartUploadError` | branch: when `failFast` set, `Effect.retry(single, { schedule, while: (err) => !failFast(err.cause) })` |
| `PartTimeoutError` | `core/src/errors/upload-error.ts` (+ `errors/index.ts`) | absent | add cause-only error class (NOT in `UploadError` union — DD4) |

- `Effect.timeoutFail({ duration, onTimeout })` keeps the error channel `PartUploadError` (onTimeout returns `PartUploadError`), so the timeout feeds `retrySchedule` (typed `Schedule<unknown, PartUploadError>`) and the existing `MaxRetriesExceededError` catchAll — no other change to the part pipeline.
- `Effect.retry(self, { schedule, while })`: `while` is a predicate on the error; retry continues only while it returns `true`. `while: () => true` is a no-op gate, so the `failFast === undefined` branch keeps the EXACT current `Effect.retry(single, retrySchedule)` path (don't unify them — preserve the default byte-for-byte).
- Effect version: `3.19.19` (peer `>=3.19.19`). Both `Effect.timeoutFail` and the `Effect.retry` options-object form (`{ schedule, while }`) exist in this version — confirm at typecheck.

### Design decisions (call these out — do not silently re-pick)

- **DD1 — `failFast` is a PREDICATE on the raw cause, symmetric with `reinitOnStale` (Story 13.2).** The core is protocol-agnostic and MUST NOT special-case `PresignedUrlError` by name in the orchestration. `failFast: (cause: unknown) => boolean` receives the **raw** error thrown by `uploadPart` (the `cause` inside `PartUploadError`), and the caller classifies. Default `undefined` → uniform retry. (Considered + rejected: a `failFastErrors: string[]` of `_tag`s — less flexible, still core-side classification; the predicate is strictly more general.)
- **DD2 — AC#1 is locked at the UNIT tier; `11.5-E2E-010` is RE-TAGGED, not flipped (RESOLVED 2026-06-14, Project Lead).** The epic named `11.5-E2E-010 (C#15)` as the flip target, but the API-validation pass found it is a **PW-Lib E2E chaos spec** (`tests/e2e/lib/chaos-degraded.spec.ts`) that: (1) requires MinIO + 3 browser engines + Playwright (the story is otherwise unit-level, no MinIO — cf. 13.1/13.2); (2) drives the upload via `page.evaluate(driveMultipartInPage, ...)`, and an Effect `Duration`/`partTimeout` **cannot be serialized across the `page.evaluate` boundary** (it's a runtime object) — the driver would need a numeric-ms param + in-page reconstruction; (3) currently locks the **non-breaking DEFAULT** ("no `partTimeout` → slow part still completes"), which 13.4 **preserves** — flipping it would DESTROY that valuable lock; (4) E2E is the wrong tier for a deterministic timeout assertion (slow, timing-sensitive across 3 engines). So: ship `partTimeout` in core, lock it with **net-new surgical unit tests** (`13.4-INT-001/002/003`, deterministic via `TestClock`, no MinIO), and **re-tag** `11.5-E2E-010`'s comment to record that the candidate shipped and the spec now guards the non-breaking default. This is the same honest-scope move as 13.2 DD2 (net-new test when the named lock is the wrong shape) + Story 11.6 Pattern 3.
- **DD3 — AC#2 is thin ergonomic SUGAR over an existing capability (RESOLVED 2026-06-14, Project Lead).** Fail-fast for any error type is **already achievable today** via `retrySchedule: Schedule.whileInput(base, (err) => !(err.cause instanceof X))` — proven by the existing passing test `upload-stream.test.ts:241` ("Schedule.whileInput allows differentiating by original error type"). So AC#2 is NOT a missing capability. We ship `failFast` anyway because it is a **genuine ergonomic win**: it lets a caller add fail-fast to the **default** exponential schedule (or any schedule) **without rebuilding it** and without learning `Schedule.whileInput` + the `err.cause` indirection. It composes orthogonally (AND) with `retrySchedule`. (Considered + rejected: declining AC#2 as redundant — the Project Lead chose to ship the sugar for discoverability; the redundancy is documented here and the `Schedule.whileInput` path remains for advanced composition.)
- **DD4 — `PartTimeoutError` is CAUSE-ONLY, not a `UploadError` union member.** The timeout's error channel is `PartUploadError` (so it feeds `retrySchedule`); `PartTimeoutError` only ever lives as `.cause`. It is exported for `instanceof` checks but deliberately NOT added to the union — adding it would be unmatchable in the channel and would trigger the documented 6-location exhaustive-switch update (union, index, `mapError`, `upload-error.test.ts` switch, README `Match.tag`, doctest fixture) for zero benefit. This is the first cause-only exported error; note it in the changeset.

### Critical patterns (MEMORY)

- **Pre-1.0 changesets MUST be `patch`** — `minor` + `workspace:^` peerDep = unwanted jump to 1.0.0. (`project_pre1_peerdep_changesets_trap.md`)
- **Surgical tests** — assert the EXACT error type/`_tag`, the exact call count, the exact `.cause instanceof`, the exact `.attempt`/`.totalParts` — not just "fails". (`feedback_surgical_tests.md`)
- **TestClock for time-based behaviour** — `Effect.timeoutFail` uses the Clock; drive it with `Effect.fork` + `TestClock.adjust` + `Fiber.join` (the `:216` test is the template). `@effect/vitest` `it.effect` injects TestClock. (`effect-vitest-testclock-injection`)
- **normalizeCallback double-wrapping** — pass a raw `throw`/never-resolving `Promise` from test `uploadPart`, NOT an Effect-typed callback (avoids `normalizeCallback` + `mapError` double-wrap). (MEMORY)
- **Typecheck mandatory** — build + test + typecheck triptyque per story. (`feedback_typecheck_mandatory.md`)
- **F#N / test-ID prefix** — preserve `F#5` when flipping `11.3-INT-001`; tag net-new tests `13.4-INT-00N (C#15)`.
- **Don't duplicate the flipped test** — edit `11.3-INT-001` in place (11.2/11.3 review lesson; reaffirmed by 13.1/13.2).
- **MinIO NOT required** — all changes unit-level; `uploadPart` stubbed, no real S3. The re-tagged `11.5-E2E-010` is NOT run as part of this story's gate (it's a nightly PW-Lib chaos spec; we touch only its comment). Triptyque is the gate.
- **AbortSignal / tryPromise caveat** — `Effect.timeoutFail` interrupts the orchestration fiber's wait; the underlying Promise (a real `fetch`) is NOT cancelled unless the user wired a signal. Document the same caveat as the abort path. (`AbortSignal must be wired` MEMORY)

### Why per-attempt, not whole-part (the meaty part of AC#1)

The epic wording "wrapping the per-part `partEffect`" is imprecise: the outer `partEffect` variable (`upload-stream.ts:374`/`:380`) is the semaphore-wrapped + signal-raced effect that contains the WHOLE retry loop. Wrapping THAT in `timeoutFail` would bound all attempts together and the timeout would NOT feed `retrySchedule` (it would sit outside the retry). The AC explicitly says the timeout "feeds the existing `retrySchedule`", which is typed `Schedule<unknown, PartUploadError>` — so the timeout must produce a `PartUploadError` on the **per-attempt** effect (`single`, `:326-334`), inside the retry. A slow attempt then times out → `PartUploadError(cause: PartTimeoutError)` → schedule retries → budget exhausted → `MaxRetriesExceededError(cause: PartTimeoutError)`. (This is the API-validation correction; reviewer should confirm the wrap is on `single`, not the outer `partEffect`.)

### Files likely touched

- **Modified (lib):** `packages/tranquilload-core/src/errors/upload-error.ts` (add `PartTimeoutError`), `packages/tranquilload-core/src/errors/index.ts` (export it), `packages/tranquilload-core/src/multipart/upload-stream.ts` (two options + per-attempt timeout + conditional retry).
- **Modified (test):** `packages/tranquilload-core/src/multipart/resume-error-edges.test.ts` (flip `11.3-INT-001`, add arm c), `packages/tranquilload-core/src/multipart/upload-stream.test.ts` (net-new `13.4-INT-001/002/003`), `tests/e2e/lib/chaos-degraded.spec.ts` (re-tag `11.5-E2E-010` comment only).
- **Added:** 2 changesets (`.changeset/epic13-core-part-timeout.md`, `.changeset/epic13-core-fail-fast.md`).
- **Modified:** this story file; `sprint-status.yaml`.

### Out of scope

- Flipping `11.5-E2E-010` / any MinIO / Playwright / e2e tier work (DD2 — re-tag only).
- Adding `PartTimeoutError` to the `UploadError` union (DD4 — cause-only).
- A whole-part (vs per-attempt) timeout (the AC requires per-attempt to feed the schedule).
- Auto-threading `partTimeout` into the user's `fetch` as an `AbortSignal` (the lib interrupts the fiber wait, not the underlying request — documented caveat, not a change).
- Cancelling the in-flight Promise on timeout (same tryPromise caveat as abort).
- The other Epic 13 stories (13.3 / 13.5 / 13.6 spike-gated) and the deferred 13.7 spike.

## References

- [Source: _bmad-output/planning-artifacts/epics.md § Story 13.4]
- [Source: _bmad-output/implementation-artifacts/epic-11-retro-2026-06-11.md § Epic 13 Candidate Backlog]
- [Source: _bmad-output/brainstorming/brainstorming-session-2026-05-17-001.md] — F#5, C#15
- [Locking tests: resume-error-edges.test.ts (11.3-INT-001 flip); upload-stream.test.ts (13.4-INT-001/002/003 net-new); chaos-degraded.spec.ts (11.5-E2E-010 re-tag)]
- [Existing capability proving AC#2 is sugar: upload-stream.test.ts:241 "Schedule.whileInput allows differentiating by original error type"]
- [Precedent: 13-1-api-boundary-input-guards.md + 13-2-resume-and-reconcile-robustness.md — flip-the-lock pattern, DD structure, API-validation-during-creation]
- [MEMORY: project_pre1_peerdep_changesets_trap.md, feedback_surgical_tests.md, feedback_typecheck_mandatory.md, effect-vitest-testclock-injection]

## Dev Agent Record

### Agent Model Used

claude-opus-4-8 (Opus 4.8) — dev per the permanent Epics 6–9 rule (Opus for dev AND review).

### Debug Log References

- `pnpm vitest run src/multipart/upload-stream.test.ts src/multipart/resume-error-edges.test.ts` (focused) → 37/37 green first run (upload-stream 28→31 with the 3 net-new partTimeout tests; resume-error-edges 6/6, 11.3-INT-001 flipped in place with arm (c) — count unchanged). No red-phase iteration needed.
- `pnpm turbo typecheck --filter=@tranquilload/core` run mid-implementation (before tests) to validate the Effect API usage — both `Effect.timeoutFail({ duration, onTimeout })` and the `Effect.retry(self, { schedule, while })` options form typecheck clean on effect 3.19.19.
- Full triptyque: `pnpm turbo build` ✅ 2/2 · `pnpm turbo typecheck` ✅ 5/5 · `pnpm -r test` ✅ core 209/209 (206→209, +3 partTimeout), adapters 61/61 (unchanged — no adapter change this story). `upload-error.test.ts` 45/45 confirms the cause-only `PartTimeoutError` (NOT a union member) did not break the exhaustive-switch test.
- Red-phase reasoning (not reverted): without the impl, the failFast arm (c) would retry 3× (`failFastCalls === 3 ≠ 1`) → fail; the partTimeout tests' never-resolving Promise would hang the fiber forever (no timeout to fire under TestClock) → vitest timeout. Both genuinely exercise the new behaviour.

### Completion Notes List

- **Third behaviour-CHANGING Epic 13 story — both ACs shipped, two scope corrections from the API-validation pass (Project Lead confirmed before dev).** Both new options are opt-in with defaults that preserve current behaviour byte-for-byte → non-breaking → pre-1.0 patch.
- **AC#1 (core `partTimeout`):** added `partTimeout?: Duration.DurationInput` to `UploadMultipartOptions`, decoded once (`Duration.decode`). The **per-attempt** effect (`single`, inside `makeUploadOne`, inside the retry loop) is wrapped in `Effect.timeoutFail` when set, producing `PartUploadError(partNumber, attempt, new PartTimeoutError(partNumber, duration))` — so a timed-out attempt feeds `retrySchedule` like any transient failure and, when the budget is exhausted, surfaces as `MaxRetriesExceededError(cause: PartTimeoutError)`. New `PartTimeoutError` is **cause-only** (DD4): exported from `errors/index.ts`, NOT added to the `UploadError` union (it never appears in the channel; adding it would be unmatchable + trigger the 6-location exhaustive-switch churn).
- **AC#1 lock (DD2 — net-new unit tier, E2E re-tagged):** `partTimeout` proven by 3 surgical core unit tests `13.4-INT-001/002/003 (C#15)` in `upload-stream.test.ts` (deterministic via `Effect.fork` + `TestClock.adjust` + `Fiber.join`; never-resolving `uploadPart` Promise; no MinIO): single-attempt timeout → `PartUploadError(cause=PartTimeoutError)`; repeated timeouts → `MaxRetriesExceededError(cause=PartTimeoutError)`; control (generous timeout + sync success → completes). The named E2E lock `11.5-E2E-010 (C#15)` was **re-tagged, not flipped** — comment + title updated to record that `partTimeout` shipped (opt-in) and the spec now guards the non-breaking default ("no partTimeout → slow part still completes"); assertion untouched.
- **AC#2 (core `failFast`, DD3 — thin ergonomic sugar):** added `failFast?: (cause: unknown) => boolean` to `UploadMultipartOptions`. The retry is branched: `failFast === undefined` → the EXACT current `Effect.retry(single, retrySchedule)` path (byte-for-byte default); else `Effect.retry(single, { schedule: retrySchedule, while: (err) => !failFast(err.cause) })`. A classified-unrecoverable cause fails on attempt 1 (`totalAttempts <= 1` → the existing catchAll returns the raw `PartUploadError`, cause preserved), retry budget untouched. Protocol-agnostic (predicate on raw cause, symmetric with 13.2's `reinitOnStale`). The capability already existed via `Schedule.whileInput` (existing passing test `upload-stream.test.ts:241`); `failFast` is the discoverable form that composes with the default schedule without rebuilding it.
- **AC#2 flip (11.3-INT-001 / F#5):** edited in place (no duplicate). Kept arm (a) single-attempt + arm (b) multi-attempt → both still "retried uniformly" (locks the non-breaking default); added arm (c) opt-in `failFast` → `failFastCalls === 1`, `PartUploadError`, `attempt === 1`, `cause === presigned`. Title + comment reframed (stripped "Epic 13 candidate"), kept the `F#5` prefix.
- **No adapter change this story** — both options are core-only; adapters 61/61 unchanged. 2 pre-1.0 patch changesets (`epic13-core-part-timeout.md`, `epic13-core-fail-fast.md`).
- **README untouched (deliberate, matches 13.1/13.2):** only `PresignedUrlError` appears (a `Match.tag` doctest example at `README.md:265`); no retry/timeout docs there. The new options are documented via TSDoc (visible in `.d.mts`/IDE). Adding them to the README would drag in the separate doctest tier. Optional discoverability follow-up — flagged, not done.
- **Scope note:** e2e/integration tiers (`tests/`, MinIO/Playwright) NOT run — out of scope (both changes unit-level; `uploadPart` stubbed). The re-tagged `11.5-E2E-010` is a nightly PW-Lib chaos spec; only its comment/title were touched (no assertion change), so it is unaffected. Triptyque is the gate.
- **Reviewer flags:** (1) confirm the timeout wraps the per-attempt `single`, not the outer `partEffect`, so it feeds `retrySchedule` (per AC#1 / the "why per-attempt" note); (2) confirm the `failFast === undefined` branch preserves the exact current retry path (non-breaking default); (3) confirm `PartTimeoutError` being cause-only (not in `UploadError`) is the right call vs adding a 10th union variant; (4) confirm the `partTimeout` TestClock tests are deterministic (no real-time dependence) and the never-resolving Promise leak is harmless in-test.

### Change Log

- 2026-06-14 — Story 13.4 dev (Opus 4.8): resilience policies & timeouts, both ACs. **Lib:** `upload-error.ts` (+ cause-only `PartTimeoutError`); `errors/index.ts` (export it); `upload-stream.ts` (opt-in `partTimeout` per-attempt `Effect.timeoutFail` + opt-in `failFast` conditional retry; both defaults byte-for-byte unchanged). **Tests:** +3 net-new `13.4-INT-001/002/003 (C#15)` partTimeout unit tests (TestClock); flipped `11.3-INT-001 (F#5)` in place (default arms + failFast arm (c)); re-tagged (not flipped) `11.5-E2E-010 (C#15)` comment/title. **2 patch changesets** (core only). Triptyque green (build 2/2, core 209/209, adapters 61/61, typecheck 5/5). API-validation rescopes: DD2 (E2E lock re-tagged, partTimeout locked at unit tier), DD3 (failFast = sugar over existing `Schedule.whileInput`), DD4 (`PartTimeoutError` cause-only). No e2e run (out of scope).

### File List

- **Modified (lib):** `packages/tranquilload-core/src/errors/upload-error.ts` (cause-only `PartTimeoutError`)
- **Modified (lib):** `packages/tranquilload-core/src/errors/index.ts` (export `PartTimeoutError`)
- **Modified (lib):** `packages/tranquilload-core/src/multipart/upload-stream.ts` (`partTimeout` + `failFast` options + per-attempt timeout + conditional retry)
- **Modified (test):** `packages/tranquilload-core/src/multipart/upload-stream.test.ts` (net-new `13.4-INT-001/002/003`)
- **Modified (test):** `packages/tranquilload-core/src/multipart/resume-error-edges.test.ts` (flip `11.3-INT-001`, arm (c))
- **Modified (test):** `tests/e2e/lib/chaos-degraded.spec.ts` (re-tag `11.5-E2E-010` comment + title only)
- **Added:** `.changeset/epic13-core-part-timeout.md`
- **Added:** `.changeset/epic13-core-fail-fast.md`
- **Modified:** `_bmad-output/implementation-artifacts/13-4-resilience-policies-and-timeouts.md` (this file)
- **Modified:** `_bmad-output/implementation-artifacts/sprint-status.yaml` (13-4 → in-progress → review)
