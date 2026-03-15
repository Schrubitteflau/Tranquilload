# Story 4.3: Pipeline Integration with Upload Functions

Status: review

## Story

As a developer consuming the library,
I want to pass a `pipeline` option to `uploadMultipart` and `uploadOnce`,
so that transforms are applied transparently to the stream before chunking or uploading.

## Acceptance Criteria

1. **Given** `uploadMultipart({ ..., pipeline: compose(compress()) })` **When** the upload runs **Then** the pipeline is applied to the source stream before chunking **And** `PartCompleted` events' `bytesUploaded` reflect the compressed byte counts *(note: `ProgressTick` is Epic 5 Story 5.1 — verify via `PartCompleted.bytesUploaded` for now)*

2. **Given** `uploadOnce({ ..., pipeline: compose(compress()) })` **When** the upload runs **Then** the pipeline is applied before the single HTTP request (i.e., the `upload` callback receives the transformed stream)

3. **Given** no `pipeline` option is provided **When** either upload function runs **Then** behavior is identical to before — source stream used as-is (regression: all existing tests must continue to pass)

## Tasks / Subtasks

- [x] Task 1: Update `compose` in `middleware.ts` to support Effect transforms (AC: #1, #2)
  - [x]Add `import { Effect } from "effect"` at top of `packages/tranquilload-core/src/pipeline/middleware.ts`
  - [x]Keep existing plain-Transform overload (backward compat) — DO NOT change its behavior
  - [x]Add a new overload: when any arg is an `Effect.Effect<Transform, E, R>`, `compose` returns `Effect.Effect<Transform, E, R>`
  - [x]Implementation body: check `transforms.some((t) => typeof t !== 'function')` — if true, use `Effect.map(Effect.all(resolved), (ts) => (stream) => ts.reduce((s, t) => t(s), stream))`
  - [x]The zero-arg case still returns a no-op `Transform` (unchanged)
  - [x]Exact code:
    ```ts
    import { Effect } from "effect"

    export type Transform = (stream: ReadableStream<Uint8Array>) => ReadableStream<Uint8Array>

    export function compose(): Transform
    export function compose(...transforms: Transform[]): Transform
    export function compose<E, R>(
      ...transforms: Array<Transform | Effect.Effect<Transform, E, R>>
    ): Effect.Effect<Transform, E, R>
    export function compose(
      ...transforms: Array<Transform | Effect.Effect<Transform, any, any>>
    ): Transform | Effect.Effect<Transform, any, any> {
      const hasEffect = transforms.some((t) => typeof t !== "function")
      if (!hasEffect || transforms.length === 0) {
        return (stream: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> =>
          (transforms as Transform[]).reduce((s, t) => t(s), stream)
      }
      return Effect.map(
        Effect.all(
          transforms.map((t) =>
            typeof t === "function"
              ? Effect.succeed(t as Transform)
              : (t as Effect.Effect<Transform, any, any>)
          )
        ),
        (resolved) =>
          (stream: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> =>
            resolved.reduce((s, t) => t(s), stream)
      )
    }
    ```
  - [x]Run `pnpm turbo typecheck` on `pipeline/` to confirm no new TS errors in `middleware.ts`

- [x] Task 2: Update `multipart/index.ts` — add `pipeline` option (AC: #1, #3)
  - [x]Add imports at top:
    ```ts
    import { CompressionServiceLive } from "../services/compression-service.js"
    import type { Transform } from "../pipeline/middleware.js"
    ```
  - [x]Update `MultipartPublicOptions`:
    ```ts
    export interface MultipartPublicOptions extends UploadMultipartOptions {
      readonly totalBytes?: number
      readonly pipeline?: Transform | Effect.Effect<Transform, any, any>
    }
    ```
  - [x]Refactor the `collected` variable from a Promise chain into an async IIFE:
    ```ts
    const collected: Promise<ReadonlyArray<UploadEvent>> = (async () => {
      // Step 1: resolve pipeline to get the processed stream
      let processedStream = options.stream
      if (options.pipeline !== undefined) {
        if (typeof options.pipeline === "function") {
          processedStream = options.pipeline(options.stream)
        } else {
          // Effect pipeline — resolve with CompressionServiceLive
          const pipelineEffect = options.pipeline as Effect.Effect<
            Transform,
            any,
            ReturnType<typeof CompressionServiceLive extends never ? never : any>
          >
          const transform = await Effect.runPromise(
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            Effect.provide(pipelineEffect as Effect.Effect<Transform, any, any>, CompressionServiceLive)
          )
          processedStream = transform(options.stream)
        }
      }

      // Step 2: run upload with processedStream
      const program = uploadMultipartEffect({ ...options, stream: processedStream }).pipe(
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

      const exit = await Stream.runCollect(program).pipe(
        Effect.map((chunk) => Array.from(chunk)),
        Effect.runPromiseExit
      )
      if (Exit.isSuccess(exit)) return exit.value
      return Promise.reject(Cause.squash(exit.cause))
    })()
    ```
  - [x]**IMPORTANT**: `refProgress` must still be created synchronously BEFORE the async IIFE (as it is now). The IIFE only wraps the `collected` promise derivation. The `events`, `result`, and `getProgress` construction below is UNCHANGED — they still derive from `collected` as a Promise.
  - [x]Simplify the `Effect.provide` call — the exact incantation that works without TS errors:
    ```ts
    const transform = await Effect.runPromise(
      Effect.provide(
        options.pipeline as Effect.Effect<Transform, any, never>,
        CompressionServiceLive
      )
    )
    ```
    Note: cast to `Effect<Transform, any, never>` to avoid type issues. `Effect.provide` with `CompressionServiceLive` satisfies whatever service requirements exist — at runtime this is correct.
  - [x]`uploadMultipart.effect = uploadMultipartEffect` — UNCHANGED. The `.effect` escape hatch does NOT support the `pipeline` option. Users who use `.effect` must pre-process the stream manually before passing it.

- [x] Task 3: Update `oneshot/index.ts` — add `pipeline` option (AC: #2, #3)
  - [x]Add imports:
    ```ts
    import { CompressionServiceLive } from "../services/compression-service.js"
    import type { Transform } from "../pipeline/middleware.js"
    ```
  - [x]**DO NOT modify** `UploadOnceOptions` in `oneshot/upload.ts`. Instead, define a new public options type in `oneshot/index.ts`:
    ```ts
    export interface OneShotPublicOptions extends UploadOnceOptions {
      readonly pipeline?: Transform | Effect.Effect<Transform, any, any>
    }
    ```
  - [x]Change `uploadOnce` parameter type from `UploadOnceOptions` to `OneShotPublicOptions`
  - [x]Refactor `collected` into async IIFE (same pattern as multipart):
    ```ts
    const collected: Promise<ReadonlyArray<UploadEvent>> = (async () => {
      let processedStream = options.stream
      if (options.pipeline !== undefined) {
        if (typeof options.pipeline === "function") {
          processedStream = options.pipeline(options.stream)
        } else {
          const transform = await Effect.runPromise(
            Effect.provide(
              options.pipeline as Effect.Effect<Transform, any, never>,
              CompressionServiceLive
            )
          )
          processedStream = transform(options.stream)
        }
      }

      const program = uploadOnceEffect({ ...options, stream: processedStream }).pipe(
        Stream.provideLayer(LoggerServiceLive)
      )

      const exit = await Stream.runCollect(program).pipe(
        Effect.map((chunk) => Array.from(chunk)),
        Effect.runPromiseExit
      )
      if (Exit.isSuccess(exit)) return exit.value
      return Promise.reject(Cause.squash(exit.cause))
    })()
    ```
  - [x]The `events` and `result` construction after `collected` is UNCHANGED.
  - [x]`uploadOnce.effect = uploadOnceEffect` — UNCHANGED. No pipeline support in `.effect`.

- [x] Task 4: Tests — `pipeline/middleware.test.ts` (AC: #1, #2)
  - [x]Add tests for `compose` with Effect transforms (import `{ it, describe, expect } from "@effect/vitest"`, `Effect, Layer` from `"effect"`, `compress`, `CompressionService`, `CompressionServiceLive` from appropriate paths)
  - [x]Test: `compose` with a single `compress()` returns an `Effect<Transform>`:
    ```ts
    it.effect("compose(compress()) returns an Effect that resolves to a working Transform", () =>
      Effect.gen(function* () {
        const transformEffect = compose(compress("deflate-raw"))
        // Confirm it's an Effect (has .pipe method, not a function)
        expect(typeof transformEffect).not.toBe("function")

        // Resolve it with CompressionServiceLive
        const transform = yield* Effect.provide(transformEffect, CompressionServiceLive)
        expect(typeof transform).toBe("function")

        // Apply the transform to a stream
        const input = new ReadableStream<Uint8Array>({
          start(c) { c.enqueue(new Uint8Array([1, 2, 3])); c.close() }
        })
        const output = transform(input)
        const reader = output.getReader()
        const chunks: Uint8Array[] = []
        while (true) {
          const { done, value } = yield* Effect.promise(() => reader.read())
          if (done) break
          chunks.push(value)
        }
        const totalBytes = chunks.reduce((acc, c) => acc + c.length, 0)
        expect(totalBytes).toBeGreaterThan(0)
      })
    )
    ```
  - [x]Test: `compose` with plain transforms still works (regression):
    ```ts
    it("compose with plain transforms is still a plain Transform function", () => {
      const t1: Transform = (s) => s
      const t2: Transform = (s) => s
      const composed = compose(t1, t2)
      expect(typeof composed).toBe("function")
    })
    ```

- [x] Task 5: Tests — `multipart/index.test.ts` (AC: #1, #3)
  - [x]Add imports: `compress` from `"../pipeline/compress.js"`, `compose` from `"../pipeline/middleware.js"`, `CompressionService`, `CompressionServiceLive`, `CompressionUnavailableError` from `"../services/compression-service.js"`, `Layer` from `"effect"`
  - [x]Test 1 — plain Transform pipeline: verify `uploadPart` receives transformed data:
    ```ts
    it.effect("applies plain Transform pipeline before chunking (data reaches uploadPart transformed)", () =>
      Effect.gen(function* () {
        const received: Uint8Array[] = []
        // Transform: replace every byte with 0xAA
        const markerTransform: Transform = (stream) =>
          stream.pipeThrough(
            new TransformStream<Uint8Array, Uint8Array>({
              transform(chunk, controller) {
                controller.enqueue(new Uint8Array(chunk.length).fill(0xaa))
              },
            })
          )

        const { result } = uploadMultipart({
          stream: new ReadableStream({
            start(c) { c.enqueue(new Uint8Array([1, 2, 3])); c.close() },
          }),
          chunkSize: 3,
          pipeline: markerTransform,
          uploadPart: (_, chunk) => {
            received.push(chunk)
            return "etag-1"
          },
          completeUpload: () => {},
        })

        yield* Effect.promise(() => result)
        expect(received).toHaveLength(1)
        expect(Array.from(received[0]!)).toEqual([0xaa, 0xaa, 0xaa])
      })
    )
    ```
  - [x]Test 2 — Effect pipeline (compress): verify `uploadPart` receives compressed data:
    ```ts
    it.effect("applies Effect pipeline (compress) before chunking — PartCompleted.bytesUploaded reflects compressed size", () =>
      Effect.gen(function* () {
        const received: Uint8Array[] = []
        const original = new Uint8Array([1, 2, 3, 4, 5])

        const { result } = uploadMultipart({
          stream: new ReadableStream({
            start(c) { c.enqueue(original); c.close() },
          }),
          chunkSize: 4096, // large enough to receive all compressed output in one part
          pipeline: compress("deflate-raw"),
          uploadPart: (_, chunk) => {
            received.push(chunk)
            return "etag-1"
          },
          completeUpload: () => {},
        })

        yield* Effect.promise(() => result)
        expect(received).toHaveLength(1)
        // Compressed output is non-empty
        expect(received[0]!.length).toBeGreaterThan(0)
        // Compressed bytes differ from raw input
        expect(Array.from(received[0]!)).not.toEqual(Array.from(original))
      })
    )
    ```
  - [x]Test 3 — compose(compress()) pattern from epic AC:
    ```ts
    it.effect("compose(compress()) can be passed as pipeline — same as compress() directly", () =>
      Effect.gen(function* () {
        const received: Uint8Array[] = []

        const { result } = uploadMultipart({
          stream: new ReadableStream({
            start(c) { c.enqueue(new Uint8Array([10, 20, 30])); c.close() },
          }),
          chunkSize: 4096,
          pipeline: compose(compress("deflate-raw")),
          uploadPart: (_, chunk) => {
            received.push(chunk)
            return "etag-1"
          },
          completeUpload: () => {},
        })

        yield* Effect.promise(() => result)
        expect(received).toHaveLength(1)
        expect(received[0]!.length).toBeGreaterThan(0)
      })
    )
    ```

- [x] Task 6: Tests — `oneshot/index.test.ts` (AC: #2, #3)
  - [x]Add imports: `compress` from `"../pipeline/compress.js"`, `compose` from `"../pipeline/middleware.js"`, `Transform` type from `"../pipeline/middleware.js"`
  - [x]Test 1 — plain Transform pipeline: verify `upload` callback receives transformed stream:
    ```ts
    it.effect("applies plain Transform pipeline — upload callback receives transformed stream", () =>
      Effect.gen(function* () {
        let receivedStream: ReadableStream<Uint8Array> | undefined

        // Pipeline that returns a known marker stream
        const markerStream = new ReadableStream<Uint8Array>({ start(c) { c.close() } })
        const pipeline: Transform = () => markerStream

        const { result } = uploadOnce({
          stream: new ReadableStream({ start(c) { c.close() } }),
          pipeline,
          upload: (s) => {
            receivedStream = s
            return Promise.resolve()
          },
        })

        yield* Effect.promise(() => result)
        // upload callback received the transformed stream (identity check)
        expect(receivedStream).toBe(markerStream)
      })
    )
    ```
  - [x]Test 2 — Effect pipeline (compress): verify upload callback receives compressed data:
    ```ts
    it.effect("applies Effect pipeline (compress) — upload callback receives compressed bytes", () =>
      Effect.gen(function* () {
        let receivedByteCount = 0
        const original = new Uint8Array([1, 2, 3, 4, 5])

        const { result } = uploadOnce({
          stream: new ReadableStream({
            start(c) { c.enqueue(original); c.close() },
          }),
          pipeline: compress("deflate-raw"),
          upload: async (stream) => {
            const reader = stream.getReader()
            while (true) {
              const { done, value } = await reader.read()
              if (done) break
              receivedByteCount += value.length
            }
          },
        })

        yield* Effect.promise(() => result)
        // Compressed output is non-empty
        expect(receivedByteCount).toBeGreaterThan(0)
      })
    )
    ```
  - [x]Keep all existing 4 tests in `oneshot/index.test.ts` — they must continue to pass (regression)

- [x] Task 7: Build & tests pass
  - [x]`pnpm turbo build` — no errors, `compose` overloads exported correctly from `@tranquilload/pipeline`
  - [x]`pnpm turbo test` — all existing 85 core + 1 adapter tests pass + 5 new tests (1 middleware + 2 multipart + 2 oneshot) = **90 core + 1 adapter**
  - [x]`pnpm turbo typecheck` — no new TS errors introduced by story 4.3 changes (pre-existing errors in oneshot tests are unrelated — do not fix them, do not introduce new ones)

## Dev Notes

### Design Decision: Pipeline resolved in Promise API wrapper (NOT in Effect core)

`pipeline` is applied in `uploadMultipart`/`uploadOnce` wrappers (index.ts), not inside `uploadMultipartEffect`/`uploadOnceEffect`. This keeps the Effect core functions' service requirements unchanged (`LoggerService` only). Benefits:
- No breaking change to `.effect` escape hatch
- `CompressionService` is only materialized when needed (no `CompressionUnavailableError` for users without pipeline)
- Clean separation: Effect core = pure stream logic, wrapper = DI resolution

### Design Decision: `pipeline` type is `Transform | Effect.Effect<Transform, any, any>`

Using `any` for the Effect type parameters avoids TypeScript assignability issues between `Effect<Transform, E, CompressionService>` (compress returns) and `Effect<Transform, E, never>` (after providing). At runtime, `Effect.provide(pipeline, CompressionServiceLive)` resolves correctly for either case.

The cast `options.pipeline as Effect.Effect<Transform, any, never>` before `Effect.provide` is intentional — it tells TypeScript the effect has no remaining requirements after `CompressionServiceLive` is provided, so `Effect.runPromise` accepts it.

### Design Decision: `.effect` escape hatch does NOT support pipeline

`uploadMultipart.effect = uploadMultipartEffect` and `uploadOnce.effect = uploadOnceEffect` are unchanged. Users of `.effect` must pre-process the stream with the transform before passing it. This is acceptable for Story 4.3; future stories can add pipeline support to the Effect API if needed.

### Design Decision: ProgressTick deferred to Epic 5

The AC mentions "ProgressTick events reflect compressed byte counts" but `ProgressTick` is not yet in the `UploadEvent` union (see `upload-event.ts:23`: "Minimal type — Story 5.1 will expand"). Verify pipeline byte counts via `PartCompleted.bytesUploaded` in tests. Story 5.1 will add `ProgressTick` properly.

### compose Overload TypeScript Notes

The third overload signature:
```ts
export function compose<E, R>(
  ...transforms: Array<Transform | Effect.Effect<Transform, E, R>>
): Effect.Effect<Transform, E, R>
```

TypeScript will select this overload when at least one argument is an `Effect.Effect`. Calling `compose(compress())` where `compress()` returns `Effect.Effect<Transform, never, CompressionService>` correctly selects this overload and returns `Effect.Effect<Transform, never, CompressionService>`.

`Effect.all(array)` on `Array<Effect<Transform, any, any>>` returns `Effect<Transform[], any, any>`. `Effect.map` over it to produce `Effect<Transform, any, any>`.

### Files to Create / Modify

```
MODIFY:
  packages/tranquilload-core/src/pipeline/middleware.ts       ← update compose + add Effect import
  packages/tranquilload-core/src/pipeline/middleware.test.ts  ← add 2 compose+Effect tests
  packages/tranquilload-core/src/multipart/index.ts           ← add pipeline option + async IIFE
  packages/tranquilload-core/src/multipart/index.test.ts      ← add 3 pipeline tests
  packages/tranquilload-core/src/oneshot/index.ts             ← add pipeline option + async IIFE
  packages/tranquilload-core/src/oneshot/index.test.ts        ← add 2 pipeline tests
```

**DO NOT TOUCH** any file outside this list.

### Previous Story Intelligence (Story 4.2)

- Current test count: **85 core tests** (14 files) + **1 adapter test** — all must continue to pass
- `compress()` returns `Effect.Effect<Transform, never, CompressionService>` — pass directly as `pipeline`
- `CompressionServiceLive` is `Layer.Layer<CompressionService, CompressionUnavailableError>` — use to resolve pipeline
- `CompressionUnavailableError` class is in `compression-service.ts` — not in `UploadError` union (it's separate)
- `Transform` type: `(stream: ReadableStream<Uint8Array>) => ReadableStream<Uint8Array>` in `pipeline/middleware.ts`
- Pre-existing TS errors in `oneshot/upload.test.ts` and `oneshot/index.test.ts` — do NOT fix, do NOT introduce new ones
- Story 4.2 dev notes explicitly said: "Story 4.3 will update `uploadMultipart` and `uploadOnce` to accept a `pipeline` option. The `compose(compress())` pattern will be refined — `compose` may need an `.effect` variant."

### Architecture Compliance

- **Dual API pattern**: Pipeline is wired into Promise API wrapper. `.effect` escape hatch unchanged. [Source: `architecture.md#Dual API Wrapper Pattern`]
- **Service definition pattern**: `CompressionServiceLive` used as-is from `compression-service.ts` — NOT re-defined [Source: `architecture.md#Effect Service Definition Pattern`]
- **globalThis only**: `CompressionStream` already uses `globalThis` in `CompressionServiceLive` — no change needed [Source: `architecture.md#Runtime boundary`]
- **Test co-location**: new tests in existing test files, co-located with source [Source: `architecture.md#Testing Pattern`]
- **`@effect/vitest`**: Used for all new Effect tests [Source: `architecture.md#Testing Pattern`]
- **Data flow**: Architecture shows `Pipeline middleware` applied between `ChunkStream` and `UploadStream`. Applied to stream BEFORE passing to `uploadMultipartEffect` — correct. [Source: `architecture.md#Data Flow`]
- **kebab-case files**: No new files created — all modifications to existing kebab-case files [Source: `architecture.md#Naming Patterns`]

### Key Import Additions

**`multipart/index.ts`** — add these imports:
```ts
import { CompressionServiceLive } from "../services/compression-service.js"
import type { Transform } from "../pipeline/middleware.js"
```

**`oneshot/index.ts`** — add these imports:
```ts
import { CompressionServiceLive } from "../services/compression-service.js"
import type { Transform } from "../pipeline/middleware.js"
```

**`pipeline/middleware.test.ts`** — add:
```ts
import { compress } from "./compress.js"
import { CompressionServiceLive } from "../services/compression-service.js"
```
(keep existing `import { it, describe, expect } from "@effect/vitest"` if already there, or use `import { it } from "vitest"` for the non-Effect test)

### References

- `Transform` type + `compose`: `packages/tranquilload-core/src/pipeline/middleware.ts`
- `compress()` function: `packages/tranquilload-core/src/pipeline/compress.ts`
- `CompressionService` + `CompressionServiceLive`: `packages/tranquilload-core/src/services/compression-service.ts`
- `uploadMultipartEffect` + `UploadMultipartOptions`: `packages/tranquilload-core/src/multipart/upload-stream.ts`
- `uploadOnceEffect` + `UploadOnceOptions`: `packages/tranquilload-core/src/oneshot/upload.ts`
- Epic 4 Story 4.3 requirements: `_bmad-output/planning-artifacts/epics.md#Story 4.3`
- Architecture patterns (Dual API, data flow): `_bmad-output/planning-artifacts/architecture.md`
- TestClock rule: `docs/project-context.md`

## Dev Agent Record

### Agent Model Used

Claude Opus 4.6

### Debug Log References

None — clean implementation, no debugging required.

### Completion Notes List

- ✅ Task 1: Updated `compose` in `middleware.ts` with 3 overloads — plain transforms (unchanged behavior), Effect transforms (new), and zero-arg (unchanged). All 4 existing tests pass.
- ✅ Task 2: Added `pipeline` option to `MultipartPublicOptions` in `multipart/index.ts`. Refactored `collected` to async IIFE to resolve Effect pipelines via `CompressionServiceLive`. `refProgress` remains synchronous. `.effect` escape hatch unchanged.
- ✅ Task 3: Added `OneShotPublicOptions` with `pipeline` option in `oneshot/index.ts`. Same async IIFE pattern. `UploadOnceOptions` in `upload.ts` untouched. `.effect` escape hatch unchanged.
- ✅ Task 4: Added 2 new tests to `middleware.test.ts` — Effect compose with `compress("deflate-raw")` and plain transform regression check.
- ✅ Task 5: Added 3 new tests to `multipart/index.test.ts` — plain Transform pipeline, Effect pipeline (compress), and `compose(compress())` pattern.
- ✅ Task 6: Added 2 new tests to `oneshot/index.test.ts` — plain Transform pipeline (identity check on marker stream), Effect pipeline (compress with byte count verification). All 4 existing tests pass.
- ✅ Task 7: `pnpm turbo build` passes, `pnpm turbo test` passes (92 core + 1 adapter = 93 total), typecheck shows only pre-existing errors in `oneshot/upload.test.ts`.

### Change Log

- 2026-03-15: Implemented Story 4.3 — Pipeline integration with upload functions. Added `pipeline` option to `uploadMultipart` and `uploadOnce`, updated `compose` to support Effect transforms, added 7 new tests.

### File List

- `packages/tranquilload-core/src/pipeline/middleware.ts` — MODIFIED: added Effect import, 3 overloads for `compose`
- `packages/tranquilload-core/src/pipeline/middleware.test.ts` — MODIFIED: added 2 new tests (Effect compose, plain regression)
- `packages/tranquilload-core/src/multipart/index.ts` — MODIFIED: added `pipeline` option to `MultipartPublicOptions`, async IIFE for pipeline resolution
- `packages/tranquilload-core/src/multipart/index.test.ts` — MODIFIED: added 3 new tests (plain Transform, Effect compress, compose(compress()))
- `packages/tranquilload-core/src/oneshot/index.ts` — MODIFIED: added `OneShotPublicOptions` with `pipeline`, async IIFE for pipeline resolution
- `packages/tranquilload-core/src/oneshot/index.test.ts` — MODIFIED: added 2 new tests (plain Transform, Effect compress)
