# Story 3.1: Chunk Stream

Status: review

## Story

As a library developer,
I want a `chunkStream` transform that splits a `ReadableStream<Uint8Array>` into fixed-size chunks,
so that the multipart upload can feed parts of a controlled size to the upload pipeline.

## Acceptance Criteria

1. **Given** a `ReadableStream<Uint8Array>` and a `chunkSize` in bytes, **When** passed through `chunkStream(stream, chunkSize)`, **Then** each emitted chunk is exactly `chunkSize` bytes — except the last which may be smaller.

2. **Given** any source stream, **When** all emitted chunks are concatenated, **Then** the total bytes equals the source stream's total bytes (no data loss, no duplication).

3. **Given** a source stream whose total bytes < `chunkSize`, **When** passed through `chunkStream`, **Then** exactly one chunk is emitted containing all the source bytes.

4. **Given** a source stream whose total bytes is an exact multiple of `chunkSize`, **When** passed through `chunkStream`, **Then** all chunks are exactly `chunkSize` bytes and no trailing empty chunk is emitted.

5. **Given** a slow consumer, **When** reading chunks from the resulting stream, **Then** backpressure propagates back to the source (no unbounded buffering).

## Tasks / Subtasks

- [x] Task 1: Implement `multipart/chunk-stream.ts` (AC: #1, #2, #3, #4, #5)
  - [x] Define `chunkStream(stream, chunkSize): Stream.Stream<Uint8Array, unknown>` function
  - [x] Use WHATWG `TransformStream<Uint8Array, Uint8Array>` for chunking + `stream.pipeThrough()` for backpressure
  - [x] Convert resulting `ReadableStream` to Effect Stream via `Stream.fromReadableStream`
  - [x] All relative imports MUST use `.js` extension (NodeNext)

- [x] Task 2: Write `multipart/chunk-stream.test.ts` (AC: #1, #2, #3, #4)
  - [x] Use `import { it, describe, expect } from "@effect/vitest"` + `it.effect(...)`
  - [x] Test: non-multiple → correct chunk sizes + last chunk smaller
  - [x] Test: total bytes preserved across chunks (byte value integrity)
  - [x] Test: stream smaller than chunkSize → single chunk
  - [x] Test: exact multiple → no trailing empty chunk
  - [x] Surgical assertions: check exact lengths AND byte values

- [x] Task 3: Verify build and tests pass
  - [x] `pnpm turbo build` — no errors
  - [x] `pnpm turbo test` — all tests pass, zero regressions (currently 53 tests)

## Dev Notes

### Project Structure

Only two files are created in this story. **DO NOT touch `multipart/index.ts`** — it stays as a placeholder until Story 3.3.

```
packages/tranquilload-core/src/
  multipart/
    index.ts          ← DO NOT TOUCH (placeholder for Story 3.3)
    chunk-stream.ts   ← CREATE (this story)
    chunk-stream.test.ts ← CREATE (this story)
```

### Task 1 — Function Signature

```ts
// multipart/chunk-stream.ts
import { Stream } from "effect"

export const chunkStream = (
  stream: ReadableStream<Uint8Array>,
  chunkSize: number
): Stream.Stream<Uint8Array, unknown> => {
  // ... (see implementation pattern below)
}
```

Error type is `unknown` — if the source ReadableStream errors, `Stream.fromReadableStream` surfaces it as `unknown`. The multipart upload orchestrator (Story 3.2) will map it to a typed `UploadError`.

### Task 1 — Implementation Pattern: WHATWG TransformStream + Effect Stream

Use a WHATWG `TransformStream` for the byte-level accumulation. This gives native backpressure for free (AC #5) and matches the architecture intent ("WHATWG TransformStream → Effect Stream").

```ts
export const chunkStream = (
  stream: ReadableStream<Uint8Array>,
  chunkSize: number
): Stream.Stream<Uint8Array, unknown> => {
  let buffer = new Uint8Array(0)

  const transform = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      // Concatenate incoming chunk into the buffer
      const merged = new Uint8Array(buffer.length + chunk.length)
      merged.set(buffer)
      merged.set(chunk, buffer.length)
      buffer = merged

      // Emit every full-size chunk
      while (buffer.length >= chunkSize) {
        controller.enqueue(buffer.slice(0, chunkSize))
        buffer = buffer.slice(chunkSize)
      }
    },
    flush(controller) {
      // Emit remaining bytes (last partial chunk)
      if (buffer.length > 0) {
        controller.enqueue(buffer)
      }
    },
  })

  const chunked = stream.pipeThrough(transform)

  return Stream.fromReadableStream(
    () => chunked,
    (e) => e
  )
}
```

**Why this approach:**
- `pipeThrough` delegates backpressure management to the WHATWG streams API — no unbounded buffering (AC #5)
- `flush` guarantees the last partial chunk is emitted (AC #1, #3)
- The `while` loop in `transform` correctly handles large incoming chunks that span multiple output chunks
- `Stream.fromReadableStream(() => chunked, ...)` — the lazy getter `() => chunked` is required; do NOT pass `chunked` directly

**`Stream.fromReadableStream` signature:**
```ts
Stream.fromReadableStream<A, E>(
  evaluate: LazyArg<ReadableStream<A>>,  // MUST be a lazy getter () => stream
  onError: (error: unknown) => E         // maps stream errors to typed errors
): Stream<A, E>
```

**Anti-patterns to avoid:**
```ts
// ❌ WRONG — eager evaluation, stream consumed before Effect runs
return Stream.fromReadableStream(chunked, (e) => e)

// ❌ WRONG — trying to use Effect operators before converting — overcomplicates things
return Stream.fromReadableStream(() => stream, (e) => e).pipe(
  Stream.mapChunks(...)  // Effect Chunk-level, not byte-level
)

// ❌ WRONG — manual ReadableStream reader loop — breaks backpressure
const reader = chunked.getReader()
while (true) { ... }
```

### Task 2 — Test Patterns

```ts
import { describe, expect, it } from "@effect/vitest"
import { Array as Arr, Chunk, Effect, Stream } from "effect"
import { chunkStream } from "./chunk-stream.js"

// Helper: create a ReadableStream from a Uint8Array (single chunk)
const fromBytes = (bytes: Uint8Array): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start(controller) {
      controller.enqueue(bytes)
      controller.close()
    },
  })

// Helper: run chunkStream and collect chunks as a plain Array
const collectChunks = (
  stream: ReadableStream<Uint8Array>,
  chunkSize: number
): Effect.Effect<Uint8Array[]> =>
  Stream.runCollect(chunkStream(stream, chunkSize)).pipe(
    Effect.map((chunk) => Array.from(chunk))
  )
```

**Non-multiple test (AC #1 — primary correctness test):**
```ts
it.effect("splits into chunkSize chunks, last chunk smaller", () =>
  Effect.gen(function* () {
    // 10 bytes, chunkSize 3 → chunks: [3, 3, 3, 1]
    const data = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
    const chunks = yield* collectChunks(fromBytes(data), 3)

    expect(chunks).toHaveLength(4)
    expect(chunks[0]).toEqual(new Uint8Array([0, 1, 2]))
    expect(chunks[1]).toEqual(new Uint8Array([3, 4, 5]))
    expect(chunks[2]).toEqual(new Uint8Array([6, 7, 8]))
    expect(chunks[3]).toEqual(new Uint8Array([9]))
  })
)
```

**Total bytes preserved (AC #2 — byte integrity):**
```ts
it.effect("preserves all bytes across chunks", () =>
  Effect.gen(function* () {
    const data = new Uint8Array(100).map((_, i) => i % 256)
    const chunks = yield* collectChunks(fromBytes(data), 7)

    const totalLength = chunks.reduce((sum, c) => sum + c.length, 0)
    expect(totalLength).toBe(100)

    // Verify byte values are intact
    const reconstructed = new Uint8Array(100)
    let offset = 0
    for (const chunk of chunks) {
      reconstructed.set(chunk, offset)
      offset += chunk.length
    }
    expect(reconstructed).toEqual(data)
  })
)
```

**Single chunk (AC #3):**
```ts
it.effect("emits single chunk when stream is smaller than chunkSize", () =>
  Effect.gen(function* () {
    const data = new Uint8Array([10, 20, 30])
    const chunks = yield* collectChunks(fromBytes(data), 100)

    expect(chunks).toHaveLength(1)
    expect(chunks[0]).toEqual(new Uint8Array([10, 20, 30]))
  })
)
```

**Exact multiple — no trailing empty chunk (AC #4):**
```ts
it.effect("emits no trailing empty chunk on exact multiple", () =>
  Effect.gen(function* () {
    const data = new Uint8Array(9).fill(5) // 9 = 3 * 3
    const chunks = yield* collectChunks(fromBytes(data), 3)

    expect(chunks).toHaveLength(3)
    for (const chunk of chunks) {
      expect(chunk).toHaveLength(3)
      expect(chunk).toEqual(new Uint8Array([5, 5, 5]))
    }
  })
)
```

**Surgical assertion rule**: always assert exact byte values (not just lengths). This catches off-by-one errors in the buffer slicing logic.

### Architecture Compliance (Absolute Rules)

1. **`globalThis` only** — no `window`, no `process`, no `node:*` imports. `TransformStream` and `ReadableStream` are `globalThis` in Node 18+, browser, Bun, Deno.
2. **`.js` on all relative imports** — NodeNext module resolution.
3. **No `try/catch`** — `Stream.fromReadableStream` handles source stream errors via the `onError` mapper.
4. **No Effect `Stream.fromReadableStream` without lazy getter** — always `() => chunkedStream`, not `chunkedStream`.
5. **No `window.TransformStream`** — always bare `new TransformStream(...)` (it's on `globalThis`).

### What This Story Does NOT Do

- Does NOT implement `multipart/index.ts` — that's Story 3.3 (Dual API Entry Point)
- Does NOT implement `upload-stream.ts` — that's Story 3.2 (Core Effect Implementation)
- Does NOT add a new export to `package.json` — `chunkStream` is an internal utility, not a public export
- Does NOT handle `chunkSize = 0` — undefined behavior, not in scope

### Previous Story Intelligence (Story 2.2)

From Story 2.2 implementation and review (0 HIGH, 0 MEDIUM findings):

- **`Stream.provideLayer` vs `Effect.provide`** — for `Stream` use `Stream.provideLayer`, for `Effect` use `Effect.provide`
- **`Effect.runPromiseExit` + `Cause.squash`** — used in the Dual API wrapper so `result` Promise rejects with the raw typed error (not `FiberFailure`). Not needed in this story (internal utility), but remember for Story 3.3.
- **Test pattern: `import { it, describe, expect } from "@effect/vitest"`** (NOT from `vitest`). Always `it.effect(...)`.
- **Single-run trap** — each call to an Effect Stream runs the program independently. Not applicable here but crucial for Story 3.3.
- **`Effect.sync(() => logger.log(...))` pattern** — LoggerService.log returns `void`, must wrap with `Effect.sync` before `yield*` in `Effect.gen`. Not needed in this story (no LoggerService).

### Git Intelligence

Recent commits:
```
7b040ab retrospective: epic 2
89a663d review: 2-2-one-shot-upload-dual-api-entry-point
e7231f5 dev: 2-2-one-shot-upload-dual-api-entry-point
```

Current test count: **53 tests** (all passing). New tests from this story will add to that count.

Files currently in `multipart/`:
- `packages/tranquilload-core/src/multipart/index.ts` — placeholder, DO NOT TOUCH

### References

- Architecture: chunk-stream design → [Source: _bmad-output/planning-artifacts/architecture.md#Complete Project Directory Structure]
- `Stream.fromReadableStream`: [Source: effect/packages/effect/README.md or effect/docs/]
- Multipart data flow: [Source: _bmad-output/planning-artifacts/architecture.md#Data Flow]
- Effect Stream patterns: [Source: _bmad-output/planning-artifacts/architecture.md#Testing Pattern]
- `WHATWG TransformStream`: MDN / `globalThis.TransformStream` — no import needed, available in Node 18+
- Error types: [Source: packages/tranquilload-core/src/errors/upload-error.ts]
- normalizeCallback (used in Story 3.2, not here): [Source: packages/tranquilload-core/src/utils/normalize-callback.ts]

## Dev Agent Record

### Agent Model Used

claude-sonnet-4-6

### Debug Log References

### Completion Notes List

- Implemented `chunkStream` using WHATWG `TransformStream` for byte-level chunking with native backpressure (AC #5 via `pipeThrough`).
- Converted to Effect Stream via `Stream.fromReadableStream(() => chunked, (e) => e)` with lazy getter.
- 4 `it.effect` tests cover all ACs: non-multiple split, byte integrity, single chunk (stream < chunkSize), exact multiple (no trailing empty chunk).
- All 57 tests pass (53 pre-existing + 4 new). Build clean with `pnpm turbo build` and `pnpm turbo test`.
- `multipart/index.ts` left untouched (placeholder for Story 3.3).

### File List

- packages/tranquilload-core/src/multipart/chunk-stream.ts (created)
- packages/tranquilload-core/src/multipart/chunk-stream.test.ts (created)

## Change Log

- 2026-03-14: Implemented chunkStream transform and tests (Story 3.1)
