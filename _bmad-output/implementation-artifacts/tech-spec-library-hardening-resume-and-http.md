---
title: 'Library Hardening — Resume Safety + HTTP Streaming Strategy (v2)'
slug: 'library-hardening-resume-and-http'
created: '2026-05-17'
revised: '2026-05-17 (post second adversarial review — auto-re-init scope cut)'
status: 'Implementation Complete'
stepsCompleted: [1, 2, 3, 4, 5]
tech_stack:
  - typescript
  - effect
  - vitest
  - '@effect/vitest'
  - tsdown
  - pnpm-workspaces
  - changesets
files_to_modify:
  - 'packages/tranquilload-adapters/src/protocols/simple-http-upload.ts'
  - 'packages/tranquilload-adapters/src/protocols/simple-http-upload.test.ts'
  - 'packages/tranquilload-core/src/errors/upload-error.ts'
  - 'packages/tranquilload-core/src/errors/upload-error.test.ts'
  - 'packages/tranquilload-core/src/errors/index.ts'
  - 'packages/tranquilload-core/src/multipart/upload-stream.ts'
  - 'packages/tranquilload-core/src/multipart/upload-stream.test.ts'
  - 'packages/tranquilload-core/src/multipart/index.ts'
  - 'packages/tranquilload-core/src/multipart/index.test.ts'
  - 'README.md'
  - 'MIGRATION.md'
  - '.changeset/'
code_patterns:
  - 'Closed UploadError union: each variant extends Error + has readonly _tag literal'
  - 'Effect Services: Interface + Tag + Layer.Live in same file'
  - 'Dual-mode callbacks: normalizeCallback() detects Promise / Effect / sync'
  - 'Effect-first internals: no try/catch, use Effect.tryPromise / Effect.try'
  - 'Effect.raceFirst(uploadEffect, fromAbortSignal(signal)) for AbortController interop'
  - 'mapError to project caller errors into UploadError union'
  - 'Tests use @effect/vitest: it.effect(...), Effect.provide(LoggerServiceLive)'
test_patterns:
  - 'it.effect for pure Effect tests'
  - 'Custom layer pattern: define recording array outside Effect.gen, nest Effect.provide'
  - 'TestClock.adjust for time-based Schedules'
  - 'expect(...).toBeInstanceOf(UploadError) + toMatchObject for tagged variants'
---

# Tech-Spec: Library Hardening — Resume Safety + HTTP Streaming Strategy (v2)

**Created:** 2026-05-17 · **Revised:** 2026-05-17 (post second adversarial review)

> **Revision history.** The first version of this spec (v1) included an "auto-re-initiate when uploadId is gone" feature. Two rounds of adversarial review revealed that the Stream-level event-injection plumbing required to implement it cleanly was being hand-waved, AND the patches I wrote introduced new semantic regressions (synthetic `UploadInitiated` on resume, unimplementable resumeState resolution logic). The honest call was a scope cut. **Auto-re-init is deferred to its own future spec (v0.3+).** This v2 spec ships the silent-corruption protections (which were always the higher-value defenses) without the complexity ceiling that broke v1.

## Overview

### Problem Statement

The brainstorming session at `_bmad-output/brainstorming/brainstorming-session-2026-05-17-001.md` surfaced 18 missing-feature flags. The top-priority cluster — silent-corruption risks on resume and HTTP body streaming correctness — ships here as one coherent change because they share types (`UploadError`, `UploadMultipartOptions`).

Specific gaps addressed:

1. **`simpleHttpUpload` browser failure (F#40, G#2).** The adapter does `fetch({ body: ReadableStream })` without `duplex: 'half'`. Modern browsers reject this; HTTP/2 is required.
2. **ChunkSize mismatch on resume → silent corruption (P#C3).** A user changing `chunkSize` between sessions silently corrupts files; lib doesn't notice.
3. **Content mismatch on resume → silent corruption (P#C4).** A user resumes with a different file of the same name+size; lib uploads wrong bytes; MinIO completes the corrupt object.
4. **ResumeState schema evolution risk (Pre-mortem Failure A).** Without versioning, the first ResumeState schema change breaks every persisted state in the wild.
5. **Pipeline mismatch on resume → silent corruption (Pre-mortem Failure D).** Resuming with a different compression algorithm produces a Frankenstein object.
6. **Legacy `initiate-with-stored-id` pattern silently survives upgrade.** v0.1.0 users keep working but get zero new safety.

### Solution

Two changes:

1. **`simpleHttpUpload` ships both streaming and buffered modes.** Default streaming with `duplex: 'half'` (requires HTTP/2; documented). Opt-in `bufferMode: true` drains the source into a `Blob` first via a signal-aware manual reader loop. Works on HTTP/1.1 at the cost of memory.

2. **`uploadMultipart` introduces an opaque `ResumeState`** returned alongside `uploadId`. The state object carries `version`, `chunkSize`, optional `pipelineIdentity`, optional `contentDigest`, and a `contentDigestCaptured` flag. Caller persists it (typically `JSON.stringify` to localStorage). On the next session, caller passes `resumeFrom: ResumeState`. The lib validates `version`, `chunkSize`, `pipelineIdentity`, content-digest match (when applicable), and rejects mismatches with a typed `ResumeMismatchError` — *before any byte is uploaded*.

### Scope

**In Scope:**

- `simpleHttpUpload`: add `bufferMode?: boolean` option; set `duplex: 'half'` in stream path; tests; JSDoc.
- New `ResumeState` type exported from `@tranquilload/core/multipart`.
- New `ResumeMismatchError` variant in `UploadError` union (errors/index.ts re-export).
- Fix pre-existing missing `CircuitOpenError` re-export from `@tranquilload/core/errors`.
- `UploadMultipartOptions`: add `resumeFrom?: ResumeState`, `getContentDigest?: () => string | Promise<string> | Effect<string, UploadError>`, `pipelineIdentity?: string`.
- `uploadMultipart` semantics: when `resumeFrom` is set, validate match; use `resumeFrom.uploadId` directly (skip `initiate`). When `resumeFrom` is absent and `initiate` is set, capture state via `initiate` + optional digest. Existing optional-`initiate` behavior unchanged for users without resume.
- Public `uploadMultipart` wrapper: surface `resumeState: Promise<ResumeState>` on return.
- Legacy-pattern detection: warn unconditionally on `console.warn` when `initiate + reconcileCompletedParts + no resumeFrom` is detected. Warning includes link to MIGRATION.md.
- README: update Resume example for the new flow; add HTTP streaming requirements section; update Match.tag example.
- MIGRATION.md: explain v0.1.x → v0.2.x changes.
- Changesets: 2 entries (adapters patch, core minor).

**Out of Scope (explicitly deferred):**

- **Auto-re-initiate on dead uploadId.** This was in scope for v1 of this spec but the Stream-level event-injection design had hidden complexity that two adversarial reviews failed to resolve. Deferred to a future spec with its own design pass. Users currently still get `PartUploadError` (wrapping the 404) when the stored uploadId is dead — same as today. No regression, no advance.
- `UploadIdGoneError` typed sentinel. Without auto-re-init there's no consumer for it.
- `UploadReinitiated` event variant. Without auto-re-init there's no emission point.
- Web Locks for multi-tab coordination (P#D2, C#9) — separate v1.x epic.
- Differentiated retry policies per `PartUploadError.cause` shape (F#5).
- Pre-validation of S3 10,000-part limit (F#49).
- Auto-abort on `CompleteUploadError` — needs its own design.

### Pre-mortem Defensive Additions (carried from v1)

| # | Addition | Prevents |
|---|---|---|
| A | `version: 1` literal field in `ResumeState` | Silent breakage when ResumeState schema evolves |
| C | Strong JSDoc on `getContentDigest`: "must be lightweight + stable; suggested patterns: `${name}\|${size}\|${lastModified}`" | Battery-killing full-file SHA-256 on mobile |
| D | `pipelineIdentity?: string` field + strict-equality validation | Compression-pipeline mismatch corruption |
| E | `console.warn` for legacy v0.1.0 pattern + MIGRATION.md | Silent no-op upgrade |
| F | Strong JSDoc on `bufferMode`: "memory equals source size" | OOM on multi-GB files with bufferMode enabled |

*(Item B from v1 — `UploadReinitiated` event + cap-at-1 — is dropped along with auto-re-init.)*

## Context for Development

### Locked Design Decisions

| Decision | Choice | Rationale |
|---|---|---|
| `simpleHttpUpload` streaming strategy | Both modes; stream default with `duplex: 'half'`, opt-in `bufferMode: true` | Honest about HTTP/2 requirement; HTTP/1.1 escape hatch |
| Resume state shape | Opaque `ResumeState` returned by initiate; user persists one blob | User can't lose half the state; lib owns shape |
| Legacy-pattern warning | Unconditional `console.warn` when `initiate + reconcile + no resumeFrom` is detected | Simpler than provenance tracking; some false positives accepted (documented) |
| Pipeline identity | User-provided string (opt-in), strict equality | Lib can't derive from arbitrary Transform functions; pragmatic trade-off |

### Codebase Patterns (relevant to this work)

- **UploadError union is closed, tag-discriminated.** Each variant extends `Error`, has `readonly _tag = "FooError" as const`, sets `this.name = "FooError"`. `errors/index.ts` re-exports every variant.
- **3+1 exhaustive locations to update when adding an error variant** (from MEMORY.md): union in `upload-error.ts`, exports in `errors/index.ts`, `mapError` in `upload-stream.ts`, exhaustive switch test in `upload-error.test.ts`.
- **`normalizeCallback` handles Promise / Effect / sync** in `utils/normalize-callback.ts`. The new `getContentDigest` callback uses it.
- **Error mapping inside `uploadMultipartEffect`** uses `Effect.mapError((cause): UploadError => new SpecificError(cause))` per phase.
- **Public wrapper at `multipart/index.ts`** runs the Stream via `Effect.runPromiseExit + Cause.squash` to surface typed errors as Promise rejections.

### Files to Reference

| File | Purpose |
| ---- | ------- |
| `packages/tranquilload-core/src/errors/upload-error.ts` | Add `ResumeMismatchError`; extend union |
| `packages/tranquilload-core/src/errors/index.ts` | Re-export new variant; fix missing `CircuitOpenError` export |
| `packages/tranquilload-core/src/errors/upload-error.test.ts` | Exhaustive-switch case for new variant |
| `packages/tranquilload-core/src/multipart/upload-stream.ts` | Add ResumeState, validation, getContentDigest, mapError additions |
| `packages/tranquilload-core/src/multipart/upload-stream.test.ts` | New tests for resume validation |
| `packages/tranquilload-core/src/multipart/index.ts` | Export ResumeState; add `resumeState` to return; legacy-warn |
| `packages/tranquilload-core/src/multipart/index.test.ts` | Wrapper tests |
| `packages/tranquilload-adapters/src/protocols/simple-http-upload.ts` | `bufferMode` + `duplex: 'half'` |
| `packages/tranquilload-adapters/src/protocols/simple-http-upload.test.ts` | Both modes; signal honor |
| `README.md` | Resume example; HTTP streaming requirements; Match.tag update |
| `MIGRATION.md` | v0.1.x → v0.2.x migration guide (new file) |

### Technical Constraints

- **Effect singleton.** No new `effect` copies. All code uses existing peer.
- **No `try/catch` in Effect code.** Use `Effect.tryPromise` / `Effect.try`. (Adapters are not Effect code; try/catch allowed there.)
- **Effect.raceFirst pattern preserved** for AbortSignal interop.
- **Changeset granularity.** 2 entries: adapters patch, core minor.
- **Tests use `@effect/vitest`**. `it.effect(...)` for Effect-pure tests.
- **`duplex: 'half'` is not in lib.dom.d.ts.** Use a one-line cast: `{ ...init, duplex: "half" } as RequestInit & { duplex: "half" }`.
- **Requires Node 22+ / modern browsers.** Documented; no runtime feature detection.

### Investigation Findings (from Step 2)

1. **`normalizeCallback` is callback-shape-ready.** Handles sync / Promise / Effect via `Effect.isEffect`. No changes needed.
2. **`CircuitOpenError` is missing from `errors/index.ts` re-exports** — pre-existing bug, fixed here (bundled in Task 1.4 with a callout in the changeset).
3. **The exhaustive-switch test pattern in `errors/upload-error.test.ts:191-218`** uses a switch on `_tag` with `default: never`. Adding `ResumeMismatchError` = +1 case + 1 assertion.
4. **`simple-http-upload.test.ts` uses `vi.stubGlobal("fetch", fetchMock)`** + `afterEach(() => vi.unstubAllGlobals())`. New tests follow this pattern.
5. **`initiate` semantics change is a breaking-for-legacy-resume change.** Users currently doing `initiate: () => ({uploadId: stored})` need to migrate to `resumeFrom`. Minor bump (v0.1.x → v0.2.x — pre-1.0 SemVer allows breaking on minor); migration warning + MIGRATION.md ship together.
6. **mapError sequencing:** `initiate` → `InitiateUploadError`; `reconcile` → `ReconcileError`; `uploadPart` → `PartUploadError`; `complete` → `CompleteUploadError`; ResumeState validation → `ResumeMismatchError` (synchronous throw before any I/O).
7. **`ResumeState.uploadId` validation:** must be a non-empty string. Empty-string check belongs at validation time (synchronous).

## Implementation Plan

### Tasks

Ordered by dependency: types → adapter (independent) → multipart core → public wrapper → docs → release → verify.

#### Phase 1 — Types & Errors

- [x] **Task 1.1**: Add `ResumeMismatchError` to the UploadError union
  - File: `packages/tranquilload-core/src/errors/upload-error.ts`
  - Action: New class extending `Error`. Constructor: `constructor(readonly reason: "version_mismatch" | "chunksize_mismatch" | "pipeline_mismatch" | "content_mismatch", readonly cause?: unknown)`. `readonly _tag = "ResumeMismatchError" as const`. Message: `\`Resume state mismatch: ${reason}\``. `this.name = "ResumeMismatchError"`. Add to `UploadError` union.
  - Notes: Single class with `reason` discriminant is a conscious exception to the per-class-per-tag pattern — ResumeMismatch is one kind of error (pre-flight validation refusal), the `reason` is its specific cause. JSDoc must explain this. Per-reason dispatch via `Match.value(err.reason)`.

- [x] **Task 1.2**: Export new error + fix pre-existing missing `CircuitOpenError` export
  - File: `packages/tranquilload-core/src/errors/index.ts`
  - Action: Re-export `ResumeMismatchError` and `CircuitOpenError` (was missing — pre-existing bug).
  - Notes: Changeset entry must call out the `CircuitOpenError` export as a previously-broken-now-fixed item to avoid misleading the changelog.

- [x] **Task 1.3**: Update exhaustive-switch test for new variant
  - File: `packages/tranquilload-core/src/errors/upload-error.test.ts`
  - Action: Add `import { ResumeMismatchError }`. Add case: `case "ResumeMismatchError": return "resumeMismatch"`. Add assertion: `expect(check(new ResumeMismatchError("chunksize_mismatch"))).toBe("resumeMismatch")`. Add a `describe("ResumeMismatchError", ...)` block covering `instanceof Error`, `_tag`, `message`, `name`, `reason`, and optional `cause` preservation.
  - Notes: TS compile fail if the new variant is missed in the switch.

- [x] **Task 1.4**: Add optional `contentDigest` field to `UploadInitiated` event [H2]
  - File: `packages/tranquilload-core/src/progress/upload-event.ts`
  - Action: Extend the `UploadInitiated` interface:
    ```ts
    export interface UploadInitiated {
      readonly _tag: "UploadInitiated"
      readonly uploadId: string
      readonly contentDigest?: string  // populated when getContentDigest was provided
      readonly timestamp: number
    }
    ```
  - Notes: Adding an *optional* field is a non-breaking change to event consumers. The field is populated by `runFreshInit` (Task 3.4) from `refDigest`. Public wrapper `Stream.tap` reads it from the event (same pattern as `uploadId`), bypassing the H2 "ref not accessible" problem.

#### Phase 2 — `simpleHttpUpload` adapter (independent of multipart)

- [x] **Task 2.1**: Add `bufferMode?` option + `duplex: 'half'` in stream path
  - File: `packages/tranquilload-adapters/src/protocols/simple-http-upload.ts`
  - Action:
    1. Extend `SimpleHttpUploadOptions`: add `readonly bufferMode?: boolean` (default `false`).
    2. In `upload`, branch on `bufferMode`:
       - If `bufferMode === true`: drain the stream manually via a `reader.read()` loop. **Before every `reader.read()` call, check `signal?.aborted` — if true, release the reader and throw `new AbortError()` (do NOT remap as `CompleteUploadError`). [G2 fix]** Accumulate chunks into `chunks: Uint8Array[]`. After draining: construct a `Blob` from `chunks`; PUT it; no `duplex` flag.
       - Else (streaming, default): pass `stream as unknown as BodyInit` as body; add `duplex: "half"` via cast: `fetch(url, { method, headers, body: stream as unknown as BodyInit, signal, duplex: "half" } as RequestInit & { duplex: "half" })`.
    3. Error handling: keep the existing pattern — `cause instanceof Error && cause.name === "AbortError"` → re-throw as Tranquilload `AbortError`; otherwise wrap as `CompleteUploadError(cause)`. The drain-loop `AbortError` from G2 lands in this same handler and passes through correctly.
  - Notes:
    - Per F11: requires Node 22+ / modern browsers. No runtime guard.
    - Per F12 / G2: `Response#blob()` ignores AbortSignal; the manual reader loop with per-iteration `signal.aborted` checks is the correct approach.
    - Per F13 (acknowledged risk): source-read and network errors both wrap as `CompleteUploadError`. Telemetry consumers distinguish via `cause` inspection.

- [x] **Task 2.2**: Add JSDoc warnings
  - File: `packages/tranquilload-adapters/src/protocols/simple-http-upload.ts`
  - Action: Doc comments:
    - `bufferMode`: "When true, buffers the entire source stream into a Blob before PUT. **Memory usage equals the source size — DO NOT enable for files larger than available memory.** Use only when streaming PUT isn't supported (HTTP/1.x, environments where `duplex: 'half'` is unavailable). Default: `false`."
    - Top-of-interface: "Streaming PUT requires HTTP/2 and `duplex: 'half'`. If your target is HTTP/1.x, set `bufferMode: true`."

- [x] **Task 2.3**: Tests for both modes
  - File: `packages/tranquilload-adapters/src/protocols/simple-http-upload.test.ts`
  - Action: Add tests after existing block:
    1. `it("passes duplex: 'half' on streaming uploads (default)", ...)` — assert `fetchMock.mock.calls[0][1]` contains `duplex: "half"` and `body === stream`.
    2. `it("buffers the stream into a Blob when bufferMode is true", ...)` — stream yields a known sequence; assert `fetchMock.mock.calls[0][1].body instanceof Blob`, `blob.size === sum(bytes)`, no `duplex` in options.
    3. `it("rejects with CompleteUploadError on mid-stream read errors when bufferMode is true", ...)`.
    4. `it("rejects with AbortError when signal aborts during bufferMode drain", ...)` — construct an AbortController, fire `.abort()` after the first `read()` returns a chunk but before the second `read()` completes; expect rejection `instanceof AbortError`, NOT `CompleteUploadError`. [G2 verification]
  - Notes: Use existing `vi.stubGlobal("fetch", ...)` pattern.

#### Phase 3 — `multipart` core — ResumeState

- [x] **Task 3.1**: Define `ResumeState` interface
  - File: `packages/tranquilload-core/src/multipart/upload-stream.ts`
  - Action: Above `UploadMultipartOptions`, add:
    ```ts
    export interface ResumeState {
      readonly version: 1
      readonly uploadId: string
      readonly chunkSize: number
      readonly pipelineIdentity?: string
      readonly contentDigest?: string
      /** True if the original session captured a digest. Detects persistence
       * layers that drop the digest field (which would otherwise silently
       * bypass content-mismatch validation). */
      readonly contentDigestCaptured: boolean
    }
    ```
  - Notes: `version: 1` literal — future v2 schemas widen this. Serializable to JSON without loss. The `contentDigestCaptured` flag prevents the F9 bypass.

- [x] **Task 3.2**: Extend `UploadMultipartOptions` with new fields
  - File: `packages/tranquilload-core/src/multipart/upload-stream.ts`
  - Action: Add three optional fields:
    ```ts
    readonly resumeFrom?: ResumeState
    readonly getContentDigest?: () =>
      | string | Promise<string> | Effect.Effect<string, UploadError>
    readonly pipelineIdentity?: string
    ```
  - Notes: All three optional, backward-compatible at the *type* level. **The behaviour change** is on `initiate` semantics (see Investigation Finding #5).
    JSDoc for `getContentDigest`:
    > Called once on fresh initiate to capture a digest of the source content. On a subsequent resume session, called again and compared to `resumeFrom.contentDigest`; a mismatch fails the upload with `ResumeMismatchError("content_mismatch")` before any byte is uploaded.
    >
    > **MUST be lightweight and stable across sessions.** Suggested patterns:
    > - Browser `File`: ``${name}|${size}|${lastModified}``
    > - Node `Readable` from a file: `${path}|${stat.size}|${stat.mtimeMs}`
    > - Synchronous strings; avoid full-file crypto hashes on the synchronous path.
    >
    > **MUST NOT consume bytes from the source stream** (passed in `options.stream`). The lib calls `getContentDigest` before any chunk is pulled from the source; consuming from the source here will produce a zero-byte upload because no bytes remain for `chunkStream`.

    JSDoc for `pipelineIdentity`:
    > An opaque, stable identifier for the upstream pipeline composition. Captured in `ResumeState` and validated strict-equality on resume. **You own keeping this stable** — if you configure `compress("deflate-raw")` in session A, you must pass the same `pipelineIdentity` on resume.
    >
    > **Strict equality limitation:** a pipeline that is logically identical but produces different identifier strings (e.g. tag bumps, version-stamped strings) triggers `ResumeMismatchError("pipeline_mismatch")`. Pick a stable string (e.g. `"deflate-raw-v1"`) and only change it when the pipeline's *byte-level output* changes.
    >
    > **Compression non-determinism caveat (G5):** even with identical `pipelineIdentity`, a non-deterministic pipeline (e.g. gzip with `mtime` headers, encryption with random salt) produces different bytes per run. Resume against the same uploaded parts only works if the pipeline is byte-deterministic. Verify your pipeline's determinism before relying on this.

- [x] **Task 3.3**: Validate `resumeFrom` at construction time (synchronous)
  - File: `packages/tranquilload-core/src/multipart/upload-stream.ts`
  - Action: After the existing `chunkSize > 0` guard, if `resumeFrom !== undefined`:
    - Throw `new TypeError("ResumeState.uploadId must be a non-empty string")` if `resumeFrom.uploadId === ""`. [F24]
    - Throw `new ResumeMismatchError("version_mismatch")` if `resumeFrom.version !== 1`.
    - Throw `new ResumeMismatchError("chunksize_mismatch")` if `resumeFrom.chunkSize !== chunkSize`.
    - Throw `new ResumeMismatchError("pipeline_mismatch")` if `resumeFrom.pipelineIdentity !== options.pipelineIdentity`.
    - Throw `new ResumeMismatchError("content_mismatch")` if `resumeFrom.contentDigestCaptured === true && resumeFrom.contentDigest === undefined`. [F9 — dropped-digest bypass detection]
  - Notes: All synchronous throws at function entry, like the chunkSize guard. **Content-digest *value* mismatch** is validated inside the Effect during initiate (Task 3.4).

- [x] **Task 3.4**: Implement resume vs fresh-init branching *(scope: only fresh-init or use-stored-state; auto-re-init dropped)*
  - File: `packages/tranquilload-core/src/multipart/upload-stream.ts`
  - Action: Replace the existing `initiateStream` definition:
    1. **New state Ref:** `const refDigest = yield* Ref.make<Option.Option<string>>(Option.none())`.
    2. **Define `runFreshInit` as `Effect<UploadInitiated, UploadError>`:**
       - Call `normalizeCallback(initiate)` wrapped with `Effect.mapError(InitiateUploadError)`.
       - If `getContentDigest` is provided, call it via `normalizeCallback`. Store result in `refDigest`.
       - Set `refUploadId` to the returned id.
       - Return `UploadInitiated` event with the new uploadId AND the captured digest (`contentDigest: yield* Ref.get(refDigest).pipe(Effect.map(Option.getOrUndefined))`). [H2]
    3. **Define `runResumeSetup` as `Effect<void, UploadError>` (NO event emitted):** [H3]
       - If `resumeFrom.contentDigest` AND `getContentDigest` are both present: call `getContentDigest()`. Compare to `resumeFrom.contentDigest`. If mismatch, `Effect.fail(new ResumeMismatchError("content_mismatch"))`. Store result in `refDigest`.
       - Set `refUploadId` to `resumeFrom.uploadId`.
       - Return `Effect.void`. **No event emitted.** Resume is silent — no synthetic `UploadInitiated`. [G1 fix — was a semantic regression in v1]
    4. **`setupStream` is:**
       - If `resumeFrom` is set: `Stream.fromEffect(runResumeSetup).pipe(Stream.drain)` (executes the Effect for its side effects; emits zero events).
       - Else if `initiate` is set: `Stream.fromEffect(runFreshInit)` (emits one `UploadInitiated`).
       - Else: `Stream.empty` (existing behavior for users with no initiate at all).
    5. **`reconcileCompletedParts` keeps its existing eager-resolution pattern** inside `Effect.gen`. No restructure needed (since no auto-re-init catch is wanted). Map any reconcile error to `ReconcileError` (existing mapError pattern).
    6. **Final composition:** `Stream.concat(setupStream, partsStream, Stream.fromEffect(finalEffect))` — same as today.
  - Notes:
    - **No `UploadInitiated` emitted on resume.** Downstream consumers see exactly the events they always saw, plus zero extras on resume. The first event after `setupStream` on a resume run is whatever the parts stream emits next (`PartCompleted` or `ProgressTick`).
    - **No Stream.catchTag plumbing.** Reconcile errors remain mapped to `ReconcileError` exactly as today.
    - **No `refReinitCount`, no `UploadIdGoneError`, no `UploadReinitiated` event.** All of that is deferred.
    - If the stored `uploadId` is dead (404 on first sign request), the user sees `PartUploadError(1, 1, <404>)` — same as today. No regression, no advance.

- [x] **Task 3.5**: Add tests for ResumeState validation
  - File: `packages/tranquilload-core/src/multipart/upload-stream.test.ts`
  - Action: Add `describe("ResumeState validation", ...)` block:
    1. Throws `TypeError` matching `/non-empty string/` when `resumeFrom.uploadId === ""`.
    2. Throws `ResumeMismatchError` with `reason: "version_mismatch"` when `resumeFrom.version !== 1`.
    3. Throws with `reason: "chunksize_mismatch"`.
    4. Throws with `reason: "pipeline_mismatch"`.
    5. Throws with `reason: "content_mismatch"` (synchronous, dropped-digest bypass).
    6. Effect-level fail with `reason: "content_mismatch"` (asynchronous, digest value mismatch via `getContentDigest`).
    7. Accepts a valid `resumeFrom` (no throw; uploadId honored; reconcile is called).
    8. Does NOT emit `UploadInitiated` on resume (the first event is from the parts stream). [G1 verification]
  - Notes: Synchronous tests use `expect(() => uploadMultipartEffect(...)).toThrow(...)`. For #6 and #8 use `it.effect` with `Effect.exit` + `Cause.squash` then `expect(squashed).toBeInstanceOf(ResumeMismatchError)`.

#### Phase 4 — `multipart` public wrapper

- [x] **Task 4.1**: Surface `resumeState` Promise + fix `uploadId` Promise on resume [H1, H2, H4]
  - File: `packages/tranquilload-core/src/multipart/index.ts`
  - Action:
    1. **Fix existing `uploadId: Promise<string>` regression [H1]:** today's wrapper resolves `uploadId` on `UploadInitiated` event. On resume (per AC11), no such event is emitted → `uploadId` would hang. **On the resume branch, resolve `uploadId` *synchronously* with `resumeFrom.uploadId` before the stream runs.** On the fresh-init branch, the existing `Stream.tap` for `UploadInitiated` continues to fire as today.
    2. **Add `resumeState: Promise<ResumeState>`** to return type and implementation. Resolution logic:
       - **Fresh init:** in the `Stream.tap`, on `UploadInitiated`, build state from `event.uploadId` + `event.contentDigest` (from Task 1.4's new field) + options.chunkSize + options.pipelineIdentity + `contentDigestCaptured = getContentDigest !== undefined`. Resolve the Promise with this state.
       - **Resume:** resolve **synchronously with `resumeFrom` itself** (before the stream runs). The lib's `runResumeSetup` revalidates the digest but doesn't produce a new state — the user already has the value, and it's identical (otherwise content_mismatch would have rejected). **Symmetric with fresh-init semantically (both surface a complete state object), even though the resume value is sourced from the user's input.** [H4]
       - **Error path:** if `setupStream` fails before the first `UploadInitiated` (fresh init) OR if synchronous validation throws (resume), reject `resumeState` Promise with the same error. Note: synchronous throws will propagate from the `uploadMultipart(...)` call itself, not as Promise rejections.
  - Notes: This task depends on Task 1.4 (`contentDigest` field on `UploadInitiated`) and Task 3.1 (`ResumeState` type). The H2 problem (refDigest inaccessible from wrapper) is eliminated because the digest is now carried on the event.

- [x] **Task 4.2**: Legacy-pattern detection + console.warn *(per G3: unconditional)*
  - File: `packages/tranquilload-core/src/multipart/index.ts`
  - Action: At the **top** of `uploadMultipart`, detect: `options.initiate !== undefined && options.reconcileCompletedParts !== undefined && options.resumeFrom === undefined`. If detected, immediately call:
    ```js
    console.warn(
      "Tranquilload: detected legacy resume pattern. You're passing `initiate` " +
      "and `reconcileCompletedParts` without `resumeFrom: ResumeState`. The new " +
      "API requires the persisted ResumeState to validate chunkSize/pipeline/" +
      "digest match across sessions. See MIGRATION.md for migration steps."
    )
    ```
  - Notes:
    - **Unconditional warn** is the simple fix for G3 (the "warn only when reconcile returns ≥ 1" logic from v1 was unimplementable AND missed first-time-after-upgrade users). False positives accepted: a first-time uploader will see the warning, but they should also see it — they need to persist `resumeState` for the next session.
    - Fires **once per `uploadMultipart` call** (no deduplication across calls).
    - Users who want it silenced can override their own `console.warn`. The lib does not provide an opt-out mechanism (kept simple).
    - **Additional warn per H9:** also fire `console.warn` (separate message) when `options.pipeline !== undefined && options.pipelineIdentity === undefined`. Message: `"Tranquilload: pipeline is set but pipelineIdentity is not. Without an identity, the resume validation cannot detect a pipeline mismatch across sessions. See README → Resume Safety."`

- [x] **Task 4.3**: Export `ResumeState` type
  - File: `packages/tranquilload-core/src/multipart/index.ts`
  - Action: Re-export `ResumeState` from `upload-stream.ts` alongside `CompletedPart` and `UploadMultipartOptions`.

- [x] **Task 4.4**: Pre-existing tests audit + migration
  - File: `packages/tranquilload-core/src/multipart/index.test.ts`, `upload-stream.test.ts`
  - Action: Grep for `initiate: () => ({ uploadId:` and `initiate: async () => ({ uploadId:` patterns. Each match is a test using the legacy resume pattern. For each:
    1. If the test's intent was "fresh init that returns a stored id": migrate to `resumeFrom: { version: 1, uploadId: "stored-id", chunkSize: <n>, contentDigestCaptured: false }`. Remove the `initiate` callback.
    2. If the test's intent was "fresh init that returns a fresh id": rename the variable in the test to be unambiguous; no semantic change needed.
  - Notes: This is the concrete enumeration F3 demanded. Audit happens here; the count of migrated tests is reported in the PR description.

- [x] **Task 4.5**: Tests for public wrapper changes
  - File: `packages/tranquilload-core/src/multipart/index.test.ts`
  - Action:
    1. `resumeState` Promise resolves with correct shape on fresh init.
    2. `resumeState` Promise resolves with the passed `resumeFrom` shape on resume.
    3. `console.warn` is called once when legacy pattern detected (use `vi.spyOn(console, "warn")`).
    4. `console.warn` is NOT called when `resumeFrom` is provided alongside `initiate` + `reconcile`.
    5. `console.warn` IS called even when `reconcileCompletedParts` returns an empty array (per G3 fix — unconditional).
  - Notes: Restore `console.warn` between tests with `afterEach(() => vi.restoreAllMocks())`.

#### Phase 5 — Documentation

- [x] **Task 5.1**: Create MIGRATION.md
  - File: `MIGRATION.md` (repo root, new file)
  - Sections:
    - "v0.1.x → v0.2.x"
      - Side-by-side: old `initiate: () => ({uploadId: stored})` vs new `resumeFrom: ResumeState`.
      - List the new error variant: `ResumeMismatchError` and its `reason` discriminants.
      - List the new option: `getContentDigest`.
      - List the new field: `pipelineIdentity`.
      - List the deprecation warning text + how to silence (override console.warn in your app).
      - **Note on dropped feature:** "Auto-re-initiate on dead uploadId was considered for this release but deferred to a future version. If your stored uploadId is no longer valid server-side, you'll currently see `PartUploadError(1, 1, <404>)` on the first part upload — same as before this release. Future versions will add `UploadIdGoneError` and auto-re-init."
    - "v0.1.x → v0.2.x: `simpleHttpUpload`"
      - HTTP/2 requirement for default streaming; flip `bufferMode: true` for HTTP/1.x environments.
      - Memory caveat.

- [x] **Task 5.2**: Update README.md
  - File: `README.md`
  - Action:
    1. Update "Resuming an upload after a refresh" code block: show `JSON.stringify(resumeState)` → localStorage → `JSON.parse(stored) as ResumeState` → `resumeFrom: parsed`.
    2. Add a sub-section "Concepts → Resume Safety" explaining version + chunkSize + pipeline + digest validation. Include the compression non-determinism caveat (G5).
    3. Add HTTP streaming requirements note under install/quickstart.
    4. Update the `Match.tag` example to cover `ResumeMismatchError`. **Note (H8):** `ResumeMismatchError` uses an internal `reason` discriminant, not nested tags — show `Match.tag("ResumeMismatchError", (e) => Match.value(e.reason).pipe(Match.when("chunksize_mismatch", ...), Match.when("content_mismatch", ...), ...))` or a simple `switch (e.reason)` inside the Match.tag handler.
    5. Note: README accuracy is enforced by code review (G#28 doctest infra doesn't exist yet — flagged as follow-up).

#### Phase 6 — Release artifacts

- [x] **Task 6.1**: Changeset for `@tranquilload/adapters` (patch)
  - File: `.changeset/simple-http-upload-buffer-mode.md`
  - Action: Patch bump describing `bufferMode` and `duplex: 'half'`.

- [x] **Task 6.2**: Changeset for `@tranquilload/core` (minor)
  - File: `.changeset/resume-state.md`
  - Action: Minor bump with bulleted summary:
    - New: `ResumeState` opaque return-type carrying versioned resume metadata.
    - New: `resumeFrom`, `getContentDigest`, `pipelineIdentity` options.
    - New: `ResumeMismatchError` variant.
    - Behaviour change: `initiate` semantics tightened to "always fresh"; legacy-pattern users get a `console.warn` directing to MIGRATION.md.
    - Fix: `CircuitOpenError` is now exported from `@tranquilload/core/errors` (was previously absent due to a pre-existing bug).
    - **NOT in this release** (explicit non-feature note): auto-re-initiate on dead uploadId — deferred to a future version.

#### Phase 7 — Verification

- [x] **Task 7.1**: Triptyque green
  - Action: `pnpm turbo build && pnpm turbo test && pnpm -r typecheck`. All exit 0. The legacy-pattern tests explicitly assert console.warn fires — no unexpected console.warn elsewhere.

### Acceptance Criteria

#### `simpleHttpUpload`

- [x] **AC 1**: Given `bufferMode` is unset (default), when `upload(stream)` is called, then `fetch` is invoked with `body === stream` AND `duplex === "half"` in the request options.
- [x] **AC 2**: Given `bufferMode: true`, when `upload(stream)` is called with a stream of N bytes, then `fetch` is invoked with `body instanceof Blob`, `body.size === N`, and no `duplex` in options.
- [x] **AC 3**: Given `bufferMode: true` and a stream that errors during a `reader.read()`, when `upload` is called, then the rejection is `instanceof CompleteUploadError` whose `cause` is the original stream error.
- [x] **AC 4**: Given `bufferMode: true` and `signal: someAbortSignal`, when the signal aborts between two `reader.read()` calls, then the returned Promise rejects with `instanceof AbortError` — NOT `CompleteUploadError`. [G2]

#### `ResumeState` synchronous validation

- [x] **AC 5**: Given `resumeFrom.uploadId === ""`, when `uploadMultipart` is invoked, then `TypeError` is thrown matching `/non-empty string/`. [F24]
- [x] **AC 6**: Given `resumeFrom.version !== 1`, then `ResumeMismatchError` with `reason === "version_mismatch"` is thrown synchronously.
- [x] **AC 7**: Given `resumeFrom.chunkSize !== options.chunkSize`, then `ResumeMismatchError` with `reason === "chunksize_mismatch"` is thrown synchronously.
- [x] **AC 8**: Given `resumeFrom.pipelineIdentity !== options.pipelineIdentity`, then `ResumeMismatchError` with `reason === "pipeline_mismatch"` is thrown synchronously.
- [x] **AC 9**: Given `resumeFrom.contentDigestCaptured === true && resumeFrom.contentDigest === undefined`, then `ResumeMismatchError` with `reason === "content_mismatch"` is thrown synchronously. [F9]

#### `ResumeState` runtime validation

- [x] **AC 10**: Given a `resumeFrom` with `contentDigest === "abc"` and a `getContentDigest` that returns `"xyz"`, when the upload stream is consumed, then it fails with `ResumeMismatchError{reason: "content_mismatch"}` before any chunk is PUT.

#### Resume happy path

- [x] **AC 11**: Given a valid `resumeFrom` (all fields match), when `uploadMultipart` is invoked, then NO `UploadInitiated` event is emitted, `initiate` is NOT called, `reconcileCompletedParts` is called once, and only un-reconciled parts get PUT requests. [G1 — proves the resume path is silent]

#### Fresh-init happy path

- [x] **AC 12**: Given no `resumeFrom` and `initiate` is provided, when `uploadMultipart` is invoked, then `initiate` is called once and exactly one `UploadInitiated` event is emitted as the first stream event.

#### Public wrapper (`uploadMultipart`)

- [x] **AC 13**: Given a successful fresh init, when `uploadMultipart` is invoked, then `resumeState` Promise resolves with `{version: 1, uploadId, chunkSize, pipelineIdentity, contentDigest?, contentDigestCaptured}`.
- [x] **AC 14**: Given a successful resume (with `resumeFrom`), when `uploadMultipart` is invoked, then `resumeState` Promise resolves with the same shape as the passed `resumeFrom` (lib has no new state to add).
- [x] **AC 15**: Given an error during `setupStream` execution (fresh init: `initiate` callback fails; resume: `getContentDigest` fails), when `uploadMultipart` is invoked, then `resumeState` rejects with the same error as `result`. (Synchronous throws from validation propagate from the call itself.) [H6]
- [x] **AC 22**: Given a resume run (`resumeFrom` set), when `uploadMultipart` is invoked, then the `uploadId: Promise<string>` resolves **synchronously** with `resumeFrom.uploadId` (does NOT wait for an `UploadInitiated` event that will never come). [H1]
- [x] **AC 23**: Given a fresh-init run with `getContentDigest` provided, when the `UploadInitiated` event is emitted, then `event.contentDigest` equals the value returned by `getContentDigest()`. [H2]
- [x] **AC 24**: Given `options.pipeline` is set but `options.pipelineIdentity` is undefined, when `uploadMultipart` is invoked, then `console.warn` is called with a message about missing pipelineIdentity (since the lack of identity disables pipeline-mismatch protection on resume). [H9]

#### Legacy-pattern detection

- [x] **AC 16**: Given the legacy pattern (`initiate + reconcile + no resumeFrom`), when `uploadMultipart` is invoked, then `console.warn` is called exactly once with a message starting with `"Tranquilload: detected legacy resume pattern"`.
- [x] **AC 17**: Given the new pattern (`resumeFrom` set alongside `initiate + reconcile`), when `uploadMultipart` is invoked, then `console.warn` is NOT called.
- [x] **AC 18**: Given `reconcileCompletedParts` is provided but returns an empty array, when `uploadMultipart` is invoked, `console.warn` IS called (unconditional warn per G3 — first-time uploaders need the message too).

#### Backward compatibility

- [x] **AC 19**: Given the existing test suite, when all Tasks 1-6 are applied, then **all pre-existing tests pass EXCEPT** those that have been explicitly migrated in Task 4.4 (which were exercising the legacy pattern). The PR description must enumerate the migrated tests.
- [x] **AC 20**: Given `import { CircuitOpenError } from "@tranquilload/core/errors"`, when the code is loaded, `CircuitOpenError` resolves to the class constructor (previously `undefined`).

#### Verification

- [x] **AC 21**: When `pnpm turbo build && pnpm turbo test && pnpm -r typecheck` is executed at the repo root, all three exit 0 with no unexpected warnings.

## Additional Context

### Dependencies

- No new runtime dependencies. No new dev dependencies.
- **Phase order:** Task 3.4 depends on Tasks 1.1 (`ResumeMismatchError`) and 3.1-3.3 (types + sync validation). Phase 4 depends on Phase 3. Phase 5+ depends on all of Phase 1-4 being merged (README/MIGRATION reference shipped API).

### Testing Strategy

**Unit tests (vitest + @effect/vitest):**
- New `ResumeMismatchError`: 6 tests (`instanceof Error`, `_tag`, `message`, `name`, `reason` preservation, optional `cause` preservation).
- ResumeState validation: 8 tests (5 sync throws — empty uploadId, version, chunksize, pipeline, captured-but-dropped — plus 1 effect-level content-mismatch, 1 happy-path no-throw, 1 G1 verification that resume emits no `UploadInitiated`).
- `simpleHttpUpload` adapter: 4 tests (streaming with duplex; buffered mode with Blob body; mid-stream error; signal abort during drain).
- Public wrapper: 5 tests (`resumeState` resolves on fresh init; on resume; rejects on error; legacy warn fires; legacy warn doesn't fire on new pattern; legacy warn fires on empty reconcile).
- **New test total: ~23 tests + 1 modification** (exhaustive-switch update in `upload-error.test.ts`).
- **Migrated tests** (from Task 4.4 audit): N — to be enumerated in the PR.

**Manual verification:**
- Restart `examples/test-app/`. Fresh upload. Refresh browser. Pass `JSON.parse(localStorage.getItem("resumeState"))` as `resumeFrom`. Confirm resume succeeds against MinIO.
- Modify the chunkSize between sessions; confirm `ResumeMismatchError("chunksize_mismatch")` rejects before any PUT fires.

### Notes

**High-risk items mitigated:**
- Schema evolution → `version: 1` literal field + sync version-mismatch check.
- Persistence layer drops digest → `contentDigestCaptured` flag + sync mismatch check.
- Pipeline composition mismatch → `pipelineIdentity` + sync match check.
- HTTP/2-only streaming → `bufferMode` escape hatch + doc.
- Silent legacy-upgrade → `console.warn` + MIGRATION.md (unconditional warn per G3).
- bufferMode abort → manual reader loop with per-iteration `signal.aborted` check; AbortError passes through (per G2).
- bufferMode OOM → strong JSDoc warning.

**Acknowledged risks (low-severity findings noted but not mitigated):**
- **F5 — `pipelineIdentity` is "user must" smell.** Documented in JSDoc; future option to derive from the pipeline composition.
- **F6 — Content-mismatch leaves orphan multipart server-side.** Documented; future option: `onValidationFailure` hook.
- **F11 — `duplex` flag silently ignored on older runtimes.** Documented as "Node 22+ / modern browsers".
- **F13 — Indistinguishable source-vs-network errors in `simpleHttpUpload`.** Documented; future option: `phase` field on `CompleteUploadError`.
- **F14 — `ResumeMismatchError` single class with `reason` discriminant.** Stylistic exception documented in JSDoc.
- **F17 — `pipelineIdentity` strict equality is brittle.** Documented in JSDoc.
- **G5 — Non-deterministic compression breaks resume even with matching `pipelineIdentity`.** Documented in JSDoc with the "verify your pipeline is byte-deterministic" caveat.
- **G8 — `getContentDigest` consuming source stream is not lib-enforced.** A 2-line `options.stream.locked` check could catch it; deferred (low ROI vs JSDoc).

**Future considerations (not in scope, NOT acceptance criteria):**
- **Auto-re-initiate on dead uploadId** — needs proper Stream-level event-injection design. Will introduce `UploadIdGoneError`, `UploadReinitiated` event. Separate spec.
- **Auto-abort on `CompleteUploadError`** — Cross #5 from original brainstorm.
- **Web Locks for multi-tab.**
- **Doctest infrastructure** for README examples (G#28).
- **ResumeState v2 schema** when first additive field is needed.

---

## Adversarial Review History

This spec went through two rounds of independent adversarial review.

### Round 1 — 25 findings

See git history for v1 of this file (commit prior to revision). 23 of 25 findings genuinely resolved; 2 attempted resolutions introduced new issues (caught in Round 2).

### Round 2 — 8 new findings

Re-review of the patched v1 surfaced:

| ID | Sev | v2 disposition |
|---|---|---|
| G1 | Critical | **Resolved by scope cut:** dropped synthetic `UploadInitiated` on resume. Resume now emits zero setup events. AC11 verifies. |
| G2 | High | **Resolved:** Task 2.1 + AC4 specify that drain-loop `AbortError` passes through, not remapped to `CompleteUploadError`. |
| G3 | High | **Resolved:** Task 4.2 + AC18 specify unconditional warn (first-time-after-upgrade users now see the migration message). |
| G4 | High | **Resolved by scope cut:** without auto-re-init, the `resumeState` Promise resolution simplifies — fresh-init resolves on `UploadInitiated`, resume resolves with `resumeFrom` itself. |
| G5 | Medium | **Acknowledged:** added compression non-determinism caveat to `pipelineIdentity` JSDoc + Notes. Future option: post-pipeline digest. |
| G6 | Medium | **Resolved by scope cut:** without auto-re-init, no `catchTag` is needed. Reconcile errors stay mapped to `ReconcileError` as today. |
| G7 | Low | **Resolved by scope cut:** no post-re-init flow to verify. |
| G8 | Low | **Acknowledged:** `stream.locked` check is cheap but the JSDoc invariant is the primary mitigation. Deferred. |

**Net change v1 → v2:**
- Auto-re-init machinery dropped (`UploadIdGoneError`, `UploadReinitiated` event, Stream restructure, cap-at-1, F1/F4/F7/F8/G1/G4/G6/G7 all eliminated by removing the feature itself).
- Spec smaller: 25 → 14 tasks, 25 → 21 ACs, 32 → ~23 new tests.
- Silent-corruption protections all retained.
- Auto-re-init deferred cleanly to a future spec.

### Round 3 — 9 new findings (post-v2 cut)

The third review on the v2 spec surfaced regressions introduced by the cut itself + lingering Task 4.1 issues from v1.

| ID | Sev | v2.1 disposition |
|---|---|---|
| H1 | Blocking | **Resolved:** Task 4.1 + AC22 specify that `uploadId` Promise resolves synchronously with `resumeFrom.uploadId` on the resume branch (preventing the dropped-`UploadInitiated`-event hang). |
| H2 | Blocking | **Resolved:** Task 1.4 adds optional `contentDigest?: string` field to the `UploadInitiated` event. The public wrapper's `Stream.tap` reads from the event (same pattern as `uploadId`), eliminating the inaccessible-Ref problem. |
| H3 | Blocking | **Resolved:** Task 3.4 step 3 corrected to `Effect<void, UploadError>` (was `Effect<never, ...>`). |
| H4 | Blocking | **Resolved:** Task 4.1 explicitly states the symmetry: both branches produce a complete state object. Fresh init sources from the `UploadInitiated` event; resume sources from `resumeFrom` (the value passed in). Same shape, different provenance. |
| H5 | Non-block | **Verified false positive:** `MaxRetriesExceededError` IS exported from `errors/index.ts` (only `CircuitOpenError` was missing). Reviewer flagged for verification; verification complete. No spec change. |
| H6 | Non-block | **Resolved:** AC15 wording updated to "during `setupStream` execution" (covers both fresh init and resume). |
| H7 | Non-block | **Resolved:** Pre-mortem letters consistent (A, C, D, E, F; B explicitly noted as dropped along with auto-re-init). |
| H8 | Non-block | **Resolved:** Task 5.2 #4 note clarifies that `ResumeMismatchError` needs `Match.value(e.reason)` inside the `Match.tag` handler. |
| H9 | Non-block | **Resolved:** Task 4.2 adds a second `console.warn` for `pipeline` set without `pipelineIdentity`; AC24 verifies. |

**Net change v2 → v2.1:**
- +1 task (Task 1.4: `contentDigest` field on `UploadInitiated`)
- +3 ACs (AC22 for uploadId-on-resume, AC23 for contentDigest in event, AC24 for pipeline-without-identity warn)
- 1 `Effect<never>` typo corrected
- README example updated to reflect `ResumeMismatchError.reason` discriminant pattern
- 0 false-positive findings adopted

**Spec status:** ready-for-dev (post Round 3, v2.1). Net 31 findings over 3 reviews; 29 acted on, 1 verified false-positive, 1 partial (acknowledged risk).
