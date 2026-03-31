# Story 8.1: File Source Adapter

Status: review

## Story

As a developer consuming the library,
I want a `fromFile(file: File)` adapter from `@tranquilload/adapters/fromFile`,
so that I can feed a browser `File` object directly to `uploadMultipart` or `uploadOnce` with `totalBytes` and a stream pre-configured.

## Acceptance Criteria

1. **Given** a browser `File` object **When** the developer calls `fromFile(file)` **Then** it returns `{ stream: ReadableStream<Uint8Array>, totalBytes: number }` ready to spread into upload options **And** it uses only `globalThis` APIs — no `window` reference.

2. **Given** `fromFile(file)` result is spread into `uploadMultipart` **When** the upload runs **Then** `ProgressTick` events carry accurate `totalBytes` derived from `file.size`.

## Tasks / Subtasks

- [x] Task 1: Implement `fromFile` in `from-file.ts` (AC: #1)
  - [x] Replace the placeholder export with a real implementation
  - [x] `fromFile(file: File): { stream: ReadableStream<Uint8Array>, totalBytes: number }`
  - [x] Use `file.stream()` for the ReadableStream, `file.size` for totalBytes
  - [x] No `window` reference — `File` is passed in by the caller, not constructed internally

- [x] Task 2: Write tests in `from-file.test.ts` (AC: #1, #2)
  - [x] Create `packages/tranquilload-adapters/src/sources/from-file.test.ts`
  - [x] Test: `fromFile(file).totalBytes === file.size`
  - [x] Test: stream yields all bytes from the file (read stream to completion, compare bytes)
  - [x] Remove `src/scaffold.test.ts` once the real test file exists (vitest 3.x requires at least one test file; `from-file.test.ts` satisfies this)

- [x] Task 3: Triptyque build/test/typecheck (AC: all)
  - [x] `pnpm turbo build` — clean
  - [x] `pnpm turbo test` — all tests pass
  - [x] `pnpm turbo typecheck` — no errors

## Dev Notes

### What `fromFile` Must Do

Pure function — no Effect, no services. It adapts a browser `File` into the shape expected by `uploadMultipart` and `uploadOnce`:

```ts
export function fromFile(file: File): { stream: ReadableStream<Uint8Array>; totalBytes: number } {
  return {
    stream: file.stream(),
    totalBytes: file.size,
  }
}
```

- `file.stream()` — WHATWG `Blob.stream()`, returns `ReadableStream<Uint8Array>`. Available in Node 20+, all modern browsers, Bun, Deno. No `globalThis.File` access needed inside the adapter — `File` is the type of the parameter.
- `file.size` — integer number of bytes. Exact, always known for a `File` object.
- No `window` reference anywhere — `File` is a `globalThis` type, not a `window` property.

### Usage Pattern (for context only)

```ts
import { fromFile } from "@tranquilload/adapters/fromFile"
import { uploadMultipart } from "@tranquilload/core/multipart"

const { stream, totalBytes } = fromFile(file)
await uploadMultipart({ stream, totalBytes, chunkSize: 5 * 1024 * 1024, uploadPart, completeUpload })
```

The spread pattern `{ ...fromFile(file), chunkSize, uploadPart, completeUpload }` also works.

### Files to Touch

**Modify:**
- `packages/tranquilload-adapters/src/sources/from-file.ts` — replace placeholder with real implementation

**Create:**
- `packages/tranquilload-adapters/src/sources/from-file.test.ts` — new test file

**Delete:**
- `packages/tranquilload-adapters/src/scaffold.test.ts` — placeholder, replaced by the real test file above

**Do NOT touch:**
- `packages/tranquilload-adapters/tsdown.config.ts` — `from-file` entry point already configured
- `packages/tranquilload-adapters/package.json` — `./fromFile` export already configured
- `packages/tranquilload-core/` — no core changes needed
- Any protocol adapters (`s3-multipart-upload.ts`, `simple-http-upload.ts`, `from-node-readable.ts`) — out of scope

### Testing: `from-file.test.ts`

Use `it` from `vitest` (NOT `@effect/vitest`) — this is a pure function, no Effect involved.

```ts
import { describe, it, expect } from 'vitest'
import { fromFile } from './from-file.js'

describe('fromFile', () => {
  it('returns totalBytes equal to file.size', () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5])
    const file = new File([bytes], 'test.bin', { type: 'application/octet-stream' })

    const result = fromFile(file)

    expect(result.totalBytes).toBe(5)
  })

  it('stream yields all file bytes', async () => {
    const bytes = new Uint8Array([10, 20, 30, 40])
    const file = new File([bytes], 'test.bin')

    const { stream } = fromFile(file)

    const reader = stream.getReader()
    const chunks: Uint8Array[] = []
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
    }

    const all = new Uint8Array(chunks.reduce((acc, c) => acc + c.length, 0))
    let offset = 0
    for (const chunk of chunks) { all.set(chunk, offset); offset += chunk.length }

    expect(Array.from(all)).toEqual([10, 20, 30, 40])
  })
})
```

`File` is available in Node.js 20+ as a global — no imports needed. Vitest runs on Node 22+ per this project's constraint.

### Export Map Already Configured

The `package.json` `./fromFile` export and `tsdown.config.ts` `from-file` entry are already in place (set up in Epic 1 scaffolding). No changes needed there.

### TypeScript Type for `File`

`File` is part of `lib.dom.d.ts`. The adapters package does NOT include DOM lib (it targets Node + browser). To type `File` correctly, either:
- Add `"DOM"` to `lib` in `packages/tranquilload-adapters/tsconfig.json` (preferred — same approach used in core for `CompressionStream`), OR
- Import the type from `node:buffer` (Node 20+ exposes `File` there)

Check the existing `tsconfig.json` in `packages/tranquilload-adapters` before deciding — if `DOM` is already included, no changes needed.

### Project Structure Notes

- Package: `@tranquilload/adapters` (`packages/tranquilload-adapters`)
- File: `src/sources/from-file.ts` (kebab-case, matches the export key `from-file` in tsdown config)
- Test: `src/sources/from-file.test.ts` (co-located, `*.test.ts` naming)
- No sub-path imports from `@tranquilload/core` needed for this pure adapter

### Triptyque obligatoire

`pnpm turbo build && pnpm turbo test && pnpm turbo typecheck` — les trois doivent passer avant de marquer la story done.

### References

- Epic 8 requirements: `_bmad-output/planning-artifacts/epics.md#Epic 8`
- Architecture adapters structure: `_bmad-output/planning-artifacts/architecture.md` (packages/adapters/ section)
- Placeholder file: `packages/tranquilload-adapters/src/sources/from-file.ts`
- Export map: `packages/tranquilload-adapters/package.json` (`./fromFile` entry)
- tsdown config: `packages/tranquilload-adapters/tsdown.config.ts`
- Resilience adapter reference (similar pure-function pattern): `packages/tranquilload-adapters/src/resilience/optimal-part-size.ts`

## Dev Agent Record

### Agent Model Used

Claude Sonnet 4.6

### Debug Log References

None — straightforward implementation, no debugging needed.

### Completion Notes List

- Implemented `fromFile` as a pure function: `file.stream()` for the ReadableStream, `file.size` for totalBytes
- Tests written TDD-style (RED confirmed, then GREEN): totalBytes assertion + full stream byte verification
- Removed `scaffold.test.ts` placeholder — `from-file.test.ts` now satisfies vitest 3.x requirement
- No tsconfig changes needed — `DOM` lib already included via `tsconfig.base.json`
- Triptyque passed: build clean, 125 tests pass (0 regressions), typecheck clean

### Change Log

- 2026-03-31: Implemented `fromFile` adapter, added tests, removed scaffold placeholder

### File List

- `packages/tranquilload-adapters/src/sources/from-file.ts` — modified (placeholder → real implementation)
- `packages/tranquilload-adapters/src/sources/from-file.test.ts` — created (2 tests)
- `packages/tranquilload-adapters/src/scaffold.test.ts` — deleted (replaced by from-file.test.ts)
