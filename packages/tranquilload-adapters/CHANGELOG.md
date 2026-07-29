# @tranquilload/adapters

## 0.1.10

### Patch Changes

- 052491b: Add npm version badges and direct npm links for both packages to the README,
  plus a note that releases carry build provenance.

  Docs only — no code change. Released because the README now ships inside the
  published tarballs, so the npmjs.com pages would otherwise keep the previous
  version of it.

- Updated dependencies [052491b]
  - @tranquilload/core@0.1.10

## 0.1.9

### Patch Changes

- 7872f26: Ship `README.md` and `LICENSE` in the published tarballs.

  Neither file had ever reached npm: both live at the repo root, and npm only
  force-includes them when they exist in the package directory itself — so the
  registry showed an empty description for both packages, and the MIT-licensed
  code shipped without its license text. A `prepack` hook now copies them from
  the root into each package at pack time, keeping a single source of truth.

  No runtime change: `dist/` is byte-for-byte identical.

- Updated dependencies [7872f26]
  - @tranquilload/core@0.1.9

## 0.1.8

### Patch Changes

- cafa293: Ship only what consumers need: the published tarball is now `dist/` + `CHANGELOG.md` + `package.json`, declared explicitly via a `files` field.

  Until now neither package declared `files`, so tarball contents were decided by whatever the packer chose to keep. Every release carried the full `src/` tree (unit tests included), `tsconfig.json`, `tsdown.config.ts`, `vitest.config.ts` and even a stray `.turbo/turbo-build.log`. Install size drops accordingly.

  **Nothing is lost for consumers.** The `.mjs.map` / `.cjs.map` files embed complete `sourcesContent`, so stepping into library source in a debugger still works without `src/` being shipped. No API change, no behaviour change — the runtime bytes under `dist/` are identical.

  This also removes a real hazard: because `dist/` is gitignored and the packer follows the ignore file in recent toolchains, an undeclared `files` field meant the published tarball could silently lose `dist/` entirely — every export map entry pointing at a file absent from the package. Declaring `files` makes the published surface intentional rather than a side effect of `.gitignore`.

- Updated dependencies [cafa293]
  - @tranquilload/core@0.1.8

## 0.1.6

### Patch Changes

- ed96b80: Add an opt-in **size-bounded auto-buffer** to `simpleHttpUpload` (Epic 13, Story 13.6). For sources of a known size, set `maxAutoBufferBytes` (and `contentLength`) and the adapter chooses the transport up front — before the single-use stream is consumed — instead of forcing a manual per-environment `bufferMode` toggle:

  - `contentLength <= maxAutoBufferBytes` → buffered PUT/POST (HTTP/1.1-safe, works in every engine, no `duplex: 'half'`).
  - `contentLength > maxAutoBufferBytes` → streamed PUT/POST (`duplex: 'half'`, requires HTTP/2) — the large source is never held in memory.

  The decision is memory-safe by construction: `maxAutoBufferBytes` requires `contentLength` (the factory throws a `TypeError` rather than measure-then-buffer an unsized stream), and oversized sources stream rather than buffer. `bufferMode: true` still takes precedence (explicit mode wins). HTTP/2 capability detection is intentionally not attempted — the Fetch API exposes no negotiated-protocol signal in the browser, so a caller-supplied size threshold is the honest, deliverable knob.

  Default behaviour is byte-for-byte unchanged: with neither `bufferMode` nor `maxAutoBufferBytes` set, `simpleHttpUpload` streams with `duplex: 'half'` exactly as before.

## 0.1.3

### Patch Changes

- 3b6ab28: Add an opt-in `resumeUploadId` option to `s3MultipartUpload` (Epic 13, Story 13.2). On a cross-session resume the consumer no longer calls `initiate`, which previously left the adapter's internal `storedUploadId` empty so `uploadPart` signed presigned URLs against `""`. Supplying `resumeUploadId` now seeds that value, so `getPresignedUrl(partNumber, uploadId)` receives the resumed `uploadId` without an `initiate` call. Default (no option) is unchanged — `storedUploadId` starts empty and is set only by `initiate`.
- 3f9855d: Add S3 input-boundary guards (Epic 13, Story 13.1). `s3MultipartUpload` now rejects an S3 object key longer than 1024 bytes (UTF-8) pre-flight with `InitiateUploadError`, before any `createMultipartUpload` request. A new caller-side helper `assertS3PartCount(totalBytes, chunkSize)` (exported from `@tranquilload/adapters/optimalPartSize`, alongside `S3_MAX_PARTS`) throws a `RangeError` when an upload would exceed S3's 10,000-part maximum — the 10k cap is an S3 constraint, so it lives in the adapter layer rather than the protocol-agnostic core.
- Updated dependencies [da82622]
- Updated dependencies [bc6cb8c]
- Updated dependencies [3f9855d]
- Updated dependencies [bc6cb8c]
- Updated dependencies [3b6ab28]
  - @tranquilload/core@0.1.3

## 0.1.2

### Patch Changes

- 9883efb: Story 10.6 — Doctest harness for the README quick-start blocks, plus the adapter bug fix it surfaced.

  **`@tranquilload/adapters` bug fix (s3MultipartUpload):** sort completed parts by `PartNumber` before calling `CompleteMultipartUpload`. S3 requires ascending order; the core completes parts concurrently, so the array arrives in arbitrary order. Any upload with `maxConcurrency > 1` (including the README's `4`) and ≥2 parts was failing with `InvalidPartOrder`. The test-app server route had a local workaround; the adapter itself didn't, so every direct consumer of `s3MultipartUpload` was affected. Caught by the new `10.6-D-002` doctest against MinIO. Adds a regression test (`completeUpload sorts parts by partNumber`).

  **Doctest harness (test-only, no published surface change):** `tests/integration/docs/` with three tests:

  - **10.6-D-001 (G#23)** — extract the README one-shot quick-start, compile against the published `.d.mts`, run against a mocked `fetch`. Assert body bytes.
  - **10.6-D-002 (G#24)** — same pipeline against MinIO (5 MiB + 1 MiB → 2 parts). Skips locally when MinIO isn't up; CI gates with `MINIO_REQUIRED=1`.
  - **10.6-D-003 (G#28)** — compile-only over the `Match.tag` block. Adding a new `UploadError` variant without updating the README block fails `tsc`.

  **README fix (no published surface change — root README is not in the npm tarballs):** `() => /* comment */` was a parser error (no expression after `=>`). Replaced with `() => { /* comment */ }` to preserve the explanatory comment while compiling.

  **New devDep**: `@aws-sdk/s3-request-presigner` in `@tranquilload/tests`.

- 043361e: Story 10.8 — Cleanup invariants + peer-dep contract.

  **README accuracy fix (no published surface change — root README is not in the npm tarballs):** the "Why `effect` is a peer dependency" section claimed `Context.Tag` uses reference equality for runtime lookup. Effect's `unsafeGet` is actually key-based (`self.unsafeMap.has(tag.key)`), so same-key Tags interop for `Layer.succeed`/`yield* Tag` even across copies. Rewrote the rationale to focus on what _does_ break with two copies: class identity (Tag class objects, brand types), `instanceof` for `Cause`/`Exit`/`Fiber`, module-level singletons, version skew, and bundle bloat. The peer-dep declaration is still important — just for the right reasons.

  **Test additions (test-only, no surface change):**

  - **10.8-INT-002 (F#77)** — new `packages/tranquilload-core/src/peer-dep-contract.test.ts` locks down: (a) `Context.Tag(key)()` produces a new class object on every evaluation (Tag identity uniqueness), and (b) Effect's context lookup is string-key-based (same-key Tags interop via Layer). Both invariants are load-bearing for the peer-dep rationale; a future Effect change to either will surface here.
  - **10.8-INT-001 (F#89)** — new test in `multipart/index.test.ts` proves two parallel `uploadMultipart` calls have isolated `getProgress()` state (no shared Ref cross-talk).
  - **10.8-E2E-001 (F#82)** — new `tests/e2e/ui/cleanup.spec.ts` asserts that clicking the test-app's Abort button cancels in-flight PUTs to MinIO (Playwright `requestfailed` log shows ≥1 PUT aborted, not merely abandoned). Required threading `currentAbort.signal` through the test-app's `makeMultipartCallbacks` to the inner `fetch` calls — the lib's contract is "user wires their own signal"; the lib interrupts orchestration but `Effect.tryPromise`-wrapped Promises continue silently otherwise.

  **`examples/test-app` (private workspace, no published surface):** `makeMultipartCallbacks(file, ctx, signal?)` now accepts an AbortSignal and threads it into every `fetch` call (initiate, sign, PUT, complete, parts). Aligns the harness with the lib's documented signal-propagation pattern.

- Updated dependencies [de95a15]
- Updated dependencies [9883efb]
- Updated dependencies [043361e]
  - @tranquilload/core@0.1.2

## 0.1.1

### Patch Changes

- 6ca9186: `simpleHttpUpload`: add `bufferMode` option + set `duplex: 'half'` on streaming uploads.

  The streaming PUT path now sets `duplex: 'half'`, which modern browsers and
  Node 22+ require to accept a `ReadableStream` as a `fetch` body. **Streaming
  PUT now requires an HTTP/2 endpoint** — HTTP/1.x will reject the request.

  For HTTP/1.x targets (or environments where the `duplex` flag is unavailable),
  opt in to `bufferMode: true`. The adapter drains the entire source stream
  into a `Blob` before issuing the request:

  ```ts
  const adapter = simpleHttpUpload({
    url: "https://legacy-http1.example.com/upload",
    bufferMode: true,
  });
  ```

  **Memory caveat.** `bufferMode: true` buffers the whole source into memory —
  do not enable for files larger than available memory. Use it as the HTTP/1.x
  escape hatch, not as a default.

  The drain loop is signal-aware: aborting via `AbortSignal` between read
  iterations rejects with `AbortError` (not `CompleteUploadError`), preserving
  the abort phase mapping.

- Updated dependencies [6ca9186]
- Updated dependencies [6ca9186]
  - @tranquilload/core@0.1.1
