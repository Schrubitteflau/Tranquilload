---
stepsCompleted: [1, 2, 3, 4]
status: complete
completedAt: '2026-03-08'
lastAppended: '2026-06-11'
lastAppendedEpic: 13
inputDocuments:
  - '_bmad-output/planning-artifacts/architecture.md'
  - '_bmad-output/test-artifacts/test-design-epic-11.md'
  - '_bmad-output/implementation-artifacts/epic-11-retro-2026-06-11.md'
  - '_bmad-output/brainstorming/brainstorming-session-2026-05-17-001.md'
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
- **Two npm packages**: `@tranquilload/core` and `@tranquilload/adapters`, with independent versioning via Changesets (peer dep `^X.Y.Z` ensures compatibility).
- **Build**: tsdown generates CJS + ESM + `.d.ts` via Oxc. Granular exports map in `package.json`.
- **Testing**: vitest + `@effect/vitest` (official Effect testing wrapper), tests co-located with source files (`*.test.ts`).
- **CI/CD**: Two GitHub Actions workflows — `ci.yml` (typecheck + test + build on push/PR) and `release.yml` (Changesets publish on merge to main).
- **Effect as peer dependency**: `effect >= 3.19.19` in both packages (reference equality requirement for Context.Tag).
- **Circuit Breaker**: 3-state machine (Closed → Open → HalfOpen) included in v1, located in `packages/core/src/multipart/circuit-breaker.ts`.
- **Naming conventions**: kebab-case files, PascalCase types/classes/services, camelCase functions, `SCREAMING_SNAKE_CASE` constants.
- **Pattern consistency**: All modules must expose Dual API (Promise/ReadableStream + `.effect` escape hatch), normalize callbacks via `normalizeCallback`, use `Effect.raceFirst` + `fromAbortSignal` for AbortController interop.
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
FR hardening (P2-surfaced gaps) — Epic 13: matures FR1/FR2/FR5/FR6/FR7/FR8 documented edge behaviour into typed contracts

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
**FRs covered:** Additional requirements (GitHub Actions, Changesets, independent versioning)

### Epic 10: P1 Test Coverage (tracked separately)
The team can run a P1 nightly suite covering the 42 release-critical scenarios surfaced by `brainstorming-session-2026-05-17-001`, gating v0.1.x releases.
**Status:** done (2026-05-21, v0.1.2). Story-level artifacts live in `_bmad-output/test-artifacts/test-design-epic-10.md` and `_bmad-output/test-artifacts/traceability/`; sprint status in `sprint-status.yaml`. No per-story files in `implementation-artifacts/` for this epic — recorded here for `epics.md` continuity.
**FRs covered:** Transversal (locks behaviour of FR1–FR10 + NFR1–NFR7 via P1 coverage)

### Epic 11: P2 Nightly Coverage
The team can run a P2 nightly suite covering ~87 scenarios across compression error paths, layer/logger/cleanup safety, resume edges, persona journeys, chaos, stream/chunking edges, and cross-browser/DIST/DOC gap-closers — extending Epic 10's P1 gate to a full nightly green bar.
**FRs covered:** Transversal (extends Epic 10; targets FR3/FR4 error paths, FR5 observability, FR6 resilience, FR7 resume edges, FR8 adapter edges, NFR1/NFR3 cross-browser, NFR5 logger safety)

### Epic 13: Library Hardening
The library maintainer can land the 14 documented behaviour-gaps surfaced by Epic 11's P2 coverage as validated, typed contracts — each story flips an existing locking test from "documents the gap" to "validates the fix": input-boundary guards, resume/reconcile robustness, abort & cleanup recovery, resilience policies, observability/integrity, and the `simpleHttpUpload` HTTP/1.1 streaming-transmission fix (D1). Epic 12 (circuit-breaker wire-up) is tracked separately.
**FRs covered:** Transversal (hardens FR1/FR2/FR5/FR6/FR7/FR8 + NFR3/NFR4/NFR6; no new FR)

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
**Then** the type is a closed union of `PartUploadError | MaxRetriesExceededError | PresignedUrlError | InitiateUploadError | ReconcileError | CompleteUploadError | AbortError | CircuitOpenError`
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
**And** if `signal` is provided, `Effect.raceFirst` with `fromAbortSignal` is used — no direct `signal.aborted` check

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
**Then** all in-flight parts are interrupted via `Effect.raceFirst` + `fromAbortSignal`
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
**Then** the Changesets GitHub Action opens a "Version Packages" PR bumping the changed package(s) with an updated CHANGELOG per package

**Given** the "Version Packages" PR is merged
**When** the release workflow runs
**Then** the changed package(s) are published to npm with their updated version numbers
**And** a GitHub Release is created with the CHANGELOG entries

**Given** no changeset file is present in a PR
**When** it is merged to `main`
**Then** no version bump or publish occurs — the release PR is not updated

## Epic 11: P2 Nightly Coverage

The team can run a P2 nightly suite covering ~87 scenarios across compression error paths, layer/logger/cleanup safety, resume edges, persona journeys, chaos, stream/chunking edges, and cross-browser/DIST/DOC gap-closers — extending Epic 10's P1 gate to a full nightly green bar.

**Source spec:** `_bmad-output/test-artifacts/test-design-epic-11.md` (the test design IS the spec input — there is no `tech-spec-epic-11.md`).

**Coverage origin:** P2 subset (~85 scenarios) of `_bmad-output/brainstorming/brainstorming-session-2026-05-17-001.md`, re-validated 2026-05-21 with no obsoletion from Epic 10's library bug fixes.

**Policy:** `feedback_p2_default_to_lib.md` (Epic 10 retro action #3) — P2 specs default to `tests/integration/` (vitest) or `tests/e2e/lib/` (PW-Lib). Only escalate to `tests/e2e/ui/` when a scenario genuinely needs the test-app DOM (persona journeys only).

**Effort:** ~75–115h (~3–4.5 sprint-weeks), ~1.6× Epic 10's footprint at 2× scenario count.

### Open Decisions (recorded 2026-05-22)

| # | Decision | Resolution | Impact |
|---|---|---|---|
| **D1** | **R-P2-4 — `simpleHttpUpload` missing `duplex: 'half'` fix** — schedule Epic 13 micro-fix in parallel OR codify the gap in Story 11.7? | **Codify gap in Story 11.7-E2E-002.** Test documents current cross-browser behaviour; the fix is tracked as an Epic 13 candidate and the test flips from "documents gap" to "validates fix" once Epic 13 lands. | Story 11.7-E2E-002 in scope; 11.7 exit criterion allows WAIVER + Epic 13 ticket. |
| **D2** | **R-P2-11 — `CircuitOpenError` (F#10) pending circuit-breaker wire-up** — keep deferred to Epic 12 OR promote circuit-breaker to its own micro-epic? | **Keep deferred to Epic 12.** Listed in Story 11.7-E2E-001 with explicit DEFER status; will graduate to Epic 12 once the wire-up lands as part of Epic 13's library hardening. No micro-epic detour. | 11.7-E2E-001 stays in the design matrix for traceability but contributes 0h to Epic 11 effort. |
| **D3** | **Story 11.4 persona WebKit flake risk (~2 week slip)** — pre-emptively demote to weekly OR commit to stabilization? | **Commit to stabilization.** Run 11.4 in the standard nightly tier; only demote individual specs to weekly via the `@flaky` tag if WebKit timings prove unstable in practice. Chaos-isolation audit (150/150 PASS, commit `b493bd0`) is the precedent that personas inherit. | Story 11.4 nominal effort 14–20h holds; ~2 week slip is the worst-case contingency, not the plan. |

### Story 11.1: Compression & Pipeline Error Paths

As a library maintainer,
I want vitest-integration coverage for compression and pipeline error paths,
So that any user-supplied or environment-misconfigured `CompressionService` surfaces a typed `UploadError`, never a fiber DEFECT.

**Acceptance Criteria:**

**Given** a custom `CompressionService` that throws synchronously
**When** `compress()` is added to the pipeline and an upload runs
**Then** the failure surfaces as `PartUploadError` in the Effect error channel (test ID 11.1-INT-001, 11.1-INT-004), and the upload fiber does not DEFECT

**Given** `globalThis.CompressionStream` is `undefined` or polyfilled to `undefined`
**When** `compress()` is invoked via the Promise or Effect API
**Then** `result` rejects (Promise) or fails in the typed error channel (Effect) — no unhandled exception (test IDs 11.1-INT-003, 11.1-INT-006)

**Given** a `CompressionService` whose returned `ReadableStream` errors asynchronously when read
**When** an upload runs
**Then** the stream-error path produces a typed `PartUploadError(0, 0, cause)` (test ID 11.1-INT-005)

**Given** an Effect-typed pipeline with `CompressionServiceLive`
**When** the upload runs via `.effect`
**Then** the Layer resolves correctly and produces the expected compressed output (test ID 11.1-INT-002)

**Coverage:** 6 vitest-integration tests (test IDs 11.1-INT-001 → 11.1-INT-006). Risk cluster R-P2-5.

### Story 11.2: Layers, Logger, Cleanup & Resource Safety

As a library maintainer,
I want vitest-integration + one PW-Lib heap-stability test covering layer composition, logger safety, and resource cleanup on all termination paths,
So that long-lived consumers do not leak streams, semaphores, or memory, and so layer-composition edge cases produce deterministic Effect errors instead of silent corruption.

**Acceptance Criteria:**

**Given** a user-injected recording logger
**When** an upload runs through its lifecycle
**Then** the expected sequence of log lines is captured deterministically (test ID 11.2-INT-001), and a logger throwing inside `logger.log` is swallowed by `safeLog` without crashing the upload fiber (verified by the existing Story 10.1-INT-013 contract; Story 11.2-INT-002 extends with a slow-logger latency check)

**Given** a `Layer.empty` is provided where the lib expects `CompressionServiceLive` or `LoggerServiceLive`
**When** the upload runs
**Then** the Effect runtime fails with a clear, typed error (test ID 11.2-INT-007) — no silent crash

**Given** a user Layer stacked above `CompressionServiceLive`
**When** the upload resolves the Tag
**Then** last-writer-wins semantics hold (test ID 11.2-INT-009)

**Given** an upload that errors, aborts, or completes
**When** the Effect scope closes
**Then** the source `ReadableStream` reader is released (11.2-INT-012), the pipeline cancels the upstream source on error (11.2-INT-013), the semaphore permit is released on terminal error (11.2-INT-016), and Layer finalizers run exactly once (11.2-INT-010)

**Given** 100 sequential uploads in a Chromium PW-Lib runner
**When** `performance.memory.usedJSHeapSize` is sampled before and after
**Then** the heap stays flat (no monotonic growth indicating leaks) (test ID 11.2-E2E-001)

**Given** a TCP RST during a PUT
**When** the upload runs
**Then** the failure surfaces as `PartUploadError`, not a hang (test ID 11.2-INT-014)

**Coverage:** 17 vitest-integration tests + 1 PW-Lib heap stability test = 18 net-new (test IDs 11.2-INT-001 → 11.2-INT-017 + 11.2-E2E-001). Risk clusters R-P2-2 + R-P2-8.

### Story 11.3: Resume + Reconcile + Error-Mapping Edges

As a library maintainer,
I want vitest-integration coverage for the resume + reconcile error-mapping edges that fell out of Epic 10's P1 scope,
So that every documented resume-failure mode (deleted uploadId, expired presigned URL, stale reconcile, 0-parts reconcile, presigned-URL failure inside `uploadPart`, 500 on `/parts`) maps to a phase-accurate `UploadError` variant.

**Acceptance Criteria:**

**Given** the adapter throws inside `uploadPart` because of a presigned-URL failure (`PresignedUrlError`)
**When** the upload runs
**Then** the failure wraps as `PartUploadError.cause` and retry semantics apply uniformly (test ID 11.3-INT-001 — codifies the design-gap surfaced by F#5)

**Given** the resume call hits a 500 on the `/parts` reconcile endpoint
**When** the upload starts
**Then** the failure surfaces as `ReconcileError` BEFORE any PUT is attempted (test ID 11.3-INT-002)

**Given** an `uploadId` that the server reports as `NoSuchUpload` (deleted)
**When** the resume runs
**Then** the error maps to a phase-accurate variant (test ID 11.3-INT-003)

**Given** a presigned URL that expires between sign and PUT
**When** the resume runs with re-sign-per-attempt
**Then** the upload recovers (test ID 11.3-INT-004 — complements the existing Story 10.3-E2E-002 path with a phase-accurate Effect-channel error)

**Given** `reconcileCompletedParts` returns a result that becomes stale (the server deletes a part between `ListParts` and the next op)
**When** the upload continues
**Then** the lib detects the divergence (test ID 11.3-INT-005)

**Given** `reconcileCompletedParts` returns an empty array for a known `uploadId`
**When** the upload starts
**Then** behaviour is identical to a fresh upload from part 1 (test ID 11.3-INT-006)

**Coverage:** 6 vitest-integration tests (test IDs 11.3-INT-001 → 11.3-INT-006). Risk cluster R-P2-6.

### Story 11.4: Persona Journeys (UI Flows)

As a library maintainer,
I want Playwright-UI persona journey specs that drive the full test-app DOM through realistic user-failure scenarios (tunnel disconnect, screen lock, Wi-Fi handoff, forgot-await, foot-gun `getProgress`, custom retry schedule, MinIO multipart TTL),
So that the documented foot-guns and persona-failures stay locked behaviour and do not silently regress.

**Acceptance Criteria:**

**Given** the test-app upload UI is loaded and a multipart upload is in flight
**When** the network is dropped for 30 seconds (P#A1 tunnel disconnect) or the page is throttled to simulate a screen lock (P#A2)
**Then** the documented behaviour holds: default retry schedule proves insufficient for 30s+ outages (locks the tuning need into a test), and screen-lock throttling does not crash the upload fiber (test IDs 11.4-E2E-001, 11.4-E2E-002)

**Given** an upload that survives a Wi-Fi → 5G handoff (P#A4)
**When** the underlying TCP connection dies and `fetch` errors
**Then** retry resilience kicks in and the upload completes (test ID 11.4-E2E-003)

**Given** a developer who forgets to `await result` on `uploadMultipart()` (P#B1)
**When** the upload fails
**Then** the unhandled rejection surface is deterministic and documented (test ID 11.4-E2E-004)

**Given** an upload whose `uploadPart` callback for part 1 calls `getProgress()` inside itself (P#B5)
**When** the call happens BEFORE the `Ref.update` post-uploadPart timing window
**Then** the snapshot returns 0 bytes — locking the documented foot-gun from MEMORY (`normalizeCallback double-wrapping` + `Ref.update post-uploadPart timing`) (test ID 11.4-E2E-005)

**Given** `retrySchedule: Schedule.recurs(10).pipe(Schedule.fixed("1 second"))` is supplied (P#B6)
**When** transient failures occur
**Then** the schedule is honoured end-to-end through the test-app (test ID 11.4-E2E-006)

**Given** an upload abandoned long enough for MinIO to GC the multipart (P#C2)
**When** the user reloads the page and the test-app calls `reconcileCompletedParts`
**Then** reconcile returns empty AND HEAD on the key fails — current behaviour is documented as fresh-start, with the gap surfaced as an Epic 13 candidate (test ID 11.4-E2E-007)

**Stabilization commitment (D3):** Story 11.4 runs in the standard nightly tier. Individual specs that prove unstable on WebKit may be demoted to weekly via the `@flaky` tag, but this is the contingency, not the plan. The 150/150 chaos-isolation audit is the precedent the personas inherit.

**Coverage:** 7 PW-UI persona specs (test IDs 11.4-E2E-001 → 11.4-E2E-007). Risk clusters R-P2-1 + R-P2-10. **Only PW-UI story in Epic 11** — all other P2 stories follow the lib-default policy.

### Story 11.5: Chaos Cluster (Intermittent + Simultaneous + Degraded)

As a library maintainer,
I want PW-Lib chaos coverage for intermittent, simultaneous, and degraded-network failure clusters via the per-session chaos endpoint,
So that retry, abort, and backpressure semantics hold under realistic adversarial conditions across the 3-browser matrix.

**Acceptance Criteria:**

**Given** 30% of PUTs fail randomly (C#1) or an offline window lasts 8 seconds (C#3)
**When** the upload runs with the default retry schedule
**Then** flapping recovers and the offline-window failure exposes the tuning need into a test (test IDs 11.5-E2E-001, 11.5-E2E-002)

**Given** a partial response truncation (`Content-Length` lies) (C#4), missing ETag in 200 OK (C#5), or garbage ETag (C#6)
**When** the upload runs
**Then** the error maps to `PartUploadError` (C#4, C#5) or `MinIO InvalidPart` on Complete (C#6) (test IDs 11.5-E2E-003 → 11.5-E2E-005)

**Given** two parts fail at the same time (C#7) or an abort fires during retry backoff (C#8)
**When** the orchestration fiber processes the failures
**Then** no shared-state bugs leak across retry loops (C#7) and `Effect.raceFirst` wins immediately against backoff (C#8) (test IDs 11.5-E2E-006, 11.5-E2E-007 — critical interrupt semantics)

**Given** degraded network conditions — slow 3G (C#12), high-latency + low-bandwidth (C#13), slow-loris server (C#15)
**When** the upload runs
**Then** no hardcoded client-side timeouts fire (slow 3G), abort stays responsive, and slow-loris surfaces the need for a future `partTimeout` option (Epic 13 candidate) (test IDs 11.5-E2E-008 → 11.5-E2E-010)

**Given** an abort fires during `/initiate`, between parts, or during `/complete` (C#18, C#19, C#20)
**When** the orchestration tears down
**Then** the documented behaviour holds: orphan multipart on `/initiate` abort, partial state in `refParts` on between-parts abort, no clean late-stage recovery on `/complete` (Epic 13 candidates) (test IDs 11.5-E2E-011 → 11.5-E2E-013)

**Test mechanism:** all 13 specs run via the `request` fixture's per-session chaos endpoint (validated by `tests/e2e/ui/chaos-isolation.spec.ts` at 150/150 PASS). PW-Lib level — no test-app UI navigation, no `addInitScript` monkey-patch.

**Coverage:** 13 PW-Lib chaos specs (test IDs 11.5-E2E-001 → 11.5-E2E-013). Risk clusters R-P2-3 + R-P2-9.

### Story 11.6: Stream/Chunking + One-Shot Edges + Events/Progress Dual-Mode

As a library maintainer,
I want vitest-integration coverage across stream/chunking edges, one-shot upload edges, `getProgress()` corner cases, `networkMultiplier` extrema, `computeOptimalPartSize` round-trip, File/Buffer/Node `Readable` sources, and the events-stream lifecycle,
So that all 28 documented surface-area edges from the brainstorming F# block are locked behaviour and no regression slips into a v0.1.x patch release.

**Acceptance Criteria:**

**Given** edge stream/chunking inputs (zero-byte file, mid-read source error, concurrency saturation, chunkSize=1, chunkSize > totalBytes, non-integer chunkSize)
**When** the upload runs
**Then** behaviour matches the documented contract — typed error or graceful single-part — for each input (test IDs 11.6-INT-001 → 11.6-INT-003, 11.6-INT-013 → 11.6-INT-015)

**Given** one-shot edges (sync `completeUpload`, Effect-typed `initiate` failure, abort mid-stream, server 4xx, empty stream)
**When** `uploadOnce` runs
**Then** each edge produces the documented result — typed error or success (test IDs 11.6-INT-004, 11.6-INT-005, 11.6-INT-010 → 11.6-INT-012)

**Given** events/progress dual-mode (cancelled events reader, `getProgress()` before initiate, `getProgress()` after completion, `uploadId` promise resolving even on later failure, events-stream-not-read latency)
**When** the upload runs
**Then** no leak, no surprise zero, no slow-down (test IDs 11.6-INT-006 → 11.6-INT-009, 11.6-INT-027, 11.6-INT-028)

**Given** `networkMultiplier` with no samples or saturated slow conditions
**When** the factor is sampled
**Then** the floor (1.0 on no samples; 0.1 on saturated slow — below S3 floor, user must clamp) is documented (test IDs 11.6-INT-016, 11.6-INT-017)

**Given** `computeOptimalPartSize` invoked with a range of inputs
**When** the resulting `chunkSize` flows through `uploadMultipart`
**Then** actual PUT body sizes round-trip the calculation (test ID 11.6-INT-018)

**Given** File / Buffer / Node `Readable` source edges (empty File, revoked blob URL, MIME parity, backpressure under slow consumer, ENOENT on `createReadStream`, `Readable.destroy(err)`, paused Readable auto-resume, Buffer no-realloc)
**When** the upload runs
**Then** each adapter edge surfaces the documented behaviour (test IDs 11.6-INT-019 → 11.6-INT-026)

**Coverage:** 28 vitest-integration tests (test IDs 11.6-INT-001 → 11.6-INT-028). Risk clusters R-P2-7 + R-P2-13. High count, low cost each (~0.5h/test mean).

### Story 11.7: Cross-Browser + DIST + DOC + Filename Gap-Closers

As a library maintainer,
I want mixed-harness coverage for cross-browser streaming body behaviour, DIST tree-shaking + `node:*` boundary, doctest extensions, and filename edges,
So that the bundle/runtime contract holds across all 3 browsers and the README examples stay reproducible.

**Acceptance Criteria:**

**Given** F#10 / `CircuitOpenError` — circuit-breaker not yet wired (R-P2-11)
**When** Epic 11 nightly runs
**Then** test ID 11.7-E2E-001 is recorded as **DEFER to Epic 12** with no effort consumed in Epic 11; entry remains in the design matrix for traceability (per Decision D2)

**Given** `simpleHttpUpload` lacking the `duplex: 'half'` fix (R-P2-4, per Decision D1)
**When** the test runs across Chromium / Firefox / WebKit
**Then** the spec documents the current cross-browser gap; the same spec validates the fix once the Epic 13 candidate lands (test ID 11.7-E2E-002 — exit criterion allows WAIVER + Epic 13 ticket)

**Given** `CompressionStream` `deflate-raw` algorithm support across browsers (older WebKit lacks the algo, R-P2-12)
**When** the smoke spec runs
**Then** the support matrix is documented in the README and the spec catches a regression (test ID 11.7-E2E-003)

**Given** the built bundles in `packages/*/dist/`
**When** DIST validation runs (extends Epic 10's `tests/integration/dist/` harness)
**Then** a oneshot-only import excludes multipart code from the final bundle (test ID 11.7-X-001 — tree-shake proof), and no `node:*` import appears in the browser bundle outside the `fromNodeReadable` boundary (test ID 11.7-X-002)

**Given** special-character (`#`, `?`, `%`, `+`, ` `, `café`, `🚀`, RTL) and >1024-char filenames (R-P2-14)
**When** the S3 key path is built
**Then** sanitization holds for special chars (test ID 11.7-INT-001) and the >1024-char case fails with `InitiateUploadError` (test ID 11.7-INT-002)

**Given** the README resume example, compression example, and test-app setup script
**When** the doctest harness runs (extends Epic 10's `spawnSync` harness)
**Then** each example compiles and executes end-to-end — size assertion for compression, CI-runnable for test-app README (test IDs 11.7-D-001 → 11.7-D-003)

**Coverage:** 11 total — 3 PW-Lib (F#10 deferred, F#40/G#2, G#3) + 2 DIST (G#13, G#15) + 3 DOC (G#25, G#27, G#29) + 3 VT (G#17, G#19 + 1 deferred entry). Risk clusters R-P2-4, R-P2-11 (deferred), R-P2-12, R-P2-14.

---

**Total Epic 11 scope:** 87 net-new tests + 1 deferred to Epic 12. ~75–115h effort. See `_bmad-output/test-artifacts/test-design-epic-11.md` for the full coverage matrix, execution tiers (Smoke / Tier A VT / Tier B PW-Lib / Tier C PW-UI), and gate criteria.

## Epic 13: Library Hardening

The library maintainer can land the 14 documented behaviour-gaps surfaced by Epic 11's P2 coverage as validated, typed contracts. Unlike Epics 10/11 (which *locked* current behaviour), Epic 13 *changes* behaviour — each story flips an existing locking test from "documents the gap" to "validates the fix".

**Source backlog:** `_bmad-output/implementation-artifacts/epic-11-retro-2026-06-11.md` § *Epic 13 Candidate Backlog* (14 items, each with a locking test already in place). Genealogy: `brainstorming-session-2026-05-17-001.md` (F#N scenario matrix).

**Shovel-ready property:** because each candidate already has a passing locking test that documents the desired end-state, most stories are "flip the lock + update the assertion". The 14 candidates group into 6 stories by subsystem.

**API-validation gate (process lesson from 11.4):** brainstorming-sourced ACs must pass an API-validation pass before dev (the 11.4 AC#5 `Schedule.fixed`-as-combinator drift). This pass was run during epic authoring (2026-06-11) and is baked into the ACs below; the 3 spike-gated stories (13.3, 13.5, 13.6) require a further design pass at story-creation time.

**Non-breaking default rule:** every new option (`partTimeout`, fail-fast policy, `reinitOnStale`, ingest checksum, auto-fallback) is opt-in — Epic 13 must not change default behaviour for existing consumers.

**Epic 12 (circuit-breaker wire-up, R-P2-11 / D2) is tracked separately** and is NOT part of Epic 13.

### Story 13.1: API-Boundary Input Guards

As a library maintainer,
I want pre-flight validation guards at the public API boundary for the four documented input-edge gaps (non-integer `chunkSize`, oversized S3 key, S3 10k-part overflow, empty one-shot),
So that malformed configuration surfaces as a typed error/throw BEFORE any network request, instead of silently degrading or producing a corrupt/orphaned upload.

**Acceptance Criteria:**

**Given** a non-integer `chunkSize` (e.g. `1024.7`)
**When** `uploadMultipart` runs
**Then** it fails fast with a typed validation error and uploads no part — by extending the existing guard in `multipart/upload-stream.ts` (currently `!Number.isFinite(chunkSize) || chunkSize <= 0`) to also require `Number.isInteger(chunkSize)`. Flips locking test 11.6-INT-015 (F#44) from "accepted, byte-fidelity preserved" to "rejected at the boundary".

**Given** an S3 object key longer than 1024 chars
**When** `s3MultipartUpload`'s `initiate` is invoked
**Then** it rejects pre-flight with `InitiateUploadError` BEFORE calling `createMultipartUpload`. The guard lives in the **S3 adapter** (S3-specific limit), per the architecture rule "protocol constraints live in the adapter, never in the core". Flips locking test 11.7-INT-002 (G#19) from "adapter does NOT pre-validate" to "pre-flight rejection".

**Given** a `totalBytes / chunkSize` that would exceed S3's 10,000-part maximum
**When** the caller validates upload configuration
**Then** the overflow is surfaced as an `InitiateUploadError`/throw via a **caller-side helper** (extend `computeOptimalPartSize` or a new `assertS3PartCount`) — the 10k limit is S3-specific and MUST NOT live in the protocol-agnostic core. *(Design choice: opt-in helper vs S3-adapter-embedded guard — decide at story creation.)* Complements locking test 11.6-INT-013 (F#42).

**Given** an empty source stream passed to `uploadOnce`
**When** the upload runs
**Then** per the chosen policy, it either rejects with a typed error OR preserves the current `UploadCompleted totalParts:1` behaviour behind an explicit `allowEmpty` opt-in. *(Design choice: empty-as-error vs opt-in — decide at story creation; default must not break existing callers without a flag.)* Flips/refines locking test 11.6-INT-012 (F#39).

**Coverage:** flips/refines 4 locking tests (11.6-INT-015, 11.7-INT-002, 11.6-INT-013, 11.6-INT-012). Touches core (`upload-stream.ts` chunkSize guard; `oneshot` empty policy) + S3 adapter (key-length guard; part-count helper). **Quick-win tier** — no spike. Risk clusters R-P2-7, R-P2-13, R-P2-14.

### Story 13.2: Resume & Reconcile Robustness

As a library maintainer,
I want the resume/reconcile path to recover from the three documented stale-state gaps (deleted/GC'd `uploadId`, GC'd reconciled part, and the S3 adapter not threading a resumed `uploadId`),
So that a cross-session resume against drifted server-side state recovers gracefully instead of dead-ending in `ReconcileError`/`CompleteUploadError` or signing against an empty `uploadId`.

**Acceptance Criteria:**

**Given** a persisted `uploadId` the server reports as `NoSuchUpload` (deleted / GC'd)
**When** the resume reconcile runs with an opt-in `reinitOnStale` policy
**Then** the lib auto-reinitiates a fresh multipart from part 1 and completes, instead of failing with `ReconcileError`. Default (no policy) keeps the current fail-fast. Flips locking test 11.3-INT-003 (F#12) from "surfaces ReconcileError, no auto-reinit" to "re-initiates and completes"; corroborated by persona 11.4-E2E-007 (C2).

**Given** a cross-session resume where the consumer never calls `initiate` in the new session
**When** `s3MultipartUpload` signs presigned URLs for `uploadPart`
**Then** it threads a caller-supplied `resumeUploadId` (new adapter option/setter) instead of the empty `storedUploadId` closure (`let storedUploadId = ""` at `s3-multipart-upload.ts:42`, set only in `initiate`). Closes the 11.7 S3-resume gap.

**Given** `reconcileCompletedParts` returns a part the server GCs before `/complete`
**When** the upload reaches the complete phase
**Then** the lib detects the missing part and re-uploads it instead of dead-ending. Flips locking test 11.3-INT-005 (F#14) from "surfaces as CompleteUploadError at complete phase" to "re-uploads and completes". **🔻 DEFERRED from Story 13.2 (2026-06-12, Project Lead, via API-validation pass)** — this is NOT a quick-win flip: it carries a memory-safety tension (reconciled chunks are discarded after the skip and the source stream is drained by the complete phase, so re-upload requires unbounded opt-in retention) + a protocol-agnostic-detection problem (the core can't identify which part S3's `InvalidPart` refers to without parsing S3 error strings). Moved to a follow-up spike (recommended new Story 13.7 "Reconciled-part integrity & re-upload", or fold into 13.5). 11.3-INT-005 stays a LOCK (re-tagged, not flipped) until then.

**Coverage:** Story 13.2 ships **2 of 3** sub-changes — flips 11.3-INT-003 (`reinitOnStale`, core) + closes the 11.7 S3-resume gap (`resumeUploadId`, net-new adapter test). The third (re-upload GC'd reconciled part, would flip 11.3-INT-005) is **DEFERRED** (see above). Persona 11.4-E2E-007 corroborates. Touches core resume orchestration + S3 adapter. **Quick-win tier.** Risk cluster R-P2-6.

### Story 13.3: Abort & Cleanup Recovery

As a library maintainer,
I want a teardown/cleanup contract for the two documented abort gaps (orphan multipart on initiate-abort/tab-close, and no clean late-stage `/complete`-abort recovery),
So that an aborted or abandoned upload does not silently leave an orphan multipart on the server and a late-stage abort has a documented recovery path.

**⚠️ API-validation / design spike required before dev:** there is NO existing hook the lib can call on teardown (F#87 lock: `initiate` fires once, `completeUpload` never reached, no callback). The story must first design the abort/cleanup surface (e.g. an `abortMultipartUpload(uploadId)` callback the orchestrator invokes on interrupt) and validate it against Effect's `Scope`/finalizer semantics and the existing `Effect.raceFirst(partEffect, fromAbortSignal(signal))` interrupt path before implementing.

**Acceptance Criteria:**

**Given** an abort fires after `/initiate` but before `/complete`
**When** the orchestration tears down
**Then** the lib invokes a user-supplied abort/cleanup callback so the server-side multipart is cleaned up — instead of the current "orphan multipart on server, no auto-abort hook". Flips BOTH the vitest lock 11.2-INT-015 (F#87) and the PW-Lib chaos lock 11.5-E2E-011 (C#18).

**Given** an abort fires DURING `/complete`
**When** the upload tears down
**Then** the lib surfaces a deterministic, documented recovery state (parts are uploaded; `/complete` may or may not have landed) and defines whether `/complete` is idempotent-retryable or requires a reconcile probe — instead of the current "no clean late-stage recovery". Flips locking test 11.5-E2E-013 (C#20).

**Coverage:** flips 11.2-INT-015, 11.5-E2E-011, 11.5-E2E-013. Touches core orchestration teardown + adapter abort surface. **Spike-gated.** Risk clusters R-P2-3 + R-P2-9.

### Story 13.4: Resilience Policies & Timeouts

As a library maintainer,
I want two opt-in resilience knobs — a `partTimeout` bound on a pathologically slow part, and a fail-fast policy for `PresignedUrlError` —
So that a slow-loris part cannot hang an upload indefinitely and an unrecoverable presigning failure can short-circuit instead of burning the full retry budget.

**Acceptance Criteria:**

**Given** a `partTimeout: Duration` is supplied and a part's transfer exceeds it
**When** the upload runs
**Then** that part attempt fails with a typed timeout error (which feeds the existing `retrySchedule`) — by wrapping the per-part `partEffect` in `Effect.timeoutFail` at the `upload-stream.ts` part-execution site. With no `partTimeout` set, the current "no hardcoded client timeout" behaviour is preserved. Flips locking test 11.5-E2E-010 (C#15) from "slow-loris part still completes" to "slow part times out when bounded".

**Given** a fail-fast policy naming `PresignedUrlError`
**When** `uploadPart`'s sign step throws `PresignedUrlError`
**Then** the part fails immediately without consuming the retry budget — instead of the current "wraps as `PartUploadError.cause` and is retried uniformly" (3 attempts in the lock). Default (no policy) preserves uniform retry. Flips locking test 11.3-INT-001 (F#5).

**Coverage:** flips 11.5-E2E-010, 11.3-INT-001. Both additive opt-in options; defaults unchanged (non-breaking). Touches core `upload-stream.ts` part execution + retry. **Quick-win tier.** Risk clusters R-P2-6 + R-P2-9.

### Story 13.5: Observability — Event-Stream Flush-Before-Error

As a library maintainer,
I want the public `events` stream to flush buffered `UploadEvent`s before surfacing a failure/abort,
So that abort/failure observability is not lost (events currently read empty on the failure path).

**✅ Spike resolved 2026-06-20 (Project Lead, via API-validation pass). SHIPPED (done).** The epic-level 13.5 bundled TWO halves — (1) event-stream flush + (2) optional ingest checksum. The spike found the root cause of the flush gap (both `multipart/index.ts` and `oneshot/index.ts` build `events` from an all-or-nothing `Stream.runCollect` that discards buffered events on a failed Exit → the stream closes empty), and that the checksum half carries a **genuine semantics fork** (a digest of the uploaded bytes cannot detect a buggy compressor — it faithfully matches the corrupt output). **Decision: ship the flush half only here; carve the ingest checksum into Story 13.5b** with its own design pass. Design chosen: split the events channel from the result channel — enqueue each event **live** via `Stream.tap` into a controller-backed `ReadableStream`, keep the typed `UploadError` on `result` only (never masked). Locked at the **unit tier** (net-new `13.5-INT-001/002`); the Story 11.5 E2E callback-counter workaround is re-tagged, not flipped (DD1).

**Acceptance Criteria:**

**Given** an upload that fails or is aborted mid-flight (after ≥1 event emitted)
**When** the consumer reads the `events` stream
**Then** all `UploadEvent`s emitted before the failure are observable (flushed) before the stream closes — instead of reading empty — while the typed `UploadError` still surfaces only via `result` (never masked on the events channel). With a successful upload the events stream is unchanged. Locked by net-new `13.5-INT-001` (part-failure) + `13.5-INT-002` (abort); the Story 11.5 events-empty workaround is re-tagged.

**Coverage:** locks the flush at the unit tier; re-tags (does not flip) the Story 11.5 events-empty E2E workaround + applies symmetrically (behaviour-preserving) to `uploadOnce`. Touches core events/Stream orchestration. **Spike resolved.** Risk cluster R-P2-3. Story file: `13-5-observability-and-integrity.md`.

### Story 13.5b: Ingest Integrity Checksum (SPIKE RESOLVED — decline/document-only)

As a library maintainer,
I want an optional ingest checksum to surface a corrupting upload pipeline before `completeUpload`,
So that a buggy `CompressionService` (or wire corruption) is caught instead of silently producing a corrupt object.

**✅ Spike resolved 2026-06-20 (Project Lead, via design pass + AskUserQuestion → decline/document-only). NO library code.** The design pass confirmed F#70's literal promise ("a checksum catches a buggy compressor") is **not honestly deliverable by any generic checksum**, and found that the only real-world win is **already achievable caller-side**:

- **(a) per-part transport-integrity checksum** — the win (the SERVER rejects wire corruption via `x-amz-checksum-sha256`) needs no library API: `uploadPart(partNumber, chunk)` already hands the caller the exact post-pipeline bytes, so they can `crypto.subtle.digest("SHA-256", chunk)` and forward the header themselves. The lib could only offer thin sugar; does NOT detect a buggy compressor.
- **(b) caller-supplied expected post-pipeline digest** — has **no oracle on a first upload** (the expected digest *is* the pipeline's output, unknown before the pipeline runs); only detects divergence between a recorded prior run and a re-run (niche regression check), with cross-platform streaming-hash friction (Web Crypto `subtle.digest` is one-shot, no MD5).
- `getContentDigest` is orthogonal (a resume-identity key called before bytes flow — "MUST NOT consume bytes"), not reusable for integrity.

**Decision (Option 1): ship NO new API.** Document the DIY path instead — README "Ingest integrity (the no-checksum trust boundary)" subsection + a TSDoc note on `uploadPart`. F#70 / `11.2-INT-005` stays a GREEN trust-boundary lock — **13.5b does NOT flip it** (comment updated to record the resolution). Heuristics applied: (ii) capability already exists → don't add a knob; (v) don't ship a dishonest lock for an undeliverable AC.

**Outcome:** doc-only (README + TSDoc), no behaviour change, no new surface, no crypto dependency. Risk cluster R-P2-5 closed (documented trust boundary + DIY remedy).

### Story 13.6: simpleHttpUpload HTTP/1.1 Streaming Transmission

As a library maintainer,
I want `simpleHttpUpload` to transmit a streamed body across all three engines — either by negotiating HTTP/2 or by transparently falling back to buffered mode when streaming over HTTP/1.1 fails —
So that the documented cross-browser transmission gap (streamed PUT works only on Chromium/HTTP-2 today) closes without forcing the user to manually set `bufferMode`.

**⚠️ API-validation / design spike required before dev (Decision D1):** the adapter ALREADY has `duplex: 'half'` streaming + a manual `bufferMode` opt-out; CONSTRUCTION works in all 3 engines, but TRANSMISSION over plain HTTP/1.1 fails outside Chromium (request streams require HTTP/2). Automatic fallback has a memory-safety tension — `bufferMode` buffers the whole source, so the lib MUST NOT blindly auto-buffer a huge file. The spike must choose between (a) HTTP/2 capability detection, (b) catch-stream-failure-then-retry-buffered bounded by a size threshold, or (c) a documented per-engine policy — validated against the cross-engine probe in `11.7-E2E-002`.

**🔬 Design pass RUN 2026-06-20 — fork surfaced, PENDING Project Lead decision (PL stopped to clarify first; not yet chosen).** Validated against `packages/tranquilload-adapters/src/protocols/simple-http-upload.ts` + the `11.7-E2E-002` probe. Findings: **(a) HTTP/2 detection is NOT deliverable in-browser** — the Fetch API exposes no negotiated-protocol signal (no `response.httpVersion`, no pre-flight probe); the locking test itself *empirically probes* (buffered vs streamed) rather than detecting. (Node/undici DOES expose the protocol — revisit if the Node path is the priority.) **(b) catch-fail→retry-buffered is blocked by single-use streams** — `upload(stream)` hands the source straight to `fetch` (`simple-http-upload.ts:69`); a `ReadableStream` is consumed once, so a buffered retry from the same stream is impossible. Safe retry needs either `tee()`+buffer-one-branch (whole source in memory always → violates AC#2) OR a re-openable source (Blob/File/factory → contract change, not "transparent"). **(c) is ~90% shipped** — `bufferMode:true` already gives an HTTP/1.1-safe path in all engines (heuristic ii) and README already documents it. **AC#2 memory-safety crux:** any auto-buffer needs a SIZE BOUND, but a bare stream has no known size → a safe design must take size from the caller. **Honest fork for the PL:** (1) **opt-in size-bounded auto-buffer** — caller gives a sized source (Blob/File or `contentLength`) + `maxAutoBufferBytes`, decided BEFORE consuming the stream (size ≤ threshold ⇒ buffer/all-engines/no-manual-bufferMode; size > threshold ⇒ stream-needs-HTTP/2 or typed error); memory-safe; *proactive buffer-if-small* mechanism is cleaner than catch-retry; flips `11.7-E2E-002` for the bounded case — **recommended**; (2) **document-only** (close like 13.5b — `bufferMode` already exists; `11.7-E2E-002` stays green, not flipped); (3) transparent `tee()`-catch-retry — NOT recommended (whole source in memory always / fragile stream-reuse). Resume by re-presenting this fork via AskUserQuestion.

**✅ DECIDED 2026-06-22 — Project Lead chose fork (1): opt-in size-bounded auto-buffer. IMPLEMENTED (adapter-only, opt-in patch).** New `SimpleHttpUploadOptions` fields `contentLength?: number` + `maxAutoBufferBytes?: number` decide the transport up front (before the single-use stream is touched): `contentLength <= maxAutoBufferBytes` ⇒ buffered (HTTP/1.1-safe, all engines, no manual `bufferMode`); `contentLength > maxAutoBufferBytes` ⇒ streamed (`duplex:'half'`, HTTP/2; large source never buffered). Memory-safe by construction — `maxAutoBufferBytes` requires `contentLength` (factory throws `TypeError` rather than measure-then-buffer an unsized stream — this is AC#2's "surfaces a typed error"), oversize streams rather than buffers (AC#2's "honours an explicit policy"), and `bufferMode:true` still wins. HTTP/2 detection intentionally NOT attempted (undeliverable in-browser per finding (a)). **Flip-the-lock per the wrong-tier rule:** `11.7-E2E-002` empirically probes RAW browser `fetch` HTTP/1.1-streaming capability — a platform fact the adapter routes *around* (small sources buffer) but cannot *remove* — so it stays a TRUE negative lock (RE-TAGGED, NOT flipped); the deterministic buffer-vs-stream decision is locked NET-NEW at the unit tier (`packages/tranquilload-adapters/src/protocols/simple-http-upload.test.ts`, `13.6-INT-001..007`). AC#1 is satisfied in its achievable form (see the reconciliation note under it).

**Acceptance Criteria:**

**Given** a streamed PUT to an HTTP/1.1 endpoint in Firefox / WebKit
**When** `simpleHttpUpload` runs in its default (streaming) mode
**Then** the upload transmits successfully — over a negotiated HTTP/2 connection or via a transparent buffered fallback — instead of rejecting. Flips locking test 11.7-E2E-002 (F#40 / G#2) from "streamed PUT fails on HTTP/1.1 outside Chromium" to "streamed PUT transmits in all engines". — **RECONCILED 2026-06-22:** the literal "transmits via streaming in all engines" is undeliverable (HTTP/2 detection impossible in-browser; the engine genuinely rejects an HTTP/1.1 request stream). Delivered in its achievable form: a **small bounded** source now transmits in all engines via the opt-in auto-buffer (no manual `bufferMode`). `11.7-E2E-002` is RE-TAGGED (its raw-engine negative assertion stays green — correct platform fact), and the new behaviour is locked at the unit tier (`13.6-INT-001..007`).

**Given** auto-fallback to buffered mode is triggered
**When** the source exceeds a configured size threshold
**Then** the lib surfaces a typed error (or honours an explicit policy) rather than silently buffering an oversized file into memory.

**Coverage:** flips 11.7-E2E-002 (the D1 WAIVER entry). Touches the `simpleHttpUpload` adapter only. **Spike-gated (D1).** Risk cluster R-P2-4.

---

**Total Epic 13 scope:** stories flipping ~13 discrete locking tests (plus the 11.5 events-empty cross-cutting workaround and the 11.7 S3-resume gap) from "documents the gap" to "validates the fix". 1 candidate (F#42 10k-part) is realized as a caller-side/S3-adapter helper per the protocol-agnostic-core rule. **Quick-win tier:** 13.1, 13.2, 13.4 (flip-the-lock). **Spike-gated:** 13.3, 13.5, 13.6 (API-validation/design pass precedes implementation). **Status (2026-06-22):** 13.1/13.2/13.3/13.4 done + released; **13.5 done** (flush half); **13.5b resolved** (ingest-checksum spike → decline/document-only, doc-only, no library code — the transport-checksum win is already caller-achievable via the `chunk` handed to `uploadPart`; F#70 stays a green trust-boundary lock, not flipped); **13.6 done** (fork (1) opt-in size-bounded auto-buffer, adapter-only patch; `11.7-E2E-002` re-tagged + `13.6-INT-001..007` net-new unit locks; independent Opus review Approve-with-nits 0H/0M/3L, F3 README caveat applied; pending release). Remaining: deferred 13.7 (reconciled-part integrity). Every new option is opt-in — no default behaviour changes. Epic 12 (circuit-breaker, R-P2-11) tracked separately.
