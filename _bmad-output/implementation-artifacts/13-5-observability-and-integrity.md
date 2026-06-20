---
baseline_commit: ce41c18
---

# Story 13.5: Observability — Event-Stream Flush-Before-Error

Status: done

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a library maintainer,
I want the public `events` stream to flush every buffered `UploadEvent` before surfacing a failure/abort,
so that abort/failure observability is not lost — events currently read **empty** on the failure path, a gap worked around throughout Story 11.5 with callback-side counters.

> **⚠️ This is a behaviour-CHANGING story, gated by an API-validation / design spike (run during creation, 2026-06-20).** The epic-level Story 13.5 bundled TWO halves: (1) event-stream flush-before-error and (2) an optional ingest checksum. The spike found the flush is a clean, well-defined, high-value fix, but the **checksum half carries a genuine semantics fork** (a digest of the uploaded bytes cannot detect a buggy compressor — it faithfully matches the corrupt output). **Project Lead decision (2026-06-20, via AskUserQuestion):** ship the **flush half only** this story; **carve the ingest checksum into a follow-up Story 13.5b** with its own design pass (semantics TBD). This story is therefore flush-only.

> **🔧 Scope decided 2026-06-20 (Project Lead, via API-validation pass).** (a) Flush locked at the **unit tier** (net-new `13.5-INT-001/002` in `multipart/index.test.ts`); the Story 11.5 E2E callback-counter workaround is **re-tagged, not flipped** — an E2E/MinIO/3-engine chaos spec is the wrong tier for a deterministic stream behaviour (same call as 13.4 DD2). (b) Applied **symmetrically to `uploadOnce`** for code consistency, but **behaviour-preserving** there (one-shot emits only its terminal `UploadCompleted` — no pre-failure events to flush; DD3). (c) Ingest checksum + the `11.2-INT-005` (F#70) flip **deferred to 13.5b** — that lock stays green, re-tagged to point at 13.5b.

## Acceptance Criteria

1. **Given** an upload that fails or is aborted mid-flight (after ≥1 `UploadEvent` has been emitted), **When** the consumer reads the `events` stream, **Then** all `UploadEvent`s emitted before the failure are observable (flushed) before the stream closes — instead of reading empty — while the typed `UploadError` still surfaces **only** via `result` (the error is never masked on the events channel). With a **successful** upload, the events stream is unchanged (still yields the full event sequence ending in `UploadCompleted`). Locked by net-new unit tests `13.5-INT-001` (part-failure path) + `13.5-INT-002` (abort path) in `packages/tranquilload-core/src/multipart/index.test.ts`. The Story 11.5 E2E callback-counter workaround is re-tagged (DD1).

2. **(DEFERRED to Story 13.5b)** ~~optional ingest checksum to surface a corrupting `CompressionService`~~ — carved out per the Project Lead scope decision; `11.2-INT-005` (F#70) stays a green lock, re-tagged to point at 13.5b.

## Tasks / Subtasks

- [x] Task 1: Flush events live in `uploadMultipart` (AC: #1) — core `multipart/index.ts`
  - [x] Replace the "build `events` by awaiting the fully-collected array" pattern (which closed empty on a rejected `collected`) with a controller-backed `ReadableStream` whose controller is captured in `start`, defined **before** the `collected` IIFE so the enqueue fn exists when the stream runs.
  - [x] Add a `Stream.tap((event) => Effect.sync(() => enqueueEvent(event)))` ahead of the existing uploadId/progress side-effect tap — neither depends on the other; the flush tap just mirrors each event into the live stream.
  - [x] Call `closeEvents()` right after `Stream.runCollect(...)` settles (both success and failure branches) — every event was already enqueued; the failure surfaces only via `result`.
  - [x] Guard `enqueueEvent`/`closeEvents` with an `eventsClosed` flag + try/catch so a consumer that cancels the reader cannot crash the upload fiber (the `cancel()` handler sets `eventsClosed`).

- [x] Task 2: Symmetric flush in `uploadOnce` (AC: #1, DD3) — core `oneshot/index.ts`
  - [x] Apply the identical controller-backed pattern + a single `Stream.tap` flush. Behaviour-preserving: one-shot emits only its terminal `UploadCompleted`, so there is never a pre-failure event to flush; a failed/aborted one-shot still closes the events stream cleanly with zero events. Done for wrapper symmetry (the two public entry points must not diverge).

- [x] Task 3: Net-new unit locks (AC: #1) — `multipart/index.test.ts`
  - [x] `13.5-INT-001` — part-failure path: `initiate` (→ `UploadInitiated`), 2 parts, `maxConcurrency: 1` (part 1 completes + emits `ProgressTick` before part 2), `retrySchedule: Schedule.recurs(0)` (1 attempt, deterministic), `uploadPart` resolves part 1, rejects part 2. Assert: `result` rejects with `PartUploadError(partNumber: 2)` (error NOT masked) AND `events` contains `UploadInitiated` + exactly one `PartCompleted(partNumber: 1)` + no `UploadCompleted` (flushed; was EMPTY pre-13.5).
  - [x] `13.5-INT-002` — abort path: same shape, part 2 trips `controller.abort()` then never resolves. Assert: `result` rejects `AbortError` AND `events` flushed `UploadInitiated` + `PartCompleted(1)` + no `UploadCompleted`.
  - [x] Reframe (not flip) the existing F#9 abort test comment — its scenario (no `initiate`, `uploadPart` never resolves) emits nothing before the abort, so 0 events is still correct there; add a `not.toContain("UploadCompleted")` assertion and point to 13.5-INT-001/002 for the flush proof.
  - [x] Reframe the `uploadOnce` abort test (`oneshot/index.test.ts`) comment — `toHaveLength(0)` stays correct (no pre-failure events for one-shot, DD3).

- [x] Task 4: Re-tag the Story 11.5 E2E callback-counter workaround (AC: #1, DD1) — comments only
  - [x] `tests/support/helpers/lib-multipart-driver.ts` (`completedParts` / `partsCompletedViaCallback` TSDoc): record that 13.5's flush makes `events`/`completedParts` reliable on the abort path too; `partsCompletedViaCallback` is RETAINED as the primary abort signal (defense-in-depth; deterministic flush locked at the unit tier).
  - [x] `tests/e2e/lib/chaos-abort-timing.spec.ts` (the `11.5-E2E-012` workaround comment): same re-tag. **Do NOT flip any assertion** — verified none of the chaos specs assert events-emptiness (abort specs use `not.toContain("UploadCompleted")`, success specs use `toContain` — both robust to the flush).

- [x] Task 5: Re-tag the deferred checksum lock (DD5) — `compression-service-edges.test.ts`
  - [x] `11.2-INT-005` (F#70): replace the "Epic 13 candidate: optional ingest checksum" comment with the 13.5b carve-out note (semantics fork documented); the trust-boundary lock stays GREEN — 13.5b will flip it.

- [x] Task 6: Changeset (pre-1.0 PATCH) — `.changeset/epic13-core-events-flush.md`, `@tranquilload/core` patch (flush-before-error; non-breaking — success path unchanged, failure still rejects `result` with the same typed error).

- [x] Task 7: Triptyque verification — `pnpm turbo build` ✅ 2/2 · `pnpm turbo typecheck` ✅ 5/5 · `pnpm -r test` ✅ core 216/216 (214→216, +2 flush locks), adapters 61/61 (unchanged).

## Dev Notes

### Spec inputs

- Source: `_bmad-output/planning-artifacts/epics.md § Story 13.5` (flush + checksum; the flush flips "the Story 11.5 events-empty workaround"; the checksum flips `11.2-INT-005`/F#70). Spike-gated; risk clusters R-P2-3 + R-P2-5.
- Backlog origin: `_bmad-output/implementation-artifacts/epic-11-retro-2026-06-11.md § Epic 13 Candidate Backlog`.

### Root cause (the spike's central finding)

Both `multipart/index.ts` and `oneshot/index.ts` built the public `events` stream from a single `collected` promise that uses `Stream.runCollect`. `runCollect` is **all-or-nothing**: on a failed `Exit` it discards every buffered event and `collected` *rejects*; the `events` `ReadableStream`'s `start` then hit its `catch` and closed **empty**. That is the "events read empty on the failure path" gap. Fix = stop deriving `events` from the all-or-nothing collected array; enqueue each event **live** via `Stream.tap` and keep the typed error on the `result` channel only (the spike note's "split the events channel from the result channel WITHOUT masking the typed error").

### Design decisions (call these out — do not silently re-pick)

- **DD1 — flush locked at the UNIT tier; Story 11.5 E2E callback-counter workaround RE-TAGGED, not flipped.** The AC names "the Story 11.5 events-empty workaround" — that workaround lives in PW-Lib/MinIO chaos specs (`tests/e2e/lib/chaos-*.spec.ts` + `lib-multipart-driver.ts`), which drive the upload via `page.evaluate` across 3 browser engines. A deterministic stream behaviour belongs at the unit tier (net-new `13.5-INT-001/002`, no MinIO, no browsers), and re-asserting it across 3 nightly chaos engines would be slow + the wrong tier. Same tier-correctness call as 13.4 DD2 / 13.3 DD2. The E2E specs are unaffected by the flush (none assert emptiness) — only their now-stale "events read empty on abort" comments are re-tagged.
- **DD2 — split the events channel from the result channel (live enqueue), NOT runCollect-then-replay.** `events` is fed by a `Stream.tap` that enqueues each event into a controller-backed `ReadableStream` as it flows; `result` still derives from `collected` (which keeps using `runCollect` to get the terminal `UploadCompleted` + the "ended without event" guard) and still rejects with the squashed typed `UploadError`. The typed error is therefore **never masked** — it is simply no longer on the events channel (the events channel only ever closes, cleanly). `runCollect` still buffers the event array for `result`; the extra live-controller buffer is events-only (small metadata objects) — same memory profile as before.
- **DD3 — applied symmetrically to `uploadOnce`, but behaviour-preserving there.** One-shot's effect emits a single terminal `UploadCompleted` (`Stream.fromEffect(program)`); there are never pre-failure events, so the flush is a no-op for one-shot (a failed/aborted one-shot still yields 0 events, cleanly). Applied anyway so the two public wrappers stay structurally identical (a future maintainer/reviewer would flag divergence). The `oneshot/index.test.ts` abort lock (`toHaveLength(0)`) stays valid and is reframed, not flipped.
- **DD4 — incremental emission is an intentional, beneficial side effect.** Pre-13.5 the events stream was batched at completion (built from the collected array after the upload settled) — the MEMORY note "Test-app log batches events at completion" is exactly this. Post-13.5 events stream **live**, which is strictly better for observability and removes that batching friction at the library level. No existing test relies on batched timing (the unit tests read events after `result`; reading-after-result still yields the full set), so this is backward-compatible.
- **DD5 — ingest checksum (AC#2 / F#70) DEFERRED to Story 13.5b.** The F#70 framing ("catch a corrupting `CompressionService`") is not honestly satisfiable by a generic checksum: a digest of the uploaded bytes faithfully matches whatever (corrupt) bytes the compressor produced — it cannot tell that the compressor mangled its input. The achievable designs diverge (transport-integrity-checksum-for-server-verification vs caller-supplied-expected-digest), which is a genuine fork deserving its own design pass. Project Lead deferred the semantics decision to 13.5b. `11.2-INT-005` (F#70) stays a green trust-boundary lock, re-tagged to 13.5b.

### Critical patterns (MEMORY)

- **Pre-1.0 changesets MUST be `patch`** — `minor` + `workspace:^` peerDep = unwanted jump to 1.0.0. (`project_pre1_peerdep_changesets_trap.md`)
- **Surgical tests** — assert the EXACT error type/`partNumber`, the exact event `_tag`s + counts, not just "fails". (`feedback_surgical_tests.md`)
- **P2 specs default to PW-Lib / vitest-integration; only escalate to e2e/ui when browser-specific** — the flush is deterministic, so it's a unit lock (`feedback_p2_default_to_lib.md`).
- **Typecheck mandatory** — build + test + typecheck triptyque per story. (`feedback_typecheck_mandatory.md`)
- **Don't duplicate / flip-the-lock in place** — but `13.5-INT-001/002` are NET-NEW (no existing test exercised "events emitted before failure"; the existing F#9/oneshot abort locks emit nothing before the abort, so they are reframed not flipped — honest-scope move, same as 13.4 DD2's net-new + re-tag).
- **MinIO NOT required** — all changes unit-level (`uploadPart` stubbed). The re-tagged E2E chaos specs are nightly PW-Lib; only comments touched. Triptyque is the gate.

### Files likely touched

- **Modified (lib):** `packages/tranquilload-core/src/multipart/index.ts` (live events flush), `packages/tranquilload-core/src/oneshot/index.ts` (symmetric flush).
- **Modified (test):** `packages/tranquilload-core/src/multipart/index.test.ts` (+`13.5-INT-001/002`, reframe F#9 comment), `packages/tranquilload-core/src/oneshot/index.test.ts` (reframe abort comment), `packages/tranquilload-core/src/services/compression-service-edges.test.ts` (re-tag `11.2-INT-005`/F#70 → 13.5b), `tests/support/helpers/lib-multipart-driver.ts` + `tests/e2e/lib/chaos-abort-timing.spec.ts` (re-tag E2E workaround comments — no assertion change).
- **Added:** `.changeset/epic13-core-events-flush.md` (1 pre-1.0 patch, core only).
- **Modified:** this story file; `_bmad-output/planning-artifacts/epics.md` (narrow 13.5 → flush-only, add 13.5b); `_bmad-output/implementation-artifacts/sprint-status.yaml`.

### Out of scope

- The ingest checksum + the `11.2-INT-005` (F#70) flip (DD5 — deferred to Story 13.5b).
- Flipping any E2E/MinIO/Playwright chaos spec (DD1 — re-tag comments only).
- Story 13.6 (spike-gated) and the deferred 13.7 spike.

## References

- [Source: _bmad-output/planning-artifacts/epics.md § Story 13.5]
- [Source: _bmad-output/implementation-artifacts/epic-11-retro-2026-06-11.md § Epic 13 Candidate Backlog]
- [Locking tests: multipart/index.test.ts (13.5-INT-001/002 net-new); oneshot/index.test.ts (abort lock reframed); compression-service-edges.test.ts (11.2-INT-005/F#70 re-tagged → 13.5b)]
- [E2E re-tag (comments only): tests/support/helpers/lib-multipart-driver.ts; tests/e2e/lib/chaos-abort-timing.spec.ts]
- [Precedent: 13-4-resilience-policies-and-timeouts.md — unit-tier lock + E2E re-tag (DD2); flip-the-lock vs net-new honesty]
- [MEMORY: project_pre1_peerdep_changesets_trap.md, feedback_surgical_tests.md, feedback_typecheck_mandatory.md, feedback_p2_default_to_lib.md]

## Dev Agent Record

### Agent Model Used

claude-opus-4-8 (Opus 4.8) — dev per the permanent Epics 6–9 rule (Opus for dev AND review).

### Debug Log References

- `pnpm --filter @tranquilload/core exec vitest run src/multipart/index.test.ts src/oneshot/index.test.ts src/services/compression-service-edges.test.ts` → 30/30 green (multipart 19→21 with the 2 net-new flush locks; oneshot 6/6 unchanged; compression-edges 3/3 unchanged).
- Full triptyque: `pnpm turbo build` ✅ 2/2 · `pnpm turbo typecheck` ✅ 5/5 · `pnpm -r test` ✅ core 216/216 (214→216, +2), adapters 61/61 (unchanged — no adapter change).
- Red-phase reasoning (not reverted): against the OLD code, `collected` rejects on the failure path → the events `ReadableStream` `catch` closes EMPTY → `readAllEvents` returns `[]` → `13.5-INT-001/002`'s `evts.length > 0` + `partEvents.toHaveLength(1)` would fail. Both genuinely exercise the new flush.

### Completion Notes List

- **Spike-gated Epic 13 story, scoped to the flush half (Project Lead deferred the checksum to 13.5b via AskUserQuestion during creation).** Non-breaking: the success path is byte-for-byte unchanged; a failed/aborted upload still rejects `result` with the same typed error — the only change is that `events` now flushes pre-failure events instead of closing empty → pre-1.0 patch.
- **AC#1 (core flush):** both `uploadMultipart` and `uploadOnce` now feed `events` via a controller-backed `ReadableStream` + a live `Stream.tap` enqueue, closing the stream cleanly on settle. The typed `UploadError` is split onto the `result` channel only (never masked). Guarded against consumer-cancel (`eventsClosed` flag + try/catch + `cancel()` handler) so cancelling the reader can't crash the upload fiber.
- **AC#1 lock (DD1 — unit tier, E2E re-tagged):** net-new surgical `13.5-INT-001` (part-failure) + `13.5-INT-002` (abort) prove the flush deterministically (no MinIO); the existing F#9 (multipart) + abort (oneshot) locks are reframed, not flipped (their scenarios emit nothing before the abort → 0 events still correct). The Story 11.5 E2E callback-counter workaround comments (`lib-multipart-driver.ts`, `chaos-abort-timing.spec.ts`) are re-tagged — verified no chaos spec asserts events-emptiness, so the flush breaks none of them.
- **DD3:** the `uploadOnce` change is behaviour-preserving (single terminal event → nothing to flush); applied for wrapper symmetry.
- **DD5:** ingest checksum + the F#70 flip deferred to 13.5b; `11.2-INT-005` re-tagged, stays green.
- **No adapter change** — adapters 61/61 unchanged. 1 pre-1.0 patch changeset (core only).
- **README untouched (deliberate, matches 13.1/13.2/13.4):** the flush is an internal-behaviour fix to an already-documented `events` stream; no public API surface changed. Optional discoverability follow-up — flag, don't do.
- **Reviewer flags:** (1) confirm the typed `UploadError` is genuinely never lost — it still rejects `result` (the events channel only closes); (2) confirm the consumer-cancel guard (`eventsClosed` + try/catch) actually prevents an upload-fiber crash if a reader cancels mid-flight; (3) confirm the `uploadOnce` symmetric change is truly behaviour-preserving (single terminal event); (4) confirm `13.5-INT-001/002` are deterministic (`maxConcurrency: 1` + `Schedule.recurs(0)` serialize part 1 before the part-2 failure) and genuinely red against the old code; (5) confirm the E2E re-tags changed no assertions.

### Change Log

- 2026-06-20 — Story 13.5 dev (Opus 4.8): event-stream flush-before-error (flush half only; checksum deferred to 13.5b). **Lib:** `multipart/index.ts` + `oneshot/index.ts` (live events flush via controller-backed `ReadableStream` + `Stream.tap`; typed error split onto `result`; consumer-cancel guarded). **Tests:** +2 net-new `13.5-INT-001/002` (multipart flush, part-failure + abort); reframed F#9 (multipart) + abort (oneshot) comments; re-tagged `11.2-INT-005`/F#70 → 13.5b; re-tagged Story 11.5 E2E callback-counter workaround comments (`lib-multipart-driver.ts`, `chaos-abort-timing.spec.ts`) — no assertion change. **1 patch changeset** (core only). Triptyque green (build 2/2, core 216/216, adapters 61/61, typecheck 5/5). Spike forks surfaced to Project Lead (AskUserQuestion): flush-only this story; checksum → 13.5b with its own design pass.

### File List

- **Modified (lib):** `packages/tranquilload-core/src/multipart/index.ts`
- **Modified (lib):** `packages/tranquilload-core/src/oneshot/index.ts`
- **Modified (test):** `packages/tranquilload-core/src/multipart/index.test.ts` (+`13.5-INT-001/002`, reframe F#9)
- **Modified (test):** `packages/tranquilload-core/src/oneshot/index.test.ts` (reframe abort comment)
- **Modified (test):** `packages/tranquilload-core/src/services/compression-service-edges.test.ts` (re-tag `11.2-INT-005`/F#70 → 13.5b)
- **Modified (test infra):** `tests/support/helpers/lib-multipart-driver.ts` (re-tag E2E workaround TSDoc)
- **Modified (test):** `tests/e2e/lib/chaos-abort-timing.spec.ts` (re-tag E2E workaround comment)
- **Added:** `.changeset/epic13-core-events-flush.md`
- **Modified:** `_bmad-output/implementation-artifacts/13-5-observability-and-integrity.md` (this file)
- **Modified:** `_bmad-output/planning-artifacts/epics.md` (narrow 13.5 → flush-only; add 13.5b)
- **Modified:** `_bmad-output/implementation-artifacts/sprint-status.yaml`

## Senior Developer Review (AI)

**Reviewer:** independent Opus 4.8 `code-reviewer` agent (fresh context — Codex unavailable; another Opus stands in per user direction).
**Date:** 2026-06-20
**Outcome:** ✅ **Approve** — 0 HIGH / 0 MEDIUM / 3 LOW (all declined; doc/process only).

### Verdict

Clean, minimal, correctly-split fix. The reviewer traced all 7 load-bearing invariants statically rather than rubber-stamping, and every one held: (1) the typed `UploadError` is never masked — `result` rejects via `Promise.reject(Cause.squash(exit.cause))` while the events channel only ever `enqueue`/`close`s (never `controller.error(...)`), and `closeEvents()` runs before the reject branch and cannot throw into it; (2) consumer-cancel is safe — `enqueueEvent`/`closeEvents` guard on `eventsClosed` + try/catch and the `cancel()` handler sets the flag, so no `enqueue`/`close` can throw out of the (synchronous, total) `Effect.sync` tap; (3) `start` runs synchronously during `new ReadableStream(...)` (WHATWG spec) — strictly before the `collected` IIFE's first tap, so `eventsController` is never `undefined` at first enqueue (also empirically confirmed by the passing `13.5-INT-001/002`); (4) `uploadOnce` is genuinely behaviour-preserving — `Stream.fromEffect(program)` emits exactly one terminal `UploadCompleted`, so the flush is a true no-op and the reframed `toHaveLength(0)` lock stays correct; (5) `maxConcurrency: 1` + `Schedule.recurs(0)` make `13.5-INT-001/002` deterministic (part 1's `PartCompleted` flushes before part 2's `PartUploadError(partNumber: 2)`; `totalAttempts <= 1` keeps it a raw `PartUploadError`, not `MaxRetriesExceededError`) and genuinely red pre-change; (6) the E2E re-tags break no assertion. The reviewer surfaced one assertion my own grep missed — `chaos-abort-timing.spec.ts:49` `result.completedParts).toBe(0)` (`11.5-E2E-011`) — and I independently confirmed it: that spec aborts `{ when: "duringInitiate" }`, so no part runs and `0` holds regardless of the flush; `11.5-E2E-012` asserts `partsCompletedViaCallback` (not `completedParts`). All `result.events` assertions are `toContain`/`not.toContain("UploadCompleted")` — robust to a now-populated array.

### Findings & dispositions

- **LOW-1** (un-drained-reader buffer): the live `events` controller has no queuing-strategy/`pull` handler, so a consumer that holds `events` but never reads it retains the per-event queue (~2 events/part) until settle. **Declined (no code change)** — it is NOT a regression (`runCollect` already buffers the identical array for `result` over the same lifetime, bounded by S3's 10k-part cap) and the project keeps internal-behaviour fixes out of the public-doc surface (consistent with 13.1/13.2/13.4). The reviewer itself rated it "Acceptable as-is / no code change required to merge." Optional discoverability follow-up — flagged, not done.
- **LOW-2** (the green-suite was asserted by the story, not re-run by the reviewer): **Addressed** — the dev independently ran the full triptyque twice (build 2/2, core 216/216, adapters 61/61, typecheck 5/5) + the forced `@tranquilload/tests` typecheck (3/3). CI is the formal gate at release time (CI-native release flow). No code change.
- **LOW-3** (`enqueueEvent` silently absorbs an unexpected `enqueue` throw): **Declined** — the reviewer confirms the silence is intentional (symmetry with consumer-cancel; the failure surfaces via `result` regardless). No change.

**Dev decision:** all 3 LOWs declined/addressed with rationale — `receiving-code-review` skepticism applied in both directions (each is a genuine observation but none is a reachable defect or a regression). Triptyque remains green (unchanged since no code edit followed the review).
