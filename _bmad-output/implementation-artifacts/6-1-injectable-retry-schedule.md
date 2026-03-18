# Story 6.1: Injectable Retry Schedule

Status: done

## Story

As a developer consuming the library,
I want to pass a custom `Effect.Schedule` as a `retrySchedule` option to `uploadMultipart`,
so that I can define my own retry policy (exponential backoff, jitter, max attempts) per deployment context.

## Acceptance Criteria

1. **Given** `uploadMultipart({ ..., retrySchedule: Schedule.exponential("100 millis").pipe(Schedule.upTo("30 seconds")) })` **When** a part fails **Then** retries follow the provided schedule exactly **And** once the schedule is exhausted, the part fails with `MaxRetriesExceededError`.

2. **Given** no `retrySchedule` is provided **When** a part fails **Then** the default schedule is used (3 total attempts: 1 initial + 2 retries with exponential backoff) **And** behavior is consistent with previous epics.

3. **Given** different error types (`PresignedUrlError` vs `PartUploadError`) **When** a retry policy is evaluated **Then** the schedule can differentiate by error type via Effect's typed error channel (e.g., `Schedule.whileInput` predicate on `err.cause`).

## Tasks / Subtasks

- [x] Task 1: Write tests for default schedule behavior (AC: #2)
  - [x] Test: no `retrySchedule` option → 3 total attempts (1 initial + 2 retries)
  - [x] Test: after 3 failures with default schedule → `MaxRetriesExceededError`

- [x] Task 2: Write test for error type differentiation via `Schedule.whileInput` (AC: #3)
  - [x] Test: schedule that only retries `PartUploadError` (skips retry when error wraps a `PresignedUrlError`) — fails with `PartUploadError` on first attempt for PresignedUrlError-type failures

- [x] Task 3: Build, test, typecheck (AC: all)
  - [x] `pnpm turbo build` — clean
  - [x] `pnpm turbo test` — all tests pass
  - [x] `pnpm turbo typecheck` — no errors

## Dev Notes

### Current State — Implementation Already Complete, Tests Partially Covered

**`retrySchedule` is already implemented** in `packages/tranquilload-core/src/multipart/upload-stream.ts`.

**Existing implementation in `upload-stream.ts`:**

```ts
// UploadMultipartOptions (line 28):
readonly retrySchedule?: Schedule.Schedule<unknown, PartUploadError>

// DEFAULT_RETRY_SCHEDULE (line 35-37):
const DEFAULT_RETRY_SCHEDULE = Schedule.exponential("100 millis").pipe(
  Schedule.compose(Schedule.recurs(2))
)
// → 3 total attempts: 1 initial + 2 retries

// Used at line 49 (destructuring):
retrySchedule = DEFAULT_RETRY_SCHEDULE,

// Used at line 79:
const etag = yield* Effect.retry(single, retrySchedule).pipe(
  Effect.catchAll(err =>
    Effect.gen(function* () {
      const totalAttempts = yield* Ref.get(refAttempts)
      if (totalAttempts <= 1) {
        return yield* Effect.fail(err)          // single attempt → PartUploadError
      }
      return yield* Effect.fail(
        new MaxRetriesExceededError(partNumber, totalAttempts, err.cause)
      )
    })
  )
)
```

**Critical: error wrapping before retry.** `uploadPart` callback errors are wrapped in `PartUploadError` BEFORE reaching `Effect.retry`:
```ts
// line 72-76 in upload-stream.ts:
return yield* normalizeCallback(() => uploadPart(partNumber, chunk)).pipe(
  Effect.mapError(
    (cause): PartUploadError => new PartUploadError(partNumber, attempt, cause)
  )
)
```
This means the `retrySchedule` always receives a `PartUploadError`. To differentiate by original error type (AC3), use `Schedule.whileInput((err: PartUploadError) => !(err.cause instanceof PresignedUrlError))` — the original error is accessible via `err.cause`.

**`retrySchedule` is exposed via the public API.** `MultipartPublicOptions extends UploadMultipartOptions` in `multipart/index.ts` line 16, so `retrySchedule` is already accessible from the Promise API `uploadMultipart(...)`.

**Existing test coverage** in `packages/tranquilload-core/src/multipart/upload-stream.test.ts`:
- Line 76-96: custom `Schedule.recurs(2)` → retries until success ✅
- Line 98-113: `Schedule.recurs(0)` → no retries → `PartUploadError` ✅
- Line 116-132: `Schedule.recurs(1)` → exhausted → `MaxRetriesExceededError` ✅

**What is MISSING:**
1. Test for **default schedule** (no `retrySchedule` → 3 attempts) — not tested with explicit attempt count assertion
2. Test for **error type differentiation** (AC3) via `Schedule.whileInput`

### Task 1 & 2: Test File to Modify

Add the following tests to `packages/tranquilload-core/src/multipart/upload-stream.test.ts` (inside the existing `describe("uploadMultipartEffect")` block):

```ts
it.effect("default schedule retries 3 total attempts (1 initial + 2 retries)", () =>
  Effect.gen(function* () {
    const refAttempts = yield* Ref.make(0)

    const result = yield* run({
      stream: fromBytes(new Uint8Array(10).fill(1)),
      chunkSize: 10,
      // No retrySchedule → DEFAULT_RETRY_SCHEDULE = recurs(2) = 3 total
      uploadPart: () => Effect.gen(function* () {
        yield* Ref.update(refAttempts, n => n + 1)
        return yield* Effect.fail(new PartUploadError(1, 1, new Error("permanent")) as never)
      }) as Effect.Effect<string, PartUploadError>,
      completeUpload: () => {},
    }).pipe(Effect.flip)

    // 3 total attempts: 1 initial + 2 retries
    expect(yield* Ref.get(refAttempts)).toBe(3)
    expect(result).toBeInstanceOf(MaxRetriesExceededError)
    expect((result as MaxRetriesExceededError).totalAttempts).toBe(3)
  })
)

it.effect("Schedule.whileInput allows differentiating by original error type (AC3)", () =>
  Effect.gen(function* () {
    const refAttempts = yield* Ref.make(0)

    // Schedule that only retries when the cause is NOT a PresignedUrlError
    // PartUploadError.cause holds the original error — inspect it to differentiate
    const scheduleNoRetryForPresigned = Schedule.whileInput(
      Schedule.recurs(2),
      (err: PartUploadError) => !(err.cause instanceof PresignedUrlError)
    )

    const result = yield* run({
      stream: fromBytes(new Uint8Array(10).fill(1)),
      chunkSize: 10,
      retrySchedule: scheduleNoRetryForPresigned,
      uploadPart: () => Effect.gen(function* () {
        yield* Ref.update(refAttempts, n => n + 1)
        // Simulate a PresignedUrlError as the underlying cause
        const cause = new PresignedUrlError(new Error("presigned URL expired"))
        return yield* Effect.fail(new PartUploadError(1, 1, cause) as never)
      }) as Effect.Effect<string, PartUploadError>,
      completeUpload: () => {},
    }).pipe(Effect.flip)

    // Schedule.whileInput returns false on first attempt → no retries → 1 attempt only
    expect(yield* Ref.get(refAttempts)).toBe(1)
    // 1 attempt only → PartUploadError (not MaxRetriesExceededError — because totalAttempts <= 1)
    expect(result).toBeInstanceOf(PartUploadError)
  })
)
```

**Import needed:** `PresignedUrlError` is already imported in the test file at line 4.

**`Schedule.whileInput` API:** Available in Effect's `Schedule` module. Signature: `Schedule.whileInput(schedule, predicate)` — stops the schedule when `predicate(input)` returns false. This is the correct API to use (not `Schedule.whileInputEffect`).

### Error Types Reference

```ts
// From packages/tranquilload-core/src/errors/upload-error.ts:
class PresignedUrlError extends Error {
  readonly _tag = "PresignedUrlError" as const
  constructor(override readonly cause: unknown) { ... }
}

class PartUploadError extends Error {
  readonly _tag = "PartUploadError" as const
  constructor(
    readonly partNumber: number,
    readonly attempt: number,
    override readonly cause: unknown
  ) { ... }
}

class MaxRetriesExceededError extends Error {
  readonly _tag = "MaxRetriesExceededError" as const
  constructor(
    readonly partNumber: number,
    readonly totalAttempts: number,
    override readonly cause: unknown
  ) { ... }
}
```

### Project Structure Notes

- **File to modify:** `packages/tranquilload-core/src/multipart/upload-stream.test.ts`
- **Do NOT modify** `upload-stream.ts` — `retrySchedule` is fully implemented
- **Do NOT modify** `multipart/index.ts` — `retrySchedule` is already exposed via `MultipartPublicOptions extends UploadMultipartOptions`
- **Add tests to the existing `describe("uploadMultipartEffect")` block**, not a new describe block
- **Test file location:** co-located with source, `*.test.ts` pattern

### Testing Pattern

```ts
import { describe, expect, it } from "@effect/vitest"
import { Effect, Ref, Schedule, Stream } from "effect"
import { ..., PresignedUrlError, MaxRetriesExceededError, PartUploadError } from "../errors/upload-error.js"
import { uploadMultipartEffect } from "./upload-stream.js"
```

Refer to existing test helpers at top of `upload-stream.test.ts`:
- `fromBytes(bytes: Uint8Array)` — wraps bytes into a `ReadableStream`
- `run(options)` — runs `uploadMultipartEffect` with `LoggerServiceLive` provided

### Verify `Schedule.whileInput` Availability

Before writing the AC3 test, confirm the API exists in the current Effect version:
```bash
grep -r "whileInput" effect/packages/effect/src/Schedule.ts | head -5
```
If `Schedule.whileInput` is not found, use `Schedule.check` instead:
```ts
// Alternative: Schedule.check — keep running while predicate is true
Schedule.check(Schedule.recurs(2), (input: PartUploadError, _output) =>
  !(input.cause instanceof PresignedUrlError)
)
```
Check `effect/docs/index.md` or `effect/packages/effect/src/Schedule.ts` for the exact API.

### References

- `retrySchedule` implementation: `packages/tranquilload-core/src/multipart/upload-stream.ts:28,35-37,49,79-91`
- `DEFAULT_RETRY_SCHEDULE`: `packages/tranquilload-core/src/multipart/upload-stream.ts:35-37`
- Error wrapping before retry: `packages/tranquilload-core/src/multipart/upload-stream.ts:72-76`
- `MultipartPublicOptions` extends `UploadMultipartOptions`: `packages/tranquilload-core/src/multipart/index.ts:16-19`
- Existing retry tests: `packages/tranquilload-core/src/multipart/upload-stream.test.ts:76-132`
- Error types: `packages/tranquilload-core/src/errors/upload-error.ts`
- `@effect/vitest` pattern: `_bmad-output/planning-artifacts/architecture.md#Testing Pattern`
- Effect Schedule API: `effect/packages/effect/src/Schedule.ts` (local clone)
- FR6 — Resilience: `_bmad-output/planning-artifacts/epics.md#NonFunctional Requirements`

## Dev Agent Record

### Agent Model Used

claude-opus-4-6

### Debug Log References

- `@effect/vitest` uses `TestClock` by default — `Schedule.exponential` (which has real time delays) requires `Effect.fork` + `TestClock.adjust` to advance time in tests. `Schedule.recurs` (no delays) works without this pattern.
- Story spec suggested providing `uploadPart` as Effect callback, but `normalizeCallback` + `mapError` double-wraps errors when using Effect callbacks. Using raw `throw` or `Promise.reject` callbacks (which go through `normalizeCallback`'s try/catch or tryPromise paths) avoids double-wrapping and accurately tests the real user scenario.

### Completion Notes List

- ✅ Task 1: Added test "default schedule retries 3 total attempts (1 initial + 2 retries)" — uses `Effect.fork` + `TestClock.adjust("500 millis")` to advance past exponential backoff delays. Asserts `attempts === 3`, `MaxRetriesExceededError`, `totalAttempts === 3`, and original cause preserved.
- ✅ Task 2: Added test "Schedule.whileInput allows differentiating by original error type" — uses `Schedule.whileInput(Schedule.recurs(2), predicate)` where predicate checks `err.cause instanceof PresignedUrlError`. Asserts 1 attempt only and `PartUploadError` (not `MaxRetriesExceededError`).
- ✅ Task 3: `pnpm turbo build test typecheck` — 6/6 tasks successful, 105 tests passed, 0 type errors.

### Change Log

- 2026-03-18: Added 2 tests to `upload-stream.test.ts` for default retry schedule behavior (AC2) and error type differentiation via `Schedule.whileInput` (AC3). Added `PresignedUrlError` import, `Fiber` and `TestClock` imports.

### File List

- `packages/tranquilload-core/src/multipart/upload-stream.test.ts` (modified)
