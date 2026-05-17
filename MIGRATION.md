# Migration Guide

This document describes breaking and behavioural changes between Tranquilload
releases that require user action.

## v0.1.x → v0.2.x — `@tranquilload/core`

### Resume API redesigned around `ResumeState`

The old resume pattern was: persist the `uploadId` yourself, then return it
from `initiate` on the next session. The lib trusted you and uploaded against
the stored id. This had three silent-corruption gaps:

1. **ChunkSize mismatch.** Change `chunkSize` between sessions → the lib
   slices the file differently, parts no longer line up, completed object is
   corrupt.
2. **Content mismatch.** Resume with a different file of the same name/size →
   the lib uploads the wrong bytes against the stored `uploadId`.
3. **Pipeline mismatch.** Resume with a different compression algorithm →
   you produce a Frankenstein object (some parts gzip, some plain).

v0.2.x introduces an opaque `ResumeState` that the lib produces, you persist,
and the lib re-validates. A mismatch fails the upload with
`ResumeMismatchError` **before any byte is uploaded** — no orphan multiparts,
no silent corruption.

### Before (v0.1.x)

```ts
// First session
const stored = localStorage.getItem("uploadId")
const { uploadId, result } = uploadMultipart({
  stream,
  chunkSize: 5 * 1024 * 1024,
  initiate: stored
    ? () => ({ uploadId: stored })          // ← legacy resume pattern
    : () => fetchFreshInit(),
  reconcileCompletedParts: () => listParts(stored),
  uploadPart,
  completeUpload,
})
const id = await uploadId
localStorage.setItem("uploadId", id)
```

### After (v0.2.x)

```ts
// First session — fresh init
const { resumeState, result } = uploadMultipart({
  stream,
  chunkSize: 5 * 1024 * 1024,
  initiate: () => fetchFreshInit(),
  getContentDigest: () => `${file.name}|${file.size}|${file.lastModified}`,
  pipelineIdentity: "deflate-v1",                  // if you use a pipeline
  uploadPart,
  completeUpload,
})

const state = await resumeState
localStorage.setItem("resumeState", JSON.stringify(state))
await result
localStorage.removeItem("resumeState")

// Subsequent session — resume
const stored = localStorage.getItem("resumeState")
if (stored) {
  const parsed = JSON.parse(stored) as ResumeState
  const { result } = uploadMultipart({
    stream,
    chunkSize: 5 * 1024 * 1024,                    // must match parsed.chunkSize
    pipelineIdentity: "deflate-v1",                // must match parsed.pipelineIdentity
    getContentDigest: () => `${file.name}|${file.size}|${file.lastModified}`,
    uploadPart,
    completeUpload,
    reconcileCompletedParts: () => listParts(parsed.uploadId),
    resumeFrom: parsed,
  })
  await result
}
```

### New surface

| New | Kind | Purpose |
|---|---|---|
| `ResumeState` | type | Opaque, JSON-serializable resume metadata |
| `resumeFrom: ResumeState` | option | Resume from a persisted state |
| `getContentDigest: () => string \| Promise<string> \| Effect<string, UploadError>` | option | Lightweight stable identifier of the source content |
| `pipelineIdentity: string` | option | Opaque, stable identifier for the upstream pipeline composition |
| `resumeState: Promise<ResumeState>` | return | Resolves once the lib has a state to persist |
| `ResumeMismatchError` | error variant | Resume validation refusal (with `reason` discriminant) |

### `ResumeMismatchError.reason`

The new error has a `reason` discriminant. Dispatch with `Match.value(err.reason)`
inside a `Match.tag("ResumeMismatchError", ...)` handler, or with a `switch`:

```ts
import { Match } from "effect"

const handle = Match.type<UploadError>().pipe(
  Match.tag("ResumeMismatchError", (err) =>
    Match.value(err.reason).pipe(
      Match.when("version_mismatch", () => "Upgrade your lib"),
      Match.when("chunksize_mismatch", () => "ChunkSize changed — start over"),
      Match.when("pipeline_mismatch", () => "Pipeline differs — start over"),
      Match.when("content_mismatch", () => "Source content differs — start over"),
      Match.exhaustive
    )
  ),
  // … other tags
)
```

The `reason` discriminants are: `version_mismatch`, `chunksize_mismatch`,
`pipeline_mismatch`, `content_mismatch`.

### Deprecation warning

If you keep the v0.1.x pattern (`initiate` + `reconcileCompletedParts` without
`resumeFrom`), the lib emits a `console.warn` once per `uploadMultipart` call:

> Tranquilload: detected legacy resume pattern. You're passing `initiate` and
> `reconcileCompletedParts` without `resumeFrom: ResumeState`. The new API
> requires the persisted ResumeState to validate chunkSize/pipeline/digest
> match across sessions. See MIGRATION.md for migration steps.

If you also use a `pipeline` without setting `pipelineIdentity`, a second
warning fires:

> Tranquilload: pipeline is set but pipelineIdentity is not. Without an
> identity, the resume validation cannot detect a pipeline mismatch across
> sessions. See README → Resume Safety.

The lib does not provide an opt-out. If you need to silence the warning, wrap
or override `console.warn` in your app.

### Deferred feature: auto-re-initiate on dead `uploadId`

Auto-re-initiate on dead `uploadId` was considered for this release but
deferred to a future version. If your stored `uploadId` is no longer valid
server-side (404 on the first part upload), you'll currently see
`PartUploadError(1, 1, <404>)` on the first part — same as before this
release. Future versions will add `UploadIdGoneError` and auto-re-init.

### Bug fix bundled in this release

`CircuitOpenError` is now exported from `@tranquilload/core/errors`. In v0.1.x
the symbol was defined internally but never re-exported, so callers had no
way to `instanceof`-check it. No code change needed on your side beyond
adding the import.

---

## v0.1.x → v0.2.x — `@tranquilload/adapters`

### `simpleHttpUpload` now requires HTTP/2 by default

The streaming PUT path now sets `duplex: 'half'`, which is required by modern
browsers and Node 22+ to accept a `ReadableStream` as a `fetch` body.
**Streaming PUT now requires an HTTP/2 endpoint.** HTTP/1.x will reject the
request.

### `bufferMode` escape hatch

For HTTP/1.x targets (or environments where `duplex: 'half'` is unavailable),
opt in to `bufferMode: true`. The adapter drains the entire source stream
into a `Blob` before issuing the request:

```ts
const adapter = simpleHttpUpload({
  url: "https://legacy-http1.example.com/upload",
  bufferMode: true,
})
```

**Memory caveat.** `bufferMode: true` buffers the entire source into memory.
**Do not enable for files larger than available memory.** Use it as the
HTTP/1.x escape hatch, not as a default.

The drain loop is signal-aware: aborting via `AbortSignal` between read
iterations rejects with `AbortError` (not `CompleteUploadError`).
