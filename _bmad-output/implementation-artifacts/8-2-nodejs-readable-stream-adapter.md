# Story 8.2: Node.js Readable Stream Adapter

Status: done

## Story

As a developer consuming the library,
I want a `fromNodeReadable(readable: Readable)` adapter from `@tranquilload/adapters/fromNodeReadable`,
so that I can use any Node.js `Readable` stream as an upload source without manual conversion.

## Acceptance Criteria

1. **Given** a Node.js `Readable` stream **When** `fromNodeReadable(readable)` is called **Then** it returns a `ReadableStream<Uint8Array>` compatible with all upload functions **And** `fromNodeReadable` is the only file in the codebase allowed to import `node:stream`.

2. **Given** the source `Readable` emits an error **When** the converted stream is consumed **Then** the error propagates through the Effect error channel as a typed `UploadError`.

## Tasks / Subtasks

- [x] Task 1: Add `@types/node` dev dependency (AC: #1)
  - [x] Add `"@types/node": "latest"` to `devDependencies` in `packages/tranquilload-adapters/package.json`
  - [x] Run `pnpm install` to install it (required for `import { Readable } from 'node:stream'` to typecheck)

- [x] Task 2: Implement `fromNodeReadable` in `from-node-readable.ts` (AC: #1, #2)
  - [x] Replace the placeholder export with the real implementation
  - [x] `fromNodeReadable(readable: Readable): ReadableStream<Uint8Array>`
  - [x] Use `Readable.toWeb(readable) as ReadableStream<Uint8Array>` — one line, Node 17+ static method
  - [x] Only import from `node:stream` — no other Node built-in imports needed

- [x] Task 3: Write tests in `from-node-readable.test.ts` (AC: #1, #2)
  - [x] Create `packages/tranquilload-adapters/src/sources/from-node-readable.test.ts`
  - [x] Test: stream yields all bytes from the Node Readable
  - [x] Test: error from Node Readable propagates as a ReadableStream error on read

- [x] Task 4: Triptyque build/test/typecheck (AC: all)
  - [x] `pnpm turbo build` — clean
  - [x] `pnpm turbo test` — all tests pass (127 passing, 0 regressions)
  - [x] `pnpm turbo typecheck` — no errors

## Dev Notes

### Implementation: `from-node-readable.ts`

```ts
import { Readable } from 'node:stream'

export function fromNodeReadable(readable: Readable): ReadableStream<Uint8Array> {
  return Readable.toWeb(readable) as ReadableStream<Uint8Array>
}
```

- `Readable.toWeb(readable)` — static method available since Node.js 17, confirmed available in Node 22 (this project's minimum). Converts a Node.js `Readable` to a WHATWG `ReadableStream<any>`.
- Type assertion `as ReadableStream<Uint8Array>` — required because Node.js types return `ReadableStream<any>`. Safe in practice: Node Readable streams emit `Buffer` (which extends `Uint8Array`).
- Error propagation: `Readable.toWeb()` internally attaches an `'error'` listener on the Readable. When the Readable emits an error, the WHATWG ReadableStream is errored with that same error. Downstream Effect code (via `Stream.fromReadableStream`) receives the error in its `unknown` error channel.
- No additional error wrapping needed in this adapter — the core's `chunkStream` and `upload-stream` handle stream errors.

### CRITICAL: `@types/node` must be added

`@types/node` is **not installed** anywhere in the project (confirmed: no `node_modules/@types/node` exists). Without it, `import { Readable } from 'node:stream'` causes a TypeScript error:

> Cannot find module 'node:stream' or its corresponding type declarations.

Add to `packages/tranquilload-adapters/package.json`:
```json
"devDependencies": {
  "@types/node": "latest",
  ...
}
```

Then run `pnpm install` from the monorepo root.

### CRITICAL: Architecture boundary — `node:stream` isolation

Architecture rule (from `architecture.md`): **`from-node-readable.ts` is the ONLY file allowed to import `node:stream`**. This ensures tree-shaking works: browser bundles that don't use `fromNodeReadable` don't accidentally pull in Node.js internals.

Do NOT import `node:stream` from any other file, including the test file. In tests, use `Readable.from()` or `new Readable(...)` — but be careful: `Readable` must be imported in the test too (that's fine, it's the test file for `from-node-readable.ts`).

Wait — actually the architecture rule says `from-node-readable.ts` is the only **source** file allowed to import `node:stream`. The test file `from-node-readable.test.ts` can also import `node:stream` to construct test Readables.

### Usage Pattern (for context only)

```ts
import { fromNodeReadable } from "@tranquilload/adapters/fromNodeReadable"
import { uploadMultipart } from "@tranquilload/core/multipart"
import { createReadStream } from 'node:fs'

const readable = createReadStream('/path/to/file')
const stream = fromNodeReadable(readable)
await uploadMultipart({ stream, chunkSize: 5 * 1024 * 1024, uploadPart, completeUpload })
// Note: totalBytes is unknown for a Readable — omit it or pass undefined
```

Note: unlike `fromFile`, `fromNodeReadable` only returns `ReadableStream<Uint8Array>` (not `{ stream, totalBytes }`). Node `Readable` has no inherent size — callers must provide `totalBytes` separately if known.

### Error Propagation Path (AC #2)

1. Node `Readable` emits `'error'` event → `Readable.toWeb()` calls `controller.error(err)` on the WHATWG stream
2. WHATWG `ReadableStream` is now in errored state
3. `pipeThrough(transform)` in `chunkStream` propagates the error
4. `Stream.fromReadableStream(() => chunked, (e) => e)` captures it (error type: `unknown`)
5. `upload-stream.ts` wraps stream read errors as `PartUploadError` in the Effect error channel

### Testing: `from-node-readable.test.ts`

Use `it` from `vitest` (NOT `@effect/vitest`) — pure function adapter, no Effect involved.

```ts
import { describe, it, expect } from 'vitest'
import { Readable } from 'node:stream'
import { fromNodeReadable } from './from-node-readable.js'

describe('fromNodeReadable', () => {
  it('streams all bytes from a Node Readable', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5])
    const readable = Readable.from([Buffer.from(bytes)])

    const webStream = fromNodeReadable(readable)

    const reader = webStream.getReader()
    const chunks: Uint8Array[] = []
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
    }

    const totalLength = chunks.reduce((n, c) => n + c.length, 0)
    const all = new Uint8Array(totalLength)
    let offset = 0
    for (const chunk of chunks) { all.set(chunk, offset); offset += chunk.length }

    expect(Array.from(all)).toEqual([1, 2, 3, 4, 5])
  })

  it('propagates Readable errors to the ReadableStream', async () => {
    const readable = new Readable({
      read() {
        this.emit('error', new Error('read failure'))
      },
    })

    const webStream = fromNodeReadable(readable)
    const reader = webStream.getReader()

    await expect(reader.read()).rejects.toThrow('read failure')
  })
})
```

- `Readable.from([Buffer.from(bytes)])` — creates a Readable from an array of Buffers. `Buffer` extends `Uint8Array`, so `ReadableStream<Uint8Array>` is correct.
- `Readable` global is NOT available in test files — must import from `node:stream`.
- Tests run on Node 22 (project constraint) — all APIs available.

### Files to Touch

**Modify:**
- `packages/tranquilload-adapters/package.json` — add `@types/node` to `devDependencies`
- `packages/tranquilload-adapters/src/sources/from-node-readable.ts` — replace placeholder with real implementation

**Create:**
- `packages/tranquilload-adapters/src/sources/from-node-readable.test.ts` — new test file

**Do NOT touch:**
- `packages/tranquilload-adapters/tsdown.config.ts` — `from-node-readable` entry already configured
- `packages/tranquilload-adapters/package.json` exports — `./fromNodeReadable` export already configured
- `packages/tranquilload-core/` — no core changes needed
- Any other adapter files — out of scope

### Project Structure Notes

- Package: `@tranquilload/adapters` (`packages/tranquilload-adapters`)
- File: `src/sources/from-node-readable.ts` (kebab-case, matches tsdown entry key `from-node-readable`)
- Test: `src/sources/from-node-readable.test.ts` (co-located, `*.test.ts` naming)
- Export path: `@tranquilload/adapters/fromNodeReadable` (camelCase, maps to `./fromNodeReadable` in package.json)

### Lesson from Story 8.1

Story 8.1 (`fromFile`) was a pure function returning `{ stream, totalBytes }`. No `@types/node` was needed. This story differs: it requires Node.js types. Adding `@types/node` does NOT affect the `fromFile` adapter or any other adapter — it's a dev-only dependency for TypeScript type checking.

The `from-file.ts` pattern (pure function, no Effect, `vitest` not `@effect/vitest`) is the correct model to follow here.

### Triptyque obligatoire

`pnpm turbo build && pnpm turbo test && pnpm turbo typecheck` — all three must pass before marking the story done.

### References

- Epic 8 requirements: `_bmad-output/planning-artifacts/epics.md` (Story 8.2)
- Architecture adapters structure: `_bmad-output/planning-artifacts/architecture.md` (packages/adapters/ section, `from-node-readable.ts` boundary rule)
- Placeholder file: `packages/tranquilload-adapters/src/sources/from-node-readable.ts`
- Export map: `packages/tranquilload-adapters/package.json` (`./fromNodeReadable` entry)
- tsdown config: `packages/tranquilload-adapters/tsdown.config.ts` (`from-node-readable` entry)
- Reference adapter (same pure-function pattern): `packages/tranquilload-adapters/src/sources/from-file.ts`
- Error types: `packages/tranquilload-core/src/errors/upload-error.ts`

## Dev Agent Record

### Agent Model Used

Claude Opus 4.6

### Debug Log References

None — clean implementation, no issues encountered.

### Completion Notes List

- Added `@types/node` (latest) as devDependency to `@tranquilload/adapters` for `node:stream` type support
- Replaced placeholder in `from-node-readable.ts` with `Readable.toWeb(readable) as ReadableStream<Uint8Array>` — single-line adapter using Node 17+ static method
- Created `from-node-readable.test.ts` with 2 tests: byte streaming correctness and error propagation from Node Readable to ReadableStream
- Triptyque build/test/typecheck passed: 127 tests (112 core + 15 adapters), 0 regressions, 0 type errors
- Architecture boundary respected: `node:stream` imported only in `from-node-readable.ts` (and its test file)

### Change Log

- 2026-03-31: Implemented `fromNodeReadable` adapter — Node.js Readable to WHATWG ReadableStream conversion with error propagation

### File List

**Modified:**
- `packages/tranquilload-adapters/package.json` — added `@types/node` devDependency
- `packages/tranquilload-adapters/src/sources/from-node-readable.ts` — replaced placeholder with real implementation

**Created:**
- `packages/tranquilload-adapters/src/sources/from-node-readable.test.ts` — unit tests (2 tests)
