# Story 8.3: S3 Multipart Upload Adapter

Status: review

## Story

As a developer consuming the library,
I want an `s3MultipartUpload(s3Options)` adapter from `@tranquilload/adapters/s3MultipartUpload`,
so that I can wire `uploadMultipart` to S3 with correct part size constraints and presigned URL handling built in.

## Acceptance Criteria

1. **Given** `s3MultipartUpload({ bucket, key, getPresignedUrl, s3Client })` **When** spread into `uploadMultipart` **Then** it provides `uploadPart`, `completeUpload`, and `initiate` callbacks pre-configured for S3 **And** part size is validated against S3's 5 MiB minimum (all parts except last) — violation produces a typed error before upload starts.

2. **Given** `getPresignedUrl` rejects **When** a part attempts to upload **Then** the error is normalized and surfaces as `PresignedUrlError` in the typed error channel.

## Tasks / Subtasks

- [x] Task 1: Implement `s3MultipartUpload` in `s3-multipart-upload.ts` (AC: #1, #2)
  - [x] Replace the placeholder export with the real implementation
  - [x] Define `S3Client` minimal interface (no AWS SDK dep — structural typing only)
  - [x] Add synchronous `chunkSize` validation: throw if `chunkSize < S3_MIN_PART_SIZE` (5 MiB)
  - [x] Implement `initiate` async callback: calls `s3Client.createMultipartUpload`, stores `uploadId` in closure
  - [x] Implement `uploadPart` async callback: calls `getPresignedUrl(partNumber, uploadId)`, PUTs chunk via `fetch`, returns ETag
  - [x] Map `getPresignedUrl` rejection to `PresignedUrlError` in `uploadPart`
  - [x] Implement `completeUpload` async callback: calls `s3Client.completeMultipartUpload`, maps failure to `CompleteUploadError`
  - [x] Return `{ chunkSize, initiate, uploadPart, completeUpload }` — all ready to spread into `uploadMultipart`

- [x] Task 2: Write tests in `s3-multipart-upload.test.ts` (AC: #1, #2)
  - [x] Create `packages/tranquilload-adapters/src/protocols/s3-multipart-upload.test.ts`
  - [x] Test: throws synchronously when `chunkSize < 5 MiB`
  - [x] Test: `initiate` calls `s3Client.createMultipartUpload` with correct `{ Bucket, Key }` and returns `{ uploadId }`
  - [x] Test: `uploadPart` calls `getPresignedUrl(partNumber, uploadId)` then PUTs to the presigned URL
  - [x] Test: `uploadPart` returns the ETag from the S3 response (stripped of quotes)
  - [x] Test: `uploadPart` rejects with `PresignedUrlError` when `getPresignedUrl` rejects
  - [x] Test: `completeUpload` calls `s3Client.completeMultipartUpload` with correct params

- [x] Task 3: Triptyque build/test/typecheck (AC: all)
  - [x] `pnpm turbo build` — clean
  - [x] `pnpm turbo test` — all tests pass (134 passing, 0 regressions)
  - [x] `pnpm turbo typecheck` — no errors

## Dev Notes

### Implementation: `s3-multipart-upload.ts`

**Minimal interface — no AWS SDK dependency:**

```ts
interface S3Client {
  createMultipartUpload(params: {
    Bucket: string
    Key: string
  }): Promise<{ UploadId?: string }>

  completeMultipartUpload(params: {
    Bucket: string
    Key: string
    UploadId: string
    MultipartUpload: { Parts: ReadonlyArray<{ PartNumber: number; ETag: string }> }
  }): Promise<unknown>
}
```

This is structural typing — the actual `@aws-sdk/client-s3` `S3Client` instance satisfies this interface without being imported. Zero npm dependency on AWS SDK in the adapters package.

**Function signature:**

```ts
export interface S3MultipartUploadOptions {
  bucket: string
  key: string
  chunkSize?: number  // defaults to S3_MIN_PART_SIZE; validated >= 5 MiB if provided
  getPresignedUrl: (partNumber: number, uploadId: string) => string | Promise<string>
  s3Client: S3Client
}

export function s3MultipartUpload(options: S3MultipartUploadOptions): {
  chunkSize: number
  initiate: () => Promise<{ uploadId: string }>
  uploadPart: (partNumber: number, chunk: Uint8Array) => Promise<string>
  completeUpload: (uploadId: string, parts: ReadonlyArray<CompletedPart>) => Promise<void>
}
```

**Core implementation pattern:**

```ts
import { CompleteUploadError, PartUploadError, PresignedUrlError } from "@tranquilload/core/errors"
import type { CompletedPart } from "@tranquilload/core/multipart"

const S3_MIN_PART_SIZE = 5 * 1024 * 1024  // 5 MiB in bytes

export function s3MultipartUpload(options: S3MultipartUploadOptions) {
  const { bucket, key, chunkSize = S3_MIN_PART_SIZE, getPresignedUrl, s3Client } = options

  // Synchronous validation — typed error before upload starts
  if (chunkSize < S3_MIN_PART_SIZE) {
    throw new Error(
      `S3 requires chunkSize >= ${S3_MIN_PART_SIZE} bytes (5 MiB), received ${chunkSize} bytes`
    )
  }

  // Captured in closure by initiate, used by uploadPart
  let storedUploadId = ""

  const initiate = async (): Promise<{ uploadId: string }> => {
    const result = await s3Client.createMultipartUpload({ Bucket: bucket, Key: key })
    if (!result.UploadId) throw new Error("S3 CreateMultipartUpload did not return an UploadId")
    storedUploadId = result.UploadId
    return { uploadId: storedUploadId }
  }

  const uploadPart = async (partNumber: number, chunk: Uint8Array): Promise<string> => {
    let url: string
    try {
      url = await Promise.resolve(getPresignedUrl(partNumber, storedUploadId))
    } catch (cause) {
      throw new PresignedUrlError(cause)
    }
    const response = await fetch(url, { method: "PUT", body: chunk })
    if (!response.ok) {
      throw new PartUploadError(
        partNumber,
        0,
        new Error(`S3 PUT failed: HTTP ${response.status} ${response.statusText}`)
      )
    }
    const rawEtag = response.headers.get("ETag") ?? response.headers.get("etag")
    if (!rawEtag) {
      throw new PartUploadError(partNumber, 0, new Error("S3 response missing ETag header"))
    }
    return rawEtag.replace(/"/g, "")  // S3 wraps ETag in quotes, strip them
  }

  const completeUpload = async (
    uploadId: string,
    parts: ReadonlyArray<CompletedPart>
  ): Promise<void> => {
    try {
      await s3Client.completeMultipartUpload({
        Bucket: bucket,
        Key: key,
        UploadId: uploadId,
        MultipartUpload: {
          Parts: parts.map((p) => ({ PartNumber: p.partNumber, ETag: p.etag })),
        },
      })
    } catch (cause) {
      throw new CompleteUploadError(cause)
    }
  }

  return { chunkSize, initiate, uploadPart, completeUpload }
}
```

### CRITICAL: uploadId Closure Pattern

`uploadPart` receives only `(partNumber, chunk)` — no uploadId. But S3 presigned URLs require the uploadId. Solution: `initiate` stores the uploadId in a closure variable `storedUploadId`. `uploadPart` reads it from the closure when called. This works because `initiate` always runs before any `uploadPart` calls (enforced by `upload-stream.ts`).

### CRITICAL: PresignedUrlError Propagation

`uploadPart` throws `PresignedUrlError` directly. When this callback goes through `upload-stream.ts`, `normalizeCallback` wraps it via `Effect.tryPromise`, then `Effect.mapError` re-wraps it as `PartUploadError(n, m, presignedUrlError)`. So at the stream level, the error is `PartUploadError` with `cause = PresignedUrlError`.

**In adapter unit tests**, test `uploadPart` in isolation — call it directly and assert it `rejects` with `PresignedUrlError`. Do NOT go through `uploadMultipart` for this assertion.

This is per the established pattern (MEMORY: "normalizeCallback double-wrapping: passing an Effect-typed callback to `uploadPart` causes double-wrapping — use raw throw/Promise.reject in test callbacks").

### CRITICAL: No Effect imports in the adapter

This adapter uses only `async/await` (no Effect internals). It imports:
- `PresignedUrlError`, `PartUploadError`, `CompleteUploadError` from `@tranquilload/core/errors`
- `CompletedPart` (type import) from `@tranquilload/core/multipart`

Do NOT import from `effect` directly. Do NOT use `normalizeCallback` or `Effect.gen` in the adapter — those are internal core utilities.

### CRITICAL: Architecture Boundary

- This adapter lives in `packages/tranquilload-adapters/src/protocols/s3-multipart-upload.ts`
- It is the only place S3-specific logic lives — never leak S3 concerns into core
- Uses `fetch` (global) for presigned URL PUT — no Node.js imports needed, fully runtime-agnostic
- `@types/node` is already in adapters devDependencies (from story 8.2) — no new deps needed

### ETag Stripping

S3 returns ETags wrapped in double quotes, e.g. `"abc123"`. The `completeMultipartUpload` call requires unquoted ETags. Strip with `.replace(/"/g, "")`.

### Testing: `s3-multipart-upload.test.ts`

Use `vitest` (`it`, `describe`, `expect`, `vi`) — NOT `@effect/vitest`. The adapter is pure async/await with no Effect.

```ts
import { describe, it, expect, vi } from 'vitest'
import { PresignedUrlError, PartUploadError } from '@tranquilload/core/errors'
import { s3MultipartUpload, S3_MIN_PART_SIZE } from './s3-multipart-upload.js'

// Mock s3Client
const makeMockS3Client = (overrides = {}) => ({
  createMultipartUpload: vi.fn().mockResolvedValue({ UploadId: 'upload-123' }),
  completeMultipartUpload: vi.fn().mockResolvedValue({}),
  ...overrides,
})

// Mock fetch via vi.stubGlobal
```

**Test: synchronous validation**
```ts
it('throws synchronously when chunkSize < 5 MiB', () => {
  expect(() =>
    s3MultipartUpload({
      bucket: 'b', key: 'k',
      chunkSize: 1024,  // 1 KiB — below 5 MiB minimum
      getPresignedUrl: vi.fn(),
      s3Client: makeMockS3Client(),
    })
  ).toThrow()
})
```

**Test: initiate**
```ts
it('initiate calls createMultipartUpload with bucket and key', async () => {
  const s3Client = makeMockS3Client()
  const adapter = s3MultipartUpload({ bucket: 'my-bucket', key: 'my-key', getPresignedUrl: vi.fn(), s3Client })
  const result = await adapter.initiate()
  expect(s3Client.createMultipartUpload).toHaveBeenCalledWith({ Bucket: 'my-bucket', Key: 'my-key' })
  expect(result).toEqual({ uploadId: 'upload-123' })
})
```

**Test: uploadPart calls getPresignedUrl and PUTs to presigned URL**
```ts
it('uploadPart calls getPresignedUrl with partNumber and uploadId then PUTs chunk', async () => {
  const getPresignedUrl = vi.fn().mockResolvedValue('https://s3.example.com/presigned')
  const s3Client = makeMockS3Client()
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    headers: new Headers({ ETag: '"etag-abc"' }),
  })
  vi.stubGlobal('fetch', fetchMock)

  const adapter = s3MultipartUpload({ bucket: 'b', key: 'k', getPresignedUrl, s3Client })
  await adapter.initiate()  // populate storedUploadId
  const etag = await adapter.uploadPart(1, new Uint8Array([1, 2, 3]))

  expect(getPresignedUrl).toHaveBeenCalledWith(1, 'upload-123')
  expect(fetchMock).toHaveBeenCalledWith('https://s3.example.com/presigned', {
    method: 'PUT',
    body: expect.any(Uint8Array),
  })
  expect(etag).toBe('etag-abc')  // quotes stripped
})
```

**Test: getPresignedUrl rejection → PresignedUrlError**
```ts
it('uploadPart rejects with PresignedUrlError when getPresignedUrl rejects', async () => {
  const getPresignedUrl = vi.fn().mockRejectedValue(new Error('no URL'))
  const adapter = s3MultipartUpload({ bucket: 'b', key: 'k', getPresignedUrl, s3Client: makeMockS3Client() })
  await adapter.initiate()
  await expect(adapter.uploadPart(1, new Uint8Array())).rejects.toBeInstanceOf(PresignedUrlError)
})
```

**Test: completeUpload**
```ts
it('completeUpload calls s3Client.completeMultipartUpload with correct structure', async () => {
  const s3Client = makeMockS3Client()
  const adapter = s3MultipartUpload({ bucket: 'b', key: 'k', getPresignedUrl: vi.fn(), s3Client })
  await adapter.completeUpload('upload-123', [{ partNumber: 1, etag: 'etag-1' }])
  expect(s3Client.completeMultipartUpload).toHaveBeenCalledWith({
    Bucket: 'b', Key: 'k', UploadId: 'upload-123',
    MultipartUpload: { Parts: [{ PartNumber: 1, ETag: 'etag-1' }] },
  })
})
```

**Note on `vi.stubGlobal`:** Call `vi.unstubAllGlobals()` in `afterEach` or use `vi.stubGlobal` inside individual tests to avoid cross-test contamination.

### Exporting `S3_MIN_PART_SIZE`

Consider exporting `S3_MIN_PART_SIZE` as a named constant so users can use it with `computeOptimalPartSize`:
```ts
export const S3_MIN_PART_SIZE = 5 * 1024 * 1024
```

Users can then: `computeOptimalPartSize({ totalBytes, targetPartCount: 10, minPartSize: S3_MIN_PART_SIZE })`

### Usage Pattern

```ts
import { s3MultipartUpload, S3_MIN_PART_SIZE } from "@tranquilload/adapters/s3MultipartUpload"
import { uploadMultipart } from "@tranquilload/core/multipart"
import { S3Client } from "@aws-sdk/client-s3"
import { getSignedUrl } from "@aws-sdk/s3-request-presigner"
import { UploadPartCommand } from "@aws-sdk/client-s3"

const s3 = new S3Client({ region: "us-east-1" })

const result = uploadMultipart({
  stream: fileStream,
  ...s3MultipartUpload({
    bucket: "my-bucket",
    key: "uploads/my-file.bin",
    chunkSize: S3_MIN_PART_SIZE,
    getPresignedUrl: (partNumber, uploadId) =>
      getSignedUrl(s3, new UploadPartCommand({
        Bucket: "my-bucket", Key: "uploads/my-file.bin",
        PartNumber: partNumber, UploadId: uploadId,
      }), { expiresIn: 3600 }),
    s3Client: s3,
  }),
})
```

### Files to Touch

**Modify:**
- `packages/tranquilload-adapters/src/protocols/s3-multipart-upload.ts` — replace placeholder with real implementation

**Create:**
- `packages/tranquilload-adapters/src/protocols/s3-multipart-upload.test.ts` — new test file

**Do NOT touch:**
- `packages/tranquilload-adapters/tsdown.config.ts` — `s3-multipart-upload` entry already configured
- `packages/tranquilload-adapters/package.json` exports — `./s3MultipartUpload` already configured
- `packages/tranquilload-core/` — no core changes needed
- `packages/tranquilload-adapters/src/protocols/simple-http-upload.ts` — story 8.4 scope
- Any other adapter files — out of scope

### Project Structure Notes

- Package: `@tranquilload/adapters` (`packages/tranquilload-adapters`)
- File: `src/protocols/s3-multipart-upload.ts` (kebab-case, matches tsdown entry key `s3-multipart-upload`)
- Test: `src/protocols/s3-multipart-upload.test.ts` (co-located, `*.test.ts` naming)
- Export path: `@tranquilload/adapters/s3MultipartUpload` (camelCase, maps to `./s3MultipartUpload` in package.json)
- Architecture: adapters in `packages/adapters/src/protocols/` per directory structure doc

### References

- Epic 8 requirements: `_bmad-output/planning-artifacts/epics.md` (Story 8.3)
- Architecture adapters boundary: `_bmad-output/planning-artifacts/architecture.md` (Architectural Boundaries section)
- Core multipart options interface: `packages/tranquilload-core/src/multipart/upload-stream.ts` (`UploadMultipartOptions`)
- Error types: `packages/tranquilload-core/src/errors/upload-error.ts`
- CompletedPart type: `packages/tranquilload-core/src/multipart/upload-stream.ts` (exported from `@tranquilload/core/multipart`)
- Optimal part size helper: `packages/tranquilload-adapters/src/resilience/optimal-part-size.ts` (`computeOptimalPartSize`, `S3_MIN_PART_SIZE` integration)
- Previous adapter (same pure-function pattern): `packages/tranquilload-adapters/src/sources/from-file.ts`, `from-node-readable.ts`
- Placeholder file: `packages/tranquilload-adapters/src/protocols/s3-multipart-upload.ts`
- tsdown config: `packages/tranquilload-adapters/tsdown.config.ts`

## Dev Agent Record

### Agent Model Used

Claude Opus 4.6

### Debug Log References

- Fixed cross-package typecheck: core and adapters `package.json` exports pointed to `.js`/`.d.ts` but tsdown generates `.mjs`/`.d.mts`. Updated both packages' exports to use correct extensions.
- Fixed `Uint8Array` not assignable to `BodyInit` in `fetch` call: cast via `as unknown as BodyInit` due to `@types/node` vs DOM lib type conflict.
- Added vitest alias in adapters `vitest.config.ts` to resolve `@tranquilload/core` imports to source for cross-package testing.

### Completion Notes List

- Implemented `s3MultipartUpload` adapter with structural S3Client typing (zero AWS SDK dependency)
- Synchronous chunkSize validation against S3's 5 MiB minimum
- `initiate` stores uploadId in closure for `uploadPart` to use
- `uploadPart` fetches presigned URL, PUTs chunk, strips ETag quotes
- `completeUpload` maps parts to S3 format and delegates to s3Client
- Error mapping: `PresignedUrlError` for URL failures, `CompleteUploadError` for completion failures, `PartUploadError` for HTTP failures
- 7 tests covering all callbacks, validation, error paths
- Triptyque: build clean, 134 tests passing (0 regressions), typecheck clean

### Change Log

- 2026-03-31: Implemented s3MultipartUpload adapter (Story 8.3)
- 2026-03-31: Fixed package.json exports in core and adapters to match tsdown output extensions (.mjs/.d.mts)
- 2026-03-31: Added vitest resolve alias for cross-package @tranquilload/core imports

### File List

- `packages/tranquilload-adapters/src/protocols/s3-multipart-upload.ts` — replaced placeholder with full implementation
- `packages/tranquilload-adapters/src/protocols/s3-multipart-upload.test.ts` — new, 7 tests
- `packages/tranquilload-adapters/vitest.config.ts` — added resolve alias for @tranquilload/core
- `packages/tranquilload-adapters/package.json` — fixed exports extensions (.js → .mjs, .d.ts → .d.mts)
- `packages/tranquilload-core/package.json` — fixed exports extensions (.js → .mjs, .d.ts → .d.mts)
