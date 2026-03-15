# Story 3.2: Multipart Upload — Core Effect Implementation

Status: done

## Story

As a library developer,
I want the internal Effect implementation of parallel multipart upload in `packages/tranquilload-core/src/multipart/upload-stream.ts`,
so that part orchestration, concurrency control, and retry logic are isolated and testable.

## Acceptance Criteria

1. **Given** a chunked stream, an `uploadPart` callback, and a `maxConcurrency` option **When** `uploadMultipartEffect(options)` runs **Then** at most `maxConcurrency` parts are in-flight simultaneously via `Effect.Semaphore` (default: 4)

2. **Given** any `uploadPart` callback form (plain value, `Promise<string>`, or `Effect<string, _>`) **When** the part runs **Then** `normalizeCallback` normalizes it to `Effect<string, UploadError>` where the string is the etag

3. **Given** a successful part upload **When** the part completes **Then** the stream emits a `PartCompleted` event with `{ _tag: "PartCompleted", partNumber, etag, bytesUploaded, timestamp }`

4. **Given** all parts complete successfully **When** `completeUpload` resolves **Then** the stream emits a `UploadCompleted` event and terminates cleanly

5. **Given** a part upload fails and the retry schedule has remaining iterations **When** the error occurs **Then** the part is retried according to the schedule before failing

6. **Given** all retry iterations are exhausted for a part **When** the final failure is recorded **Then** the stream fails with `MaxRetriesExceededError(partNumber, totalAttempts, cause)`; a single-attempt failure (no retries) fails with `PartUploadError`

7. **Given** an `AbortSignal` is provided **When** `controller.abort()` is called mid-upload **Then** in-flight parts are interrupted via `Effect.raceFirst(partEffect, fromAbortSignal(signal))` and the stream fails with `AbortError`; no new parts are started after abort

## Tasks / Subtasks

- [x] Task 1: Extend `progress/upload-event.ts` (AC: #3)
  - [x] Add `PartCompleted` interface
  - [x] Expand `UploadEvent = UploadCompleted | PartCompleted`

- [x] Task 2: Implement `multipart/upload-stream.ts` (AC: #1–#7)
  - [x] Define `CompletedPart` type and `UploadMultipartOptions` interface
  - [x] Export `uploadMultipartEffect(options)` returning `Stream<UploadEvent, UploadError, LoggerService>`
  - [x] Use `chunkStream(stream, chunkSize)` — map its `unknown` error to `PartUploadError(0, 0, cause)`
  - [x] Use `Stream.zipWithIndex` to assign 1-indexed part numbers
  - [x] Create `Effect.makeSemaphore(maxConcurrency)` — wrap each part in `semaphore.withPermits(1)(...)`
  - [x] Use `Stream.mapEffect(..., { concurrency: 'unbounded' })` — semaphore controls actual parallelism
  - [x] Per-part retry with `Ref<number>` tracking attempts; map exhaustion to `MaxRetriesExceededError`
  - [x] Abort: `Effect.raceFirst(partEffect, fromAbortSignal(signal))` per part when signal is provided
  - [x] After all parts: read `refParts`, call `completeUpload`, emit `UploadCompleted`
  - [x] Use `Stream.unwrap(Effect.gen(...))` to flatten `Effect<Stream<...>>` into `Stream<...>`
  - [x] All relative imports MUST use `.js` extension (NodeNext)

- [x] Task 3: Write `multipart/upload-stream.test.ts` (AC: #1–#7)
  - [x] Use `import { it, describe, expect } from "@effect/vitest"` + `it.effect(...)`
  - [x] Test: happy path — correct `PartCompleted` events (partNumber, etag, bytesUploaded) + `UploadCompleted`
  - [x] Test: `completeUpload` receives all completed parts with correct partNumbers and etags
  - [x] Test: `maxConcurrency` limits concurrency (track concurrent calls via Effect Ref)
  - [x] Test: retry on failure — success on second attempt emits `PartCompleted` (not error)
  - [x] Test: retries exhausted → stream fails with `MaxRetriesExceededError`
  - [x] Test: abort signal → stream fails with `AbortError`
  - [x] Surgical assertions: exact `_tag`, `partNumber`, `etag`, `bytesUploaded` values

- [x] Task 4: Verify build and tests pass
  - [x] `pnpm turbo build` — no errors
  - [x] `pnpm turbo test` — all tests pass, zero regressions (62 tests total, 5 new)

## Dev Notes

### Files to Create / Modify

```
packages/tranquilload-core/src/
  progress/
    upload-event.ts           ← MODIFY: add PartCompleted, expand UploadEvent union
  multipart/
    upload-stream.ts          ← CREATE
    upload-stream.test.ts     ← CREATE
    index.ts                  ← DO NOT TOUCH (Story 3.3)
    chunk-stream.ts           ← DO NOT TOUCH (Story 3.1)
    chunk-stream.test.ts      ← DO NOT TOUCH
```

### Task 1 — `PartCompleted` type

Current `progress/upload-event.ts`:
```ts
export interface UploadCompleted { ... }
export type UploadEvent = UploadCompleted  // minimal — Story 5.1 expands to full union
```

Add to it:
```ts
export interface PartCompleted {
  readonly _tag: "PartCompleted"
  readonly partNumber: number
  readonly etag: string
  readonly bytesUploaded: number
  readonly timestamp: number
}

export type UploadEvent = UploadCompleted | PartCompleted
```

### Task 2 — Interface Definitions

```ts
// multipart/upload-stream.ts
import { Effect, Ref, Schedule, Stream } from "effect"
import type { UploadError } from "../errors/upload-error.js"
import { CompleteUploadError, MaxRetriesExceededError, PartUploadError } from "../errors/upload-error.js"
import type { PartCompleted, UploadCompleted, UploadEvent } from "../progress/upload-event.js"
import { LoggerService } from "../services/logger-service.js"
import { fromAbortSignal } from "../utils/abort-interop.js"
import { normalizeCallback } from "../utils/normalize-callback.js"
import { chunkStream } from "./chunk-stream.js"

export interface CompletedPart {
  readonly partNumber: number
  readonly etag: string
}

export interface UploadMultipartOptions {
  readonly stream: ReadableStream<Uint8Array>
  readonly chunkSize: number
  readonly uploadPart: (
    partNumber: number,
    chunk: Uint8Array
  ) => string | Promise<string> | Effect.Effect<string, UploadError>
  readonly completeUpload: (
    parts: ReadonlyArray<CompletedPart>
  ) => void | Promise<void> | Effect.Effect<void, UploadError>
  readonly maxConcurrency?: number
  readonly signal?: AbortSignal
  readonly retrySchedule?: Schedule.Schedule<unknown, PartUploadError>
}
```

### Task 2 — Implementation Pattern

```ts
const DEFAULT_MAX_CONCURRENCY = 4

// 3 total attempts: 1 initial + 2 retries, with exponential backoff
const DEFAULT_RETRY_SCHEDULE = Schedule.exponential("100 millis").pipe(
  Schedule.compose(Schedule.recurs(2))
)

export const uploadMultipartEffect = (
  options: UploadMultipartOptions
): Stream.Stream<UploadEvent, UploadError, LoggerService> => {
  const {
    stream,
    chunkSize,
    uploadPart,
    completeUpload,
    maxConcurrency = DEFAULT_MAX_CONCURRENCY,
    signal,
    retrySchedule = DEFAULT_RETRY_SCHEDULE,
  } = options

  // Use Stream.unwrap to flatten Effect<Stream<...>, ...> → Stream<...>
  return Stream.unwrap(
    Effect.gen(function* () {
      const logger = yield* LoggerService
      const semaphore = yield* Effect.makeSemaphore(maxConcurrency)
      const refParts = yield* Ref.make<CompletedPart[]>([])

      // Per-part upload: retry logic with attempt tracking
      const makeUploadOne = (
        partNumber: number,
        chunk: Uint8Array
      ): Effect.Effect<PartCompleted, UploadError> =>
        Effect.gen(function* () {
          const refAttempts = yield* Ref.make(0)

          const single: Effect.Effect<string, PartUploadError> = Effect.gen(function* () {
            yield* Ref.update(refAttempts, n => n + 1)
            const attempt = yield* Ref.get(refAttempts)
            return yield* normalizeCallback(() => uploadPart(partNumber, chunk)).pipe(
              Effect.mapError(
                (cause): PartUploadError => new PartUploadError(partNumber, attempt, cause)
              )
            )
          })

          const etag = yield* Effect.retry(single, retrySchedule).pipe(
            Effect.catchAll(err =>
              Effect.gen(function* () {
                const totalAttempts = yield* Ref.get(refAttempts)
                return yield* Effect.fail(
                  new MaxRetriesExceededError(partNumber, totalAttempts, err.cause)
                )
              })
            )
          )

          const event: PartCompleted = {
            _tag: "PartCompleted" as const,
            partNumber,
            etag,
            bytesUploaded: chunk.length,
            timestamp: Date.now(),
          }

          yield* Ref.update(refParts, parts => [...parts, { partNumber, etag }])
          yield* Effect.sync(() => logger.log("info", `Part ${partNumber} completed`))
          return event
        })

      // Build the parts stream: chunk → index → upload concurrently via semaphore
      const partsStream: Stream.Stream<UploadEvent, UploadError, never> = chunkStream(
        stream,
        chunkSize
      ).pipe(
        Stream.mapError((cause): UploadError => new PartUploadError(0, 0, cause)),
        Stream.zipWithIndex,
        Stream.mapEffect(
          ([chunk, idx]) => {
            const partEffect = semaphore.withPermits(1)(
              makeUploadOne(Number(idx) + 1, chunk)
            )
            return signal ? Effect.raceFirst(partEffect, fromAbortSignal(signal)) : partEffect
          },
          { concurrency: "unbounded" }
        )
      )

      // After all parts complete, call completeUpload and emit UploadCompleted
      const finalEffect: Effect.Effect<UploadEvent, UploadError, never> = Effect.gen(
        function* () {
          const parts = yield* Ref.get(refParts)
          // Parts accumulated in completion order — completeUpload must sort if protocol requires order
          yield* normalizeCallback(() => completeUpload(parts)).pipe(
            Effect.mapError(
              (cause): UploadError =>
                cause instanceof Error
                  ? (cause as UploadError)
                  : new CompleteUploadError(cause)
            )
          )
          yield* Effect.sync(() => logger.log("info", "Multipart upload completed"))
          return {
            _tag: "UploadCompleted" as const,
            uploadId: "",
            totalParts: parts.length,
            timestamp: Date.now(),
          } satisfies UploadCompleted
        }
      )

      return partsStream.pipe(Stream.concat(Stream.fromEffect(finalEffect)))
    })
  )
}
```

**Key points:**
- `Stream.unwrap(Effect.gen(...))` — resolves `LoggerService` requirement, creates Semaphore and Refs once, returns the stream. The stream itself has no `R` dependency left after `unwrap` resolves what it can — but `LoggerService` is captured via closure, so the returned stream still has `R = LoggerService` in its type (it's required by the outer Effect.gen).
- `semaphore.withPermits(1)(partEffect)` + `concurrency: 'unbounded'` — all parts are submitted to the stream executor simultaneously, but the semaphore ensures at most `maxConcurrency` run concurrently.
- `Stream.concat(Stream.fromEffect(finalEffect))` — `completeUpload` is called AFTER all `PartCompleted` events are emitted, collecting parts from `refParts`.
- Parts are accumulated in `refParts` as they complete (potentially out of order). Protocol adapters (e.g., S3) must sort by `partNumber` when needed — this is the adapter's responsibility, not core's.
- `retrySchedule` default = 3 total attempts (1 initial + 2 retries). The last `PartUploadError` is mapped to `MaxRetriesExceededError` via `Effect.catchAll` after schedule exhaustion.

**Anti-patterns to avoid:**
```ts
// ❌ WRONG — Ref created outside Effect.gen, shared across part invocations
const refAttempts = Ref.make(0)  // This is Effect<Ref<number>>, not yet resolved

// ✅ CORRECT — each part creates its own Ref inside the Effect.gen
const refAttempts = yield* Ref.make(0)

// ❌ WRONG — Effect.race (waits for first SUCCESS, hangs if fromAbortSignal fails first)
Effect.race(partEffect, fromAbortSignal(signal))

// ✅ CORRECT — Effect.raceFirst (first to TERMINATE wins, success or failure)
Effect.raceFirst(partEffect, fromAbortSignal(signal))

// ❌ WRONG — Stream.provideLayer on a stream without LoggerService in its R
partsStream.pipe(Stream.provideLayer(LoggerServiceLive))

// ✅ CORRECT — LoggerService is captured via closure from Stream.unwrap(Effect.gen(...))
// The stream's R type still reflects LoggerService; the Layer is provided at Story 3.3 entry point
```

### Task 3 — Test Patterns

```ts
import { describe, expect, it } from "@effect/vitest"
import { Chunk, Effect, Ref, Schedule, Stream } from "effect"
import { AbortError, MaxRetriesExceededError, PartUploadError } from "../errors/upload-error.js"
import { LoggerServiceLive } from "../services/logger-service.js"
import { uploadMultipartEffect, type CompletedPart } from "./upload-stream.js"

// Helper: create ReadableStream from Uint8Array
const fromBytes = (bytes: Uint8Array): ReadableStream<Uint8Array> =>
  new ReadableStream({ start: c => { c.enqueue(bytes); c.close() } })

// Helper: run uploadMultipartEffect and collect all events
const run = (options: Parameters<typeof uploadMultipartEffect>[0]) =>
  Stream.runCollect(uploadMultipartEffect(options)).pipe(
    Effect.map(chunk => Array.from(chunk)),
    Effect.provide(LoggerServiceLive)
  )
```

**Happy path (AC #2, #3, #4):**
```ts
it.effect("emits PartCompleted per chunk and UploadCompleted at end", () =>
  Effect.gen(function* () {
    const etags = ["etag-1", "etag-2", "etag-3"]
    const receivedParts: CompletedPart[] = []

    const events = yield* run({
      stream: fromBytes(new Uint8Array(30).fill(1)),
      chunkSize: 10,
      uploadPart: (partNumber, chunk) => {
        expect(chunk.length).toBeLessThanOrEqual(10)
        return etags[partNumber - 1]!
      },
      completeUpload: (parts) => { receivedParts.push(...parts) },
    })

    const partEvents = events.filter(e => e._tag === "PartCompleted")
    const completeEvent = events.find(e => e._tag === "UploadCompleted")

    expect(partEvents).toHaveLength(3)
    expect(partEvents[0]).toMatchObject({ _tag: "PartCompleted", partNumber: 1, etag: "etag-1", bytesUploaded: 10 })
    expect(partEvents[1]).toMatchObject({ _tag: "PartCompleted", partNumber: 2, etag: "etag-2", bytesUploaded: 10 })
    expect(partEvents[2]).toMatchObject({ _tag: "PartCompleted", partNumber: 3, etag: "etag-3", bytesUploaded: 10 })
    expect(completeEvent).toMatchObject({ _tag: "UploadCompleted", totalParts: 3 })

    // completeUpload received all 3 parts
    expect(receivedParts).toHaveLength(3)
    expect(receivedParts.map(p => p.partNumber).sort()).toEqual([1, 2, 3])
  })
)
```

**Concurrency limiting (AC #1):**
```ts
it.effect("limits concurrent parts to maxConcurrency", () =>
  Effect.gen(function* () {
    const refConcurrent = yield* Ref.make(0)
    const refMaxObserved = yield* Ref.make(0)

    // uploadPart as an Effect to use Effect.sleep for async simulation
    const uploadPart = (_partNumber: number, _chunk: Uint8Array): Effect.Effect<string, never> =>
      Effect.gen(function* () {
        yield* Ref.update(refConcurrent, n => n + 1)
        const current = yield* Ref.get(refConcurrent)
        yield* Ref.update(refMaxObserved, max => Math.max(max, current))
        yield* Effect.sleep("10 millis")
        yield* Ref.update(refConcurrent, n => n - 1)
        return `etag-${_partNumber}`
      }) as Effect.Effect<string, never>

    yield* run({
      stream: fromBytes(new Uint8Array(60).fill(1)),
      chunkSize: 10, // 6 chunks
      uploadPart,
      completeUpload: () => {},
      maxConcurrency: 3,
    })

    const maxObserved = yield* Ref.get(refMaxObserved)
    expect(maxObserved).toBeLessThanOrEqual(3)
    expect(maxObserved).toBeGreaterThanOrEqual(1)
  })
)
```

**Retry on failure then success (AC #5):**
```ts
it.effect("retries on failure and emits PartCompleted on eventual success", () =>
  Effect.gen(function* () {
    const refAttempts = yield* Ref.make(0)

    const events = yield* run({
      stream: fromBytes(new Uint8Array(10).fill(1)),
      chunkSize: 10,
      uploadPart: (_partNumber, _chunk) => Effect.gen(function* () {
        const attempts = yield* Ref.updateAndGet(refAttempts, n => n + 1)
        if (attempts < 2) return yield* Effect.fail(new PartUploadError(1, attempts, new Error("transient")) as never)
        return "etag-ok"
      }) as Effect.Effect<string, PartUploadError>,
      completeUpload: () => {},
      retrySchedule: Schedule.recurs(2),
    })

    const partEvent = events.find(e => e._tag === "PartCompleted")
    expect(partEvent).toMatchObject({ _tag: "PartCompleted", etag: "etag-ok" })
    expect(yield* Ref.get(refAttempts)).toBe(2)
  })
)
```

**Retries exhausted → `MaxRetriesExceededError` (AC #6):**
```ts
it.effect("fails with MaxRetriesExceededError when retries exhausted", () =>
  Effect.gen(function* () {
    const cause = new Error("permanent failure")
    const result = yield* run({
      stream: fromBytes(new Uint8Array(10).fill(1)),
      chunkSize: 10,
      uploadPart: () => Promise.reject(cause),
      completeUpload: () => {},
      retrySchedule: Schedule.recurs(1), // 2 total attempts
    }).pipe(Effect.flip)

    expect(result).toBeInstanceOf(MaxRetriesExceededError)
    expect((result as MaxRetriesExceededError).partNumber).toBe(1)
    expect((result as MaxRetriesExceededError).totalAttempts).toBe(2)
    expect((result as MaxRetriesExceededError).cause).toBe(cause)
  })
)
```

**Abort signal (AC #7):**
```ts
it.effect("fails with AbortError when signal is aborted", () =>
  Effect.gen(function* () {
    const controller = new AbortController()

    const uploadPart = () => new Promise<string>((_resolve) => {
      // Never resolves — we'll abort before it completes
      setTimeout(() => controller.abort(), 5)
    })

    const result = yield* run({
      stream: fromBytes(new Uint8Array(10).fill(1)),
      chunkSize: 10,
      uploadPart,
      completeUpload: () => {},
      signal: controller.signal,
    }).pipe(Effect.flip)

    expect(result).toBeInstanceOf(AbortError)
  })
)
```

### Architecture Compliance (Absolute Rules)

1. **`Effect.raceFirst` for abort** — NOT `Effect.race` (race waits for first success; raceFirst terminates on first completion, success or failure)
2. **`Stream.unwrap` + `Effect.gen`** — not `Stream.fromEffect(effect.pipe(Stream.flatten()))` — `Stream.unwrap` is the canonical pattern
3. **`normalizeCallback` for ALL user callbacks** — `uploadPart` AND `completeUpload`. Never `.then()` or `try/catch` on user-provided functions
4. **`globalThis` only** — no `window`, no `process`, no `node:*` imports
5. **`.js` on all relative imports** — NodeNext module resolution
6. **No `try/catch`** — use Effect error channel throughout
7. **Ref per invocation** — `refAttempts` must be created inside the per-part `Effect.gen`, not as module-level state
8. **`concurrency: 'unbounded'` + Semaphore** — use `Stream.mapEffect(..., { concurrency: 'unbounded' })` alongside `semaphore.withPermits(1)(...)` (AC requires Semaphore explicitly)

### What This Story Does NOT Do

- Does NOT implement `multipart/index.ts` — Story 3.3 (Dual API Entry Point)
- Does NOT implement Circuit Breaker — Story 3.4
- Does NOT expose `getProgress()` — Story 5.2
- Does NOT expose `uploadId` from an `initiate` callback — Story 7.1
- Does NOT add `ProgressTick` or `CircuitOpen` events to `UploadEvent` — Story 5.1
- Does NOT use `CompressionService` — pipeline transform is Story 4.3
- The `uploadId` in `UploadCompleted` is `""` (empty string) for now — Story 7.1 will fill it

### Previous Story Intelligence (Story 3.1)

From 3.1 implementation:
- **`chunkStream(stream, chunkSize)`** — signature: `(stream: ReadableStream<Uint8Array>, chunkSize: number): Stream.Stream<Uint8Array, unknown>`. Note the `unknown` error type — always map it explicitly.
- **`Stream.fromReadableStream(() => chunked, (e) => e)`** — lazy getter pattern. Not relevant here (we use `chunkStream` directly).
- **`Stream.runCollect` + `Effect.map(chunk => Array.from(chunk))`** — standard pattern to get `Uint8Array[]` from a stream in tests.
- **Test pattern reminder** — `import { it, describe, expect } from "@effect/vitest"` (NOT from `vitest`). Always `it.effect(...)`.
- **57 tests currently passing** — do NOT break any of them.

### Previous Stories Intelligence (Stories 2.1 & 2.2)

- **`Stream.provideLayer` vs `Effect.provide`** — for Stream use `Stream.provideLayer`, for Effect use `Effect.provide`. In this story, the Dual API wrapper (Story 3.3) will handle the layer providing.
- **`Effect.runPromiseExit` + `Cause.squash`** — used in Story 2.2's Dual API wrapper for clean error surfacing. Not needed here (internal implementation).
- **`Effect.sync(() => logger.log(...))`** — `LoggerService.log` returns `void`, must wrap with `Effect.sync` before `yield*` in `Effect.gen`.
- **`Stream.concat`** — correct way to append `UploadCompleted` after all `PartCompleted` events.
- **Single-run trap** — the returned `Stream` is a description, not a running process. Each `Stream.run*` call executes the program once. Important for Story 3.3 (Dual API) where `events` and `result` share one execution.

### Git Intelligence

```
6aeda54 review: 3-1-chunk-stream
5d8db9a dev: 3-1-chunk-stream
7b040ab retrospective: epic 2
```

Files currently in `multipart/`:
- `packages/tranquilload-core/src/multipart/index.ts` — placeholder `export const _placeholder: undefined = undefined` — DO NOT TOUCH
- `packages/tranquilload-core/src/multipart/chunk-stream.ts` — Story 3.1, STABLE
- `packages/tranquilload-core/src/multipart/chunk-stream.test.ts` — Story 3.1, STABLE

### References

- `chunkStream` implementation: `packages/tranquilload-core/src/multipart/chunk-stream.ts`
- `normalizeCallback`: `packages/tranquilload-core/src/utils/normalize-callback.ts`
- `fromAbortSignal`: `packages/tranquilload-core/src/utils/abort-interop.ts`
- `UploadError` union: `packages/tranquilload-core/src/errors/upload-error.ts`
- `LoggerService` / `LoggerServiceLive`: `packages/tranquilload-core/src/services/logger-service.ts`
- `UploadEvent`: `packages/tranquilload-core/src/progress/upload-event.ts`
- `uploadOnceEffect` (parallel pattern reference): `packages/tranquilload-core/src/oneshot/upload.ts`
- Effect Semaphore docs: `effect/packages/effect/README.md` or `effect/docs/`
- Effect Stream.mapEffect concurrency: `effect/packages/effect/README.md`
- Architecture multipart data flow: [Source: `_bmad-output/planning-artifacts/architecture.md#Data Flow`]
- Architecture Semaphore pattern: [Source: `_bmad-output/planning-artifacts/architecture.md#Process Patterns`]
- Architecture AbortSignal pattern: [Source: `_bmad-output/planning-artifacts/architecture.md#AbortSignal Interop Pattern`]

## Dev Agent Record

### Agent Model Used

claude-opus-4-6

### Debug Log References

- Concurrency test initially timed out due to `Effect.sleep` + `@effect/vitest` TestClock — fixed by using `Effect.yieldNow()` instead

### Completion Notes List

- Task 1: Added `PartCompleted` interface to `upload-event.ts`, expanded `UploadEvent` union
- Task 2: Implemented `uploadMultipartEffect` in `upload-stream.ts` — Stream.unwrap + Effect.gen pattern, Semaphore for concurrency control, per-part retry with Ref-based attempt tracking, abort via Effect.raceFirst, completeUpload after all parts via Stream.concat
- Task 3: 7 tests covering all 7 ACs — happy path (3 parts + complete), concurrency limiting, retry success, single-attempt failure (PartUploadError), retries exhausted (MaxRetriesExceededError), completeUpload error wrapping (CompleteUploadError), abort signal (AbortError)
- Task 4: Build passes, 64 tests pass (57 existing + 7 new), zero regressions

### Change Log

- 2026-03-15: Story 3.2 implementation complete — multipart upload core Effect implementation
- 2026-03-15: Code review fixes — (1) completeUpload error mapping always wraps in CompleteUploadError (type-safety), (2) single-attempt failure surfaces PartUploadError instead of MaxRetriesExceededError (AC #6), (3) added tests for single-attempt failure and completeUpload error wrapping

### File List

- `packages/tranquilload-core/src/progress/upload-event.ts` — MODIFIED (added PartCompleted interface, expanded UploadEvent union)
- `packages/tranquilload-core/src/multipart/upload-stream.ts` — CREATED (uploadMultipartEffect, CompletedPart, UploadMultipartOptions)
- `packages/tranquilload-core/src/multipart/upload-stream.test.ts` — CREATED (7 tests)
- `packages/tranquilload-core/src/utils/normalize-callback.ts` — MODIFIED (fixed fn parameter type: union-of-functions → function-returning-union)
