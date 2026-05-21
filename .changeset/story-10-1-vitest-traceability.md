---
"@tranquilload/core": patch
---

Story 10.1 — Vitest traceability + the logger-resilience fix it surfaced.

**`@tranquilload/core` change — logger is now genuinely non-load-bearing:** introduced `safeLog(logger, level, message, data?)` in `services/logger-service.ts` which wraps `logger.log(…)` in `Effect.try` + `Effect.ignore` so a throwing user-injected `Logger` cannot crash the upload fiber. Replaced all five internal call sites that previously used `Effect.sync(() => logger.log(…))` (which turns a throw into a fiber defect that propagates as a failure). Surfaced by the new 10.1-INT-013 test below; the F#66 invariant ("logging is never load-bearing") was not held by the published code prior to this change.

**Test additions (test-only, no surface change):**

- **22 trace-only annotations** — existing `it.effect`/`it` descriptions in `multipart/upload-stream.test.ts`, `multipart/index.test.ts`, `multipart/chunk-stream.test.ts`, `oneshot/upload.test.ts`, `pipeline/compress.test.ts`, `services/logger-service.test.ts`, `progress/getprogress.test.ts`, plus the adapter tests for `s3-multipart-upload`, `from-file`, `from-node-readable` — now carry `F#N` prefixes (e.g. `"F#3 — retries on failure and emits PartCompleted on eventual success (transient 503 → recovery)"`). Establishes the bidirectional traceability matrix from the brainstorming scenario IDs to the existing 153-test core + 32-test adapter suites.
- **10.1-INT-001 (F#1)** — annotation only: the existing multipart golden-path test (`upload-stream.test.ts`).
- **10.1-INT-010 (F#52)** — net-new test in `progress/getprogress.test.ts`. Locks the `fromFile.totalBytes → Progress.totalBytes → percentage` round-trip that Playwright's R2 progress-bar assertions depend on. Asserts mid-upload percentages are monotonically non-decreasing and at least one is partial.
- **10.1-INT-013 (F#66)** — net-new pair in `services/logger-service-integration.test.ts`. A `LoggerService` whose `.log` throws on every call must let `uploadOnce.effect` and `uploadMultipart.effect` both succeed. Required the `safeLog` lib change above.
- **10.1-INT-018 (F#27)** — net-new test in `multipart/upload-stream.test.ts`. Confirms `maxConcurrency=16` against `totalParts=4` completes all parts without the semaphore stalling, with observed concurrency capped at `totalParts`.

Core test count: 153 → 157.
