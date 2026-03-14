# Story 1.4: Core Utility Helpers

Status: review

## Story

As a developer building on top of the library internals,
I want `normalizeCallback` and `fromAbortSignal` utilities,
so that user-provided callbacks (Promise, throw, Effect) and AbortController signals integrate cleanly into Effect without boilerplate.

## Acceptance Criteria

1. **Given** a user callback returning a plain value, a `Promise`, or an `Effect`, **When** passed through `normalizeCallback`, **Then** all three forms produce an equivalent `Effect<A, E>` with correct error channel typing. **And** a throwing function produces an `Effect` that fails (not an unhandled exception).

2. **Given** an `AbortController` whose `signal` is passed to `fromAbortSignal`, **When** `controller.abort()` is called, **Then** the resulting Effect fails with `AbortError`. **And** the abort event listener is cleaned up (no memory leak).

## Tasks / Subtasks

- [x] Task 1: Implement `normalize-callback.ts` (AC: #1)
  - [x] Replace placeholder stub — do NOT keep `_placeholder` export
  - [x] Handle 3 cases: plain value (`Effect.succeed`), `Promise` (`Effect.tryPromise`), `Effect` (pass-through)
  - [x] Wrap `fn()` invocation in `try/catch` inside `Effect.suspend` so sync throws become typed `Effect.fail` (not defects)
  - [x] Export `normalizeCallback` with explicit TypeScript type annotations

- [x] Task 2: Write `normalize-callback.test.ts` co-located with source (AC: #1)
  - [x] Test plain value: `normalizeCallback(() => 42)` → `Effect<number>` that succeeds with `42`
  - [x] Test Promise: `normalizeCallback(() => Promise.resolve("hello"))` → `Effect<string>` that succeeds
  - [x] Test Effect: `normalizeCallback(() => Effect.succeed(true))` → same Effect passed through
  - [x] Test throwing: `normalizeCallback(() => { throw new Error("boom") })` → Effect that fails (not unhandled)
  - [x] Test Promise rejection: `normalizeCallback(() => Promise.reject(new Error("async fail")))` → Effect that fails
  - [x] Use `import { it, describe, expect } from "@effect/vitest"` + `it.effect(...)` pattern

- [x] Task 3: Implement `abort-interop.ts` (AC: #2)
  - [x] Replace placeholder stub — do NOT keep `_placeholder` export
  - [x] Import `AbortError` from `../errors/upload-error.js`
  - [x] Use `Effect.async` with `resume` to convert `AbortSignal` → `Effect<never, AbortError>`
  - [x] Handle `!signal` case: return `undefined` (Effect never settles — only used with `Effect.race`)
  - [x] Handle `signal.aborted` at call time: immediately `resume(Effect.fail(new AbortError()))`
  - [x] Attach listener with `{ once: true }` for abort event
  - [x] Return cleanup `Effect.sync(() => signal.removeEventListener("abort", handler))` for interrupt cleanup
  - [x] Export `fromAbortSignal` with explicit type annotation

- [x] Task 4: Write `abort-interop.test.ts` co-located with source (AC: #2)
  - [x] Test: `fromAbortSignal()` with no signal never settles on its own (use `Effect.race` to verify it doesn't complete)
  - [x] Test: signal already aborted before call → Effect fails immediately with `AbortError`
  - [x] Test: `controller.abort()` called after `fromAbortSignal` → Effect fails with `AbortError`
  - [x] Test: `AbortError` shape — `_tag === "AbortError"`, `instanceof Error`, `message === "Upload aborted"`
  - [x] Use `import { it, describe, expect } from "@effect/vitest"` + `it.effect(...)` pattern

- [x] Task 5: Verify build and tests pass (AC: #1, #2)
  - [x] `pnpm turbo build` — compiles cleanly (no errors on new utils files)
  - [x] `pnpm turbo test` — all tests pass, zero regressions in `upload-error.test.ts` and service tests

## Dev Notes

### Context: What Previous Stories Left Behind

**Story 1.1** scaffolded the monorepo. The two utility files are placeholders:
- `packages/tranquilload-core/src/utils/normalize-callback.ts` → single `_placeholder` export
- `packages/tranquilload-core/src/utils/abort-interop.ts` → single `_placeholder` export

**Replace both entirely.** Do NOT keep `_placeholder` — it breaks tree-shaking (same rule applied in Story 1.3 to services/index.ts).

**No `utils/index.ts` exists** and none is needed: `utils/` contains internal helpers consumed by other modules, not exported sub-paths. Future stories import directly from `"../utils/normalize-callback.js"` and `"../utils/abort-interop.js"`.

**`AbortError` lives in errors/upload-error.ts** (Story 1.2). It is part of the `UploadError` union. Import it as:
```ts
import { AbortError } from "../errors/upload-error.js"
```

### Critical Constraint: `isolatedDeclarations` Was Removed

**`tsconfig.base.json` does NOT have `isolatedDeclarations: true`** — it was removed in Story 1.3 because the `Context.Tag` class pattern is incompatible with it (TS9021). `tsconfig.base.json` now has only `declaration: true`.

**Note:** `_bmad-output/project-context.md` still says `isolatedDeclarations: true` is required — this is outdated. The Story 1.3 implementation is the ground truth. Do NOT re-add `isolatedDeclarations`.

All exports must still have explicit TypeScript type annotations (best practice for lib code), but inference is not forbidden.

### `normalizeCallback` — Implementation

```ts
// packages/tranquilload-core/src/utils/normalize-callback.ts
import { Effect } from "effect"

export const normalizeCallback = <A, E = never>(
  fn: (() => A) | (() => Promise<A>) | (() => Effect.Effect<A, E>)
): Effect.Effect<A, E | unknown> =>
  Effect.suspend((): Effect.Effect<A, E | unknown> => {
    let result: A | Promise<A> | Effect.Effect<A, E>
    try {
      result = fn()
    } catch (e) {
      return Effect.fail(e)
    }
    if (Effect.isEffect(result)) return result
    if (result instanceof Promise) {
      return Effect.tryPromise({ try: () => result as Promise<A>, catch: (e) => e })
    }
    return Effect.succeed(result)
  })
```

**Why `try/catch` inside `Effect.suspend` instead of `Effect.suspend` without it:**
The architecture doc shows `Effect.suspend(() => { const result = fn(); ... })`. Without `try/catch`, a synchronously throwing `fn()` becomes an Effect **defect** (die), not a typed failure. AC #1 requires a throwing function to "produce an Effect that fails" — using `try/catch` ensures it lands in the typed error channel as `Effect.fail(e)`.

**Why `Effect.suspend` wraps everything:** Defers evaluation of `fn()` to Effect runtime so errors stay in the Effect fiber, not the call stack.

**Why `Effect.isEffect` before `instanceof Promise`:** An `Effect` is not a Promise, but checking Effect first is more reliable than checking Promise first.

### `fromAbortSignal` — Implementation

```ts
// packages/tranquilload-core/src/utils/abort-interop.ts
import { Effect } from "effect"
import { AbortError } from "../errors/upload-error.js"

export const fromAbortSignal = (signal?: AbortSignal): Effect.Effect<never, AbortError> =>
  Effect.async<never, AbortError>((resume) => {
    if (!signal) return
    if (signal.aborted) {
      resume(Effect.fail(new AbortError()))
      return
    }
    const handler = (): void => resume(Effect.fail(new AbortError()))
    signal.addEventListener("abort", handler, { once: true })
    return Effect.sync(() => signal.removeEventListener("abort", handler))
  })
```

**Usage pattern** (this is the ONLY way to handle AbortController in this codebase):
```ts
// ✅ Correct — always Effect.race + fromAbortSignal
Effect.race(someUploadEffect, fromAbortSignal(signal))

// ❌ NEVER — forbidden anti-pattern
if (signal.aborted) throw new AbortError()
```

**Why `{ once: true }` on the event listener:** Ensures the handler is automatically removed after first abort, even if the cleanup Effect is never called.

**Why return `Effect.sync(() => signal.removeEventListener(...))` from the async callback:** The return value of `Effect.async`'s callback is the **interrupt finalizer** — called when the fiber is interrupted (e.g., the other branch of `Effect.race` wins). This prevents memory leaks when the upload completes before abort is triggered.

**Why `if (!signal) return`:** When no signal is provided, `fromAbortSignal` should never resolve — it just hangs as the "never fires" branch of a `Effect.race`. This matches the usage in upstream stories where `signal` is optional.

### Testing Pattern

**Import from `@effect/vitest`, not `vitest`:**
```ts
import { it, describe, expect } from "@effect/vitest"
```

**`it.effect` for pure Effect tests — no manual `Effect.runPromise`:**
```ts
it.effect("normalizes a plain value", () =>
  Effect.gen(function* () {
    const result = yield* normalizeCallback(() => 42)
    expect(result).toBe(42)
  })
)
```

**Testing typed failures:**
```ts
it.effect("throwing function fails in error channel", () =>
  Effect.gen(function* () {
    const exit = yield* Effect.exit(normalizeCallback(() => { throw new Error("boom") }))
    expect(Exit.isFailure(exit)).toBe(true)
  })
)
```

**Testing `fromAbortSignal` with `Effect.race`:**
```ts
it.effect("abort signal fires → AbortError", () =>
  Effect.gen(function* () {
    const controller = new AbortController()
    const abortEffect = fromAbortSignal(controller.signal)
    // Schedule the abort then race
    const fiber = yield* Effect.fork(abortEffect)
    controller.abort()
    const exit = yield* Fiber.await(fiber)
    // exit should be Failure(Fail(AbortError))
    ...
  })
)
```

**Import needed in tests:**
```ts
import { Effect, Exit, Fiber } from "effect"
import { it, describe, expect } from "@effect/vitest"
```

### Project Structure Compliance

These files are **internal utilities** — not exported sub-paths in `package.json`. They will be consumed by:
- `multipart/upload-stream.ts` — `normalizeCallback(uploadPart)`, `Effect.race(..., fromAbortSignal(signal))`
- `oneshot/upload.ts` — `normalizeCallback(uploadOnce)`, `fromAbortSignal(signal)`

File locations (confirmed from Story 1.1 scaffold):
```
packages/tranquilload-core/src/utils/
  normalize-callback.ts        ← replace stub (this story)
  normalize-callback.test.ts   ← create (this story)
  abort-interop.ts             ← replace stub (this story)
  abort-interop.test.ts        ← create (this story)
```

All import paths in these files must use `.js` extension (NodeNext module resolution requirement):
```ts
import { AbortError } from "../errors/upload-error.js"  // ✅
import { AbortError } from "../errors/upload-error"      // ❌ NodeNext requires .js
```

### Architecture Compliance Constraints (Absolute)

1. **No `try/catch` in Effect code** — the `try/catch` in `normalizeCallback` is for catching the sync call to `fn()` before entering Effect territory, which is valid. Once inside Effect, never use `try/catch`.
2. **`globalThis` only** — these utils are in `packages/core`, so no `window`, no `process`.
3. **No `isolatedDeclarations`** — do NOT add it back to tsconfig.
4. **Abort interop rule** — `fromAbortSignal` is the single point of AbortSignal integration. All abort handling goes through here.
5. **`.js` on all relative imports** — NodeNext requirement.
6. **`effect` stays in `peerDependencies`** — never add to `dependencies`.

### References

- `normalizeCallback` pattern: [Source: _bmad-output/planning-artifacts/architecture.md#Callback Normalization Pattern]
- `fromAbortSignal` pattern: [Source: _bmad-output/planning-artifacts/architecture.md#AbortSignal Interop Pattern]
- `AbortError` definition: `packages/tranquilload-core/src/errors/upload-error.ts:45`
- `isolatedDeclarations` removal: [Source: _bmad-output/implementation-artifacts/1-3-effect-services-infrastructure.md#Critical Constraint]
- Testing pattern: [Source: _bmad-output/implementation-artifacts/1-3-effect-services-infrastructure.md#Testing Pattern]

## Dev Agent Record

### Agent Model Used

claude-sonnet-4-6

### Debug Log References

### Completion Notes List

- Implemented `normalizeCallback` using `Effect.suspend` + `try/catch` pattern: sync throws land in typed error channel, not as defects.
- Implemented `fromAbortSignal` using `Effect.async` with interrupt finalizer: `{ once: true }` listener + cleanup Effect returned from async callback.
- Both placeholder stubs fully replaced; no `_placeholder` export remains.
- 5 tests for normalize-callback, 4 tests for abort-interop — all pass.
- Full suite: 43 tests across 6 files, 0 regressions.
- Build clean: ESM + CJS + type declarations generated without errors.

### File List

- packages/tranquilload-core/src/utils/normalize-callback.ts (modified)
- packages/tranquilload-core/src/utils/normalize-callback.test.ts (created)
- packages/tranquilload-core/src/utils/abort-interop.ts (modified)
- packages/tranquilload-core/src/utils/abort-interop.test.ts (created)

### Change Log

- 2026-03-14: Story 1.4 implemented — `normalizeCallback` and `fromAbortSignal` utilities replace placeholder stubs; 9 new tests added.
