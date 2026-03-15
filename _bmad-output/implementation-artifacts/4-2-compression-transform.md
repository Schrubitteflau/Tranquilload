# Story 4.2: Compression Transform

Status: review

## Story

As a developer consuming the library,
I want a `compress(algorithm?)` pipeline transform powered by `CompressionService`,
so that I can add client-side compression to any upload in one line, with the implementation swappable via dependency injection.

## Acceptance Criteria

1. **Given** the default `CompressionServiceLive` (using `globalThis.CompressionStream`) **When** `compress()` is used as a transform **Then** the output stream contains deflate-raw compressed bytes

2. **Given** a custom `CompressionService` Layer injected via `.effect` **When** `compress()` is called **Then** the custom implementation is used instead of `globalThis.CompressionStream`

3. **Given** `globalThis.CompressionStream` is absent (unsupported environment) **When** an `AbsentLayer` (failing with `CompressionUnavailableError`) is provided **Then** the Effect fails with typed `CompressionUnavailableError` — no unhandled exception

## Tasks / Subtasks

- [x] Task 0: Retro action items (Epic 3 retro, both action items) (AC: all)
  - [x] Create `docs/project-context.md` at monorepo root with TestClock rule:
    - Content: "@effect/vitest uses TestClock by default — `Effect.sleep` does **not** advance `Date.now()`. For real-time delays (e.g. `Date.now()` reads), use `Effect.realDelay()` instead of `Effect.sleep`. For concurrency timing, use `Effect.yieldNow()`."
  - [x] Note: No `_tag` task needed for this story — `CompressionUnavailableError` is not a new type and its `_tag` is already asserted in `compression-service.test.ts` line 28

- [x] Task 1: Update `CompressionService` interface — add `algorithm` param + cleanup cast (AC: #1, #2)
  - [x] In `packages/tranquilload-core/src/services/compression-service.ts`:
    - Update interface: `compress(stream: ReadableStream<Uint8Array>, algorithm: string): ReadableStream<Uint8Array>`
    - In `CompressionServiceLive`, extract the cast ONCE at the top of `Effect.gen`:
      ```ts
      const CS = cs as new (format: string) => TransformStream<Uint8Array, Uint8Array>
      ```
    - Since `"DOM"` is in `tsconfig.base.json` lib, `CompressionStream` is globally typed — **no cast needed at all**:
      ```ts
      compress: (stream, algorithm) =>
        stream.pipeThrough(new CompressionStream(algorithm as CompressionFormat))
      ```
    - Remove the old double-`globalThis` cast (lines 27-29 of original) entirely
    - The line 20 `{ CompressionStream?: unknown }` runtime check remains (still needed for environments without the API)
  - [x] Update `compression-service.test.ts` — the mock at line 50 needs `_algorithm: string` added to its signature to match the updated interface:
    ```ts
    compress: (stream: ReadableStream<Uint8Array>, _algorithm: string): ReadableStream<Uint8Array> => {
    ```

- [x] Task 2: Create `compress.ts` pipeline transform (AC: #1, #2, #3)
  - [x] Create `packages/tranquilload-core/src/pipeline/compress.ts`
  - [x] Import `Effect` from `"effect"`, `CompressionService` from `"../services/compression-service.js"`, `Transform` type from `"./middleware.js"`
  - [x] Export `compress` function:
    ```ts
    export const compress = (
      algorithm = "deflate-raw"
    ): Effect.Effect<Transform, never, CompressionService> =>
      Effect.map(CompressionService, (svc) => (stream) => svc.compress(stream, algorithm))
    ```
  - [x] Note: `compress()` returns `Effect<Transform, never, CompressionService>` — it reads the service from context and returns a plain `Transform`. No separate `.effect` property needed: the function IS already Effect-based. Story 4.3 will resolve this Effect within the upload Effect scope and apply the resulting Transform.

- [x] Task 3: Export from `pipeline/index.ts` (AC: #1, #2)
  - [x] Add to `packages/tranquilload-core/src/pipeline/index.ts`:
    ```ts
    export { compress } from "./compress.js"
    ```

- [x] Task 4: Tests in `compress.test.ts` (AC: #1, #2, #3)
  - [x] Create `packages/tranquilload-core/src/pipeline/compress.test.ts`
  - [x] Use `import { it, describe, expect } from "@effect/vitest"` (Effect involved)
  - [x] Import: `Effect, Layer, Cause` from `"effect"`, `compress` from `"./compress.js"`, `CompressionService`, `CompressionServiceLive`, `CompressionUnavailableError` from `"../services/compression-service.js"`
  - [x] Test 1 — Custom `TestCompressionService` (AC #2): create a Layer that records calls, assert custom impl is invoked:
    ```ts
    it.effect("uses custom CompressionService when provided", () =>
      Effect.gen(function* () {
        const marker = new ReadableStream<Uint8Array>()
        let receivedAlgorithm = ""
        const TestLayer = Layer.succeed(CompressionService, {
          compress: (stream, algorithm) => { receivedAlgorithm = algorithm; return marker }
        })
        const transform = yield* Effect.provide(compress("deflate-raw"), TestLayer)
        const input = new ReadableStream<Uint8Array>()
        const result = transform(input)
        expect(result).toBe(marker)
        expect(receivedAlgorithm).toBe("deflate-raw")
      })
    )
    ```
  - [x] Test 2 — `CompressionServiceLive` happy path (AC #1): Node 22 has `CompressionStream` — assert the transform produces compressed bytes:
    ```ts
    it.effect("CompressionServiceLive produces compressed bytes (deflate-raw)", () =>
      Effect.gen(function* () {
        const transform = yield* Effect.provide(compress("deflate-raw"), CompressionServiceLive)
        const input = new ReadableStream<Uint8Array>({
          start(ctrl) { ctrl.enqueue(new Uint8Array([1, 2, 3, 4])); ctrl.close() }
        })
        const compressed = transform(input)
        const reader = compressed.getReader()
        const chunks: Uint8Array[] = []
        while (true) {
          const { done, value } = yield* Effect.promise(() => reader.read())
          if (done) break
          chunks.push(value)
        }
        // Just verify some output was produced (deflate-raw compresses any input)
        const totalBytes = chunks.reduce((acc, c) => acc + c.length, 0)
        expect(totalBytes).toBeGreaterThan(0)
      })
    )
    ```
  - [x] Test 3 — `AbsentLayer` (AC #3): assert typed `CompressionUnavailableError`:
    ```ts
    it.effect("fails with typed CompressionUnavailableError when CompressionStream is absent", () =>
      Effect.gen(function* () {
        const AbsentLayer: Layer.Layer<CompressionService, CompressionUnavailableError> =
          Layer.effect(CompressionService, Effect.fail(new CompressionUnavailableError()))
        const result = yield* Effect.exit(
          Effect.provide(compress("deflate-raw"), AbsentLayer)
        )
        expect(result._tag).toBe("Failure")
        if (result._tag === "Failure") {
          const failure = Cause.failureOption(result.cause)
          expect(failure._tag).toBe("Some")
          if (failure._tag === "Some") {
            expect(failure.value).toBeInstanceOf(CompressionUnavailableError)
            expect(failure.value._tag).toBe("CompressionUnavailableError")
          }
        }
      })
    )
    ```

- [x] Task 5: Pending cleanup applied (validate in Task 1)
  - [x] Confirm `compression-service.ts` no longer has the double-`globalThis` cast at line 27
  - [x] Confirm `CS` is cast ONCE after the `undefined` check
  - [x] Memory note `project_compression_service_cleanup.md` is now resolved — update it accordingly

- [x] Task 6: Build & tests pass
  - [x] `pnpm turbo build` — no errors, `compress` exported from `@tranquilload/pipeline`
  - [x] `pnpm turbo test` — all 85 core (82 existing + 3 new) + 1 adapter tests pass
  - [ ] `pnpm turbo typecheck` — pre-existing TS errors in `oneshot/upload.test.ts` and `oneshot/index.test.ts` (not introduced by this story); no new TS errors from story 4.2 changes

## Dev Notes

### Design Decision: `compress()` returns `Effect<Transform, never, CompressionService>`

`compress(algorithm?)` is NOT a plain `Transform` — it requires `CompressionService` from Effect context. This is intentional: it allows custom compression implementations to be injected via the Effect Layer system.

**Why not a plain `Transform`?**
- AC #2 requires the implementation to be swappable via DI
- Returning `Effect<Transform, never, CompressionService>` keeps the typed error channel (CompressionService Layer can fail with `CompressionUnavailableError`) clean

**Story 4.3 integration note:** Story 4.3 will update `uploadMultipart` and `uploadOnce` to accept a `pipeline` option typed as `Effect<Transform, CompressionUnavailableError, CompressionService>`. The upload Effect scope provides `CompressionServiceLive` automatically. Users using the `.effect` escape hatch can inject custom services. The `compose(compress())` pattern in Story 4.3's epic AC will be refined — `compose` may need an `.effect` variant, or `pipeline` may accept the Effect directly.

### Files to Create / Modify

```
CREATE:
  packages/tranquilload-core/src/pipeline/compress.ts      ← compress() function
  packages/tranquilload-core/src/pipeline/compress.test.ts ← 3 @effect/vitest tests
  docs/project-context.md                                   ← retro action item #1

MODIFY:
  packages/tranquilload-core/src/services/compression-service.ts ← add algorithm param + cleanup cast
  packages/tranquilload-core/src/services/compression-service.test.ts ← update mock signature
  packages/tranquilload-core/src/pipeline/index.ts          ← add compress export
```

**DO NOT TOUCH** any file outside this list. This story is additive except for the cleanup.

### Cleanup: `compression-service.ts` — Replacing the double `globalThis` cast

Current (lines 27-29 original):
```ts
// ❌ Double-casts globalThis — redundant since cs is already captured
new (globalThis as { CompressionStream: new (format: string) => TransformStream<Uint8Array, Uint8Array> })
  .CompressionStream("deflate-raw")
```

New pattern — DOM lib (`"DOM"` in `tsconfig.base.json`) types `CompressionStream` globally, so **zero cast needed**:
```ts
// After the undefined check, use the DOM-typed global directly:
return {
  compress: (stream, algorithm) =>
    stream.pipeThrough(new CompressionStream(algorithm as CompressionFormat))
}
```

This fully eliminates the constructor cast. `CompressionFormat = "deflate" | "deflate-raw" | "gzip"` is the DOM type — `algorithm as CompressionFormat` is the only necessary cast (since we accept `string`).

### Updated `CompressionService` interface

```ts
export class CompressionService extends Context.Tag("@tranquilload/CompressionService")<
  CompressionService,
  { readonly compress: (stream: ReadableStream<Uint8Array>, algorithm: string) => ReadableStream<Uint8Array> }
>() {}
```

### `compress.ts` Complete Implementation

```ts
import { Effect } from "effect"
import { CompressionService } from "../services/compression-service.js"
import type { Transform } from "./middleware.js"

export const compress = (
  algorithm = "deflate-raw"
): Effect.Effect<Transform, never, CompressionService> =>
  Effect.map(CompressionService, (svc) => (stream) => svc.compress(stream, algorithm))
```

### TestClock Rule (retro action item #1)

Must create `docs/project-context.md` at monorepo root with this rule:

```markdown
# Project Context

## @effect/vitest — TestClock Gotcha

`@effect/vitest` uses `TestClock` by default in `it.effect(...)` tests.

- `Effect.sleep(duration)` **does NOT advance `Date.now()`**
- For tests involving real-time delays (e.g. circuit breaker `cooldown` that reads `Date.now()`): use `Effect.realDelay(duration)` instead of `Effect.sleep`
- For concurrency/scheduling tests: use `Effect.yieldNow()` to yield control without advancing real time
- For tests that must advance `TestClock`: use `TestClock.advance(duration)` explicitly
```

This rule was learned during Stories 3.2 and 3.4 (concurrency test timeout, circuit breaker date issue).

### `_tag` Assertion Policy (retro action item #2)

This story does NOT add new types to `UploadError` or `UploadEvent`. `CompressionUnavailableError` already exists from Epic 1 and its `_tag = "CompressionUnavailableError"` is already asserted in `compression-service.test.ts` (line 28).

Standing rule (apply in every future story that extends a discriminated union): **Always include an explicit `expect(value._tag).toBe("ExpectedTag")` assertion for every new union variant.**

### Previous Story Intelligence (Story 4.1)

- Current test count: **82 core tests** (13 files) + **1 adapter test** — all must continue to pass
- `packages/tranquilload-core/src/pipeline/` exists with: `middleware.ts`, `middleware.test.ts`, `index.ts`
- `pipeline/index.ts` currently exports `Transform` (type) and `compose` — add `compress` to it
- `tsdown.config.ts` pipeline entry is `src/pipeline/index.ts` — no change needed to build config
- `@tranquilload/pipeline` export already in `package.json` exports map — no change needed
- Test pattern for Effect tests: `import { it, describe, expect } from "@effect/vitest"` — use this for `compress.test.ts`

### Architecture Compliance

- **Service pattern**: `CompressionService` uses `Context.Tag` + interface + `Layer.succeed`/`Layer.effect` — do NOT split across files [Source: `architecture.md#Effect Service Definition Pattern`]
- **File naming**: `compress.ts`, `compress.test.ts` (kebab-case) [Source: `architecture.md#Naming Patterns`]
- **Test co-location**: `compress.test.ts` next to `compress.ts` in `pipeline/` [Source: `architecture.md#Testing Pattern`]
- **`@effect/vitest`**: Required for tests involving Effect [Source: `architecture.md#Testing Pattern`]
- **globalThis only**: `globalThis.CompressionStream` (never `window.CompressionStream`) — already correct in existing service [Source: `architecture.md#Runtime boundary`]

### References

- `CompressionService` definition: `packages/tranquilload-core/src/services/compression-service.ts`
- `CompressionService` tests (existing): `packages/tranquilload-core/src/services/compression-service.test.ts`
- `Transform` type: `packages/tranquilload-core/src/pipeline/middleware.ts`
- `pipeline/index.ts`: `packages/tranquilload-core/src/pipeline/index.ts`
- Epic 4 Story 4.2 requirements: `_bmad-output/planning-artifacts/epics.md#Story 4.2`
- Architecture patterns: `_bmad-output/planning-artifacts/architecture.md#Effect Service Definition Pattern`
- Cleanup rationale: `_bmad-output/implementation-artifacts/epic-3-retro-2026-03-15.md` (review finding, line 27)

## Dev Agent Record

### Agent Model Used

Claude Opus 4.6

### Debug Log References

- TypeScript typecheck: `CompressionStream` DOM type's `WritableStream<BufferSource>` is incompatible with `pipeThrough<Uint8Array>` — required `as unknown as TransformStream<Uint8Array, Uint8Array>` cast (DOM lib limitation, not a code issue)
- Existing test `compression-service.test.ts:59` called `svc.compress(inputStream)` with 1 arg — updated to pass algorithm argument

### Completion Notes List

- Task 0: Created `docs/project-context.md` with TestClock rule (retro action item #1). `_tag` retro action item #2 acknowledged — no new types in this story.
- Task 1: Updated `CompressionService` interface to accept `algorithm: string`. Replaced double-`globalThis` cast with DOM-typed `CompressionStream` + `CompressionFormat` cast. Updated existing test mock signatures.
- Task 2: Created `compress.ts` — `compress(algorithm?)` returns `Effect<Transform, never, CompressionService>` using `Effect.map`.
- Task 3: Added `compress` export to `pipeline/index.ts`.
- Task 4: Created 3 tests — custom service DI, CompressionServiceLive happy path, AbsentLayer typed error. All pass.
- Task 5: Cleanup validated — double-globalThis cast removed, memory note updated as resolved.
- Task 6: Build passes (compress exported from `@tranquilload/pipeline`). 85 core + 1 adapter tests pass. Typecheck has pre-existing errors in oneshot tests (not from this story).

### File List

- CREATE: `docs/project-context.md`
- CREATE: `packages/tranquilload-core/src/pipeline/compress.ts`
- CREATE: `packages/tranquilload-core/src/pipeline/compress.test.ts`
- MODIFY: `packages/tranquilload-core/src/services/compression-service.ts`
- MODIFY: `packages/tranquilload-core/src/services/compression-service.test.ts`
- MODIFY: `packages/tranquilload-core/src/pipeline/index.ts`

### Change Log

- 2026-03-15: Story 4.2 implementation complete — `compress()` pipeline transform, `CompressionService` interface updated with `algorithm` param, double-globalThis cast cleanup, 3 new tests added (85 core total)
