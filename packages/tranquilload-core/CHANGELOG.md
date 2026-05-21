# @tranquilload/core

## 0.1.2

### Patch Changes

- de95a15: Story 10.1 — Vitest traceability + the logger-resilience fix it surfaced.

  **`@tranquilload/core` change — logger is now genuinely non-load-bearing:** introduced `safeLog(logger, level, message, data?)` in `services/logger-service.ts` which wraps `logger.log(…)` in `Effect.try` + `Effect.ignore` so a throwing user-injected `Logger` cannot crash the upload fiber. Replaced all five internal call sites that previously used `Effect.sync(() => logger.log(…))` (which turns a throw into a fiber defect that propagates as a failure). Surfaced by the new 10.1-INT-013 test below; the F#66 invariant ("logging is never load-bearing") was not held by the published code prior to this change.

  **Test additions (test-only, no surface change):**

  - **22 trace-only annotations** — existing `it.effect`/`it` descriptions in `multipart/upload-stream.test.ts`, `multipart/index.test.ts`, `multipart/chunk-stream.test.ts`, `oneshot/upload.test.ts`, `pipeline/compress.test.ts`, `services/logger-service.test.ts`, `progress/getprogress.test.ts`, plus the adapter tests for `s3-multipart-upload`, `from-file`, `from-node-readable` — now carry `F#N` prefixes (e.g. `"F#3 — retries on failure and emits PartCompleted on eventual success (transient 503 → recovery)"`). Establishes the bidirectional traceability matrix from the brainstorming scenario IDs to the existing 153-test core + 32-test adapter suites.
  - **10.1-INT-001 (F#1)** — annotation only: the existing multipart golden-path test (`upload-stream.test.ts`).
  - **10.1-INT-010 (F#52)** — net-new test in `progress/getprogress.test.ts`. Locks the `fromFile.totalBytes → Progress.totalBytes → percentage` round-trip that Playwright's R2 progress-bar assertions depend on. Asserts mid-upload percentages are monotonically non-decreasing and at least one is partial.
  - **10.1-INT-013 (F#66)** — net-new pair in `services/logger-service-integration.test.ts`. A `LoggerService` whose `.log` throws on every call must let `uploadOnce.effect` and `uploadMultipart.effect` both succeed. Required the `safeLog` lib change above.
  - **10.1-INT-018 (F#27)** — net-new test in `multipart/upload-stream.test.ts`. Confirms `maxConcurrency=16` against `totalParts=4` completes all parts without the semaphore stalling, with observed concurrency capped at `totalParts`.

  Core test count: 153 → 157.

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

## 0.1.1

### Patch Changes

- 6ca9186: Resume safety: opaque `ResumeState`, content-digest validation, pipeline-identity check.

  The pre-v0.2 resume pattern (re-passing a stored `uploadId` via `initiate`)
  had three silent-corruption gaps: chunkSize drift, content swap, and pipeline
  drift. This release ships an opaque `ResumeState` that the lib produces, you
  persist, and the lib re-validates before any byte is uploaded.

  **New surface:**

  - `ResumeState` — opaque, JSON-serializable resume metadata carrying `version`,
    `uploadId`, `chunkSize`, optional `pipelineIdentity`, optional `contentDigest`,
    and the `contentDigestCaptured` flag.
  - `resumeFrom: ResumeState` option on `uploadMultipart` — validates match
    synchronously (version, chunkSize, pipelineIdentity, captured-but-dropped
    digest) and asynchronously (digest value), then uses `resumeFrom.uploadId`
    directly (skipping `initiate`).
  - `getContentDigest: () => string | Promise<string> | Effect<string, UploadError>`
    option — lightweight stable identifier of the source content. Captured on
    fresh init, compared on resume. Stable patterns:
    `` `${name}|${size}|${lastModified}` `` for browser files;
    `` `${path}|${stat.size}|${stat.mtimeMs}` `` for Node fs.
  - `pipelineIdentity: string` option — opaque, strict-equality identifier for
    the upstream pipeline composition.
  - `resumeState: Promise<ResumeState>` on `uploadMultipart`'s return — resolves
    with the state you should persist.
  - `ResumeMismatchError` — new `UploadError` variant with a `reason`
    discriminant: `version_mismatch | chunksize_mismatch | pipeline_mismatch |
content_mismatch`. Dispatch with `Match.value(err.reason)` inside the
    `Match.tag("ResumeMismatchError", ...)` handler.

  **Behaviour change (semver-minor under pre-1.0 SemVer):** `initiate` semantics
  are now "always fresh". Users on the v0.1.x legacy pattern (`initiate +
reconcileCompletedParts + no resumeFrom`) get an unconditional `console.warn`
  pointing at `MIGRATION.md`. A second warning fires when `pipeline` is set
  without `pipelineIdentity` — without an identity, pipeline-mismatch protection
  on resume is disabled.

  **Resume is now silent.** On the resume branch, the lib does **not** emit a
  synthetic `UploadInitiated` event; the first event after setup is whatever
  the parts stream emits next (`PartCompleted` or `ProgressTick`). The
  `uploadId` Promise resolves synchronously with `resumeFrom.uploadId`. The
  existing fresh-init flow is unchanged.

  **Bundled fix:** `CircuitOpenError` is now exported from
  `@tranquilload/core/errors`. It was defined internally but had never been
  re-exported, so callers had no way to `instanceof`-check it.

  **NOT in this release** (explicit non-feature note): auto-re-initiate on dead
  `uploadId` was considered but deferred to a future version. If your stored
  `uploadId` is no longer valid server-side, you'll currently see
  `PartUploadError(1, 1, <404>)` on the first part upload — same as before.

  See `MIGRATION.md` for the migration guide.

- 6ca9186: Validate `chunkSize > 0` in `uploadMultipart` / `uploadMultipartEffect`.

  Previously, passing `chunkSize: 0` (or `NaN`, `Infinity`, negative values) caused an infinite loop on the first byte of the source stream — the chunking loop `while (buffer.length >= chunkSize)` never terminated.

  Now: `uploadMultipart` (and the `.effect` escape hatch) throws `TypeError` synchronously at construction time when `chunkSize` is not a positive finite number. Behaviour for all valid `chunkSize` values is unchanged.

  This is a behaviour change for users who were passing invalid `chunkSize` — but those uploads never worked (they hung forever), so this is semver-patch.
