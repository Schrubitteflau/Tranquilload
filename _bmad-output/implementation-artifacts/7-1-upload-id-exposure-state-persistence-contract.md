# Story 7.1: Upload ID Exposure & State Persistence Contract

Status: review

## Story

As a developer consuming the library,
I want `uploadMultipart` to expose the `uploadId` immediately after initiation,
so that I can persist it client-side and use it to resume the upload in a future session.

## Acceptance Criteria

1. **Given** `uploadMultipart({ ..., initiate: () => Promise<{ uploadId: string }> })` **When** the initiation callback resolves **Then** `uploadId` is emitted as a new `UploadInitiated` event (first event in the stream) and accessible from the return value via `uploadId: Promise<string>` **And** the library makes no assumption about where `uploadId` is stored — persistence is user's responsibility.

2. **Given** the upload is interrupted mid-way (network loss, page reload) **When** the user retrieves the stored `uploadId` **Then** they have all the information needed to call `uploadMultipart` again with resumption options.

3. **Given** no `initiate` callback is provided **When** `uploadMultipart` runs **Then** behavior is identical to before — no `UploadInitiated` event is emitted and `uploadId` resolves to `""`.

## Tasks / Subtasks

- [x] Task 1: Add `UploadInitiated` event to `upload-event.ts` (AC: #1)
  - [x] Define `UploadInitiated` interface: `{ _tag: "UploadInitiated"; uploadId: string; timestamp: number }`
  - [x] Add `UploadInitiated` to the `UploadEvent` union
  - [x] Re-export `UploadInitiated` from `progress/index.ts`

- [x] Task 2: Update `UploadMultipartOptions` and `completeUpload` signature in `upload-stream.ts` (AC: #1, #2, #3)
  - [x] Add optional `initiate?: () => { uploadId: string } | Promise<{ uploadId: string }> | Effect.Effect<{ uploadId: string }, UploadError>` to `UploadMultipartOptions`
  - [x] Change `completeUpload` signature to `(uploadId: string, parts: ReadonlyArray<CompletedPart>) => void | Promise<void> | Effect.Effect<void, UploadError>` — BREAKING CHANGE, update all callers
  - [x] In `uploadMultipartEffect`: if `initiate` provided, call via `normalizeCallback`, store `uploadId` in a `Ref<string>`, emit `UploadInitiated` as first stream event
  - [x] Pass stored `uploadId` to `completeUpload` (and use in `UploadCompleted` event — currently hardcoded `""`)
  - [x] If no `initiate`, skip `UploadInitiated` event; `uploadId` stays `""`

- [x] Task 3: Update `multipart/index.ts` to expose `uploadId: Promise<string>` (AC: #1, #3)
  - [x] Add deferred resolver: `let resolveUploadId!: (id: string) => void` + `const uploadId = new Promise<string>(r => { resolveUploadId = r })`
  - [x] In `Stream.tap`: when `event._tag === "UploadInitiated"`, call `Effect.sync(() => resolveUploadId(event.uploadId))`
  - [x] Fallback: after `collected` settles, resolve `uploadId` to `""` if not already resolved (via `.finally(() => resolveUploadId(""))`)
  - [x] Add `uploadId` to the return object: `{ events, result, getProgress, uploadId }`
  - [x] Update `UploadMultipartOptions` re-export if needed

- [x] Task 4: Update tests to reflect breaking change (AC: all)
  - [x] `upload-stream.test.ts` line 31: update `completeUpload: (parts) => { receivedParts.push(...parts) }` → `completeUpload: (_uploadId, parts) => { receivedParts.push(...parts) }`
  - [x] `index.test.ts`: add test for `initiate` callback — verify `UploadInitiated` event in `events`, `uploadId` promise resolves to correct value, `UploadCompleted.uploadId` also contains the ID
  - [x] `index.test.ts`: add test for no `initiate` — verify no `UploadInitiated` event, `uploadId` resolves to `""`

- [x] Task 5: Triptyque build/test/typecheck (AC: all)
  - [x] `pnpm turbo build` — clean
  - [x] `pnpm turbo test` — all tests pass
  - [x] `pnpm turbo typecheck` — no errors

## Dev Notes

### Files to Touch

**Modify:**
1. `packages/tranquilload-core/src/progress/upload-event.ts` — add `UploadInitiated` type
2. `packages/tranquilload-core/src/progress/index.ts` — re-export `UploadInitiated`
3. `packages/tranquilload-core/src/multipart/upload-stream.ts` — `initiate` callback, `completeUpload` signature, emit `UploadInitiated`, pass `uploadId`
4. `packages/tranquilload-core/src/multipart/index.ts` — expose `uploadId: Promise<string>` in return
5. `packages/tranquilload-core/src/multipart/upload-stream.test.ts` — fix `completeUpload` call at line ~31
6. `packages/tranquilload-core/src/multipart/index.test.ts` — add `initiate` tests

**Do NOT touch:**
- `packages/tranquilload-adapters/` — no adapter changes in this story
- `packages/tranquilload-core/src/oneshot/` — one-shot upload is unaffected
- `packages/tranquilload-core/src/errors/upload-error.ts` — no new error types needed

### New Event Type

Add to `upload-event.ts`:

```ts
export interface UploadInitiated {
  readonly _tag: "UploadInitiated"
  readonly uploadId: string
  readonly timestamp: number
}
```

Update the union:
```ts
export type UploadEvent = UploadInitiated | UploadCompleted | PartCompleted | ProgressTick | CircuitOpen
```

Re-export from `progress/index.ts`:
```ts
export type { UploadEvent, UploadInitiated, PartCompleted, ProgressTick, UploadCompleted, CircuitOpen } from "./upload-event.js"
```

### Breaking Change: `completeUpload` Signature

**Before:**
```ts
readonly completeUpload: (
  parts: ReadonlyArray<CompletedPart>
) => void | Promise<void> | Effect.Effect<void, UploadError>
```

**After:**
```ts
readonly completeUpload: (
  uploadId: string,
  parts: ReadonlyArray<CompletedPart>
) => void | Promise<void> | Effect.Effect<void, UploadError>
```

**Impact on existing tests:** Any callback that uses the first param positionally as `parts` needs updating. Specifically `upload-stream.test.ts` line ~31:
```ts
// BEFORE (WILL TYPE-ERROR):
completeUpload: (parts) => { receivedParts.push(...parts) },

// AFTER:
completeUpload: (_uploadId, parts) => { receivedParts.push(...parts) },
```

Callbacks that ignore their params (`() => {}`) remain valid — TypeScript allows functions with fewer params.

**Internal call site update** in `upload-stream.ts` `finalEffect`:
```ts
yield* normalizeCallback(() => completeUpload(uploadId, parts)).pipe(...)
```

### Implementation in `upload-stream.ts`

Add `Ref` for uploadId, run `initiate` at the top of the stream:

```ts
export const uploadMultipartEffect = (
  options: UploadMultipartOptions
): Stream.Stream<UploadEvent, UploadError, LoggerService> => {
  const { ..., initiate } = options

  return Stream.unwrap(
    Effect.gen(function* () {
      const refUploadId = yield* Ref.make("")

      // If initiate provided: call it, store uploadId, emit UploadInitiated
      const initiateStream: Stream.Stream<UploadEvent, UploadError, never> = initiate
        ? Stream.fromEffect(
            normalizeCallback(initiate).pipe(
              Effect.mapError((cause): UploadError => new CompleteUploadError(cause)),
              Effect.flatMap(({ uploadId }) =>
                Ref.set(refUploadId, uploadId).pipe(
                  Effect.as({
                    _tag: "UploadInitiated" as const,
                    uploadId,
                    timestamp: Date.now(),
                  } satisfies UploadInitiated)
                )
              )
            )
          )
        : Stream.empty

      // In finalEffect, read uploadId from Ref and pass to completeUpload:
      const finalEffect = Effect.gen(function* () {
        const uploadId = yield* Ref.get(refUploadId)
        const parts = yield* Ref.get(refParts)
        yield* normalizeCallback(() => completeUpload(uploadId, parts)).pipe(...)
        return { _tag: "UploadCompleted", uploadId, totalParts: parts.length, timestamp: Date.now() } satisfies UploadCompleted
      })

      return Stream.concat(initiateStream, Stream.concat(partsStream, Stream.fromEffect(finalEffect)))
    })
  )
}
```

Note: `CompleteUploadError` is imported; use it to wrap `initiate` failures (no new error type needed — `initiate` failure = upload cannot start = same as `completeUpload` failure semantically).

### Implementation in `multipart/index.ts`

Add `uploadId` deferred to the return value:

```ts
// Deferred for uploadId — resolves as soon as UploadInitiated fires
let resolveUploadId!: (id: string) => void
const uploadIdPromise: Promise<string> = new Promise<string>((resolve) => {
  resolveUploadId = resolve
})

const collected: Promise<...> = (async () => {
  // ...
  const program = uploadMultipartEffect({ ...options, stream: processedStream }).pipe(
    Stream.tap((event) => {
      if (event._tag === "UploadInitiated") {
        return Effect.sync(() => resolveUploadId(event.uploadId))
      }
      if (event._tag === "PartCompleted") {
        return Ref.update(refProgress, ...)
      }
      return Effect.void
    }),
    Stream.provideLayer(LoggerServiceLive)
  )
  // ...
})()

// Fallback: if no initiate, uploadId resolves to "" after upload ends
collected.finally(() => resolveUploadId(""))

return { events, result, getProgress, uploadId: uploadIdPromise }
```

**Note on `finally`:** The `Promise.prototype.finally` callback runs regardless of success/failure. Since `resolveUploadId` is idempotent (Promise resolves only once), calling it from both `Stream.tap` (for real `uploadId`) and `finally` (as `""` fallback) is safe.

### Tests to Add in `index.test.ts`

```ts
it.effect("initiate callback: UploadInitiated event emitted first, uploadId resolves to correct value", () =>
  Effect.gen(function* () {
    const { result, events, uploadId } = uploadMultipart({
      stream: fromBytes(new Uint8Array(10).fill(1)),
      chunkSize: 10,
      initiate: () => Promise.resolve({ uploadId: "upload-abc-123" }),
      uploadPart: () => "etag-1",
      completeUpload: (uid, _parts) => {
        expect(uid).toBe("upload-abc-123")
      },
    })

    yield* Effect.promise(() => result)
    const resolvedId = yield* Effect.promise(() => uploadId)
    expect(resolvedId).toBe("upload-abc-123")

    const evts = yield* Effect.promise(() => readAllEvents(events))
    const initiatedEvent = evts.find(e => e._tag === "UploadInitiated")
    expect(initiatedEvent).toMatchObject({ _tag: "UploadInitiated", uploadId: "upload-abc-123" })
    expect(evts[0]!._tag).toBe("UploadInitiated")  // first event

    const completedEvent = evts.find(e => e._tag === "UploadCompleted")
    expect(completedEvent).toMatchObject({ _tag: "UploadCompleted", uploadId: "upload-abc-123" })
  })
)

it.effect("no initiate: no UploadInitiated event, uploadId resolves to empty string", () =>
  Effect.gen(function* () {
    const { result, events, uploadId } = uploadMultipart({
      stream: fromBytes(new Uint8Array(10).fill(1)),
      chunkSize: 10,
      uploadPart: () => "etag-1",
      completeUpload: () => {},
    })

    yield* Effect.promise(() => result)
    const resolvedId = yield* Effect.promise(() => uploadId)
    expect(resolvedId).toBe("")

    const evts = yield* Effect.promise(() => readAllEvents(events))
    expect(evts.find(e => e._tag === "UploadInitiated")).toBeUndefined()
  })
)
```

### `upload-stream.test.ts` — One Fix Required

Line ~31 (in `"emits PartCompleted per chunk and UploadCompleted at end"` test):
```ts
// Current (will type-error after signature change):
completeUpload: (parts) => { receivedParts.push(...parts) },

// Fix:
completeUpload: (_uploadId, parts) => { receivedParts.push(...parts) },
```

All other tests use `completeUpload: () => {}` — valid as-is (TypeScript allows fewer params in callbacks).

### Effect Patterns to Follow

- **`normalizeCallback` for `initiate`**: `normalizeCallback(initiate)` — supports `Promise`, plain value, or `Effect`
- **`Ref.make("")` for `refUploadId`**: initialize inside `Effect.gen` scope (not module-level)
- **Error wrapping for `initiate`**: use `Effect.mapError((cause): UploadError => new CompleteUploadError(cause))` — reuse existing error type
- **`Stream.empty` for no-initiate path**: `import { Stream } from "effect"` already imported

### Project Structure Notes

- **Package**: `@tranquilload/core` (`packages/tranquilload-core`)
- **Folder**: all changes in `src/multipart/` and `src/progress/`
- **Naming**: `UploadInitiated` (PascalCase), `refUploadId` (camelCase with `ref` prefix per architecture conventions)
- **Effect Ref naming convention**: `refUploadId` (prefix `ref` + camelCase field name) — matches existing `refParts`, `refBytesUploaded`

### Key Architecture Rules (from `architecture.md`)

- All callbacks normalized via `normalizeCallback` — never call `.then()` on `initiate` directly
- `Effect.Ref` initialized inside `Effect.gen` scope — not module-level
- New events MUST have `_tag` (literal) + `timestamp` (number) — `UploadInitiated` follows this
- `types` MUST come before `import`/`require` in package.json export map (no package.json change needed for this story)

### Triptyque obligatoire

`pnpm turbo build && pnpm turbo test && pnpm turbo typecheck` — les trois doivent passer avant de marquer la story done.

### References

- Epic 7 requirements: `_bmad-output/planning-artifacts/epics.md#Epic 7`
- FR7 definition: `_bmad-output/planning-artifacts/epics.md#FR7`
- Current multipart implementation: `packages/tranquilload-core/src/multipart/upload-stream.ts`
- Current Dual API entry point: `packages/tranquilload-core/src/multipart/index.ts`
- UploadEvent type system: `packages/tranquilload-core/src/progress/upload-event.ts`
- Architecture patterns: `_bmad-output/planning-artifacts/architecture.md#Implementation Patterns & Consistency Rules`
- Previous story (Epic 6 last): `_bmad-output/implementation-artifacts/6-3-optimal-part-size-calculator.md`

## Dev Agent Record

### Agent Model Used

Claude Opus 4.6

### Debug Log References

- Typecheck failure: `upload-event.test.ts` exhaustive `Match.tag` and `switch` patterns needed `UploadInitiated` variant — fixed by adding case to all 3 locations (switch, Match.tag, variants array).

### Completion Notes List

- Added `UploadInitiated` event type (`_tag`, `uploadId`, `timestamp`) to the `UploadEvent` union.
- Breaking change: `completeUpload` signature now takes `(uploadId: string, parts: ReadonlyArray<CompletedPart>)`.
- Added optional `initiate` callback to `UploadMultipartOptions` — supports plain value, Promise, or Effect.
- `uploadMultipartEffect` emits `UploadInitiated` as first stream event when `initiate` is provided; passes `uploadId` to `completeUpload` and `UploadCompleted`.
- Dual API (`uploadMultipart`) exposes `uploadId: Promise<string>` — resolves from `UploadInitiated` event or falls back to `""`.
- Updated existing test (`completeUpload` signature) and added 2 new integration tests (with/without `initiate`).
- Updated `upload-event.test.ts` exhaustive type checks for new variant.
- All 107 tests pass; typecheck clean; build clean.

### Change Log

- 2026-03-29: Implemented Story 7.1 — Upload ID exposure & state persistence contract

### File List

- `packages/tranquilload-core/src/progress/upload-event.ts` — added `UploadInitiated` interface and union member
- `packages/tranquilload-core/src/progress/index.ts` — re-exported `UploadInitiated`
- `packages/tranquilload-core/src/multipart/upload-stream.ts` — added `initiate` option, changed `completeUpload` signature, `refUploadId`, `initiateStream`
- `packages/tranquilload-core/src/multipart/index.ts` — exposed `uploadId: Promise<string>`, deferred resolver, `Stream.tap` for `UploadInitiated`
- `packages/tranquilload-core/src/multipart/upload-stream.test.ts` — fixed `completeUpload` call signature
- `packages/tranquilload-core/src/multipart/index.test.ts` — added 2 tests (initiate callback, no initiate)
- `packages/tranquilload-core/src/progress/upload-event.test.ts` — added `UploadInitiated` to exhaustive switch, Match.tag, and variants array
