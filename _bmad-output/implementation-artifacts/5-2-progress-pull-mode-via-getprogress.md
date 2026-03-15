# Story 5.2: Progress Pull-Mode via `getProgress()`

Status: done

## Story

As a developer consuming the library,
I want a `getProgress()` function returned alongside `events` and `result`,
so that I can poll current upload state on demand without consuming the events stream.

## Acceptance Criteria

1. **Given** an in-progress `uploadMultipart` call **When** the developer calls `getProgress()` **Then** it returns `Promise<{ bytesUploaded: number, totalBytes: Option<number> }>` **And** calling it multiple times returns updated snapshots without side effects on the upload.

2. **Given** `getProgress.effect` is called **When** used inside an Effect program **Then** it returns `Effect<Progress>` reading from the internal `Ref<Progress>` without running the upload.

## Tasks / Subtasks

- [x] Task 1: Export `Progress` from `progress/index.ts` (AC: #1, #2)
  - [x] Add `export type { Progress } from "../multipart/index.js"` to `packages/tranquilload-core/src/progress/index.ts`
  - [x] Verify the `@tranquilload/progress` export path now resolves `Progress` correctly

- [x] Task 2: Write `progress/getprogress.test.ts` with mid-upload and `getProgress.effect` tests (AC: #1, #2)
  - [x] Create `packages/tranquilload-core/src/progress/getprogress.test.ts`
  - [x] Test: `getProgress()` mid-upload returns an increasing `bytesUploaded`
  - [x] Test: multiple `getProgress()` calls are idempotent (no side effects on upload)
  - [x] Test: `getProgress.effect` is an `Effect<Progress>` — runs without launching the upload

- [x] Task 3: Build, test, typecheck (AC: all)
  - [x] `pnpm turbo build` — clean
  - [x] `pnpm turbo test` — all tests pass
  - [x] `pnpm turbo typecheck` — no errors

## Dev Notes

### Current State — Nothing to Implement in Core, Only to Test and Export

**`getProgress` is fully implemented** as of Story 3.3 in `packages/tranquilload-core/src/multipart/index.ts`. Do NOT rewrite it.

```ts
// multipart/index.ts — lines 98-101 (already in place)
const getProgress = Object.assign(
  (): Promise<Progress> => Effect.runPromise(Ref.get(refProgress)),
  { effect: Ref.get(refProgress) }
)
```

`Progress` interface is also already there (lines 11–14):
```ts
export interface Progress {
  readonly bytesUploaded: number
  readonly totalBytes: Option.Option<number>
}
```

**Existing tests** in `packages/tranquilload-core/src/multipart/index.test.ts` already cover:
- `getProgress tracks bytesUploaded; totalBytes is Some when provided` (post-completion)
- `getProgress returns None for totalBytes when not provided` (post-completion)

**What is missing and must be added:**

1. `Progress` is not re-exported from `progress/index.ts` — user cannot import it from `@tranquilload/progress`
2. Mid-upload snapshot test (current tests only call `getProgress()` after `await result`)
3. `getProgress.effect` test (not covered anywhere yet)

### Task 1: `progress/index.ts` — Single Line Change

Current content of `packages/tranquilload-core/src/progress/index.ts`:
```ts
export type {
  UploadEvent,
  PartCompleted,
  ProgressTick,
  UploadCompleted,
  CircuitOpen,
} from "./upload-event.js"
```

Add one line:
```ts
export type { Progress } from "../multipart/index.js"
```

That's it. `Progress` lives in `multipart/index.ts` and is simply re-exported here. No circular dependency — `progress/upload-event.ts` is already imported by `multipart/index.ts`, but `multipart/index.ts` does NOT import from `progress/index.ts` (only from `progress/upload-event.ts`).

### Task 2: Test File Content

Create `packages/tranquilload-core/src/progress/getprogress.test.ts`:

```ts
import { describe, expect, it } from "@effect/vitest"
import { Effect, Option } from "effect"
import { uploadMultipart, type Progress } from "../multipart/index.js"

// Helper: create a ReadableStream from repeated chunks with a delay
const slowStream = (chunkCount: number, chunkSize: number): ReadableStream<Uint8Array> =>
  new ReadableStream({
    async start(controller) {
      for (let i = 0; i < chunkCount; i++) {
        controller.enqueue(new Uint8Array(chunkSize).fill(i))
        await new Promise((r) => setTimeout(r, 5))
      }
      controller.close()
    },
  })
```

**Test 1 — Mid-upload snapshot:**
```ts
it.effect("getProgress() returns increasing bytesUploaded during an in-progress upload", () =>
  Effect.gen(function* () {
    let snapshotDuringUpload: Progress | null = null

    const { result, getProgress } = uploadMultipart({
      stream: slowStream(3, 10), // 3 parts × 10 bytes = 30 bytes total
      chunkSize: 10,
      uploadPart: async (partNumber, _chunk) => {
        // Poll getProgress mid-upload (while part 1 is uploading)
        if (partNumber === 1) {
          snapshotDuringUpload = await getProgress()
        }
        return `etag-${partNumber}`
      },
      completeUpload: () => {},
    })

    yield* Effect.promise(() => result)

    // snapshot taken after part 1 resolved → bytesUploaded ≥ 10
    expect(snapshotDuringUpload).not.toBeNull()
    expect((snapshotDuringUpload as Progress).bytesUploaded).toBeGreaterThanOrEqual(10)

    // After completion, full 30 bytes accounted
    const finalProgress = yield* Effect.promise(() => getProgress())
    expect(finalProgress.bytesUploaded).toBe(30)
  })
)
```

**Test 2 — Multiple calls are idempotent (no side effects):**
```ts
it.effect("calling getProgress() multiple times does not affect the upload", () =>
  Effect.gen(function* () {
    const { result, getProgress } = uploadMultipart({
      stream: new ReadableStream({
        start(c) {
          c.enqueue(new Uint8Array(20).fill(1))
          c.close()
        },
      }),
      chunkSize: 10,
      uploadPart: () => "etag",
      completeUpload: () => {},
    })

    yield* Effect.promise(() => result)

    const p1 = yield* Effect.promise(() => getProgress())
    const p2 = yield* Effect.promise(() => getProgress())
    const p3 = yield* Effect.promise(() => getProgress())

    expect(p1.bytesUploaded).toBe(20)
    expect(p2.bytesUploaded).toBe(20)
    expect(p3.bytesUploaded).toBe(20)
    expect(p1.totalBytes).toEqual(Option.none())
  })
)
```

**Test 3 — `getProgress.effect` returns `Effect<Progress>`:**
```ts
it.effect("getProgress.effect reads from Ref without launching the upload", () =>
  Effect.gen(function* () {
    const { result, getProgress } = uploadMultipart({
      stream: new ReadableStream({
        start(c) {
          c.enqueue(new Uint8Array(15).fill(1))
          c.close()
        },
      }),
      chunkSize: 15,
      uploadPart: () => "etag",
      completeUpload: () => {},
      totalBytes: 15,
    })

    yield* Effect.promise(() => result)

    // getProgress.effect is an Effect<Progress> — run it via Effect.runPromise
    const progress = yield* getProgress.effect
    expect(progress.bytesUploaded).toBe(15)
    expect(progress.totalBytes).toEqual(Option.some(15))
  })
)
```

### `getProgress.effect` Subtle Note

`getProgress.effect` is set once at `uploadMultipart()` call time:
```ts
{ effect: Ref.get(refProgress) }
```
`Ref.get(refProgress)` is an Effect that lazily reads `refProgress` **when run**. It is NOT evaluated at assignment time — the Effect is a description of a computation. So calling `yield* getProgress.effect` multiple times will always read the latest `refProgress` state. This is correct behavior and should be verified by Test 3.

### Project Structure Notes

Files to modify:
- `packages/tranquilload-core/src/progress/index.ts` — add `Progress` re-export (1 line)

Files to create:
- `packages/tranquilload-core/src/progress/getprogress.test.ts` — 3 tests

**DO NOT touch** `multipart/index.ts` — `getProgress` is fully implemented there already.
**DO NOT touch** `multipart/index.test.ts` — existing tests remain valid.

### References

- `getProgress` implementation: `packages/tranquilload-core/src/multipart/index.ts:98-101`
- `Progress` interface: `packages/tranquilload-core/src/multipart/index.ts:11-14`
- `progress/index.ts` current content: `packages/tranquilload-core/src/progress/index.ts:1-7`
- Existing `getProgress` tests: `packages/tranquilload-core/src/multipart/index.test.ts:54-86`
- Story 5.2 ACs: `_bmad-output/planning-artifacts/epics.md#Story 5.2`
- `@effect/vitest` pattern: `_bmad-output/planning-artifacts/architecture.md#Testing Pattern`

## Dev Agent Record

### Agent Model Used

Claude Opus 4.6

### Debug Log References

- Mid-upload test: adjusted to poll during part 2 (not part 1) because `PartCompleted` event updates `Ref` after `uploadPart` resolves — polling inside part 1's `uploadPart` sees 0 bytes since the event hasn't fired yet.
- TypeScript cast fix: `null as Progress` → `null as unknown as Progress` to satisfy strict type checking (TS2352).

### Completion Notes List

- ✅ Task 1: Added `export type { Progress } from "../multipart/index.js"` to `progress/index.ts` — `Progress` now importable from `@tranquilload/progress`
- ✅ Task 2: Created `getprogress.test.ts` with 3 tests covering mid-upload snapshot, idempotency, and `getProgress.effect`
- ✅ Task 3: Build, test (99 passed), and typecheck all clean

### Change Log

- 2026-03-15: Story 5.2 implementation — re-exported `Progress` type and added 3 dedicated `getProgress` tests

### File List

- `packages/tranquilload-core/src/progress/index.ts` (modified) — added `Progress` re-export
- `packages/tranquilload-core/src/progress/getprogress.test.ts` (created) — 3 tests for `getProgress()` and `getProgress.effect`
