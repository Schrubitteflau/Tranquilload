# Tranquilload Test Harness

End-to-end test app that exercises `@tranquilload/core` and `@tranquilload/adapters` against a real S3-compatible server (**MinIO**, in Docker). Built with vanilla TypeScript + Vite + Fastify so the library is consumed exactly as a downstream user would consume it.

## What it lets you verify

- ✅ **One-shot upload** end-to-end through `uploadOnce`
- ✅ **Multipart upload** end-to-end through `uploadMultipart` (chunking, parallel parts, ETags, completion)
- ✅ **Retry / backoff** — flip a chaos toggle to fail the next N sign requests and watch the library retry
- ✅ **Cross-session resume** — refresh the browser mid-upload, click *Resume*, watch `reconcileCompletedParts` skip the parts already on the server
- ✅ **Abort** — cancel mid-upload via `AbortController`; the next event closes the stream cleanly
- ✅ **Compression pipeline** — toggle `deflate-raw` compression in the chunking pipeline
- ✅ **Live event stream** — every `UploadEvent` is rendered as it fires (`UploadInitiated`, `PartCompleted`, `ProgressTick`, `CircuitOpen`, `UploadCompleted`)

## Architecture

```
┌─────────────────┐   /api/multipart/*   ┌──────────────┐         ┌────────┐
│  Browser (Vite) │ ───────────────────▶ │ Fastify API  │ ──SDK──▶│ MinIO  │
│  @tranquilload  │                       │ (this app)   │         │ :9000  │
└─────────────────┘ ◀── presigned URL ── └──────────────┘         └────────┘
        │                                                              ▲
        └───────────── PUT chunk directly (presigned) ────────────────┘
```

- The **browser** uses `uploadMultipart` (or `uploadOnce`) from the library, with callbacks that hit our Fastify API for `initiate`, `sign`, `complete`, `parts` (reconcile).
- The **Fastify server** uses the AWS SDK to talk to MinIO. It signs `UploadPart` URLs so the browser uploads chunks **directly to MinIO** (no relay through the API).
- **MinIO** is a real S3-compatible server. Browse uploads at <http://localhost:9001> (login: `minioadmin` / `minioadmin`).

## Prerequisites

- **Node 22+**
- **Docker** (for MinIO)
- **pnpm** (managed at the repo root)

## Setup

From the **repository root**:

```bash
pnpm install                     # installs all workspace packages
pnpm turbo build                 # build @tranquilload/core and @tranquilload/adapters
```

The test app consumes the **built `dist/`** of the library packages via pnpm's workspace symlinks. If you change library source, rebuild (or run `pnpm turbo build --watch`).

## Running

From `examples/test-app/`:

```bash
# 1. Boot MinIO + create bucket
pnpm minio:up

# 2. Start the API server + Vite dev server (concurrently)
pnpm dev
```

Then open <http://localhost:5173>.

| URL | What |
|---|---|
| <http://localhost:5173> | The test harness UI (Vite) |
| <http://localhost:3000/api/health> | Server health check |
| <http://localhost:9001> | MinIO console (browse uploaded files) |
| <http://localhost:9000> | MinIO S3 API |

Stop everything:

```bash
# Ctrl+C the dev process, then:
pnpm minio:down
```

## How to use it

### Happy-path multipart upload

1. Pick any file > 5 MiB.
2. Leave defaults (5 MiB chunks, 4 concurrent parts).
3. Click **Start upload**.
4. Watch the event log fill with `UploadInitiated → PartCompleted × N → UploadCompleted`.
5. Check MinIO console — your file is in `tranquilload-test/uploads/`.

### Exercise retry/backoff

1. In **Chaos**, set `Fail next N sign requests` to `2`, click **Apply**.
2. Start an upload.
3. The first 2 sign requests return HTTP 503. The library retries (default: exponential backoff, 2 retries = 3 total attempts per part).
4. The log shows the same part number retried until success.

### Exercise cross-session resume

1. Pick a large file (~50 MiB+).
2. Start a multipart upload.
3. While it's running, **refresh the browser** (F5 / Ctrl+R).
4. The yellow "Unfinished upload detected" banner appears.
5. Pick the **same file** again (the harness verifies name + size match).
6. Click **Resume**.
7. The library calls `reconcileCompletedParts` → the server returns the parts already uploaded → those parts are skipped → the upload continues from where it left off.

### Exercise circuit breaker

Not enabled by default (the lib accepts `circuitBreaker?: CircuitBreakerConfig` but our test runner doesn't wire it). Easy to add — set `circuitBreaker: { threshold: 5, windowMs: 10_000 }` on the `uploadMultipart({ ... })` call in `src/main.ts` and crank up the chaos toggles until you trip it.

### Exercise abort

1. Start any upload.
2. Click **Abort**.
3. The `AbortController.abort()` propagates through `Effect.raceFirst(uploadEffect, fromAbortSignal(signal))` → the result rejects with `AbortError`.

## Layout

```
examples/test-app/
├── docker-compose.yml      ─ MinIO + mc bucket initialiser
├── package.json
├── tsconfig.json
├── vite.config.ts          ─ Vite dev server with /api → :3000 proxy
├── .env.example
├── server/
│   ├── index.ts            ─ Fastify routes (initiate/sign/complete/abort/parts/oneshot/chaos)
│   └── s3.ts               ─ AWS SDK clients + presigner helper
├── public/
│   └── index.html
└── src/
    ├── main.ts             ─ All the library wiring lives here
    └── style.css
```

## Notes

- **One-shot uses the raw `File` as fetch body.** Browsers reject `fetch({ body: ReadableStream })` without `duplex: 'half'` + HTTP/2, which the `simpleHttpUpload` adapter doesn't currently set. The test app bypasses the adapter for one-shot in the browser by passing the `File` (a `Blob`) directly — see `runOneshot` in `src/main.ts`. This is a real limitation worth tracking as a library issue.
- **`forcePathStyle: true` is required for MinIO** in both SDK clients (see `server/s3.ts`). Virtual-host style URLs (`bucket.localhost:9000`) won't resolve.
- **Presigned URLs include the host the SDK was configured with.** `S3_PUBLIC_ENDPOINT` exists for the case where the server is in Docker (talks to `http://minio:9000`) but the browser needs to reach MinIO via the host network (`http://localhost:9000`). For the default setup both are `http://localhost:9000`.
- **Chaos state is in-memory** on the server — restart the server to reset, or call `POST /api/chaos` with zeros.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `Cannot find module '@tranquilload/core/multipart'` | Run `pnpm turbo build` at the repo root |
| `Cannot find type definition file for 'node'` | Run `pnpm install` at the repo root |
| `Connection refused` to `:9000` | `pnpm minio:up` first; check `docker ps` for `tranquilload-minio` |
| Chunks failing with `XAmzContentSHA256Mismatch` | MinIO is strict — ensure the chunk size matches what was signed (≥ 5 MiB except the last) |
| Browser CORS error on the presigned URL | MinIO allows CORS by default for the dev creds; if not, enable CORS on the bucket via `mc admin policy` |
