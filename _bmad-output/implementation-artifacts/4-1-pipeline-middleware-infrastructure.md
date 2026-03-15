# Story 4.1: Pipeline Middleware Infrastructure

Status: done

## Story

As a developer consuming the library,
I want a composable pipeline system where each transform is `(stream: ReadableStream<Uint8Array>) => ReadableStream<Uint8Array>`,
so that I can chain compression, checksum, or any custom transform before my upload without framework lock-in.

## Acceptance Criteria

1. **Given** the `@tranquilload/pipeline` sub-path export **When** the developer calls `compose(transformA, transformB, transformC)` **Then** it returns a single `(stream) => stream` function applying transforms left-to-right **And** backpressure propagates through the chain (native WHATWG `ReadableStream` piping — no unbounded buffering between stages)

2. **Given** a pipeline with zero transforms **When** applied to a stream **Then** the stream passes through unchanged (identity)

## Tasks / Subtasks

- [x] Task 1: Create `Transform` type and `compose` function in `middleware.ts` (AC: #1, #2)
  - [x] Create `packages/tranquilload-core/src/pipeline/middleware.ts`
  - [x] Export `Transform` type alias: `type Transform = (stream: ReadableStream<Uint8Array>) => ReadableStream<Uint8Array>`
  - [x] Export `compose(...transforms: Transform[]): Transform` applying transforms left-to-right via `Array.reduce`
  - [x] Identity case: `compose()` with zero transforms returns `(stream) => stream`

- [x] Task 2: Create entry point `index.ts` (AC: #1)
  - [x] Create `packages/tranquilload-core/src/pipeline/index.ts`
  - [x] Re-export `Transform` and `compose` from `./middleware.js`
  - [x] No Dual API `.effect` property needed for this story — `compose` is a pure function

- [x] Task 3: Create tests in `middleware.test.ts` (AC: #1, #2)
  - [x] Create `packages/tranquilload-core/src/pipeline/middleware.test.ts`
  - [x] Use plain `vitest` (no `@effect/vitest` — no Effect involved in this story)
  - [x] Test: `compose()` zero transforms → identity (stream passes through unchanged)
  - [x] Test: `compose(t1)` single transform → applied
  - [x] Test: `compose(t1, t2)` two transforms → applied left-to-right (t1 then t2)
  - [x] Test: `compose(t1, t2, t3)` three transforms → left-to-right order verified

- [x] Task 4: Verify scaffold test exists (vitest constraint)
  - [x] Vitest 3.x exits with code 1 when no test files found — `middleware.test.ts` satisfies this for the pipeline module

- [x] Task 5: Verify build and tests pass
  - [x] `pnpm turbo build` — no errors
  - [x] `pnpm turbo test` — all 78 core + 1 adapter tests still pass, new pipeline tests added

## Dev Notes

### Files to Create

```
packages/tranquilload-core/src/pipeline/
  middleware.ts       ← CREATE: Transform type + compose function
  middleware.test.ts  ← CREATE: pure vitest tests (no @effect/vitest)
  index.ts            ← CREATE: re-export entry point for tsdown
```

**DO NOT TOUCH** anything outside `src/pipeline/` — this story is purely additive.

### `middleware.ts` Implementation

```ts
export type Transform = (stream: ReadableStream<Uint8Array>) => ReadableStream<Uint8Array>

export const compose = (...transforms: Transform[]): Transform =>
  (stream: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> =>
    transforms.reduce((s, t) => t(s), stream)
```

Key notes:
- Zero dependencies — no `effect` import, no WHATWG `TransformStream` needed in `compose` itself
- Backpressure is native to WHATWG `ReadableStream` piping — each transform in the chain receives a stream and returns one; piping handles backpressure automatically
- `Array.reduce` with `stream` as the initial value applies transforms left-to-right: `compose(t1, t2)(s)` → `t2(t1(s))`
- Zero-transform identity: `transforms.reduce((s, t) => t(s), stream)` with empty array returns `stream` unchanged — no special case needed

### `index.ts` Entry Point

```ts
export type { Transform } from "./middleware.js"
export { compose } from "./middleware.js"
```

This is the tsdown entry (`pipeline: 'src/pipeline/index.ts'` in `tsdown.config.ts`). No Dual API `.effect` property for this story — `compose` is a pure synchronous function.

### `middleware.test.ts` Tests

```ts
import { describe, expect, it } from "vitest"
import { compose } from "./middleware.js"

// Helper: creates a ReadableStream emitting a single Uint8Array chunk
function makeStream(data: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(data)
      controller.close()
    }
  })
}

// Helper: collects all chunks from a ReadableStream
async function collect(stream: ReadableStream<Uint8Array>): Promise<Uint8Array[]> {
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
  }
  return chunks
}

describe("compose", () => {
  it("zero transforms: stream passes through unchanged", async () => {
    const data = new Uint8Array([1, 2, 3])
    const pipeline = compose()
    const result = await collect(pipeline(makeStream(data)))
    expect(result).toEqual([data])
  })

  it("single transform: applied to stream", async () => {
    const data = new Uint8Array([1, 2, 3])
    const double = (stream: ReadableStream<Uint8Array>) =>
      new ReadableStream<Uint8Array>({
        async start(controller) {
          const chunks = await collect(stream)
          for (const chunk of chunks) controller.enqueue(chunk.map(b => b * 2))
          controller.close()
        }
      })
    const result = await collect(compose(double)(makeStream(data)))
    expect(result).toEqual([new Uint8Array([2, 4, 6])])
  })

  it("two transforms: applied left-to-right", async () => {
    const order: string[] = []
    const t1 = (stream: ReadableStream<Uint8Array>) => { order.push("t1"); return stream }
    const t2 = (stream: ReadableStream<Uint8Array>) => { order.push("t2"); return stream }
    compose(t1, t2)(makeStream(new Uint8Array([1])))
    expect(order).toEqual(["t1", "t2"])
  })

  it("three transforms: applied left-to-right", async () => {
    const order: string[] = []
    const t1 = (stream: ReadableStream<Uint8Array>) => { order.push("t1"); return stream }
    const t2 = (stream: ReadableStream<Uint8Array>) => { order.push("t2"); return stream }
    const t3 = (stream: ReadableStream<Uint8Array>) => { order.push("t3"); return stream }
    compose(t1, t2, t3)(makeStream(new Uint8Array([1])))
    expect(order).toEqual(["t1", "t2", "t3"])
  })
})
```

### Project Structure Notes

- `tsdown.config.ts` already declares `pipeline: 'src/pipeline/index.ts'` — entry point is pre-configured, just create the file
- Package export `./pipeline` is already in `packages/tranquilload-core/package.json` exports map — no package.json change needed
- Directory `packages/tranquilload-core/src/pipeline/` does NOT exist yet — create it
- Package dir name: `packages/tranquilload-core/` (NOT `packages/core/` — pnpm workspace symlink conflict, see memory)
- File naming: kebab-case (`middleware.ts`, not `Middleware.ts`) [Source: `architecture.md#Naming Patterns`]

### Important: Pending Cleanup from Previous Stories

Memory note: `packages/tranquilload-core/src/services/compression-service.ts` line 27 has a redundant constructor cast to simplify in Story 4.2. **Do NOT touch it in this story** — it belongs to Story 4.2.

### Scope Boundaries — What This Story Does NOT Do

- **Does NOT implement `compress()`** — that's Story 4.2 (requires `CompressionService` integration)
- **Does NOT add `pipeline` option to `uploadMultipart`/`uploadOnce`** — that's Story 4.3
- **Does NOT create any Effect-based pipeline constructs** — `Transform` is a pure WHATWG function; Effect integration comes in Story 4.2
- **Does NOT modify `multipart/index.ts`, `oneshot/index.ts`, or any existing files**

### Previous Story Intelligence (from Story 3.4)

- Current test count: **78 core tests** (12 test files), **1 adapter test** — all must continue to pass
- Build is clean for both packages — maintain this
- Pattern for test helpers: `makeStream()` utility used in `upload-stream.test.ts` — define a similar local helper in `middleware.test.ts` (don't import cross-module)
- Pattern for vitest imports without Effect: `import { describe, expect, it } from "vitest"` (not `@effect/vitest`) [Source: architecture.md — `@effect/vitest` only for tests involving Effect]

### References

- `@tranquilload/pipeline` export path: [Source: `architecture.md#Module & Package Architecture`]
- `Transform` type usage in data flow: [Source: `architecture.md#Data Flow` — pipeline middleware between source stream and chunking]
- File location: [Source: `architecture.md#Complete Project Directory Structure` — `src/pipeline/middleware.ts`]
- tsdown entry pre-configured: [Source: `packages/tranquilload-core/tsdown.config.ts` line 8]
- Package exports pre-configured: [Source: `packages/tranquilload-core/package.json` `./pipeline` entry]

## Dev Agent Record

### Agent Model Used

claude-sonnet-4-6

### Debug Log References

### Completion Notes List

- Implemented `Transform` type and `compose` function in `middleware.ts` using `Array.reduce` — zero dependencies, identity case handled naturally by empty-array reduce
- Created `index.ts` re-exporting `Transform` and `compose` — no Dual API needed (pure synchronous function)
- 4 tests added in `middleware.test.ts` covering: zero transforms identity, single transform, two transforms left-to-right order, three transforms left-to-right order — all pass
- Build: `pnpm turbo build` clean (ESM + CJS + types for pipeline generated)
- Tests: 82 core tests (13 files) + 1 adapter test — all pass, no regressions

### File List

- packages/tranquilload-core/src/pipeline/middleware.ts (created)
- packages/tranquilload-core/src/pipeline/index.ts (created)
- packages/tranquilload-core/src/pipeline/middleware.test.ts (created)

### Change Log

- 2026-03-15: Story 4.1 implemented — Pipeline middleware infrastructure: `Transform` type + `compose` function with 4 tests
