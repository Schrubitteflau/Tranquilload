---
stepsCompleted: [1, 2, 3, 4]
status: complete
completedAt: '2026-03-08'
inputDocuments:
  - '_bmad-output/planning-artifacts/architecture.md'
---

# Tranquilload - Epic Breakdown

## Overview

This document provides the complete epic and story breakdown for Tranquilload, decomposing the requirements from the Architecture document into implementable stories.

## Requirements Inventory

### Functional Requirements

FR1: **One-shot upload** — Send a file in a single HTTP request. Separate API from the multipart API, no forced unification.

FR2: **Multipart upload** — Split a binary stream into chunks, upload parts in parallel via user callbacks, collect confirmations, trigger `completeUpload`. The core is protocol-agnostic.

FR3: **Transformation pipeline** — Each transformation is `(stream: Stream<Uint8Array>) => Stream<Uint8Array>`. Composable: compression, checksum, encryption. Backpressure handled natively by Effect/Stream.

FR4: **Client-side compression** — Injectable `CompressionService`. Default implementation: `globalThis.CompressionStream`. Replaceable by WASM, zlib, or no-op.

FR5: **Observability/progress** — `Stream<UploadEvent>` returned by upload functions. Complementary pull-mode via `getProgress()`. Throttle/debounce is user's responsibility.

FR6: **Resilience** — Per-part retry via injectable `Effect.Schedule`. Differentiated policies per error type. Optional Circuit Breaker.

FR7: **Cross-session resumability** — `uploadId` exposed from `initiate`. Optional `reconcileCompletedParts` callback to reconcile server-side state. Upload identity is user's responsibility.

FR8: **Adapters** — `fileAdapter`, `fromNodeReadable`, `s3MultipartUploader`, `simpleHttpUpload`. An adapter = `(options) => options`. Protocol constraints (e.g. S3 minimum part size) live in the adapter, never in the core.

FR9: **Dynamic chunk size via network multiplier** — An adapter in `adapters/resilience/network-multiplier.ts` measures network throughput and computes a multiplier factor (0.1 to 1.0) applied to the base chunk size. Allows the multipart upload to adapt part size dynamically based on real-time network quality.

FR10: **Optimal part size calculation** — Utility to compute the optimal part size given total file size, target part count, and protocol constraints (e.g. S3 minimum part size of 5 MiB for all parts except last). Exposed as a helper so users can configure `chunkSize` correctly without manual math.

### NonFunctional Requirements

NFR1: **Tree-shaking** — Granular exports. A Node user does not bundle browser code.

NFR2: **Minimal bundle size** — Zero runtime dependencies in `@tranquilload/core` except `effect`.

NFR3: **Runtime-agnostic** — `globalThis` only — compatible Node 18+, browser, Bun, Deno.

NFR4: **Zero exposed mutable state** — All state in local `Effect.Ref`, invisible externally.

NFR5: **Silent by default** — Injectable `LoggerService`, no-op in production.

NFR6: **Strict TypeScript** — Exported types, errors = exhaustive closed union internally.

NFR7: **Progressive adoption without Effect** — All user callbacks can be plain functions (`Promise<T>`, or `throw`). Core normalizes internally. User never has to write a line of Effect if they don't want to.

### Additional Requirements

- **Monorepo scaffold**: pnpm workspaces + tsdown + vitest + Turborepo. This is the first story.
- **Two npm packages**: `@tranquilload` (core) and `@tranquilload/adapters`, with lockstep versioning via Changesets.
- **Build**: tsdown generates CJS + ESM + `.d.ts` via Oxc. Granular exports map in `package.json`.
- **Testing**: vitest + `@effect/vitest` (official Effect testing wrapper), tests co-located with source files (`*.test.ts`).
- **CI/CD**: Two GitHub Actions workflows — `ci.yml` (typecheck + test + build on push/PR) and `release.yml` (Changesets publish on merge to main).
- **Effect as peer dependency**: `effect >= 3.19.19` in both packages (reference equality requirement for Context.Tag).
- **Circuit Breaker**: 3-state machine (Closed → Open → HalfOpen) included in v1, located in `packages/core/src/multipart/circuit-breaker.ts`.
- **Naming conventions**: kebab-case files, PascalCase types/classes/services, camelCase functions, `SCREAMING_SNAKE_CASE` constants.
- **Pattern consistency**: All modules must expose Dual API (Promise/ReadableStream + `.effect` escape hatch), normalize callbacks via `normalizeCallback`, use `Effect.race` + `fromAbortSignal` for AbortController interop.
- **Local Effect documentation**: `effect/` repo cloned at project root — must be consulted before web searches.

### FR Coverage Map

FR1 — One-shot upload: Epic 2
FR2 — Multipart upload: Epic 3
FR3 — Transformation pipeline: Epic 4
FR4 — Client-side compression: Epic 4
FR5 — Observability/progress: Epic 5
FR6 — Resilience / retry / circuit breaker: Epic 3 (story 3.4 circuit breaker) + Epic 6 (story 6.1 retry schedule)
FR7 — Cross-session resumability: Epic 7
FR8 — Adapters (file, Node, S3, HTTP): Epic 8
FR9 — Network multiplier (0.1–1.0): Epic 6
FR10 — Optimal part size calculation: Epic 6
NFR1–NFR7 — Transversal: Epic 1 + epics concerned

## Epic List

### Epic 1: Project Foundation
The developer building the lib can scaffold the monorepo, run builds, run tests, and rely on the base error types and service infrastructure that all other epics depend on.
**FRs covered:** Additional requirements (monorepo, build tooling, errors union, services infrastructure, CI/CD base)

### Epic 2: One-Shot Upload
The library user can upload an entire file in a single HTTP request, using standard Promise + ReadableStream return types, with no knowledge of Effect required.
**FRs covered:** FR1, NFR2, NFR3, NFR6, NFR7

### Epic 3: Multipart Upload
The library user can upload large files split into chunks uploaded in parallel, with concurrency control and part confirmation collection.
**FRs covered:** FR2, NFR1, NFR3, NFR4, NFR7

### Epic 4: Transformation Pipeline & Compression
The library user can compose transformations on the binary stream (compression, checksum, encryption) before upload, with automatic backpressure.
**FRs covered:** FR3, FR4, NFR2

### Epic 5: Observability & Progress
The library user can monitor upload progress in real time via an event stream or in pull-mode, and log what they want with no noise by default.
**FRs covered:** FR5, NFR5

### Epic 6: Resilience & Performance Adaptability
The library user can configure per-part retry policies, automatic circuit breaking, and let the lib dynamically adapt chunk size based on network quality.
**FRs covered:** FR6, FR9, FR10

### Epic 7: Cross-Session Resumability
The library user can resume an interrupted upload in a new session by reconciling server-side state via a callback.
**FRs covered:** FR7

### Epic 8: Adapters & Protocol Integration
The library user can connect the lib to S3, HTTP one-shot, browser File API, or Node.js Readable streams without modifying the core.
**FRs covered:** FR8, NFR1, NFR3

### Epic 9: CI/CD & Publishing
The team can publish versioned npm releases automatically via Changesets, with CI validating typecheck + tests + build on every PR.
**FRs covered:** Additional requirements (GitHub Actions, Changesets, lockstep versioning)

## Epic 1: Project Foundation

The developer building the library can scaffold the monorepo, run builds, run tests, and rely on the base error types and service infrastructure that all other epics depend on.

### Story 1.1: Monorepo Scaffold

As a developer building the library,
I want a fully configured monorepo with build, test, and watch pipelines,
So that I can develop, test, and build both packages with a single toolchain.

**Acceptance Criteria:**

**Given** an empty project directory
**When** the developer runs `pnpm install` then `pnpm turbo build`
**Then** both `packages/core` and `packages/adapters` compile successfully to `dist/esm/`, `dist/cjs/`, `dist/types/`
**And** the exports map in each `package.json` satisfies all named sub-path entries (`./multipart`, `./oneshot`, `./pipeline`, `./services`, `./errors`, `./progress`)

**Given** a source file change in `packages/core`
**When** the developer runs `pnpm turbo test`
**Then** vitest runs all `*.test.ts` files co-located with source files and reports results
**And** the Turborepo cache skips unchanged packages on subsequent runs

**Given** the monorepo root
**When** the developer inspects `tsconfig.base.json`
**Then** `strict: true` and `isolatedDeclarations: true` are set
**And** each package's `tsconfig.json` extends the base config

### Story 1.2: Error Types Definition

As a developer consuming the library,
I want a typed, exhaustive error union with `_tag` discriminants,
So that I can handle all upload failure cases with full TypeScript exhaustiveness checks and Effect `catchTag` compatibility.

**Acceptance Criteria:**

**Given** the `@tranquilload/errors` sub-path export
**When** the developer imports `UploadError`
**Then** the type is a closed union of `PartUploadError | MaxRetriesExceededError | PresignedUrlError | CompleteUploadError | AbortError`
**And** each variant extends `Error` (stack trace, `instanceof Error` works)
**And** each variant has a `readonly _tag` literal property

**Given** a `PartUploadError` instance
**When** caught in a Promise `.catch()` handler
**Then** `err instanceof Error` is `true` and `err.message` is human-readable
**And** `err._tag === "PartUploadError"` narrows the type in TypeScript

### Story 1.3: Effect Services Infrastructure

As a developer consuming the library,
I want injectable `CompressionService` and `LoggerService` with sensible defaults,
So that compression and logging work out of the box but can be swapped without touching core code.

**Acceptance Criteria:**

**Given** the `@tranquilload/services` sub-path export
**When** the developer uses the library without providing any Layer
**Then** `CompressionServiceLive` uses `globalThis.CompressionStream` by default
**And** `LoggerServiceLive` is a no-op (zero output in production)

**Given** a test environment where `globalThis.CompressionStream` is absent
**When** compression is requested
**Then** the Effect fails with a typed error in the error channel (not an unhandled exception)

**Given** the developer provides a custom Layer via the `.effect` escape hatch
**When** they substitute `CompressionService` with a WASM implementation
**Then** the core uses the injected service without any code change

### Story 1.4: Core Utility Helpers

As a developer building on top of the library internals,
I want `normalizeCallback` and `fromAbortSignal` utilities,
So that user-provided callbacks (Promise, throw, Effect) and AbortController signals integrate cleanly into Effect without boilerplate.

**Acceptance Criteria:**

**Given** a user callback returning a plain value, a `Promise`, or an `Effect`
**When** passed through `normalizeCallback`
**Then** all three forms produce an equivalent `Effect<A, E>` with correct error channel typing
**And** a throwing function produces an `Effect` that fails (not an unhandled exception)

**Given** an `AbortController` whose `signal` is passed to `fromAbortSignal`
**When** `controller.abort()` is called
**Then** the resulting Effect fails with `AbortError`
**And** the abort event listener is cleaned up (no memory leak)

## Epic 2: One-Shot Upload

The library user can upload an entire file in a single HTTP request, using standard Promise + ReadableStream return types, with no knowledge of Effect required.

### Story 2.1: One-Shot Upload — Core Effect Implementation

As a library developer,
I want the internal Effect implementation of one-shot upload in `packages/core/src/oneshot/upload.ts`,
So that the pure Effect logic is isolated, testable, and reusable by the Dual API wrapper.

**Acceptance Criteria:**

**Given** a `ReadableStream<Uint8Array>` and an `uploadOnce` user callback
**When** `uploadOnceEffect(options)` is called
**Then** it returns a `Stream<UploadEvent, UploadError, LoggerService>` that emits a `UploadCompleted` event on success
**And** the user callback is normalized via `normalizeCallback` (supports Promise, plain value, or Effect)
**And** if `signal` is provided, `Effect.race` with `fromAbortSignal` is used — no direct `signal.aborted` check

**Given** the user callback throws or rejects
**When** the upload runs
**Then** the stream fails with the appropriate `UploadError` variant in the typed error channel

### Story 2.2: One-Shot Upload — Dual API Entry Point

As a developer consuming the library,
I want to call `uploadOnce(options)` and get back a `Promise<UploadResult>` and a `ReadableStream<UploadEvent>`,
So that I can perform a complete one-shot upload without writing a single line of Effect.

**Acceptance Criteria:**

**Given** the `@tranquilload/oneshot` sub-path export
**When** the developer calls `uploadOnce({ stream, upload, signal? })`
**Then** it returns `{ result: Promise<UploadResult>, events: ReadableStream<UploadEvent> }`
**And** `LoggerServiceLive` is provided automatically (no Layer required from the user)

**Given** `uploadOnce.effect` is called with the same options
**When** the developer provides their own Layers
**Then** it returns a raw `Stream<UploadEvent, UploadError, LoggerService>` with Layers open for composition

**Given** the developer calls `controller.abort()` mid-upload
**When** the signal fires
**Then** `result` rejects with `AbortError` and the events stream closes cleanly

## Epic 3: Multipart Upload

The library user can upload large files split into chunks uploaded in parallel, with concurrency control and part confirmation collection.

### Story 3.1: Chunk Stream

As a library developer,
I want a `chunkStream` transform that splits a `ReadableStream<Uint8Array>` into fixed-size chunks,
So that the multipart upload can feed parts of a controlled size to the upload pipeline.

**Acceptance Criteria:**

**Given** a `ReadableStream<Uint8Array>` and a `chunkSize` in bytes
**When** piped through `chunkStream(chunkSize)`
**Then** each emitted chunk is exactly `chunkSize` bytes, except the last which may be smaller
**And** the total bytes across all chunks equals the source stream's total bytes
**And** backpressure from the consumer is respected (no unbounded buffering)

### Story 3.2: Multipart Upload — Core Effect Implementation

As a library developer,
I want the internal Effect implementation of parallel multipart upload in `packages/core/src/multipart/upload-stream.ts`,
So that part orchestration, concurrency control, and retry logic are isolated and testable.

**Acceptance Criteria:**

**Given** a chunked stream, an `uploadPart` callback, and a `maxConcurrency` option
**When** `uploadMultipartEffect(options)` runs
**Then** at most `maxConcurrency` parts are in-flight simultaneously (via `Effect.Semaphore`)
**And** each part is normalized via `normalizeCallback` before execution
**And** the stream emits a `PartCompleted` event for each successful part

**Given** a part upload fails
**When** the configured `Effect.Schedule` allows retries
**Then** the part is retried according to the schedule before failing
**And** on final failure, the stream fails with `PartUploadError` or `MaxRetriesExceededError`

**Given** an `AbortSignal` is provided
**When** `controller.abort()` is called during parallel uploads
**Then** all in-flight parts are interrupted via `Effect.race` + `fromAbortSignal`
**And** no new parts are started after abort

### Story 3.3: Multipart Upload — Dual API Entry Point

As a developer consuming the library,
I want to call `uploadMultipart(options)` and get back `{ result, events, getProgress }`,
So that I can orchestrate a complete multipart upload with zero Effect knowledge.

**Acceptance Criteria:**

**Given** the `@tranquilload/multipart` sub-path export
**When** the developer calls `uploadMultipart({ stream, chunkSize, uploadPart, completeUpload, signal? })`
**Then** it returns `{ result: Promise<UploadResult>, events: ReadableStream<UploadEvent>, getProgress: () => Promise<Progress> }`
**And** `CompressionServiceLive` and `LoggerServiceLive` are provided automatically

**Given** `uploadMultipart.effect` is called
**When** the developer provides their own Layers
**Then** it returns a raw `Stream<UploadEvent, UploadError, CompressionService | LoggerService>` with Layers open

**Given** `getProgress()` is called at any point during the upload
**When** parts are being uploaded
**Then** it returns the current `{ bytesUploaded, totalBytes: Option }` snapshot without interrupting the upload

### Story 3.4: Circuit Breaker

As a developer consuming the library,
I want an optional circuit breaker that stops retrying parts when too many consecutive failures occur,
So that a degraded upload doesn't waste bandwidth hammering a failing endpoint.

**Acceptance Criteria:**

**Given** `circuitBreaker: { threshold, cooldown }` is configured
**When** `threshold` consecutive part failures occur within the upload
**Then** the circuit opens, emits a `CircuitOpen` event, and no new parts are attempted
**And** the circuit state machine transitions: `Closed → Open → HalfOpen → Closed` on recovery

**Given** the circuit is `Open` and `cooldown` has elapsed
**When** the next part attempt succeeds
**Then** the circuit transitions to `Closed` and normal upload resumes

**Given** no `circuitBreaker` option is provided
**When** the upload runs
**Then** behavior is identical to before — no circuit breaker overhead

## Epic 4: Transformation Pipeline & Compression

The library user can compose transformations on the binary stream (compression, checksum, encryption) before upload, with automatic backpressure.

### Story 4.1: Pipeline Middleware Infrastructure

As a developer consuming the library,
I want a composable pipeline system where each transform is `(stream: ReadableStream<Uint8Array>) => ReadableStream<Uint8Array>`,
So that I can chain compression, checksum, or any custom transform before my upload without framework lock-in.

**Acceptance Criteria:**

**Given** the `@tranquilload/pipeline` sub-path export
**When** the developer calls `compose(transformA, transformB, transformC)`
**Then** it returns a single `(stream) => stream` function applying transforms left-to-right
**And** backpressure propagates through the chain (no unbounded buffering between stages)

**Given** a pipeline with zero transforms
**When** applied to a stream
**Then** the stream passes through unchanged

### Story 4.2: Compression Transform

As a developer consuming the library,
I want a `compress(algorithm?)` pipeline transform powered by `CompressionService`,
So that I can add client-side compression to any upload in one line, with the implementation swappable via dependency injection.

**Acceptance Criteria:**

**Given** the default `CompressionServiceLive` (using `globalThis.CompressionStream`)
**When** `compress()` is added to the pipeline
**Then** the output stream contains deflate-raw compressed bytes

**Given** a custom `CompressionService` Layer injected via `.effect`
**When** `compress()` is called
**Then** the custom implementation is used instead of `globalThis.CompressionStream`

**Given** `globalThis.CompressionStream` is absent (unsupported environment)
**When** `compress()` is called via the Promise API
**Then** `result` rejects with a typed error — no unhandled exception

### Story 4.3: Pipeline Integration with Upload Functions

As a developer consuming the library,
I want to pass a `pipeline` option to `uploadMultipart` and `uploadOnce`,
So that transforms are applied transparently to the stream before chunking or uploading.

**Acceptance Criteria:**

**Given** `uploadMultipart({ ..., pipeline: compose(compress()) })`
**When** the upload runs
**Then** the pipeline is applied to the source stream before chunking
**And** `ProgressTick` events reflect compressed byte counts

**Given** `uploadOnce({ ..., pipeline: compose(compress()) })`
**When** the upload runs
**Then** the pipeline is applied before the single HTTP request

**Given** no `pipeline` option is provided
**When** either upload function runs
**Then** behavior is identical to before — source stream used as-is

## Epic 5: Observability & Progress

The library user can monitor upload progress in real time via an event stream or in pull-mode, and log what they want with no noise by default.

### Story 5.1: UploadEvent Type System

As a developer consuming the library,
I want a fully typed `UploadEvent` discriminated union exported from `@tranquilload/progress`,
So that I can exhaustively handle every event type with TypeScript and build precise progress UIs or logs.

**Acceptance Criteria:**

**Given** the `@tranquilload/progress` sub-path export
**When** the developer imports `UploadEvent`
**Then** the type is a closed union of `PartCompleted | ProgressTick | UploadCompleted | CircuitOpen`
**And** every variant has `_tag` (literal discriminant) and `timestamp` (number)
**And** `Match.tag` from Effect and standard `switch` on `_tag` both work for exhaustive handling

**Given** a new event variant is added in a future version
**When** existing user code does not handle the new `_tag`
**Then** TypeScript reports a type error at compile time (exhaustiveness enforced)

### Story 5.2: Progress Pull-Mode via `getProgress()`

As a developer consuming the library,
I want a `getProgress()` function returned alongside `events` and `result`,
So that I can poll current upload state on demand without consuming the events stream.

**Acceptance Criteria:**

**Given** an in-progress `uploadMultipart` call
**When** the developer calls `getProgress()`
**Then** it returns `Promise<{ bytesUploaded: number, totalBytes: Option<number> }>`
**And** calling it multiple times returns updated snapshots without side effects on the upload

**Given** `getProgress.effect` is called
**When** used inside an Effect program
**Then** it returns `Effect<Progress>` reading from the internal `Ref<Progress>` without running the upload

### Story 5.3: Injectable Logger Service

As a developer consuming the library,
I want to provide a custom `LoggerService` Layer to capture internal library logs,
So that I can route upload internals to my own logging infrastructure (console, Datadog, etc.) without any output by default.

**Acceptance Criteria:**

**Given** no custom `LoggerService` is provided
**When** any upload runs
**Then** zero output is produced (no `console.log`, no side effects)

**Given** a custom `LoggerService` Layer is injected via `.effect`
**When** the library logs an internal event (retry attempt, part completion, circuit state change)
**Then** the custom logger receives structured log entries

**Given** the Promise API is used (no `.effect`)
**When** the upload runs
**Then** `LoggerServiceLive` (no-op) is provided automatically — user cannot accidentally see internal logs

## Epic 6: Resilience & Performance Adaptability

The library user can configure per-part retry policies, automatic circuit breaking, and let the lib dynamically adapt chunk size based on network quality.

### Story 6.1: Injectable Retry Schedule

As a developer consuming the library,
I want to pass a custom `Effect.Schedule` as a `retrySchedule` option to `uploadMultipart`,
So that I can define my own retry policy (exponential backoff, jitter, max attempts) per deployment context.

**Acceptance Criteria:**

**Given** `uploadMultipart({ ..., retrySchedule: Schedule.exponential("100 millis").pipe(Schedule.upTo("30 seconds")) })`
**When** a part fails
**Then** retries follow the provided schedule exactly
**And** once the schedule is exhausted, the part fails with `MaxRetriesExceededError`

**Given** no `retrySchedule` is provided
**When** a part fails
**Then** a sensible default schedule is used (e.g. 3 attempts with exponential backoff)
**And** behavior is consistent with previous epics

**Given** different error types (`PresignedUrlError` vs `PartUploadError`)
**When** a retry policy is evaluated
**Then** the schedule can differentiate by error type via Effect's typed error channel

### Story 6.2: Network Multiplier Adapter

As a developer consuming the library,
I want a `networkMultiplier()` adapter from `@tranquilload/adapters/networkMultiplier` that measures throughput and returns a factor between 0.1 and 1.0,
So that I can scale chunk size dynamically based on real network conditions.

**Acceptance Criteria:**

**Given** `networkMultiplier()` is called
**When** it measures throughput over a sample window
**Then** it returns a factor in `[0.1, 1.0]` where `1.0` means full target chunk size and `0.1` means minimum viable chunk size

**Given** the factor is applied as `chunkSize = baseChunkSize * factor`
**When** passed to `uploadMultipart({ chunkSize })`
**Then** subsequent parts use the adjusted chunk size

**Given** network conditions cannot be measured (e.g. no prior upload data)
**When** `networkMultiplier()` is first called
**Then** it returns `1.0` as a safe default

### Story 6.3: Optimal Part Size Calculator

As a developer consuming the library,
I want a `computeOptimalPartSize({ totalBytes, targetPartCount, minPartSize, maxPartSize })` helper,
So that I can calculate the correct chunk size for any upload without manual math or violating protocol constraints.

**Acceptance Criteria:**

**Given** `totalBytes = 100MB`, `targetPartCount = 10`, `minPartSize = 5MB` (S3 constraint)
**When** `computeOptimalPartSize` is called
**Then** it returns `10MB` (satisfies both target count and min size)

**Given** a file so small that `totalBytes / targetPartCount < minPartSize`
**When** `computeOptimalPartSize` is called
**Then** it returns `minPartSize` and the actual part count is less than `targetPartCount`

**Given** `totalBytes` is unknown (`undefined`)
**When** `computeOptimalPartSize` is called
**Then** it returns `minPartSize` as a safe floor value

## Epic 7: Cross-Session Resumability

The library user can resume an interrupted upload in a new session by reconciling server-side state via a callback.

### Story 7.1: Upload ID Exposure & State Persistence Contract

As a developer consuming the library,
I want `uploadMultipart` to expose the `uploadId` immediately after initiation,
So that I can persist it client-side and use it to resume the upload in a future session.

**Acceptance Criteria:**

**Given** `uploadMultipart({ ..., initiate: () => Promise<{ uploadId: string }> })`
**When** the initiation callback resolves
**Then** `uploadId` is emitted as part of the first `UploadEvent` and accessible from the return value
**And** the library makes no assumption about where `uploadId` is stored — persistence is user's responsibility

**Given** the upload is interrupted mid-way (network loss, page reload)
**When** the user retrieves the stored `uploadId`
**Then** they have all the information needed to call `uploadMultipart` again with resumption options

### Story 7.2: Cross-Session Resume via `reconcileCompletedParts`

As a developer consuming the library,
I want to pass a `reconcileCompletedParts` callback to `uploadMultipart` that returns already-uploaded parts,
So that the library skips those parts and resumes only from where the previous session left off.

**Acceptance Criteria:**

**Given** `uploadMultipart({ ..., uploadId, reconcileCompletedParts: () => Promise<CompletedPart[]> })`
**When** the upload starts
**Then** `reconcileCompletedParts` is called first and its result is used to skip already-completed parts
**And** skipped parts emit `PartCompleted` events (with their original etag) without re-uploading

**Given** `reconcileCompletedParts` returns an empty array
**When** the upload starts
**Then** all parts are uploaded from scratch — behavior identical to a fresh upload

**Given** `reconcileCompletedParts` throws or rejects
**When** the upload starts
**Then** the error is normalized via `normalizeCallback` and the upload fails with a typed error

**Given** no `reconcileCompletedParts` is provided
**When** `uploadMultipart` is called with an `uploadId`
**Then** all parts are uploaded without reconciliation — `uploadId` is passed through to `completeUpload` only

## Epic 8: Adapters & Protocol Integration

The library user can connect the lib to S3, HTTP one-shot, browser File API, or Node.js Readable streams without modifying the core.

### Story 8.1: File Source Adapter

As a developer consuming the library,
I want a `fromFile(file: File)` adapter from `@tranquilload/adapters/fromFile`,
So that I can feed a browser `File` object directly to `uploadMultipart` or `uploadOnce` with `totalBytes` and a stream pre-configured.

**Acceptance Criteria:**

**Given** a browser `File` object
**When** the developer calls `fromFile(file)`
**Then** it returns `{ stream: ReadableStream<Uint8Array>, totalBytes: number }` ready to spread into upload options
**And** it uses only `globalThis` APIs — no `window` reference

**Given** `fromFile(file)` result is spread into `uploadMultipart`
**When** the upload runs
**Then** `ProgressTick` events carry accurate `totalBytes` derived from `file.size`

### Story 8.2: Node.js Readable Stream Adapter

As a developer consuming the library,
I want a `fromNodeReadable(readable: Readable)` adapter from `@tranquilload/adapters/fromNodeReadable`,
So that I can use any Node.js `Readable` stream as an upload source without manual conversion.

**Acceptance Criteria:**

**Given** a Node.js `Readable` stream
**When** `fromNodeReadable(readable)` is called
**Then** it returns a `ReadableStream<Uint8Array>` compatible with all upload functions
**And** `fromNodeReadable` is the only file in the codebase allowed to import `node:stream`

**Given** the source `Readable` emits an error
**When** the converted stream is consumed
**Then** the error propagates through the Effect error channel as a typed `UploadError`

### Story 8.3: S3 Multipart Upload Adapter

As a developer consuming the library,
I want an `s3MultipartUpload(s3Options)` adapter from `@tranquilload/adapters/s3MultipartUpload`,
So that I can wire `uploadMultipart` to S3 with correct part size constraints and presigned URL handling built in.

**Acceptance Criteria:**

**Given** `s3MultipartUpload({ bucket, key, getPresignedUrl, s3Client })`
**When** spread into `uploadMultipart`
**Then** it provides `uploadPart`, `completeUpload`, and `initiate` callbacks pre-configured for S3
**And** part size is validated against S3's 5 MiB minimum (all parts except last) — violation produces a typed error before upload starts

**Given** `getPresignedUrl` rejects
**When** a part attempts to upload
**Then** the error is normalized and surfaces as `PresignedUrlError` in the typed error channel

### Story 8.4: Simple HTTP Upload Adapter

As a developer consuming the library,
I want a `simpleHttpUpload(httpOptions)` adapter from `@tranquilload/adapters/simpleHttpUpload`,
So that I can wire `uploadOnce` to any HTTP endpoint with a single PUT or POST request.

**Acceptance Criteria:**

**Given** `simpleHttpUpload({ url, method: "PUT", headers? })`
**When** spread into `uploadOnce`
**Then** the stream is sent as the request body using `fetch`
**And** a non-2xx response produces a typed error in the error channel

**Given** an `AbortSignal` is passed
**When** `controller.abort()` is called mid-request
**Then** the `fetch` call is aborted via the signal and `AbortError` surfaces

## Epic 9: CI/CD & Publishing

The team can publish versioned npm releases automatically via Changesets, with CI validating typecheck + tests + build on every PR.

### Story 9.1: CI Workflow

As a developer contributing to the library,
I want a GitHub Actions `ci.yml` workflow that runs on every push and pull request,
So that typecheck failures, test failures, and build errors are caught before any code reaches `main`.

**Acceptance Criteria:**

**Given** a pull request is opened or a push is made to any branch
**When** the CI workflow runs
**Then** it executes `pnpm turbo typecheck && pnpm turbo test && pnpm turbo build` in dependency order
**And** a failure in any step marks the workflow as failed and blocks merge

**Given** no source files have changed in a package
**When** CI runs
**Then** Turborepo cache is used and the unchanged package is skipped

### Story 9.2: Automated Release with Changesets

As a maintainer of the library,
I want a GitHub Actions `release.yml` workflow using Changesets,
So that versioning, CHANGELOG generation, and npm publishing are fully automated on merge to `main`.

**Acceptance Criteria:**

**Given** a changeset file is present in a PR
**When** the PR is merged to `main`
**Then** the Changesets GitHub Action opens a "Version Packages" PR bumping both `@tranquilload` and `@tranquilload/adapters` in lockstep with an updated CHANGELOG

**Given** the "Version Packages" PR is merged
**When** the release workflow runs
**Then** both packages are published to npm with matching version numbers
**And** a GitHub Release is created with the CHANGELOG entries

**Given** no changeset file is present in a PR
**When** it is merged to `main`
**Then** no version bump or publish occurs — the release PR is not updated
