# Story 8.4: Simple HTTP Upload Adapter

Status: review

## Story

As a developer consuming the library,
I want a `simpleHttpUpload(httpOptions)` adapter from `@tranquilload/adapters/simpleHttpUpload`,
so that I can wire `uploadOnce` to any HTTP endpoint with a single PUT or POST request.

## Acceptance Criteria

1. **Given** `simpleHttpUpload({ url, method: "PUT", headers? })` **When** spread into `uploadOnce` **Then** the stream is sent as the request body using `fetch` **And** a non-2xx response produces a `CompleteUploadError` in the typed error channel.

2. **Given** an `AbortSignal` is passed to the adapter **When** `controller.abort()` is called mid-request **Then** the `fetch` call is aborted via the signal **And** `AbortError` surfaces in the typed error channel.

## Tasks / Subtasks

- [x] Task 1: Implement `simpleHttpUpload` in `simple-http-upload.ts` (AC: #1, #2)
  - [x] Replace the placeholder export with the real implementation
  - [x] Define `SimpleHttpUploadOptions` interface: `url`, `method?: "PUT" | "POST"`, `headers?: Record<string, string>`, `signal?: AbortSignal`
  - [x] Implement the `upload` async callback: calls `fetch(url, { method, headers, body: stream, signal })`
  - [x] Non-2xx response → throw `CompleteUploadError(new Error(`HTTP ${status} ${statusText}`))`
  - [x] Fetch throws abort DOMException (name === `'AbortError'`) → throw Tranquilload `AbortError`
  - [x] Any other fetch error (network failure) → throw `CompleteUploadError(cause)`
  - [x] Return `{ upload }` — spreads into `uploadOnce`

- [x] Task 2: Write tests in `simple-http-upload.test.ts` (AC: #1, #2)
  - [x] Create `packages/tranquilload-adapters/src/protocols/simple-http-upload.test.ts`
  - [x] Test: `upload` calls `fetch` with correct `url`, `method`, `headers`, and the stream as `body`
  - [x] Test: non-2xx response rejects with `CompleteUploadError`
  - [x] Test: fetch throws `DOMException` with `name === 'AbortError'` → rejects with `AbortError`
  - [x] Test: fetch throws a network error → rejects with `CompleteUploadError`
  - [x] Test: `method` defaults to `"PUT"` when omitted

- [x] Task 3: Triptyque build/test/typecheck (AC: all)
  - [x] `pnpm turbo build` — clean
  - [x] `pnpm turbo test` — all tests pass, 0 regressions
  - [x] `pnpm turbo typecheck` — no errors

## Dev Notes

### Implementation: `simple-http-upload.ts`

**Interface:**

```ts
import { AbortError, CompleteUploadError } from "@tranquilload/core/errors"

export interface SimpleHttpUploadOptions {
  url: string
  method?: "PUT" | "POST"
  headers?: Record<string, string>
  signal?: AbortSignal
}

export function simpleHttpUpload(options: SimpleHttpUploadOptions): {
  upload: (stream: ReadableStream<Uint8Array>) => Promise<void>
}
```

**Core implementation:**

```ts
export function simpleHttpUpload(options: SimpleHttpUploadOptions) {
  const { url, method = "PUT", headers, signal } = options

  const upload = async (stream: ReadableStream<Uint8Array>): Promise<void> => {
    let response: Response
    try {
      response = await fetch(url, {
        method,
        headers,
        body: stream as unknown as BodyInit,  // @types/node vs DOM lib conflict — same cast as s3 adapter
        signal,
      })
    } catch (cause) {
      if (cause instanceof Error && cause.name === "AbortError") {
        throw new AbortError()
      }
      throw new CompleteUploadError(cause)
    }
    if (!response.ok) {
      throw new CompleteUploadError(
        new Error(`HTTP ${response.status} ${response.statusText}`)
      )
    }
  }

  return { upload }
}
```

### CRITICAL: No Effect imports — pure async/await

This adapter uses only `async/await`, same pattern as the S3 adapter (story 8.3). Do NOT import from `effect`. Do NOT use `normalizeCallback`, `Effect.gen`, or `Stream`. Only imports needed:
- `AbortError`, `CompleteUploadError` from `@tranquilload/core/errors`

### CRITICAL: AbortError identity — Tranquilload's, not the DOM's

When `fetch` is aborted, it throws a `DOMException` (or plain `Error` on older runtimes) with `name === 'AbortError'`. The `upload.ts` `mapError` checks `if (cause instanceof AbortError) return cause` — this tests Tranquilload's `AbortError` class, not the DOM's. So the adapter MUST catch the native abort error and re-throw as `new AbortError()` (from `@tranquilload/core/errors`) for the abort to propagate correctly through the error channel.

Without this, a fetch abort would become `CompleteUploadError(DOMException)` instead of `AbortError`.

### CRITICAL: `body: stream as unknown as BodyInit` cast

`@types/node` overrides the global `fetch` types and `BodyInit` in its `lib.dom.d.ts`-compatible definitions. `ReadableStream<Uint8Array>` may not be directly assignable to `BodyInit` in TypeScript, even though Node.js 22 supports it at runtime. Use the same cast pattern established in story 8.3 for `Uint8Array`:

```ts
body: stream as unknown as BodyInit
```

If `ReadableStream` turns out to be directly assignable (TypeScript gives no error without the cast), omit the cast. Check during typecheck step.

### CRITICAL: `fetch` streaming body in Node.js 22

Node.js 22 supports `ReadableStream` as a `fetch` body without requiring `duplex: 'half'`. If you encounter a TypeScript or runtime error about streaming bodies, try:

```ts
body: stream as unknown as BodyInit,
// If needed:
// (fetch as Function)(url, { method, headers, body: stream, signal, duplex: 'half' })
```

Do NOT add `duplex: 'half'` unless the runtime requires it — it's not in `RequestInit` typings and would require a cast.

### CRITICAL: `mapError` in `upload.ts` passes `AbortError` through

From `packages/tranquilload-core/src/oneshot/upload.ts:30-33`:
```ts
Effect.mapError((cause): UploadError => {
  if (cause instanceof AbortError) return cause
  return new CompleteUploadError(cause)
})
```

The `upload` callback's thrown error is caught by `normalizeCallback` and fed through `mapError`. Throwing Tranquilload's `AbortError` in the adapter ensures it reaches the error channel as `AbortError`, not wrapped in `CompleteUploadError`.

### CRITICAL: Signal threading — adapter vs uploadOnce

The adapter's `signal` is separate from `uploadOnce`'s `signal`:
- **Adapter signal**: passed to `fetch` for network-level cancellation (cancels the HTTP request itself)
- **uploadOnce signal**: used by `Effect.raceFirst` for Effect-level abort racing

For full cancellation, the user can pass the same `AbortController.signal` to both:
```ts
const controller = new AbortController()
uploadOnce({
  stream: myStream,
  ...simpleHttpUpload({ url: "...", method: "PUT", signal: controller.signal }),
  signal: controller.signal,  // optional: also races at Effect level
})
```

The adapter's signal is sufficient to abort the underlying `fetch` and surface `AbortError`.

### Testing: `simple-http-upload.test.ts`

Use `vitest` (`it`, `describe`, `expect`, `vi`) — NOT `@effect/vitest`. Same pattern as S3 adapter tests.

```ts
import { describe, it, expect, vi, afterEach } from 'vitest'
import { AbortError, CompleteUploadError } from '@tranquilload/core/errors'
import { simpleHttpUpload } from './simple-http-upload.js'

afterEach(() => {
  vi.unstubAllGlobals()
})
```

**Test: fetch called with correct params:**
```ts
it('upload calls fetch with url, method, headers, and stream as body', async () => {
  const stream = new ReadableStream()
  const fetchMock = vi.fn().mockResolvedValue({ ok: true })
  vi.stubGlobal('fetch', fetchMock)

  const adapter = simpleHttpUpload({ url: 'https://example.com/upload', method: 'PUT', headers: { 'x-foo': 'bar' } })
  await adapter.upload(stream)

  expect(fetchMock).toHaveBeenCalledWith(
    'https://example.com/upload',
    expect.objectContaining({ method: 'PUT', headers: { 'x-foo': 'bar' }, body: stream })
  )
})
```

**Test: default method is PUT:**
```ts
it('method defaults to PUT when omitted', async () => {
  const fetchMock = vi.fn().mockResolvedValue({ ok: true })
  vi.stubGlobal('fetch', fetchMock)
  const adapter = simpleHttpUpload({ url: 'https://example.com/upload' })
  await adapter.upload(new ReadableStream())
  expect(fetchMock).toHaveBeenCalledWith(
    'https://example.com/upload',
    expect.objectContaining({ method: 'PUT' })
  )
})
```

**Test: non-2xx → CompleteUploadError:**
```ts
it('rejects with CompleteUploadError when response is not ok', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 403, statusText: 'Forbidden' }))
  const adapter = simpleHttpUpload({ url: 'https://example.com/upload' })
  await expect(adapter.upload(new ReadableStream())).rejects.toBeInstanceOf(CompleteUploadError)
})
```

**Test: fetch abort → AbortError:**
```ts
it('rejects with AbortError when fetch is aborted (DOMException name AbortError)', async () => {
  const abortError = new DOMException('The operation was aborted.', 'AbortError')
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(abortError))
  const adapter = simpleHttpUpload({ url: 'https://example.com/upload' })
  await expect(adapter.upload(new ReadableStream())).rejects.toBeInstanceOf(AbortError)
})
```

**Test: network error → CompleteUploadError:**
```ts
it('rejects with CompleteUploadError on network failure', async () => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Failed to fetch')))
  const adapter = simpleHttpUpload({ url: 'https://example.com/upload' })
  await expect(adapter.upload(new ReadableStream())).rejects.toBeInstanceOf(CompleteUploadError)
})
```

### Files to Touch

**Modify:**
- `packages/tranquilload-adapters/src/protocols/simple-http-upload.ts` — replace placeholder with real implementation

**Create:**
- `packages/tranquilload-adapters/src/protocols/simple-http-upload.test.ts` — test file

**Do NOT touch:**
- `packages/tranquilload-adapters/tsdown.config.ts` — `simple-http-upload` entry already configured
- `packages/tranquilload-adapters/package.json` — `./simpleHttpUpload` export already configured
- `packages/tranquilload-core/` — no core changes needed
- Any other adapter files — out of scope

### Project Structure Notes

- Package: `@tranquilload/adapters` (`packages/tranquilload-adapters`)
- File: `src/protocols/simple-http-upload.ts` (kebab-case, matches tsdown entry key `simple-http-upload`)
- Test: `src/protocols/simple-http-upload.test.ts` (co-located, `*.test.ts` naming)
- Export path: `@tranquilload/adapters/simpleHttpUpload` (camelCase, maps to `./simpleHttpUpload` in package.json)

### Usage Pattern

```ts
import { simpleHttpUpload } from "@tranquilload/adapters/simpleHttpUpload"
import { uploadOnce } from "@tranquilload/core/multipart"

const controller = new AbortController()

const { events, result } = uploadOnce({
  stream: fileStream,
  ...simpleHttpUpload({
    url: "https://api.example.com/uploads/my-file.bin",
    method: "PUT",
    headers: { "Content-Type": "application/octet-stream" },
    signal: controller.signal,  // optional: aborts the fetch call
  }),
  signal: controller.signal,   // optional: races at Effect level too
})
```

### References

- Epic 8 requirements: `_bmad-output/planning-artifacts/epics.md` (Story 8.4)
- UploadOnceOptions interface: `packages/tranquilload-core/src/oneshot/upload.ts:9-15`
- mapError logic (AbortError passthrough): `packages/tranquilload-core/src/oneshot/upload.ts:30-33`
- AbortError class: `packages/tranquilload-core/src/errors/upload-error.ts:63-69`
- CompleteUploadError class: `packages/tranquilload-core/src/errors/upload-error.ts`
- S3 adapter (same pure-function pattern): `packages/tranquilload-adapters/src/protocols/s3-multipart-upload.ts`
- tsdown config: `packages/tranquilload-adapters/tsdown.config.ts`
- Adapters vitest config (resolve alias for @tranquilload/core): `packages/tranquilload-adapters/vitest.config.ts`
- Previous story (8.3) learnings: `_bmad-output/implementation-artifacts/8-3-s3-multipart-upload-adapter.md`

## Dev Agent Record

### Agent Model Used

Claude Opus 4.6

### Debug Log References

No issues encountered.

### Completion Notes List

- Replaced placeholder in `simple-http-upload.ts` with full `simpleHttpUpload()` implementation
- Pure async/await adapter (no Effect imports), same pattern as S3 adapter (8.3)
- `SimpleHttpUploadOptions` interface: `url`, `method?: "PUT" | "POST"`, `headers?`, `signal?`
- Error mapping: non-2xx → `CompleteUploadError`, fetch abort (DOMException) → Tranquilload `AbortError`, network error → `CompleteUploadError`
- `body: stream as unknown as BodyInit` cast for `@types/node` compatibility
- 5 unit tests covering all AC paths: correct fetch params, default PUT method, non-2xx, abort, network failure
- Triptyque build/test/typecheck all green — 149 tests, 0 regressions

### File List

- `packages/tranquilload-adapters/src/protocols/simple-http-upload.ts` (modified)
- `packages/tranquilload-adapters/src/protocols/simple-http-upload.test.ts` (created)

### Change Log

- 2026-04-01: Implemented `simpleHttpUpload` adapter with full test coverage (Story 8.4)
