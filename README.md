# Tranquilload

> Type-safe, runtime-agnostic file upload library built on [Effect](https://effect.website).
> One-shot or multipart. Configure-once, resilient by default.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Tranquilload is a TypeScript library for uploading bytes — from a `File`, a Node `Readable`, or any `ReadableStream<Uint8Array>` — to anywhere that accepts chunks. It is built around two ideas:

1. **A small, protocol-agnostic core.** The core knows nothing about S3, HTTP, or your backend. It orchestrates the lifecycle of a transfer: chunking, concurrency, retries, abort, progress, persistence, completion. You hand it `uploadPart` and `completeUpload` as opaque callbacks.
2. **Adapters as configuration presets.** An adapter (`s3MultipartUpload`, `simpleHttpUpload`, `fromFile`, …) is a small function that returns the callbacks the core expects. They give you a one-liner for the happy path, without hiding the underlying contract.

It runs on **Node 22+, modern browsers, Bun, and Deno** — anywhere [WHATWG Streams](https://developer.mozilla.org/en-US/docs/Web/API/Streams_API) and [`CompressionStream`](https://developer.mozilla.org/en-US/docs/Web/API/CompressionStream) are available.

---

## Why Tranquilload?

Most upload libraries either expose too little (a single `upload(file)` call you can't extend), or are tightly coupled to a specific backend (S3-only, tus-only). Tranquilload sits in the middle: **declarative configuration on the outside, Effect under the hood**. You get every resilience feature from the start, but you don't pay an Effect tax to use the library — Promises and `ReadableStream` are the default surface.

What "configure-once" gives you:

- **Retry policies** per error type (network errors retry, application errors don't), composable with `Effect.Schedule`
- **Concurrency control** via `Effect.Semaphore` — back-pressure is free, no `Promise.race` to write
- **Abort interop** via `AbortSignal` — handled as a first-class state, not an exception
- **Cross-session resumption** — pass an `uploadId` and an optional `reconcileCompletedParts` callback, and resume after a crash, a refresh, or a network drop
- **Adaptive chunk size** — measure throughput per part and shrink/grow the next chunk accordingly (`networkMultiplier`, `computeOptimalPartSize`)
- **Circuit breaker** — stop retrying when the network is clearly gone
- **Pipeline composition** — compress, hash, encrypt, or any custom `Transform` between source and uploader
- **Closed, exhaustive error union** — `UploadError` is a discriminated union of 9 variants; no `catch (e: unknown)`
- **`UploadEvent` stream** — every state change emits a tagged event; subscribe if you care, ignore if you don't

---

## Install

```bash
pnpm add @tranquilload/core @tranquilload/adapters effect
# or npm / yarn / bun
```

`effect` is a peer dependency — installed once, shared across both packages.

> **Requires Node 22+.** Older runtimes are missing `process.getBuiltinModule`, used by the build toolchain.

> **HTTP streaming requirements.** `simpleHttpUpload` streams the request body
> by default (with `duplex: 'half'`), which requires HTTP/2 and a runtime that
> understands the `duplex` option (Node 22+, modern browsers). For HTTP/1.x
> endpoints, opt in to `bufferMode: true` — see [Adapters → `simpleHttpUpload`](#httpstreaming).

---

## Quick start

### One-shot upload (small file, single HTTP request)

```ts
import { uploadOnce } from "@tranquilload/core/oneshot";
import { fromFile } from "@tranquilload/adapters/fromFile";
import { simpleHttpUpload } from "@tranquilload/adapters/simpleHttpUpload";

const { stream } = fromFile(file);
const { upload } = simpleHttpUpload({
  url: "https://api.example.com/upload",
  method: "PUT",
  headers: { "Content-Type": file.type },
});

const { result, events } = uploadOnce({ stream, upload });

await result; // UploadCompleted, or throws a typed UploadError
```

### Multipart upload to S3 (resumable, retried, concurrent)

```ts
import { uploadMultipart } from "@tranquilload/core/multipart";
import { fromFile } from "@tranquilload/adapters/fromFile";
import { s3MultipartUpload } from "@tranquilload/adapters/s3MultipartUpload";

const { stream, totalBytes } = fromFile(file);

const s3 = s3MultipartUpload({
  bucket: "my-bucket",
  key: `uploads/${file.name}`,
  s3Client, // any client implementing { createMultipartUpload, completeMultipartUpload }
  getPresignedUrl: async (partNumber, uploadId) =>
    fetch(`/api/sign?uploadId=${uploadId}&part=${partNumber}`).then((r) =>
      r.text(),
    ),
});

const { uploadId, result, events, getProgress } = uploadMultipart({
  stream,
  totalBytes,
  maxConcurrency: 4,
  ...s3, // injects chunkSize + initiate + uploadPart + completeUpload
});

// Persist the uploadId early so you can resume after a refresh
const id = await uploadId;
localStorage.setItem("upload:current", id);

// Subscribe to progress events (optional)
for await (const event of events) {
  if (event._tag === "ProgressTick") {
    console.log(`${event.bytesUploaded} bytes uploaded`);
  }
}

await result;
```

### Resuming an upload after a refresh

The lib produces a `ResumeState` you persist and pass back. The lib re-validates
`chunkSize`, `pipelineIdentity`, and the content digest before any byte is
uploaded — see [Concepts → Resume Safety](#resumesafety) for what each field
guards against.

```ts
import type { ResumeState } from "@tranquilload/core/multipart"

// First session — fresh init
const { uploadId, resumeState, result } = uploadMultipart({
  stream,
  totalBytes,
  ...s3,
  getContentDigest: () => `${file.name}|${file.size}|${file.lastModified}`,
  pipelineIdentity: "deflate-v1", // if you set a `pipeline`
});

const state = await resumeState;
localStorage.setItem("upload:current", JSON.stringify(state));

await result;
localStorage.removeItem("upload:current");

// Subsequent session — resume
const stored = localStorage.getItem("upload:current");
if (stored) {
  const parsed = JSON.parse(stored) as ResumeState;
  const { result } = uploadMultipart({
    stream,
    totalBytes,
    ...s3,
    getContentDigest: () => `${file.name}|${file.size}|${file.lastModified}`,
    pipelineIdentity: "deflate-v1",
    reconcileCompletedParts: async () => {
      const res = await fetch(`/api/parts?uploadId=${parsed.uploadId}`);
      return res.json(); // [{ partNumber, etag }, ...]
    },
    resumeFrom: parsed,
  });
  await result;
}
```

### Adaptive chunk size based on network throughput

```ts
import { networkMultiplier } from "@tranquilload/adapters/networkMultiplier";
import {
  computeOptimalPartSize,
  S3_MIN_PART_SIZE,
} from "@tranquilload/adapters/optimalPartSize";

const multiplier = networkMultiplier();
const basePartSize = computeOptimalPartSize({
  totalBytes,
  targetPartCount: 100,
  minPartSize: S3_MIN_PART_SIZE,
});

// Wire `multiplier.record(bytes, durationMs)` from your PartCompleted events,
// then `Math.round(basePartSize * multiplier.factor())` is your next chunkSize.
```

### Client-side compression in the pipeline

```ts
import { uploadMultipart } from "@tranquilload/core/multipart";
import { compress } from "@tranquilload/core/pipeline";

const { result } = uploadMultipart({
  stream,
  totalBytes,
  ...s3,
  pipeline: compress("deflate-raw"), // any algo CompressionStream supports
});
```

---

## Concepts

### Two cores, two APIs

| Module                         | When to use it                                       | Returns                                     |
| ------------------------------ | ---------------------------------------------------- | ------------------------------------------- |
| `@tranquilload/core/oneshot`   | Whole body fits in one request — simple `PUT`/`POST` | `{ result, events }`                        |
| `@tranquilload/core/multipart` | Large file, resumable, parallel parts                | `{ result, events, uploadId, getProgress }` |

There is **no forced unification** between them. Patterns that turned out to be shared (progress events, abort interop, error union) live in shared modules; everything else stays separate.

### Adapters = configuration presets

An adapter is a plain function returning the callbacks the core expects:

```ts
function s3MultipartUpload(opts): {
  chunkSize: number;
  initiate: () => Promise<{ uploadId: string }>;
  uploadPart: (partNumber: number, chunk: Uint8Array) => Promise<string>;
  completeUpload: (
    uploadId: string,
    parts: ReadonlyArray<CompletedPart>,
  ) => Promise<void>;
};
```

Spread it into `uploadMultipart({ stream, ...adapter })` and you're done. Want to swap S3 for tus, or for a custom backend? Write a 30-line adapter — the core does not change.

### Dual-mode callbacks (Promise or Effect, never required)

Every user-provided callback can return a value, a `Promise<T>`, or an `Effect.Effect<T, UploadError>`. The library detects via `Effect.isEffect` and normalizes internally. **You can use the entire library without ever importing `effect`.**

If you do want the full Effect surface, every public function exposes an `.effect` escape hatch with the Layers left open:

```ts
import { uploadMultipart } from "@tranquilload/core/multipart"

const stream = uploadMultipart.effect({ ... }) // Stream<UploadEvent, UploadError, LoggerService>
```

### Errors are data

`UploadError` is a closed, exhaustive discriminated union (9 variants — one
per upload phase, plus `ResumeMismatchError` for resume validation refusals).
Use `Match.tag` or a `switch` on `_tag`. `ResumeMismatchError` uses an internal
`reason` discriminant — dispatch on it with a nested `Match.value`:

```ts
import { Match } from "effect"

result.catch((err: UploadError) =>
  Match.value(err).pipe(
    Match.tag("InitiateUploadError", () => { /* safe to retry from scratch */ }),
    Match.tag("PartUploadError",     (e) => { /* part ${e.partNumber} failed */ }),
    Match.tag("MaxRetriesExceededError", () => { /* give up */ }),
    Match.tag("ReconcileError",      () => { /* parts state unknown */ }),
    Match.tag("CompleteUploadError", () => { /* parts uploaded, retry .complete() or abort */ }),
    Match.tag("PresignedUrlError",   () => { /* could not obtain a signed URL */ }),
    Match.tag("CircuitOpenError",    () => { /* too many failures, pause */ }),
    Match.tag("AbortError",          () => { /* user cancelled */ }),
    Match.tag("ResumeMismatchError", (e) =>
      Match.value(e.reason).pipe(
        Match.when("version_mismatch",   () => { /* upgrade lib or clear state */ }),
        Match.when("chunksize_mismatch", () => { /* chunkSize changed; start over */ }),
        Match.when("pipeline_mismatch",  () => { /* pipeline changed; start over */ }),
        Match.when("content_mismatch",   () => { /* source content differs; start over */ }),
        Match.exhaustive,
      ),
    ),
    Match.exhaustive,
  ),
)
```

<a id="resumesafety"></a>

### Resume Safety

`ResumeState` carries five validation fields. Each one is a tripwire for a
silent-corruption class:

| Field | Guards against |
|---|---|
| `version: 1` | Schema evolution — a v1 state passed to a future v2 lib fails fast with `ResumeMismatchError("version_mismatch")` instead of being silently misinterpreted |
| `chunkSize` | Byte misalignment — changing `chunkSize` between sessions corrupts the completed object |
| `pipelineIdentity` (opt-in) | Pipeline composition drift — resuming with a different compression algorithm produces a Frankenstein object |
| `contentDigest` (opt-in, from `getContentDigest`) | Content swap — resuming with a different file of the same name+size uploads wrong bytes against the stored `uploadId` |
| `contentDigestCaptured` | Persistence-layer field drop — if the original session captured a digest but the persisted state lost it, the lib refuses to resume |

> **Compression non-determinism caveat.** Even with identical `pipelineIdentity`,
> a non-deterministic pipeline (e.g. gzip with `mtime` headers, encryption with
> random salt) produces different bytes per run. Resume against the same
> uploaded parts only works if your pipeline is byte-deterministic. Verify
> before relying on this.

<a id="httpstreaming"></a>

### `simpleHttpUpload` streaming vs buffered

By default, `simpleHttpUpload` sends the source as a streaming `ReadableStream`
body with `duplex: 'half'`. This requires:

- An **HTTP/2** endpoint (modern browsers reject HTTP/1.x stream uploads).
- A runtime that accepts the `duplex` flag on `fetch` (Node 22+, current
  browsers). The flag is silently ignored on older runtimes — the request
  shape is then wrong.

For HTTP/1.x targets or older runtimes, opt in to `bufferMode: true`. The
adapter drains the source into a `Blob` before sending; no `duplex` flag is
required.

> **Memory caveat.** `bufferMode: true` holds the entire source in memory.
> **Do not enable for files larger than available memory.**

### Events are a stream

`uploadMultipart` returns an `events: ReadableStream<UploadEvent>`. Subscribe with `for await`, pipe to a `TransformStream`, or ignore it entirely — no overhead if unused. Events: `UploadInitiated`, `PartCompleted`, `ProgressTick`, `CircuitOpen`, `UploadCompleted`.

### Why `effect` is a peer dependency

You'll notice the install command asks for `effect` explicitly:

```bash
pnpm add @tranquilload/core @tranquilload/adapters effect
```

`effect` is declared as a `peerDependency` in both packages (not a regular `dependency`). This is intentional, and the reason is specific to how Effect works.

**The core constraint: `Context.Tag` uses reference equality.** Effect's dependency injection (`LoggerService`, `CompressionService`, every Layer) identifies services by *object identity* of the Tag — not by name. If two copies of `effect` end up resolved in `node_modules` (one for `@tranquilload/core`, one for your app, or one for each of our packages), then the `LoggerService` tag from copy A is a *different object* than the `LoggerService` tag from copy B. A Layer registered against copy A's tag would silently not be found when the runtime looks up copy B's tag. Services would vanish at runtime with no error.

Declaring `effect` as a `peerDependency` forces the package manager to hoist a single shared copy. Both Tranquilload packages and your app code all import from the same `effect` instance — Tags stay identical, Layers connect correctly.

The same setup is what every Effect-based library does (`@effect/platform`, `@effect/schema`, `effect-http`, …) for the same reason.

**Trade-offs:**

| What we get | What it costs |
|---|---|
| Single shared `effect` instance → `Context.Tag` works | One extra package name at `install` time |
| User controls the `effect` version | You need to keep the peer range honest as Effect evolves |
| `effect` is not bundled into our `dist` → smaller install, no duplicate code if you already use Effect | Tooling warns on incompatible versions (which is the point) |

The peer range is `>=3.19.19` — covers minor/patch updates without requiring us to re-publish.

---

## Package layout

```
@tranquilload/core
├── /oneshot     — uploadOnce  ({ result, events })
├── /multipart   — uploadMultipart  ({ result, events, uploadId, getProgress })
├── /pipeline    — Transform composition (compress, compose)
├── /services    — CompressionService, LoggerService (injectable Effect Layers)
├── /progress    — UploadEvent types
└── /errors      — UploadError union (9 variants)

@tranquilload/adapters
├── /fromFile             — File           → { stream, totalBytes }
├── /fromNodeReadable     — Node Readable  → { stream }
├── /simpleHttpUpload     — One-shot PUT/POST adapter
├── /s3MultipartUpload    — S3 multipart preset (initiate / uploadPart / completeUpload)
├── /optimalPartSize      — Compute chunk size from total + target part count
└── /networkMultiplier    — Throughput-based dynamic chunk sizing
```

Each entry point is independently importable for tree-shaking. The core never imports from `@tranquilload/adapters` — the dependency is one-way.

---

## Development

```bash
pnpm install
pnpm turbo build       # build core, then adapters
pnpm turbo test        # vitest (with @effect/vitest)
pnpm -r typecheck      # tsc --noEmit across both packages
```

See [`CONTRIBUTING.md`](./CONTRIBUTING.md) for the contribution flow and [`RELEASE_FLOW.md`](./RELEASE_FLOW.md) for the Changesets-driven release process.

---

## To go further

The README intentionally stays surface-level. For the design rationale, the architectural constraints, and the rules a contributor (or AI agent) must follow:

- **[`docs/project-context.md`](./docs/project-context.md)** — critical implementation rules, technology stack, anti-patterns, and conventions. Read this before touching the code.
- **[`_bmad-output/brainstorming/brainstorming-session-2026-03-08-001.md`](./_bmad-output/brainstorming/brainstorming-session-2026-03-08-001.md)** — the full brainstorming session that shaped the library: First Principles, SCAMPER, and Cross-Pollination over the 45 ideas that defined the v1 scope and the v2 roadmap.

---

## License

[MIT](./LICENSE) © Schrubitteflau
