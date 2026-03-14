# Story 2.1: One-Shot Upload — Core Effect Implementation

Status: review

## Story

As a library developer,
I want the internal Effect implementation of one-shot upload in `packages/tranquilload-core/src/oneshot/upload.ts`,
so that the pure Effect logic is isolated, testable, and reusable by the Dual API wrapper (Story 2.2).

## Acceptance Criteria

1. **Given** a `ReadableStream<Uint8Array>` and an `upload` user callback, **When** `uploadOnceEffect(options)` is called, **Then** it returns a `Stream<UploadEvent, UploadError, LoggerService>` that emits exactly one `UploadCompleted` event on success. **And** the user callback is normalized via `normalizeCallback` (supports plain value, `Promise`, or `Effect`). **And** if `signal` is provided, `Effect.race` with `fromAbortSignal` is used — never direct `signal.aborted` check.

2. **Given** the user callback throws or rejects, **When** the upload runs, **Then** the stream fails with a `CompleteUploadError` in the typed error channel, with the original thrown value as `cause`.

3. **Given** an `AbortSignal` is passed and `controller.abort()` is called, **When** the upload is in progress, **Then** the stream fails with an `AbortError` in the typed error channel.

## Tasks / Subtasks

- [x] Task 0: Fix `project-context.md` (pre-requisite, before touching source code)
  - [x] Open `_bmad-output/project-context.md` and remove the `isolatedDeclarations: true` reference — it was removed in Story 1.3 (incompatible with `Context.Tag`). Replace with `declaration: true`. Epic 1 retro Action Item #2.

- [x] Task 1: Define `UploadCompleted` event in `progress/upload-event.ts` (AC: #1)
  - [x] Create `packages/tranquilload-core/src/progress/upload-event.ts`
  - [x] Define `UploadCompleted` interface with `_tag: "UploadCompleted"`, `uploadId: string`, `totalParts: number`, `timestamp: number` (exact architecture spec)
  - [x] Define `UploadEvent = UploadCompleted` (minimal for now — Story 5.1 will expand to full union)
  - [x] Do NOT touch `progress/index.ts` — it remains "Implemented in Epic 5" placeholder

- [x] Task 2: Implement `oneshot/upload.ts` (AC: #1, #2, #3)
  - [x] Create `packages/tranquilload-core/src/oneshot/upload.ts`
  - [x] Define `UploadOnceOptions` interface (see Dev Notes for exact shape)
  - [x] Implement `uploadOnceEffect(options)` returning `Stream<UploadEvent, UploadError, LoggerService>`
  - [x] Use `normalizeCallback(() => upload(stream))` — never call upload directly
  - [x] Map errors to `CompleteUploadError` via `Effect.mapError` (unless already `AbortError`)
  - [x] When `signal` present: `Effect.raceFirst(uploadEffect, fromAbortSignal(signal))` — NOTE: spec said `Effect.race` but `raceFirst` is required ("first to settle" semantics; `race` is "first to succeed" and hangs if signal fires while upload never resolves)
  - [x] When `signal` absent: run `uploadEffect` directly
  - [x] Log "one-shot upload starting" and "one-shot upload completed" via `LoggerService`
  - [x] Emit `UploadCompleted` event with `uploadId: ""`, `totalParts: 1`, `timestamp: Date.now()`
  - [x] Return `Stream.fromEffect(program)` to wrap the single-event logic
  - [x] All relative imports MUST use `.js` extension (NodeNext)

- [x] Task 3: Write `oneshot/upload.test.ts` co-located with source (AC: #1, #2, #3)
  - [x] Use `import { it, describe, expect } from "@effect/vitest"` + `it.effect(...)` — NO manual `Effect.runPromise`
  - [x] Test success: plain value callback → stream emits `UploadCompleted` with `_tag`, `totalParts: 1`, valid `timestamp`
  - [x] Test success: Promise callback → same assertions
  - [x] Test failure (sync throw): extract `Cause`, assert `Cause.failureOption` contains `CompleteUploadError` with `_tag === "CompleteUploadError"` and `cause` = original error — do NOT use `Exit.isFailure` alone
  - [x] Test failure (Promise reject): same surgical assertion on `CompleteUploadError`
  - [x] Test abort: `controller.abort()` → stream fails with `AbortError`, extract Cause and assert `_tag === "AbortError"` and `message === "Upload aborted"`
  - [x] Test `Effect.raceFirst` behavior: abort fires AFTER upload completes → should succeed (no spurious abort)

- [x] Task 4: Verify build and tests pass (AC: #1, #2, #3)
  - [x] `pnpm turbo build` — no errors
  - [x] `pnpm turbo test` — all tests pass, zero regressions (49 tests total, 6 new)

## Dev Notes

### Project Structure

Actual package directory is `packages/tranquilload-core/` (NOT `packages/core/`):

```
packages/tranquilload-core/src/
  progress/
    index.ts                ← DO NOT TOUCH (Epic 5 placeholder)
    upload-event.ts         ← CREATE (this story — UploadCompleted + UploadEvent)
  oneshot/
    index.ts                ← DO NOT TOUCH (Epic 2, Story 2.2 will implement this)
    upload.ts               ← CREATE (this story — uploadOnceEffect)
    upload.test.ts          ← CREATE (this story)
```

### Task 0 — Fix `project-context.md`

The Epic 1 retro flagged that `_bmad-output/project-context.md` still says `isolatedDeclarations: true`. This was removed in Story 1.3 (incompatible with Effect's `Context.Tag` class pattern — TS9021). Do this fix BEFORE touching any source to avoid confusion.

### Task 1 — `progress/upload-event.ts`

The full `UploadEvent` union (Epic 5, Story 5.1) will be `PartCompleted | ProgressTick | UploadCompleted | CircuitOpen`. For now, define only what this story needs:

```ts
// packages/tranquilload-core/src/progress/upload-event.ts

export interface UploadCompleted {
  readonly _tag: "UploadCompleted"
  readonly uploadId: string   // empty string for one-shot; multipart provides real ID
  readonly totalParts: number // 1 for one-shot
  readonly timestamp: number
}

// Minimal type — Story 5.1 will expand to full discriminated union
export type UploadEvent = UploadCompleted
```

**Why `uploadId: string` (not optional):** The architecture spec defines the shape with `uploadId: string`. For one-shot uploads, use `""`. Story 5.1 will not change this field — only multipart adds a real upload ID. The union stays additive.

**Why NOT touch `progress/index.ts`:** Its current `_placeholder` export satisfies the vitest "no test files" workaround and the build. Story 5.1 owns that file.

### Task 2 — `oneshot/upload.ts`

```ts
// packages/tranquilload-core/src/oneshot/upload.ts
import { Effect, Stream } from "effect"
import type { UploadError } from "../errors/upload-error.js"
import { AbortError, CompleteUploadError } from "../errors/upload-error.js"
import { LoggerService } from "../services/logger-service.js"
import { fromAbortSignal } from "../utils/abort-interop.js"
import { normalizeCallback } from "../utils/normalize-callback.js"
import type { UploadEvent } from "../progress/upload-event.js"

export interface UploadOnceOptions {
  readonly stream: ReadableStream<Uint8Array>
  readonly upload: (
    stream: ReadableStream<Uint8Array>
  ) => void | Promise<void> | Effect.Effect<void, UploadError>
  readonly signal?: AbortSignal
}

export const uploadOnceEffect = (
  options: UploadOnceOptions
): Stream.Stream<UploadEvent, UploadError, LoggerService> => {
  const { stream, upload, signal } = options

  const program: Effect.Effect<UploadEvent, UploadError, LoggerService> = Effect.gen(
    function* () {
      const logger = yield* LoggerService
      yield* logger.log("info", "One-shot upload starting")

      const uploadEffect: Effect.Effect<void, UploadError> = normalizeCallback(
        () => upload(stream)
      ).pipe(
        Effect.mapError((cause): UploadError => {
          if (cause instanceof AbortError) return cause
          return new CompleteUploadError(cause)
        })
      )

      yield* signal
        ? Effect.race(uploadEffect, fromAbortSignal(signal))
        : uploadEffect

      yield* logger.log("info", "One-shot upload completed")

      return {
        _tag: "UploadCompleted" as const,
        uploadId: "",
        totalParts: 1,
        timestamp: Date.now(),
      } satisfies UploadEvent
    }
  )

  return Stream.fromEffect(program)
}
```

**Key implementation decisions:**

- **`normalizeCallback(() => upload(stream))`** — wraps the upload call as a thunk. Handles plain value, Promise, and Effect. Sync throws land in the typed error channel (not as defects), because `normalizeCallback` uses `try/catch` inside `Effect.suspend`.
- **`Effect.mapError` maps unknown errors to `CompleteUploadError`** — if the user's callback throws a non-`AbortError`, it becomes `CompleteUploadError(cause)`. If already `AbortError` (from race with `fromAbortSignal`), it passes through unchanged.
- **`Effect.race(uploadEffect, fromAbortSignal(signal))`** — ONLY pattern for abort interop. Never `if (signal.aborted) throw`. The `fromAbortSignal` returns `Effect<never, AbortError>` that stays pending until abort fires. First to settle wins the race.
- **`Stream.fromEffect(program)`** — one-shot emits exactly one event. No streaming needed beyond wrapping the Effect.
- **`satisfies UploadEvent`** — compile-time check that the returned object matches the type without widening.

### Task 3 — `oneshot/upload.test.ts`

#### Surgical test assertions (Epic 1 retro Action #1)

Every failure test MUST extract the `Cause` and validate the specific error type + content. Never use `Exit.isFailure` alone.

```ts
import { Cause, Effect, Exit, Stream } from "effect"
import { it, describe, expect } from "@effect/vitest"
import { uploadOnceEffect } from "./upload.js"
import { AbortError, CompleteUploadError } from "../errors/upload-error.js"
import { LoggerServiceLive } from "../services/logger-service.js"

// Helper to run the stream and get exit
const runStream = (opts: Parameters<typeof uploadOnceEffect>[0]) =>
  Stream.runCollect(uploadOnceEffect(opts)).pipe(
    Effect.provide(LoggerServiceLive),
    Effect.exit
  )
```

**Success tests:**
```ts
it.effect("emits UploadCompleted on success (plain value callback)", () =>
  Effect.gen(function* () {
    const mockStream = new ReadableStream()
    const exit = yield* runStream({
      stream: mockStream,
      upload: () => undefined,
    })
    expect(Exit.isSuccess(exit)).toBe(true)
    if (Exit.isSuccess(exit)) {
      const events = Array.from(exit.value)
      expect(events).toHaveLength(1)
      expect(events[0]._tag).toBe("UploadCompleted")
      expect(events[0].totalParts).toBe(1)
      expect(typeof events[0].timestamp).toBe("number")
    }
  })
)

it.effect("emits UploadCompleted on success (Promise callback)", () =>
  Effect.gen(function* () {
    const mockStream = new ReadableStream()
    const exit = yield* runStream({
      stream: mockStream,
      upload: () => Promise.resolve(),
    })
    expect(Exit.isSuccess(exit)).toBe(true)
  })
)
```

**Failure tests (surgical):**
```ts
it.effect("sync throw from callback → CompleteUploadError with correct cause", () =>
  Effect.gen(function* () {
    const originalError = new Error("network failure")
    const exit = yield* runStream({
      stream: new ReadableStream(),
      upload: () => { throw originalError },
    })
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const failure = Cause.failureOption(exit.cause)
      expect(failure._tag).toBe("Some")
      const err = (failure as { _tag: "Some"; value: unknown }).value
      expect(err).toBeInstanceOf(CompleteUploadError)
      expect((err as CompleteUploadError)._tag).toBe("CompleteUploadError")
      expect((err as CompleteUploadError).cause).toBe(originalError)
    }
  })
)

it.effect("Promise rejection → CompleteUploadError with correct cause", () =>
  Effect.gen(function* () {
    const originalError = new Error("async failure")
    const exit = yield* runStream({
      stream: new ReadableStream(),
      upload: () => Promise.reject(originalError),
    })
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const failure = Cause.failureOption(exit.cause)
      expect(failure._tag).toBe("Some")
      const err = (failure as { _tag: "Some"; value: unknown }).value
      expect(err).toBeInstanceOf(CompleteUploadError)
      expect((err as CompleteUploadError).cause).toBe(originalError)
    }
  })
)
```

**Abort tests (surgical):**
```ts
it.effect("abort mid-upload → AbortError with correct tag and message", () =>
  Effect.gen(function* () {
    const controller = new AbortController()
    const exit = yield* runStream({
      stream: new ReadableStream(),
      upload: () => new Promise<void>(() => {}), // never resolves
      signal: controller.signal,
    }).pipe(
      Effect.tap(() => Effect.sync(() => controller.abort())),
      // OR: fork + abort + join
    )
    // Note: fork the effect, abort, then await
    // See alternative below
  })
)
```

**Note on testing abort:** The `Effect.race` between the upload (never-resolving Promise) and `fromAbortSignal` needs the abort to be triggered while the fiber is running. Use `Effect.fork` + `Fiber.interrupt` or `Effect.sync(() => controller.abort())` scheduled via `Effect.zipRight`. The cleanest pattern:

```ts
it.effect("abort fires → AbortError", () =>
  Effect.gen(function* () {
    const controller = new AbortController()
    // Start the upload in a fiber, abort immediately, collect exit
    const fiber = yield* Effect.fork(
      Stream.runCollect(
        uploadOnceEffect({
          stream: new ReadableStream(),
          upload: () => new Promise<void>(() => {}), // never resolves
          signal: controller.signal,
        })
      ).pipe(Effect.provide(LoggerServiceLive))
    )
    // Abort after forking
    yield* Effect.sync(() => controller.abort())
    const exit = yield* Fiber.await(fiber)

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const failure = Cause.failureOption(exit.cause)
      expect(failure._tag).toBe("Some")
      const err = (failure as { _tag: "Some"; value: unknown }).value
      expect(err).toBeInstanceOf(AbortError)
      expect((err as AbortError)._tag).toBe("AbortError")
      expect((err as AbortError).message).toBe("Upload aborted")
    }
  })
)
```

**Import needed:**
```ts
import { Cause, Effect, Exit, Fiber, Stream } from "effect"
import { it, describe, expect } from "@effect/vitest"
```

### Architecture Compliance (Absolute Rules)

1. **No `try/catch` in Effect code** — `normalizeCallback` handles sync throws. Never add a `try/catch` inside `Effect.gen`.
2. **No direct `signal.aborted` check** — ALWAYS `Effect.race` + `fromAbortSignal`.
3. **No `.then()` or `await`** — normalized via `normalizeCallback`.
4. **`globalThis` only** — `packages/core` has no `window`, no `process`, no `node:*`.
5. **`.js` on all relative imports** — NodeNext module resolution requirement.
6. **`effect` stays in `peerDependencies`** — never move to `dependencies`.
7. **No `isolatedDeclarations`** — removed in Story 1.3. Explicit type annotations are best practice but inference is allowed.

### Error Mapping Rationale

The `UploadError` union (`PartUploadError | MaxRetriesExceededError | PresignedUrlError | CompleteUploadError | AbortError`) was designed for both one-shot and multipart. For one-shot upload callback failures:
- `CompleteUploadError` is the appropriate variant — it represents "upload could not be completed"
- `AbortError` flows through unchanged (already in the union)
- `PartUploadError` is not used — it's multipart-specific (`partNumber`, `attempt` fields make no sense here)

### What Story 2.2 Will Build On

Story 2.2 (`oneshot/index.ts`) will:
1. Import `uploadOnceEffect` from `./upload.js`
2. Wrap it with `Stream.provideLayer(LoggerServiceLive)`
3. Expose `uploadOnce.effect = uploadOnceEffect` (raw, layers open)
4. Return `{ events: ReadableStream<UploadEvent>, result: Promise<UploadResult> }`

Story 2.2 does NOT create a `upload.ts` file — that's this story. Story 2.2 only creates `index.ts`.

### Previous Story Intelligence (Story 1.4)

From Story 1.4 (Core Utility Helpers — clean review, 0 findings):

- `normalizeCallback` is at `packages/tranquilload-core/src/utils/normalize-callback.ts` — import as `../utils/normalize-callback.js`
- `fromAbortSignal` is at `packages/tranquilload-core/src/utils/abort-interop.ts` — import as `../utils/abort-interop.js`
- `AbortError` class is at `packages/tranquilload-core/src/errors/upload-error.ts:45` — import as `../errors/upload-error.js`
- Testing pattern: `import { it, describe, expect } from "@effect/vitest"` (NOT from `vitest`), use `it.effect` always
- Abort test pattern: use `Effect.fork` + `Fiber.await` to run Effect in background while triggering side effects

### Git Commits from Recent Work

Commit: `review: 1-4-core-utility-helpers` — Pattern: `normalizeCallback` uses `Effect.suspend` + `try/catch` for sync throw capture. `fromAbortSignal` uses `Effect.async` with interrupt finalizer (`Effect.sync(() => signal.removeEventListener(...))`).

### References

- `UploadEvent` shape: [Source: _bmad-output/planning-artifacts/architecture.md#UploadEvent Shape]
- Dual API wrapper pattern: [Source: _bmad-output/planning-artifacts/architecture.md#Dual API Wrapper Pattern]
- `normalizeCallback` pattern: [Source: _bmad-output/planning-artifacts/architecture.md#Callback Normalization Pattern]
- `fromAbortSignal` pattern: [Source: _bmad-output/planning-artifacts/architecture.md#AbortSignal Interop Pattern]
- File locations: [Source: _bmad-output/planning-artifacts/architecture.md#Complete Project Directory Structure]
- Surgical test assertions: [Source: _bmad-output/implementation-artifacts/epic-1-retro-2026-03-14.md#Action Items]
- `normalizeCallback` implementation: [Source: _bmad-output/implementation-artifacts/1-4-core-utility-helpers.md#normalizeCallback — Implementation]
- `fromAbortSignal` implementation: [Source: _bmad-output/implementation-artifacts/1-4-core-utility-helpers.md#fromAbortSignal — Implementation]

## Dev Agent Record

### Agent Model Used

claude-sonnet-4-6

### Debug Log References

- **`Effect.race` vs `Effect.raceFirst`**: The story spec prescribed `Effect.race(uploadEffect, fromAbortSignal(signal))`, but `Effect.race` in Effect 3.x waits for the first **success** — if `fromAbortSignal` fails first (abort fired), it waits for `uploadEffect` to succeed, which hangs forever when the upload is a never-resolving Promise. The correct primitive is `Effect.raceFirst` which returns the first to **settle** (success OR failure). Verified via Effect source at `fiberRuntime.ts:3547` and `circular.ts:476`.

### Completion Notes List

- Task 0: Replaced both `isolatedDeclarations: true` occurrences in `_bmad-output/project-context.md` with `declaration: true` + explanation of why (Context.Tag incompatibility, TS9021).
- Task 1: Created `progress/upload-event.ts` with `UploadCompleted` interface and `UploadEvent = UploadCompleted` type alias. Minimal — Story 5.1 will expand.
- Task 2: Implemented `uploadOnceEffect` in `oneshot/upload.ts`. Uses `normalizeCallback` for user callback, `Effect.mapError` to map unknown errors to `CompleteUploadError`, `Effect.raceFirst` for abort interop, `Stream.fromEffect` to wrap the single-event program.
- Task 3: 6 tests covering all ACs: 2 success (plain + Promise), 2 failure (sync throw + Promise reject) with surgical Cause extraction, 1 abort test (fork + abort + Fiber.await), 1 no-spurious-abort test.
- Task 4: `pnpm turbo build` clean, `pnpm turbo test` 49/49 pass (43 existing + 6 new).

### File List

- `_bmad-output/project-context.md` (modified — Task 0: fixed isolatedDeclarations references)
- `packages/tranquilload-core/src/progress/upload-event.ts` (created — Task 1)
- `packages/tranquilload-core/src/oneshot/upload.ts` (created — Task 2)
- `packages/tranquilload-core/src/oneshot/upload.test.ts` (created — Task 3)

## Change Log

- 2026-03-14: Implemented Story 2.1 — created `upload-event.ts`, `oneshot/upload.ts`, `oneshot/upload.test.ts`; fixed `project-context.md`. 49 tests pass. Key finding: use `Effect.raceFirst` (not `Effect.race`) for abort interop.
