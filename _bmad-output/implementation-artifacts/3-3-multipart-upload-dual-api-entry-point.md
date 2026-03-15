# Story 3.3: Multipart Upload — Dual API Entry Point

Status: done

## Story

As a developer consuming the library,
I want to call `uploadMultipart(options)` and get back `{ result, events, getProgress }`,
so that I can orchestrate a complete multipart upload with zero Effect knowledge.

## Acceptance Criteria

1. **Given** the `@tranquilload/multipart` sub-path export **When** the developer calls `uploadMultipart({ stream, chunkSize, uploadPart, completeUpload, signal? })` **Then** it returns `{ result: Promise<UploadResult>, events: ReadableStream<UploadEvent>, getProgress: () => Promise<Progress> }` **And** `LoggerServiceLive` is provided automatically (no Layer required from the user)

2. **Given** `uploadMultipart.effect` is called **When** the developer provides their own Layers **Then** it returns a raw `Stream<UploadEvent, UploadError, LoggerService>` with Layers open for composition

3. **Given** the developer calls `controller.abort()` mid-upload **When** the signal fires **Then** `result` rejects with `AbortError` and the events stream closes cleanly

4. **Given** `getProgress()` is called at any point during the upload **When** parts are being uploaded **Then** it returns the current `{ bytesUploaded, totalBytes: Option }` snapshot without interrupting the upload

## Tasks / Subtasks

- [x] Task 1: Implement `multipart/index.ts` — replace placeholder with Dual API (AC: #1, #2, #3, #4)
  - [x] Remove the `export const _placeholder: undefined = undefined` line
  - [x] Import `Cause`, `Effect`, `Exit`, `Option`, `Ref`, `Stream` from `"effect"`
  - [x] Import `LoggerServiceLive` from `"../services/logger-service.js"`
  - [x] Import `uploadMultipartEffect` and `type UploadMultipartOptions`, `type CompletedPart` from `"./upload-stream.js"`
  - [x] Import `type UploadCompleted`, `type UploadEvent` from `"../progress/upload-event.js"`
  - [x] Define and export `Progress` interface: `{ readonly bytesUploaded: number; readonly totalBytes: Option.Option<number> }`
  - [x] Define and export `MultipartPublicOptions`: extends `UploadMultipartOptions` with `readonly totalBytes?: number`
  - [x] Export `type UploadResult = UploadCompleted` and re-export `type { CompletedPart }`
  - [x] Create `refProgress` via `Effect.runSync(Ref.make<Progress>({ bytesUploaded: 0, totalBytes: ... }))` outside Effect context
  - [x] Tap stream to update progress: `Stream.tap(event => event._tag === "PartCompleted" ? Ref.update(refProgress, ...) : Effect.void)`
  - [x] Apply `Stream.provideLayer(LoggerServiceLive)` to get `R = never`
  - [x] Run stream with `Stream.runCollect(program).pipe(Effect.map(chunk => Array.from(chunk)), Effect.runPromiseExit).then(...)` → `collected: Promise<ReadonlyArray<UploadEvent>>`
  - [x] Build `events: ReadableStream<UploadEvent>` that pushes all collected events then closes; closes cleanly (no throw) on error
  - [x] Build `result: Promise<UploadResult>` — last event from collected (the `UploadCompleted`), reject if stream empty
  - [x] Build `getProgress = Object.assign(() => Effect.runPromise(Ref.get(refProgress)), { effect: Ref.get(refProgress) })`
  - [x] Attach `uploadMultipart.effect = uploadMultipartEffect` for Effect escape hatch
  - [x] All relative imports use `.js` extension (NodeNext)

- [x] Task 2: Write `multipart/index.test.ts` (AC: #1–#4)
  - [x] Use `import { it, describe, expect } from "@effect/vitest"` for Effect tests; plain `async` functions for Promise-based tests
  - [x] Test: happy path — `result` resolves with `{ _tag: "UploadCompleted", totalParts: N }`, `events` yields all PartCompleted + UploadCompleted
  - [x] Test: `getProgress()` — after upload, `bytesUploaded` equals total bytes (sum of all chunk lengths); `totalBytes` is `None` when not provided, `Some(N)` when provided
  - [x] Test: abort signal — `result` rejects with `AbortError`, events stream closes without throwing
  - [x] Test: `.effect` property — `uploadMultipart.effect === uploadMultipartEffect` (identity check)

- [x] Task 3: Verify build and tests pass
  - [x] `pnpm turbo build` — no errors, `dist/multipart.js` / `.cjs` / `.d.ts` generated
  - [x] `pnpm turbo test` — all tests pass, zero regressions (64 existing tests must still pass)

## Dev Notes

### File to Modify

```
packages/tranquilload-core/src/multipart/
  index.ts              ← REPLACE placeholder entirely — this is the only file to touch
  index.test.ts         ← CREATE (co-located, per architecture)
  upload-stream.ts      ← DO NOT TOUCH (Story 3.2, stable)
  chunk-stream.ts       ← DO NOT TOUCH (Story 3.1, stable)
```

The tsdown entry is already wired: `tsdown.config.ts` maps `multipart: 'src/multipart/index.ts'` → builds to `dist/multipart.js|.cjs|.d.ts`. The export map in `package.json` is already correct (`./multipart` entry). Just implement `index.ts`.

### Implementation Pattern — Mirror `oneshot/index.ts` Closely

`oneshot/index.ts` (Story 2.2) is the canonical reference. The multipart Dual API follows the exact same structure with three additions: (1) `getProgress`, (2) the progress Ref, and (3) the `totalBytes` option.

**Key `oneshot/index.ts` patterns to replicate:**
- `Effect.runPromiseExit` + `Cause.squash` for clean error surfacing (not FiberFailure wrapper)
- ReadableStream built from the `collected` Promise — closes cleanly on error (no `controller.error()`)
- `result` = last event from collected array, reject with a meaningful message if empty
- `.effect` escape hatch assigned directly on the exported function

### Concrete Implementation

```ts
// multipart/index.ts
import { Cause, Effect, Exit, Option, Ref, Stream } from "effect"
import type { UploadCompleted, UploadEvent } from "../progress/upload-event.js"
import { LoggerServiceLive } from "../services/logger-service.js"
import { uploadMultipartEffect, type CompletedPart, type UploadMultipartOptions } from "./upload-stream.js"

export type UploadResult = UploadCompleted
export type { CompletedPart, UploadMultipartOptions }

export interface Progress {
  readonly bytesUploaded: number
  readonly totalBytes: Option.Option<number>
}

export interface MultipartPublicOptions extends UploadMultipartOptions {
  readonly totalBytes?: number
}

export const uploadMultipart = (options: MultipartPublicOptions): {
  events: ReadableStream<UploadEvent>
  result: Promise<UploadResult>
  getProgress: (() => Promise<Progress>) & { effect: Effect.Effect<Progress> }
} => {
  const refProgress = Effect.runSync(
    Ref.make<Progress>({
      bytesUploaded: 0,
      totalBytes: options.totalBytes !== undefined ? Option.some(options.totalBytes) : Option.none(),
    })
  )

  const program = uploadMultipartEffect(options).pipe(
    Stream.tap((event) => {
      if (event._tag === "PartCompleted") {
        return Ref.update(refProgress, (p) => ({
          ...p,
          bytesUploaded: p.bytesUploaded + event.bytesUploaded,
        }))
      }
      return Effect.void
    }),
    Stream.provideLayer(LoggerServiceLive)
  )

  // Single execution — collect all events to completion
  // Effect.runPromiseExit + Cause.squash ensures result rejects with typed error (AbortError, etc.)
  // rather than a FiberFailure wrapper
  const collected: Promise<ReadonlyArray<UploadEvent>> = Stream.runCollect(program).pipe(
    Effect.map((chunk) => Array.from(chunk)),
    Effect.runPromiseExit
  ).then((exit) => {
    if (Exit.isSuccess(exit)) return exit.value
    return Promise.reject(Cause.squash(exit.cause))
  })

  // events: ReadableStream built from collected array; closes cleanly on error
  const events = new ReadableStream<UploadEvent>({
    async start(controller) {
      try {
        const evts = await collected
        for (const event of evts) controller.enqueue(event)
        controller.close()
      } catch (_) {
        // Close cleanly — upload errors surface via `result` only
        controller.close()
      }
    },
  })

  // result: resolves with UploadCompleted, rejects with UploadError on failure
  const result: Promise<UploadResult> = collected.then((evts) => {
    const last = evts[evts.length - 1]
    if (last === undefined) {
      return Promise.reject(new Error("uploadMultipart: stream ended without emitting an event"))
    }
    return last as UploadResult
  })

  const getProgress = Object.assign(
    (): Promise<Progress> => Effect.runPromise(Ref.get(refProgress)),
    { effect: Ref.get(refProgress) }
  )

  return { events, result, getProgress }
}

// Effect escape hatch — LoggerService layer left open for user composition
uploadMultipart.effect = uploadMultipartEffect
```

### Test Patterns

Use **plain `async` functions** for Promise-based tests and `it.effect` only for Effect-internal tests:

```ts
// multipart/index.test.ts
import { describe, expect, it } from "@effect/vitest"
import { Option } from "effect"
import { AbortError } from "../errors/upload-error.js"
import { uploadMultipart } from "./index.js"

const fromBytes = (bytes: Uint8Array): ReadableStream<Uint8Array> =>
  new ReadableStream({ start: c => { c.enqueue(bytes); c.close() } })

describe("uploadMultipart", () => {
  it("happy path: result resolves with UploadCompleted, events contains all events", async () => {
    const { result, events } = uploadMultipart({
      stream: fromBytes(new Uint8Array(20).fill(1)),
      chunkSize: 10,
      uploadPart: (n) => `etag-${n}`,
      completeUpload: () => {},
    })

    const uploadResult = await result
    expect(uploadResult._tag).toBe("UploadCompleted")
    expect(uploadResult.totalParts).toBe(2)

    const reader = events.getReader()
    const collected: unknown[] = []
    let done = false
    while (!done) {
      const { value, done: d } = await reader.read()
      if (d) { done = true; break }
      collected.push(value)
    }
    expect(collected.filter((e: any) => e._tag === "PartCompleted")).toHaveLength(2)
    expect(collected.find((e: any) => e._tag === "UploadCompleted")).toBeDefined()
  })

  it("getProgress tracks bytesUploaded from PartCompleted events", async () => {
    const { result, getProgress } = uploadMultipart({
      stream: fromBytes(new Uint8Array(30).fill(1)),
      chunkSize: 10,
      uploadPart: (_n, _chunk) => "etag",
      completeUpload: () => {},
      totalBytes: 30,
    })

    await result

    const progress = await getProgress()
    expect(progress.bytesUploaded).toBe(30)
    expect(progress.totalBytes).toEqual(Option.some(30))
  })

  it("getProgress returns None for totalBytes when not provided", async () => {
    const { result, getProgress } = uploadMultipart({
      stream: fromBytes(new Uint8Array(10).fill(1)),
      chunkSize: 10,
      uploadPart: (_n, _chunk) => "etag",
      completeUpload: () => {},
    })

    await result
    const progress = await getProgress()
    expect(progress.totalBytes).toEqual(Option.none())
  })

  it("abort signal: result rejects with AbortError, events stream closes cleanly", async () => {
    const controller = new AbortController()
    const { result, events } = uploadMultipart({
      stream: fromBytes(new Uint8Array(10).fill(1)),
      chunkSize: 10,
      uploadPart: () => new Promise<string>((_resolve) => {
        setTimeout(() => controller.abort(), 5)
      }),
      completeUpload: () => {},
      signal: controller.signal,
    })

    await expect(result).rejects.toBeInstanceOf(AbortError)

    // events ReadableStream closes cleanly (no throw)
    const reader = events.getReader()
    let closed = false
    while (!closed) {
      const { done } = await reader.read()
      if (done) closed = true
    }
    expect(closed).toBe(true)
  })

  it(".effect property points to uploadMultipartEffect", () => {
    const { uploadMultipartEffect } = require("./upload-stream.js")
    expect(uploadMultipart.effect).toBe(uploadMultipartEffect)
  })
})
```

**Note on the last test**: The identity check of `.effect` may need adjustment if modules are cached differently. Alternatively, verify the `.effect` callable signature by calling it in an Effect test with a mock layer.

### Architecture Compliance (Absolute Rules)

1. **Pattern consistency with oneshot** — `uploadMultipart` MUST follow the exact same Dual API shape as `uploadOnce`. Reference `packages/tranquilload-core/src/oneshot/index.ts` constantly.
2. **`Effect.runSync(Ref.make(...))` is intentional** — creates the Ref synchronously BEFORE the Effect program runs, allowing `getProgress` to read live state during upload.
3. **`Stream.tap` for progress update** — runs the Ref update as a side effect inside the stream; the Effect returned by `tap` is run by the stream executor.
4. **`Effect.runPromiseExit` + `Cause.squash`** — never use `Effect.runPromise` directly for the collected stream; squash ensures typed errors (AbortError, etc.) surface cleanly without FiberFailure wrapper.
5. **`controller.close()` not `controller.error()`** in the ReadableStream — errors surface via `result` only; the events stream always closes cleanly.
6. **`.js` on all relative imports** — NodeNext module resolution requires explicit extension.
7. **`globalThis` only** — no `window`, no `process`, no `node:*` imports.
8. **No `try/catch`** — no try/catch in Effect internal code (none needed here; all internal logic is in `upload-stream.ts`).

### What this story does NOT do

- Does NOT implement Circuit Breaker — Story 3.4
- Does NOT expose `uploadId` from an `initiate` callback — Story 7.1
- Does NOT add `getProgress.effect` with full `Ref<Progress>` injection from inside `upload-stream.ts` — Story 5.2 formalizes this
- Does NOT add `ProgressTick` or `CircuitOpen` events — Story 5.1
- Does NOT add pipeline transforms or `CompressionService` — Story 4.3
- Does NOT use `CompressionServiceLive` in the Dual API — the epics file AC says "CompressionServiceLive and LoggerServiceLive are provided automatically", but `uploadMultipartEffect` R type is currently `LoggerService` only (CompressionService will be added in Story 4.3 when pipeline is wired into `upload-stream.ts`)
- The `uploadId: ""` in `UploadCompleted` is intentional — Story 7.1 will fill it

### Critical Type Note

The `.effect` escape hatch type for Story 3.3:
```
uploadMultipart.effect : Stream<UploadEvent, UploadError, LoggerService>
```

The epics file says the final type should be `CompressionService | LoggerService`, but `CompressionService` is NOT in the R type until Story 4.3 adds it. This is intentional and correct for Story 3.3. The `.effect` property will have its type naturally extended when the pipeline is wired.

### Previous Story Intelligence (Stories 3.1, 3.2)

From Story 3.2 (`upload-stream.ts`):
- **`uploadMultipartEffect` signature**: `(options: UploadMultipartOptions) => Stream<UploadEvent, UploadError, LoggerService>`
- **`UploadMultipartOptions`**: `{ stream, chunkSize, uploadPart, completeUpload, maxConcurrency?, signal?, retrySchedule? }`
- **`CompletedPart`**: `{ partNumber: number; etag: string }` — also needed in multipart/index.ts exports for users building callbacks
- **Parts accumulated in completion order** (potentially out of order for concurrent uploads) — `completeUpload` receives them in arrival order, not part number order
- **`UploadCompleted.uploadId`**: `""` (empty string) for now — Story 7.1 addresses this
- **`Stream.unwrap(Effect.gen(...))`** pattern used internally — wrapped in the story exports via `Stream.runCollect`
- **64 tests currently passing** — zero regressions allowed

From Story 3.1 (`chunk-stream.ts`):
- **`chunkStream` already used inside `uploadMultipartEffect`** — no direct import needed in `index.ts`

From Stories 2.1 & 2.2 (oneshot):
- **Single-run trap** — `Stream.runCollect` runs the program ONCE. Both `events` and `result` derive from the same `collected` Promise. Do NOT create two separate program executions.
- **`Effect.runPromiseExit` pattern** — the `.then(exit => ...)` chain is the clean way to convert Exit to Promise.
- **ReadableStream always closes** — even on error, call `controller.close()` not `controller.error()`.

### Project Structure Notes

- Package name: `@tranquilload/core` (directory: `packages/tranquilload-core/`)
- Entry file: `packages/tranquilload-core/src/multipart/index.ts` → `dist/multipart.js`
- Export path: `@tranquilload/core/multipart` (per package.json exports map `"./multipart"`)
- Test file: `packages/tranquilload-core/src/multipart/index.test.ts` (co-located, per architecture)

### References

- Canonical pattern reference: `packages/tranquilload-core/src/oneshot/index.ts` [Story 2.2]
- Core Effect implementation: `packages/tranquilload-core/src/multipart/upload-stream.ts` [Story 3.2]
- Services: `packages/tranquilload-core/src/services/logger-service.ts`
- Types: `packages/tranquilload-core/src/progress/upload-event.ts`
- Errors: `packages/tranquilload-core/src/errors/upload-error.ts`
- tsdown entry config: `packages/tranquilload-core/tsdown.config.ts`
- Architecture Dual API pattern: [Source: `_bmad-output/planning-artifacts/architecture.md#Dual API Wrapper Pattern`]
- Architecture Process Patterns: [Source: `_bmad-output/planning-artifacts/architecture.md#Process Patterns`]
- Architecture data flow: [Source: `_bmad-output/planning-artifacts/architecture.md#Data Flow`]
- Architecture getProgress: [Source: `_bmad-output/planning-artifacts/architecture.md#Gaps Addressed`]

## Dev Agent Record

### Agent Model Used

claude-opus-4-6

### Debug Log References

### Completion Notes List

- Replaced placeholder in `multipart/index.ts` with full Dual API implementation mirroring `oneshot/index.ts` pattern
- Added `Progress` interface with `Ref`-based live tracking via `Stream.tap` on `PartCompleted` events
- `getProgress()` returns `Promise<Progress>` with `.effect` property for Effect composition
- `uploadMultipart.effect` escape hatch exposes raw `Stream<UploadEvent, UploadError, LoggerService>`
- `Effect.runPromiseExit` + `Cause.squash` pattern ensures typed errors (AbortError, etc.) surface without FiberFailure wrapper
- ReadableStream always closes cleanly — errors surface via `result` only
- 5 new tests: happy path, getProgress with totalBytes, getProgress without totalBytes, abort signal, .effect identity check
- All 70 tests pass (69 core + 1 adapter), zero regressions
- Build produces `dist/multipart.mjs`, `.cjs`, `.d.mts`, `.d.cts` correctly

### Change Log

- 2026-03-15: Implemented Dual API entry point for multipart upload (Story 3.3)

### File List

- `packages/tranquilload-core/src/multipart/index.ts` — MODIFIED (replaced placeholder with Dual API implementation)
- `packages/tranquilload-core/src/multipart/index.test.ts` — CREATED (5 tests for Dual API)
