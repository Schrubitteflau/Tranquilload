# Story 5.1: UploadEvent Type System

Status: done

## Story

As a developer consuming the library,
I want a fully typed `UploadEvent` discriminated union exported from `@tranquilload/progress`,
so that I can exhaustively handle every event type with TypeScript and build precise progress UIs or logs.

## Acceptance Criteria

1. **Given** the `@tranquilload/progress` sub-path export **When** the developer imports `UploadEvent` **Then** the type is a closed union of `PartCompleted | ProgressTick | UploadCompleted | CircuitOpen` **And** every variant has `_tag` (literal discriminant) and `timestamp` (number) **And** `Match.tag` from Effect and standard `switch` on `_tag` both work for exhaustive handling.

2. **Given** a new event variant is added in a future version **When** existing user code does not handle the new `_tag` **Then** TypeScript reports a type error at compile time (exhaustiveness enforced).

3. **Given** `uploadMultipart` is running **When** parts complete **Then** the `events` stream emits `ProgressTick` events (one per `PartCompleted`) with a monotonically increasing `bytesUploaded` and `totalBytes: Option.none()` (total not known at core level).

## Tasks / Subtasks

- [x] Task 1: Add `ProgressTick` to `upload-event.ts` and update the `UploadEvent` union (AC: #1, #2)
  - [x] Add `ProgressTick` interface with `_tag: "ProgressTick"`, `bytesUploaded: number`, `totalBytes: Option.Option<number>`, `timestamp: number`
  - [x] Update `UploadEvent` to: `UploadCompleted | PartCompleted | ProgressTick | CircuitOpen`
  - [x] Remove the `// Minimal type — Story 5.1 will expand to full discriminated union` comment

- [x] Task 2: Update `progress/index.ts` — replace placeholder with proper exports (AC: #1)
  - [x] Replace the entire file with named re-exports of `UploadEvent`, `PartCompleted`, `ProgressTick`, `UploadCompleted`, `CircuitOpen` from `"./upload-event.js"`

- [x] Task 3: Emit `ProgressTick` from `uploadMultipartEffect` in `upload-stream.ts` (AC: #3)
  - [x] Add `Option` to the `import { Cause, Effect, Exit, Option, Ref, Schedule, Stream }` import line
  - [x] Add `ProgressTick` to the import from `"../progress/upload-event.js"`
  - [x] Inside the `Effect.gen` body of `uploadMultipartEffect`, after the existing Refs, add: `const refBytesUploaded = yield* Ref.make(0)`
  - [x] In the `partsStream` pipeline, between `Stream.mapEffect(...)` and `Stream.catchAll(...)`, add a `Stream.flatMap` to inject `ProgressTick` after each `PartCompleted`:
    ```ts
    Stream.flatMap(
      (event): Stream.Stream<UploadEvent, UploadError, never> => {
        if (event._tag !== "PartCompleted") return Stream.make(event)
        const tickEffect = Ref.updateAndGet(refBytesUploaded, (n) => n + event.bytesUploaded).pipe(
          Effect.map(
            (total): ProgressTick => ({
              _tag: "ProgressTick" as const,
              bytesUploaded: total,
              totalBytes: Option.none(),
              timestamp: Date.now(),
            })
          )
        )
        return Stream.concat(Stream.make(event), Stream.fromEffect(tickEffect))
      }
    ),
    ```
  - [x] Verify `partsStream` type remains `Stream.Stream<UploadEvent, UploadError, never>`

- [x] Task 4: Create `progress/upload-event.test.ts` with exhaustive handling tests (AC: #1, #2)
  - [x] Import: `import { it, describe, expect } from "@effect/vitest"`, `import { Effect, Match, Option } from "effect"`, `import type { UploadEvent } from "./upload-event.js"`, `import { PartCompleted, ProgressTick, UploadCompleted, CircuitOpen } from "./upload-event.js"` (type imports)
  - [x] Test: `switch` on `_tag` covers all variants — compile-time and runtime:
    ```ts
    it("exhaustive switch on _tag compiles and handles all variants", () => {
      const handle = (event: UploadEvent): string => {
        switch (event._tag) {
          case "PartCompleted":   return "part"
          case "ProgressTick":    return "progress"
          case "UploadCompleted": return "done"
          case "CircuitOpen":     return "circuit"
        }
      }
      const event: UploadEvent = {
        _tag: "ProgressTick",
        bytesUploaded: 500,
        totalBytes: Option.none(),
        timestamp: 0,
      }
      expect(handle(event)).toBe("progress")
    })
    ```
  - [x] Test: `Match.tag` from Effect works exhaustively:
    ```ts
    it.effect("Match.tag handles all variants exhaustively", () =>
      Effect.gen(function* () {
        const event: UploadEvent = {
          _tag: "PartCompleted",
          partNumber: 1,
          etag: "abc",
          bytesUploaded: 100,
          timestamp: 0,
        }
        const result = Match.type<UploadEvent>().pipe(
          Match.tag("PartCompleted",   (e) => `part:${e.partNumber}`),
          Match.tag("ProgressTick",    (e) => `progress:${e.bytesUploaded}`),
          Match.tag("UploadCompleted", (e) => `done:${e.totalParts}`),
          Match.tag("CircuitOpen",     (e) => `circuit:${e.failedParts}`),
          Match.exhaustive
        )(event)
        expect(result).toBe("part:1")
      })
    )
    ```
  - [x] Test: every variant has `_tag` + `timestamp` — spot-check each:
    ```ts
    it("all variants have _tag and timestamp fields", () => {
      const variants: UploadEvent[] = [
        { _tag: "PartCompleted", partNumber: 1, etag: "e", bytesUploaded: 10, timestamp: 1 },
        { _tag: "ProgressTick", bytesUploaded: 10, totalBytes: Option.some(100), timestamp: 2 },
        { _tag: "UploadCompleted", uploadId: "id", totalParts: 1, timestamp: 3 },
        { _tag: "CircuitOpen", failedParts: 3, timestamp: 4 },
      ]
      for (const v of variants) {
        expect(typeof v._tag).toBe("string")
        expect(typeof v.timestamp).toBe("number")
      }
    })
    ```
  - [x] Test: `ProgressTick` is emitted by `uploadMultipart` after each part:
    ```ts
    import { uploadMultipart } from "../multipart/index.js"
    // ...
    it.effect("uploadMultipart emits ProgressTick after each PartCompleted", () =>
      Effect.gen(function* () {
        const { result, events } = uploadMultipart({
          stream: new ReadableStream({
            start(c) {
              c.enqueue(new Uint8Array([1, 2, 3]))
              c.enqueue(new Uint8Array([4, 5, 6]))
              c.close()
            },
          }),
          chunkSize: 3, // 2 parts
          uploadPart: (_, __) => "etag",
          completeUpload: () => {},
        })
        yield* Effect.promise(() => result)
        const reader = events.getReader()
        // Already consumed — collect from emitted events via a second stream run is not possible
        // Instead, collect events in the result check:
        // Note: events stream is already consumed by result. Test via collecting upfront.
      })
    )
    ```
    **Simpler pattern** — collect all events from a test run:
    ```ts
    it.effect("emits ProgressTick events interspersed with PartCompleted", () =>
      Effect.gen(function* () {
        const allEvents: UploadEvent[] = []
        const { result, events } = uploadMultipart({
          stream: new ReadableStream({
            start(c) {
              c.enqueue(new Uint8Array([1, 2, 3]))
              c.enqueue(new Uint8Array([4, 5, 6]))
              c.close()
            },
          }),
          chunkSize: 3,
          uploadPart: (_, __) => "etag",
          completeUpload: () => {},
        })

        // Consume events stream concurrently with result
        const consumeEvents = async () => {
          const reader = events.getReader()
          while (true) {
            const { done, value } = await reader.read()
            if (done) break
            allEvents.push(value)
          }
        }

        yield* Effect.promise(() => Promise.all([result, consumeEvents()]))
        const progressTicks = allEvents.filter((e) => e._tag === "ProgressTick")
        expect(progressTicks).toHaveLength(2) // one per part
        // bytesUploaded should be monotonically increasing
        const tick1 = progressTicks[0] as ProgressTick // adjust import
        const tick2 = progressTicks[1] as ProgressTick
        expect(tick1.bytesUploaded).toBe(3)
        expect(tick2.bytesUploaded).toBe(6)
      })
    )
    ```
    **NOTE**: The `ProgressTick` type needs to be imported from `"./upload-event.js"` for the cast above.

- [x] Task 5: Build, test, typecheck (AC: all)
  - [x] `pnpm turbo build` — `@tranquilload/progress` entry builds cleanly, exports `UploadEvent` and all variants
  - [x] `pnpm turbo test` — all 96 tests pass (93 existing + 4 new - 1 scaffold = 96)
  - [x] `pnpm turbo typecheck` — no new TS errors introduced

## Dev Notes

### Current State of `progress/` Module

`upload-event.ts` already has 3 of 4 variants — `PartCompleted`, `UploadCompleted`, `CircuitOpen` — all correctly shaped with `_tag` and `timestamp`. The comment on line 23 explicitly says "Story 5.1 will expand to full discriminated union". **Only `ProgressTick` is missing.**

`progress/index.ts` is a pure placeholder:
```ts
// Placeholder — implemented in Epic 5
export const _placeholder: undefined = undefined
```
Replace it entirely.

### `ProgressTick` Shape (from Architecture)

```ts
export interface ProgressTick {
  readonly _tag: "ProgressTick"
  readonly bytesUploaded: number              // running total (cumulative, NOT delta)
  readonly totalBytes: Option.Option<number>  // Option.none() from core — totalBytes is a wrapper concern
  readonly timestamp: number
}
```

`Option` must be imported from `"effect"` in `upload-event.ts`. This is the first time `Option` is used in this file.

### Emission Logic in `upload-stream.ts`

The `partsStream` currently has this pipeline shape:
```
chunkStream → mapError → zipWithIndex → mapEffect(..., concurrency: "unbounded") → catchAll
```

Insert `Stream.flatMap` between `mapEffect` and `catchAll`. It converts each `PartCompleted` event into two events: `[PartCompleted, ProgressTick]`. Non-`PartCompleted` events (only `CircuitOpen` can come from `mapEffect`) pass through as-is.

**Key detail**: `Stream.mapEffect` with `concurrency: "unbounded"` runs parts in parallel but **emits results in order**. The subsequent `Stream.flatMap` (default `concurrency: 1`) then expands each in order. So `ProgressTick` events are strictly ordered after their corresponding `PartCompleted`.

**`refBytesUploaded` placement**: add it alongside the other Refs inside the `Effect.gen` body:
```ts
const refBytesUploaded = yield* Ref.make(0)
```
This ref tracks cumulative bytes across all parts within this upload run.

**Import additions to `upload-stream.ts`**:
1. Add `Option` to the existing `import { Cause, Effect, Exit, Ref, Schedule, Stream }` → `import { Cause, Effect, Exit, Option, Ref, Schedule, Stream }`
2. Add `ProgressTick` to the import from `"../progress/upload-event.js"` → `import type { CircuitOpen, PartCompleted, ProgressTick, UploadCompleted, UploadEvent } from "../progress/upload-event.js"`

### `multipart/index.ts` — No Changes Needed

The existing Stream tap in `multipart/index.ts`:
```ts
Stream.tap((event) => {
  if (event._tag === "PartCompleted") {
    return Ref.update(refProgress, (p) => ({
      ...p,
      bytesUploaded: p.bytesUploaded + event.bytesUploaded,
    }))
  }
  return Effect.void
}),
```
`ProgressTick` events hit the `else` branch (`Effect.void`) — no double-counting, no regression. **Do NOT change this file.**

### `oneshot/upload.ts` — No Changes Needed

One-shot upload emits only `UploadCompleted`. `ProgressTick` is a multipart-only concept (no chunks). **Do NOT change this file.**

### Package Exports Already Configured

`package.json` (`@tranquilload/core`) already has `"./progress"` in the exports map. `tsdown.config.ts` already has `progress: 'src/progress/index.ts'` as an entry point. **No changes needed to either file.**

### Testing Pattern for `ProgressTick` Emission

The challenge: `events: ReadableStream<UploadEvent>` is produced from `collected` (a Promise of all events), meaning events are buffered. To assert `ProgressTick` events, collect both `result` and `events` concurrently — race both in `Promise.all`.

The stream ordering guarantee: for a 2-chunk upload (chunkSize ≤ chunk bytes), expect events in this order:
```
PartCompleted{partNumber:1} → ProgressTick{bytesUploaded:3} → PartCompleted{partNumber:2} → ProgressTick{bytesUploaded:6} → UploadCompleted
```
(exact order may vary if `maxConcurrency > 1`, but total count of ProgressTick = total number of parts)

### Type Import for Tests

In `upload-event.test.ts`, use the interface name directly as a type for narrowing:
```ts
import type { UploadEvent, ProgressTick } from "./upload-event.js"
```
(or `import { type ProgressTick } from "./upload-event.js"`)

### Project Structure Notes

Files to modify:
- `packages/tranquilload-core/src/progress/upload-event.ts` — add `ProgressTick`, update union
- `packages/tranquilload-core/src/progress/index.ts` — replace placeholder with re-exports
- `packages/tranquilload-core/src/multipart/upload-stream.ts` — emit `ProgressTick`, add `Option` import

Files to create:
- `packages/tranquilload-core/src/progress/upload-event.test.ts` — type + emission tests

**DO NOT touch** any other file.

### References

- Current `UploadEvent` union: `packages/tranquilload-core/src/progress/upload-event.ts:23`
- `progress/index.ts` placeholder: `packages/tranquilload-core/src/progress/index.ts:1`
- `uploadMultipartEffect` partsStream pipeline: `packages/tranquilload-core/src/multipart/upload-stream.ts:105-155`
- `multipart/index.ts` refProgress tap: `packages/tranquilload-core/src/multipart/index.ts:55-64`
- `UploadEvent` shape in architecture: `_bmad-output/planning-artifacts/architecture.md#UploadEvent Shape`
- Story 5.1 AC: `_bmad-output/planning-artifacts/epics.md#Story 5.1`
- Effect `Match.tag` docs: `effect/packages/effect/README.md` (local clone)
- Test pattern (it.effect, import): `_bmad-output/planning-artifacts/architecture.md#Testing Pattern`

## Dev Agent Record

### Agent Model Used

Claude Opus 4.6

### Debug Log References

None — clean implementation, no debugging needed.

### Completion Notes List

- Added `ProgressTick` interface to `upload-event.ts` with `_tag`, `bytesUploaded`, `totalBytes: Option.Option<number>`, `timestamp`
- Updated `UploadEvent` union to include all 4 variants: `UploadCompleted | PartCompleted | ProgressTick | CircuitOpen`
- Replaced `progress/index.ts` placeholder with proper type re-exports
- Added `Stream.flatMap` in `upload-stream.ts` to emit `ProgressTick` after each `PartCompleted`, with cumulative `bytesUploaded` via `Ref`
- Created 4 tests: exhaustive switch, Match.tag, variant field check, ProgressTick emission from uploadMultipart
- All 96 tests pass, build + typecheck clean

### Change Log

- 2026-03-15: Implemented Story 5.1 — UploadEvent type system with ProgressTick variant and emission logic

### File List

- `packages/tranquilload-core/src/progress/upload-event.ts` — modified (added ProgressTick, updated union)
- `packages/tranquilload-core/src/progress/index.ts` — modified (replaced placeholder with type re-exports)
- `packages/tranquilload-core/src/multipart/upload-stream.ts` — modified (emit ProgressTick, added Option import)
- `packages/tranquilload-core/src/progress/upload-event.test.ts` — created (4 tests)
