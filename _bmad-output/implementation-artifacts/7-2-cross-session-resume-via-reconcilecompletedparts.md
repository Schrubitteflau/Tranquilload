# Story 7.2: Cross-Session Resume via `reconcileCompletedParts`

Status: review

## Story

As a developer consuming the library,
I want to pass a `reconcileCompletedParts` callback to `uploadMultipart` that returns already-uploaded parts,
so that the library skips those parts and resumes only from where the previous session left off.

## Acceptance Criteria

1. **Given** `uploadMultipart({ ..., reconcileCompletedParts: () => Promise<CompletedPart[]> })` **When** the upload starts **Then** `reconcileCompletedParts` is called first and its result is used to skip already-completed parts **And** skipped parts emit `PartCompleted` events (with their original etag) without re-uploading.

2. **Given** `reconcileCompletedParts` returns an empty array **When** the upload starts **Then** all parts are uploaded from scratch — behavior identical to a fresh upload.

3. **Given** `reconcileCompletedParts` throws or rejects **When** the upload starts **Then** the error is normalized via `normalizeCallback` and the upload fails with `CompleteUploadError`.

4. **Given** no `reconcileCompletedParts` is provided **When** `uploadMultipart` is called **Then** all parts are uploaded without reconciliation — identical behavior to before this story.

5. **Given** a mix of reconciled and new parts **When** `completeUpload` is called **Then** it receives ALL parts (reconciled + freshly uploaded) with correct `partNumber`/`etag` pairs.

## Tasks / Subtasks

- [x] Task 1: Add `reconcileCompletedParts` to `UploadMultipartOptions` (AC: #1, #2, #4)
  - [x] Add optional field after `initiate` in the interface:
    ```ts
    readonly reconcileCompletedParts?: () =>
      | ReadonlyArray<CompletedPart>
      | Promise<ReadonlyArray<CompletedPart>>
      | Effect.Effect<ReadonlyArray<CompletedPart>, UploadError>
    ```

- [x] Task 2: Implement reconcile logic in `uploadMultipartEffect` (AC: #1, #2, #3, #4, #5)
  - [x] Destructure `reconcileCompletedParts` from `options` alongside existing fields
  - [x] Inside `Effect.gen` setup (BEFORE stream construction), resolve reconciled parts:
    ```ts
    const reconciledMap: Map<number, string> = reconcileCompletedParts
      ? new Map(
          (yield* normalizeCallback(reconcileCompletedParts).pipe(
            Effect.mapError((cause): UploadError => new CompleteUploadError(cause))
          )).map(p => [p.partNumber, p.etag])
        )
      : new Map()
    ```
  - [x] In `makeUploadOne`, add reconcile check at the top of `Effect.gen`:
    ```ts
    const reconciledEtag = reconciledMap.get(partNumber)
    if (reconciledEtag !== undefined) {
      const event: PartCompleted = {
        _tag: "PartCompleted" as const,
        partNumber,
        etag: reconciledEtag,
        bytesUploaded: chunk.length,
        timestamp: Date.now(),
      }
      yield* Ref.update(refParts, parts => [...parts, { partNumber, etag: reconciledEtag }])
      yield* Effect.sync(() => logger.log("info", `Part ${partNumber} skipped (reconciled)`))
      return event
    }
    // rest of upload logic unchanged
    ```

- [x] Task 3: Add tests to `upload-stream.test.ts` (AC: #1, #2, #3, #4, #5)
  - [x] Test: skipped parts emit `PartCompleted` with reconciled etag, `uploadPart` NOT called
  - [x] Test: `completeUpload` receives all parts (reconciled + new)
  - [x] Test: empty reconcile → all parts uploaded
  - [x] Test: `reconcileCompletedParts` throws → `CompleteUploadError`

- [x] Task 4: Triptyque build/test/typecheck (AC: all)
  - [x] `pnpm turbo build` — clean
  - [x] `pnpm turbo test` — all tests pass
  - [x] `pnpm turbo typecheck` — no errors

## Dev Notes

### Files to Touch

**Modify:**
1. `packages/tranquilload-core/src/multipart/upload-stream.ts` — add `reconcileCompletedParts` option + skip logic in `makeUploadOne`
2. `packages/tranquilload-core/src/multipart/upload-stream.test.ts` — add 4 tests

**Do NOT touch:**
- `packages/tranquilload-core/src/multipart/index.ts` — `MultipartPublicOptions extends UploadMultipartOptions`, so `reconcileCompletedParts` is automatically available in `uploadMultipart`. No changes needed.
- `packages/tranquilload-core/src/multipart/index.test.ts` — all reconcile logic is in `upload-stream.ts`; Dual API integration is automatic
- `packages/tranquilload-core/src/progress/upload-event.ts` — no new event types
- `packages/tranquilload-core/src/errors/upload-error.ts` — reuse `CompleteUploadError` for reconcile failure
- `packages/tranquilload-adapters/` — no adapter changes

### Implementation: `UploadMultipartOptions` in `upload-stream.ts`

Add after `initiate?`:

```ts
export interface UploadMultipartOptions {
  readonly stream: ReadableStream<Uint8Array>
  readonly chunkSize: number
  readonly uploadPart: (partNumber: number, chunk: Uint8Array) => string | Promise<string> | Effect.Effect<string, UploadError>
  readonly completeUpload: (uploadId: string, parts: ReadonlyArray<CompletedPart>) => void | Promise<void> | Effect.Effect<void, UploadError>
  readonly initiate?: () => { uploadId: string } | Promise<{ uploadId: string }> | Effect.Effect<{ uploadId: string }, UploadError>
  readonly reconcileCompletedParts?: () =>
    | ReadonlyArray<CompletedPart>
    | Promise<ReadonlyArray<CompletedPart>>
    | Effect.Effect<ReadonlyArray<CompletedPart>, UploadError>
  readonly maxConcurrency?: number
  readonly signal?: AbortSignal
  readonly retrySchedule?: Schedule.Schedule<unknown, PartUploadError>
  readonly circuitBreaker?: CircuitBreakerConfig
}
```

### Implementation: Setup in `uploadMultipartEffect`

Inside `Effect.gen(function* () { ... })` (the setup block for `Stream.unwrap`), add reconcile resolution AFTER creating Refs, BEFORE constructing `initiateStream`/`makeUploadOne`:

```ts
const {
  stream, chunkSize, uploadPart, completeUpload,
  initiate, reconcileCompletedParts,  // <-- add
  maxConcurrency = DEFAULT_MAX_CONCURRENCY, signal, retrySchedule = DEFAULT_RETRY_SCHEDULE,
} = options

return Stream.unwrap(
  Effect.gen(function* () {
    const logger = yield* LoggerService
    const semaphore = yield* Effect.makeSemaphore(maxConcurrency)
    const refParts = yield* Ref.make<CompletedPart[]>([])
    const refBytesUploaded = yield* Ref.make(0)
    const refUploadId = yield* Ref.make("")
    const breaker = options.circuitBreaker ? yield* makeCircuitBreaker(options.circuitBreaker) : null

    // Resolve reconciled parts before stream starts
    const reconciledMap: Map<number, string> = reconcileCompletedParts
      ? new Map(
          (yield* normalizeCallback(reconcileCompletedParts).pipe(
            Effect.mapError((cause): UploadError => new CompleteUploadError(cause))
          )).map(p => [p.partNumber, p.etag])
        )
      : new Map()

    // initiateStream — unchanged from 7.1
    const initiateStream: Stream.Stream<UploadEvent, UploadError, never> = initiate ? ... : Stream.empty

    const makeUploadOne = (partNumber: number, chunk: Uint8Array): Effect.Effect<PartCompleted, UploadError> =>
      Effect.gen(function* () {
        // NEW: check reconciled parts first
        const reconciledEtag = reconciledMap.get(partNumber)
        if (reconciledEtag !== undefined) {
          const event: PartCompleted = {
            _tag: "PartCompleted" as const,
            partNumber,
            etag: reconciledEtag,
            bytesUploaded: chunk.length,
            timestamp: Date.now(),
          }
          yield* Ref.update(refParts, parts => [...parts, { partNumber, etag: reconciledEtag }])
          yield* Effect.sync(() => logger.log("info", `Part ${partNumber} skipped (reconciled)`))
          return event
        }

        // UNCHANGED: existing upload logic with retry, circuit breaker, etc.
        const refAttempts = yield* Ref.make(0)
        // ...
      })

    // partsStream, finalEffect — UNCHANGED
    // Stream concatenation — UNCHANGED
  })
)
```

**Why `Map<number, string>` not a `Ref`:** It's set once before the stream, never mutated. Plain JS `Map` is idiomatic here. `reconciledMap.get(partNumber)` returns `undefined` if not found (safe for the `!== undefined` check).

**Why inside `Effect.gen` setup (not as a `reconcileStream`):** Running it in setup means it completes before any stream events emit. If reconciliation fails, the `Stream.unwrap` itself fails — clean error propagation. No separate stream concatenation needed.

**Why `CompleteUploadError` for reconcile failure:** Same semantic as `initiate`/`completeUpload` failures — the upload cannot proceed. Reusing existing error type avoids adding a new type to the union. The `cause` field gives full context.

### Tests to Add in `upload-stream.test.ts`

Add to the existing `describe("uploadMultipartEffect")` block. Import `CompleteUploadError` is already there (line 3).

```ts
it.effect("reconcileCompletedParts: skipped parts emit PartCompleted with reconciled etag, uploadPart not called for them", () =>
  Effect.gen(function* () {
    const uploadedPartNumbers: number[] = []

    const events = yield* run({
      stream: fromBytes(new Uint8Array(30).fill(1)), // 3 × 10-byte chunks
      chunkSize: 10,
      reconcileCompletedParts: () => [
        { partNumber: 1, etag: "etag-reconciled-1" },
        { partNumber: 2, etag: "etag-reconciled-2" },
      ],
      uploadPart: (n) => { uploadedPartNumbers.push(n); return `etag-fresh-${n}` },
      completeUpload: () => {},
    })

    // Only part 3 should be uploaded
    expect(uploadedPartNumbers).toEqual([3])

    const partEvents = events.filter(e => e._tag === "PartCompleted")
    expect(partEvents).toHaveLength(3)
    expect(partEvents.find(e => e._tag === "PartCompleted" && e.partNumber === 1)).toMatchObject({ partNumber: 1, etag: "etag-reconciled-1" })
    expect(partEvents.find(e => e._tag === "PartCompleted" && e.partNumber === 2)).toMatchObject({ partNumber: 2, etag: "etag-reconciled-2" })
    expect(partEvents.find(e => e._tag === "PartCompleted" && e.partNumber === 3)).toMatchObject({ partNumber: 3, etag: "etag-fresh-3" })
  })
)

it.effect("reconcileCompletedParts: completeUpload receives all parts (reconciled + new)", () =>
  Effect.gen(function* () {
    let receivedParts: CompletedPart[] = []

    yield* run({
      stream: fromBytes(new Uint8Array(20).fill(1)), // 2 × 10-byte chunks
      chunkSize: 10,
      reconcileCompletedParts: () => [{ partNumber: 1, etag: "etag-reconciled-1" }],
      uploadPart: () => "etag-fresh-2",
      completeUpload: (_uploadId, parts) => { receivedParts = [...parts] },
    })

    expect(receivedParts).toHaveLength(2)
    expect(receivedParts.find(p => p.partNumber === 1)).toMatchObject({ partNumber: 1, etag: "etag-reconciled-1" })
    expect(receivedParts.find(p => p.partNumber === 2)).toMatchObject({ partNumber: 2, etag: "etag-fresh-2" })
  })
)

it.effect("reconcileCompletedParts returns empty: all parts uploaded normally", () =>
  Effect.gen(function* () {
    const uploadedPartNumbers: number[] = []

    yield* run({
      stream: fromBytes(new Uint8Array(20).fill(1)),
      chunkSize: 10,
      reconcileCompletedParts: () => [],
      uploadPart: (n) => { uploadedPartNumbers.push(n); return `etag-${n}` },
      completeUpload: () => {},
    })

    expect(uploadedPartNumbers.sort()).toEqual([1, 2])
  })
)

it.effect("reconcileCompletedParts throws: fails with CompleteUploadError", () =>
  Effect.gen(function* () {
    const cause = new Error("reconcile failed")

    const result = yield* run({
      stream: fromBytes(new Uint8Array(10).fill(1)),
      chunkSize: 10,
      reconcileCompletedParts: () => { throw cause },
      uploadPart: () => "etag",
      completeUpload: () => {},
    }).pipe(Effect.flip)

    expect(result).toBeInstanceOf(CompleteUploadError)
    expect((result as CompleteUploadError).cause).toBe(cause)
  })
)
```

### Key Patterns from Story 7.1 to Follow

- **`normalizeCallback` for callbacks**: `normalizeCallback(reconcileCompletedParts)` — supports plain value, Promise, or Effect
- **Error wrapping**: `Effect.mapError((cause): UploadError => new CompleteUploadError(cause))` — reuse existing error type
- **Ref naming convention**: not needed here (using plain `Map`, not a Ref)
- **Effect.gen scope**: resolve reconcile inside `Effect.gen` (not module-level)
- **`satisfies` type annotation**: the `PartCompleted` event can use `satisfies PartCompleted` for type safety if needed

### Pitfall: `reconciledMap.get()` vs `Array.find()`

Use `Map.get(partNumber)` for O(1) lookup. Do NOT iterate the reconciled array in `makeUploadOne` — `makeUploadOne` is called concurrently for many parts.

### Pitfall: `bytesUploaded` for reconciled parts

Set `bytesUploaded: chunk.length` for reconciled `PartCompleted` events. The bytes still flow through `chunkStream` (we can't seek). This ensures `ProgressTick` accumulates total bytes correctly (the `Stream.flatMap` after `partsStream` increments `refBytesUploaded` for every `PartCompleted`, including reconciled ones).

### Pitfall: Part order in `refParts`

`refParts` accumulates in completion order (concurrent uploads). For reconciled parts with `concurrency: "unbounded"`, the reconcile check is fast (no I/O), so reconciled parts may appear first in `refParts`. This is fine — `completeUpload` receives them in arrival order, same as before. The server-side multipart completion API (S3, etc.) uses `partNumber` for ordering, not array order.

### Pitfall: Dual API — NO changes needed

`MultipartPublicOptions extends UploadMultipartOptions`. Adding `reconcileCompletedParts` to `UploadMultipartOptions` automatically makes it part of the `uploadMultipart` public API. The `uploadMultipart` function passes `...options` to `uploadMultipartEffect`. Zero changes to `index.ts`.

### Project Structure Notes

- **Package**: `@tranquilload/core` (`packages/tranquilload-core`)
- **All changes**: `src/multipart/upload-stream.ts` + `src/multipart/upload-stream.test.ts`
- **No new files** needed

### Triptyque obligatoire

`pnpm turbo build && pnpm turbo test && pnpm turbo typecheck` — les trois doivent passer avant de marquer la story done.

### References

- Epic 7 requirements: `_bmad-output/planning-artifacts/epics.md#Epic 7`
- Current `uploadMultipartEffect`: `packages/tranquilload-core/src/multipart/upload-stream.ts`
- Dual API entry point: `packages/tranquilload-core/src/multipart/index.ts`
- Story 7.1 (uploadId / initiate pattern): `_bmad-output/implementation-artifacts/7-1-upload-id-exposure-state-persistence-contract.md`
- `normalizeCallback` implementation: `packages/tranquilload-core/src/utils/normalize-callback.ts`
- Error types: `packages/tranquilload-core/src/errors/upload-error.ts`

## Dev Agent Record

### Agent Model Used

Claude Opus 4.6

### Debug Log References

None — clean implementation, no debugging needed.

### Completion Notes List

- Added optional `reconcileCompletedParts` callback to `UploadMultipartOptions` interface, supporting plain value, Promise, and Effect return types
- Implemented reconcile logic in `uploadMultipartEffect`: resolves reconciled parts into a `Map<number, string>` before stream construction, checks each part in `makeUploadOne` and skips upload for reconciled parts (emitting `PartCompleted` with original etag)
- Error handling: `reconcileCompletedParts` failures are normalized via `normalizeCallback` and wrapped in `CompleteUploadError`
- Added 4 targeted tests covering all ACs: skip + event emission, completeUpload receives all parts, empty reconcile, error propagation
- Triptyque build/test/typecheck all pass. 112 tests, 0 failures.
- No changes to `index.ts` needed — `MultipartPublicOptions extends UploadMultipartOptions` propagates the new field automatically

### Change Log

- 2026-03-30: Implemented cross-session resume via `reconcileCompletedParts` callback (Story 7.2)

### File List

- `packages/tranquilload-core/src/multipart/upload-stream.ts` — modified (interface + reconcile logic)
- `packages/tranquilload-core/src/multipart/upload-stream.test.ts` — modified (4 new tests)
