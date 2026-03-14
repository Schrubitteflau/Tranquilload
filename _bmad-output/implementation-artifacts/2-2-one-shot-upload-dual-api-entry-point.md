# Story 2.2: One-Shot Upload — Dual API Entry Point

Status: done

## Story

As a developer consuming the library,
I want to call `uploadOnce(options)` and get back a `Promise<UploadResult>` and a `ReadableStream<UploadEvent>`,
so that I can perform a complete one-shot upload without writing a single line of Effect.

## Acceptance Criteria

1. **Given** the `@tranquilload/oneshot` sub-path export, **When** the developer calls `uploadOnce({ stream, upload, signal? })`, **Then** it returns `{ result: Promise<UploadResult>, events: ReadableStream<UploadEvent> }`. **And** `LoggerServiceLive` is provided automatically (no Layer required from the user).

2. **Given** `uploadOnce.effect` is called with the same options, **When** the developer provides their own Layers, **Then** it returns a raw `Stream<UploadEvent, UploadError, LoggerService>` with Layers open for composition.

3. **Given** the developer calls `controller.abort()` mid-upload, **When** the signal fires, **Then** `result` rejects with `AbortError` and the events stream closes cleanly (no hung ReadableStream).

## Tasks / Subtasks

- [x] Task 1: Implement `oneshot/index.ts` — Dual API entry point (AC: #1, #2, #3)
  - [x] Define `UploadResult = UploadCompleted` type alias (see Dev Notes)
  - [x] Implement `uploadOnce(options)` using the single-run pattern (see Dev Notes — critical)
  - [x] Attach `uploadOnce.effect = uploadOnceEffect` as the escape hatch
  - [x] Re-export `UploadOnceOptions` for consumer convenience
  - [x] All relative imports MUST use `.js` extension (NodeNext)

- [x] Task 2: Write `oneshot/index.test.ts` co-located with source (AC: #1, #2, #3)
  - [x] Use `import { it, describe, expect } from "@effect/vitest"` + `it.effect(...)` — NO manual `Effect.runPromise`
  - [x] Test success (plain value callback): `events` emits `UploadCompleted`, `result` resolves with `UploadCompleted`
  - [x] Test success (Promise callback): `result` resolves
  - [x] Test abort: `controller.abort()` → `result` rejects with `AbortError`, `events` closes (not hangs)
  - [x] Test escape hatch: `uploadOnce.effect(options)` returns a `Stream` type (no runtime execution)
  - [x] Do NOT duplicate tests for `uploadOnceEffect` internals — those are covered in `upload.test.ts`

- [x] Task 3: Verify build and tests pass (AC: #1, #2, #3)
  - [x] `pnpm turbo build` — no errors, `dist/oneshot.js` / `dist/oneshot.cjs` / `dist/oneshot.d.ts` generated
  - [x] `pnpm turbo test` — all tests pass, zero regressions

## Dev Notes

### Project Structure

Only `oneshot/index.ts` is touched in this story. The file currently contains a placeholder:

```
packages/tranquilload-core/src/
  oneshot/
    index.ts       ← REPLACE placeholder with full Dual API (this story)
    upload.ts      ← DO NOT TOUCH (Story 2.1 — implemented, done)
    upload.test.ts ← DO NOT TOUCH (Story 2.1 — 6 tests, all passing)
    index.test.ts  ← CREATE (this story)
```

### Task 1 — `UploadResult` Type

`UploadResult` is not defined in the architecture doc — it is implied by the Dual API pattern. For one-shot upload, the stream emits exactly one `UploadCompleted` event, so:

```ts
// In oneshot/index.ts
import type { UploadCompleted } from "../progress/upload-event.js"

export type UploadResult = UploadCompleted
```

`UploadCompleted` shape (from `progress/upload-event.ts`):
```ts
export interface UploadCompleted {
  readonly _tag: "UploadCompleted"
  readonly uploadId: string   // "" for one-shot
  readonly totalParts: number // 1 for one-shot
  readonly timestamp: number
}
```

### Task 1 — CRITICAL: Single-Run Pattern

**The double-run trap (DO NOT do this):**

```ts
// ❌ ANTI-PATTERN — runs uploadOnceEffect TWICE → calls user's upload callback twice
const program = uploadOnceEffect(options).pipe(Stream.provideLayer(LoggerServiceLive))
return {
  events: Stream.toReadableStream(program),       // run #1
  result: Stream.runLast(program).pipe(Effect.runPromise) // run #2
}
```

Each run of `uploadOnceEffect` invokes the user's `upload(stream)` callback. Running twice would upload the file twice and consume the source `ReadableStream` twice (second read would fail silently on an already-consumed stream).

**Correct single-run approach:**

```ts
// ✅ CORRECT — single run via Effect.runPromise(Stream.runCollect(...))
export const uploadOnce = (options: UploadOnceOptions): {
  events: ReadableStream<UploadEvent>
  result: Promise<UploadResult>
} => {
  const program = uploadOnceEffect(options).pipe(Stream.provideLayer(LoggerServiceLive))

  // Run the stream exactly once — collect all emitted events
  const collected: Promise<ReadonlyArray<UploadEvent>> = Stream.runCollect(program).pipe(
    Effect.map((chunk) => Array.from(chunk)),
    Effect.runPromise
  )

  // events: ReadableStream built from the collected array
  // Closes cleanly even on abort — errors surface via `result` only
  const events = new ReadableStream<UploadEvent>({
    async start(controller) {
      try {
        const evts = await collected
        for (const event of evts) controller.enqueue(event)
        controller.close()
      } catch (_) {
        // Close cleanly — do not propagate abort/upload errors into the stream
        controller.close()
      }
    },
  })

  // result: last emitted event (UploadCompleted) or rejects with UploadError on failure
  const result: Promise<UploadResult> = collected.then((evts) => {
    const last = evts[evts.length - 1]
    if (last === undefined) {
      return Promise.reject(new Error("uploadOnce: stream ended without emitting an event"))
    }
    return last as UploadResult
  })

  return { events, result }
}
```

**Why this works:**
- `collected` is a single `Promise` shared by both `events` and `result`
- `Stream.runCollect` runs `uploadOnceEffect` exactly once — user callback invoked exactly once
- `events` ReadableStream: `start()` awaits `collected`, enqueues the single event, then closes. On error (e.g. AbortError), closes cleanly via `catch(_)` — no error propagated to the ReadableStream consumer
- `result`: standard promise `.then()` — rejects naturally if `collected` rejects (AbortError, CompleteUploadError, etc.)

**Import shape for `index.ts`:**

```ts
import { Effect, Stream } from "effect"
import { LoggerServiceLive } from "../services/logger-service.js"
import type { UploadEvent } from "../progress/upload-event.js"
import type { UploadCompleted } from "../progress/upload-event.js"
import { uploadOnceEffect, type UploadOnceOptions } from "./upload.js"

export type UploadResult = UploadCompleted
export type { UploadOnceOptions }

export const uploadOnce = (options: UploadOnceOptions): {
  events: ReadableStream<UploadEvent>
  result: Promise<UploadResult>
} => {
  // ... (see above)
}

// Effect escape hatch — LoggerService layer left open for user composition
uploadOnce.effect = uploadOnceEffect
```

**Note on `uploadOnce.effect` TypeScript typing:**
TypeScript may infer `uploadOnce` as `(options: UploadOnceOptions) => { events: ...; result: ... }` without a `.effect` property. Assign it after declaration:
```ts
uploadOnce.effect = uploadOnceEffect
```
TypeScript will widen the function type to include `.effect` automatically. If there's a type error, use `Object.assign(uploadOnce, { effect: uploadOnceEffect })`.

### Task 2 — Test Patterns

Follow the surgical test assertion pattern from Story 2.1. Tests for `index.ts` focus on the Dual API contract, not `uploadOnceEffect` internals.

```ts
import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { AbortError } from "../errors/upload-error.js"
import { uploadOnce } from "./index.js"

// Helper: read all events from the ReadableStream
const readAllEvents = async <T>(rs: ReadableStream<T>): Promise<T[]> => {
  const reader = rs.getReader()
  const events: T[] = []
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    events.push(value)
  }
  return events
}
```

**Success test (wrap in `it.effect` using `Effect.promise`):**

```ts
it.effect("success: events emits UploadCompleted, result resolves with UploadCompleted", () =>
  Effect.gen(function* () {
    const { events, result } = uploadOnce({
      stream: new ReadableStream(),
      upload: () => Promise.resolve(),
    })

    const [evts, res] = yield* Effect.all([
      Effect.promise(() => readAllEvents(events)),
      Effect.promise(() => result),
    ])

    expect(evts).toHaveLength(1)
    expect(evts[0]._tag).toBe("UploadCompleted")
    expect(evts[0].totalParts).toBe(1)
    expect(res._tag).toBe("UploadCompleted")
    expect(res).toBe(evts[0]) // same object reference
  })
)
```

**Abort test:**

```ts
it.effect("abort: result rejects with AbortError, events closes cleanly", () =>
  Effect.gen(function* () {
    const controller = new AbortController()
    // Abort immediately before upload starts
    controller.abort()

    const { events, result } = uploadOnce({
      stream: new ReadableStream(),
      upload: () => new Promise<void>(() => {}), // never resolves
      signal: controller.signal,
    })

    // events should close cleanly (not throw)
    const evts = yield* Effect.promise(() => readAllEvents(events))
    expect(evts).toHaveLength(0) // no events before abort

    // result rejects with AbortError
    const resultExit = yield* Effect.exit(Effect.promise(() => result))
    // result is a plain Promise, so wrap its rejection
    if (resultExit._tag === "Failure") {
      // expected
    } else {
      throw new Error("Expected result to reject")
    }
  })
)
```

**Alternative abort test using `try/catch` on the Promise:**

```ts
it.effect("abort: result rejects with AbortError", () =>
  Effect.gen(function* () {
    const controller = new AbortController()
    controller.abort()

    const { result } = uploadOnce({
      stream: new ReadableStream(),
      upload: () => new Promise<void>(() => {}),
      signal: controller.signal,
    })

    let caughtError: unknown = null
    try {
      await result
    } catch (e) {
      caughtError = e
    }

    expect(caughtError).toBeInstanceOf(AbortError)
    expect((caughtError as AbortError)._tag).toBe("AbortError")
  })
)
```

**Escape hatch test (no execution, type-only sanity):**

```ts
it.effect("uploadOnce.effect returns a Stream (effect escape hatch)", () =>
  Effect.gen(function* () {
    // Calling .effect should not throw — it returns a Stream (lazy, not executed)
    const stream = uploadOnce.effect({
      stream: new ReadableStream(),
      upload: () => Promise.resolve(),
    })
    // Stream has a pipe method (duck-type check — we don't run it)
    expect(typeof stream.pipe).toBe("function")
  })
)
```

### Architecture Compliance (Absolute Rules)

Same rules as Story 2.1 — carry all forward:

1. **No `try/catch` in Effect code** — the catch in `ReadableStream.start` is intentional (Web API boundary, not Effect internal)
2. **No direct `signal.aborted` check** — handled in `uploadOnceEffect` via `Effect.raceFirst` + `fromAbortSignal`
3. **No `.then()` or `await` inside Effect.gen** — use `Effect.promise` to bridge the Promise world
4. **`globalThis` only** — no `window`, no `process`, no `node:*` in `packages/tranquilload-core`
5. **`.js` on all relative imports** — NodeNext module resolution requirement
6. **`effect` stays in `peerDependencies`** — never move to `dependencies`
7. **No `isolatedDeclarations`** — removed in Story 1.3; explicit type annotations are encouraged but inference is allowed

### What This Story Does NOT Do

- Does NOT modify `upload.ts` or `upload.test.ts` — those are Story 2.1 (done)
- Does NOT modify `progress/upload-event.ts` — Story 5.1 will expand `UploadEvent` to the full union
- Does NOT define `getProgress()` — that's Story 3.3 / 5.2 (multipart)
- Does NOT add the `./oneshot` export to `package.json` — it's already there (Story 1.1)

### Previous Story Intelligence (Story 2.1)

From Story 2.1 implementation (clean review, 0 HIGH findings):

- **`Effect.raceFirst` not `Effect.race`** — abort interop in `uploadOnceEffect` uses `Effect.raceFirst`. `Effect.race` waits for the first **success**; if `fromAbortSignal` fails (abort fires), `Effect.race` would wait for `uploadEffect` to succeed — which hangs on a never-resolving upload. `Effect.raceFirst` returns the first to **settle** (success OR failure). This is already implemented in `upload.ts` — do NOT change it.
- **`LoggerService.log` returns `void`** — the logger is synchronous (`readonly log: (...) => void`). Do not `yield*` the return of `logger.log` directly in `Effect.gen`. Story 2.1 wraps it: `yield* Effect.sync(() => logger.log(...))`.
- **`Effect.provide(LoggerServiceLive)` vs `Stream.provideLayer(LoggerServiceLive)`** — for Effect use `Effect.provide`, for Stream use `Stream.provideLayer`.
- **Test pattern**: `import { it, describe, expect } from "@effect/vitest"` (NOT from `vitest`). Always `it.effect(...)`.
- **Abort fiber pattern** (for in-flight abort): `yield* Effect.fork(...)` + `yield* Effect.sync(() => controller.abort())` + `yield* Fiber.await(fiber)`.

### Git Intelligence (Recent Commits)

```
82a5343 review: 2-1-one-shot-upload-core-effect-implementation
4f0feae dev: 2-1-one-shot-upload-core-effect-implementation
```

Files created in Story 2.1:
- `packages/tranquilload-core/src/progress/upload-event.ts` — `UploadCompleted` interface, `UploadEvent` type alias
- `packages/tranquilload-core/src/oneshot/upload.ts` — `uploadOnceEffect`, `UploadOnceOptions`
- `packages/tranquilload-core/src/oneshot/upload.test.ts` — 6 tests (all passing)

Current test count: 49 tests (43 from Epic 1 + 6 from Story 2.1). New tests from this story will add to that count.

### References

- Dual API wrapper pattern: [Source: _bmad-output/planning-artifacts/architecture.md#Dual API Wrapper Pattern]
- `UploadEvent` shape: [Source: _bmad-output/planning-artifacts/architecture.md#UploadEvent Shape]
- `LoggerService` / `LoggerServiceLive`: [Source: packages/tranquilload-core/src/services/logger-service.ts]
- `uploadOnceEffect` / `UploadOnceOptions`: [Source: packages/tranquilload-core/src/oneshot/upload.ts]
- `UploadCompleted`: [Source: packages/tranquilload-core/src/progress/upload-event.ts]
- `UploadError` union: [Source: packages/tranquilload-core/src/errors/upload-error.ts]
- `Effect.raceFirst` rationale: [Source: _bmad-output/implementation-artifacts/2-1-one-shot-upload-core-effect-implementation.md#Debug Log References]
- File locations: [Source: _bmad-output/planning-artifacts/architecture.md#Complete Project Directory Structure]
- Surgical test assertions: [Source: _bmad-output/implementation-artifacts/2-1-one-shot-upload-core-effect-implementation.md#Task 3]

## Dev Agent Record

### Agent Model Used

claude-sonnet-4-6

### Debug Log References

- FiberFailure unwrap: `Effect.runPromise` rejects with `FiberFailure` wrapping the typed error. Used `Effect.runPromiseExit` + `Cause.squash` in the implementation so `result` Promise rejects with the raw `AbortError` (AC#3). In tests, used `Effect.tryPromise` + `Effect.exit` + `Cause.failureOption` to capture the rejection as a typed Effect failure (no `try/catch` in `Effect.gen`).

### Completion Notes List

- Implemented `uploadOnce` using the single-run pattern via `Effect.runPromiseExit` + `Cause.squash` — `collected` resolves with `ReadonlyArray<UploadEvent>` or rejects with the squashed typed error (AbortError, CompleteUploadError).
- `events` ReadableStream closes cleanly on error (catch swallows) — abort errors surface via `result` only (AC#3).
- `uploadOnce.effect = uploadOnceEffect` attached after declaration (TypeScript widening).
- 4 new tests added; total: 53 tests passing, 0 regressions.

### File List

- `packages/tranquilload-core/src/oneshot/index.ts` (modified — replaced placeholder with Dual API implementation)
- `packages/tranquilload-core/src/oneshot/index.test.ts` (created — 4 tests)

## Change Log

- 2026-03-14: Implemented `uploadOnce` Dual API entry point and `index.test.ts` (4 tests). 53 tests total, 0 regressions.
- 2026-03-14: **Code Review (AI)** — 0 HIGH, 0 MEDIUM, 1 LOW (merged duplicate import). All ACs verified, all tasks confirmed done. Status → done.
