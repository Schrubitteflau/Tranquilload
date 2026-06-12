import { Cause, Effect, Exit, Option, Ref, Schedule, Stream } from "effect"
import type { UploadError } from "../errors/upload-error.js"
import { CircuitOpenError, CompleteUploadError, InitiateUploadError, MaxRetriesExceededError, PartUploadError, ReconcileError, ResumeMismatchError } from "../errors/upload-error.js"
import type { CircuitOpen, PartCompleted, ProgressTick, UploadCompleted, UploadEvent, UploadInitiated } from "../progress/upload-event.js"
import { LoggerService, safeLog } from "../services/logger-service.js"
import { fromAbortSignal } from "../utils/abort-interop.js"
import { normalizeCallback } from "../utils/normalize-callback.js"
import { makeCircuitBreaker, type CircuitBreakerConfig } from "./circuit-breaker.js"
import { chunkStream } from "./chunk-stream.js"

export interface CompletedPart {
  readonly partNumber: number
  readonly etag: string
}

/**
 * Opaque resume metadata returned by `uploadMultipart` and persisted by the
 * caller (typically `JSON.stringify` → localStorage). Pass it back as
 * `resumeFrom` on the next session.
 *
 * The lib validates `version`, `chunkSize`, `pipelineIdentity`, and the content
 * digest before any byte is uploaded. A mismatch fails the upload with a typed
 * `ResumeMismatchError` — preventing the silent-corruption classes documented
 * in the v0.2.x release notes.
 *
 * **Schema versioning.** The `version: 1` literal is a tripwire for schema
 * evolution: future v2 schemas widen this union, and a persisted v1 state
 * passed to a future v2 lib will fail with `ResumeMismatchError("version_mismatch")`
 * rather than silently misinterpreting old fields.
 */
export interface ResumeState {
  readonly version: 1
  readonly uploadId: string
  readonly chunkSize: number
  readonly pipelineIdentity?: string
  readonly contentDigest?: string
  /**
   * True if the original session captured a digest. Detects persistence layers
   * that drop the `contentDigest` field (which would otherwise silently bypass
   * content-mismatch validation).
   */
  readonly contentDigestCaptured: boolean
}

export interface UploadMultipartOptions {
  readonly stream: ReadableStream<Uint8Array>
  readonly chunkSize: number
  readonly uploadPart: (
    partNumber: number,
    chunk: Uint8Array
  ) => string | Promise<string> | Effect.Effect<string, UploadError>
  readonly completeUpload: (
    uploadId: string,
    parts: ReadonlyArray<CompletedPart>
  ) => void | Promise<void> | Effect.Effect<void, UploadError>
  readonly initiate?: () =>
    | { uploadId: string }
    | Promise<{ uploadId: string }>
    | Effect.Effect<{ uploadId: string }, UploadError>
  readonly reconcileCompletedParts?: () =>
    | ReadonlyArray<CompletedPart>
    | Promise<ReadonlyArray<CompletedPart>>
    | Effect.Effect<ReadonlyArray<CompletedPart>, UploadError>
  /**
   * Resume metadata persisted from a previous session. When set, the lib skips
   * the `initiate` callback (the `uploadId` is read from `resumeFrom`) and
   * validates `version`, `chunkSize`, `pipelineIdentity`, and `contentDigest`
   * before any byte is uploaded. A mismatch fails the upload with
   * `ResumeMismatchError`.
   *
   * Synchronous (pre-flight) validation happens at `uploadMultipart()` call
   * time — `TypeError` for an empty `uploadId`, `ResumeMismatchError` for the
   * rest. The asynchronous content-digest *value* match is verified inside
   * the Effect once the upload stream is consumed.
   */
  readonly resumeFrom?: ResumeState
  /**
   * Called once on fresh initiate to capture a digest of the source content.
   * On a subsequent resume session, called again and compared to
   * `resumeFrom.contentDigest`; a mismatch fails the upload with
   * `ResumeMismatchError("content_mismatch")` before any byte is uploaded.
   *
   * **MUST be lightweight and stable across sessions.** Suggested patterns:
   * - Browser `File`: `` `${name}|${size}|${lastModified}` ``
   * - Node `Readable` from a file: `` `${path}|${stat.size}|${stat.mtimeMs}` ``
   * - Synchronous strings; avoid full-file crypto hashes on the synchronous path.
   *
   * **MUST NOT consume bytes from the source stream** (passed in
   * `options.stream`). The lib calls `getContentDigest` before any chunk is
   * pulled from the source; consuming from the source here will produce a
   * zero-byte upload because no bytes remain for `chunkStream`.
   */
  readonly getContentDigest?: () =>
    | string
    | Promise<string>
    | Effect.Effect<string, UploadError>
  /**
   * An opaque, stable identifier for the upstream pipeline composition.
   * Captured in `ResumeState` and validated strict-equality on resume.
   * **You own keeping this stable** — if you configure `compress("deflate-raw")`
   * in session A, you must pass the same `pipelineIdentity` on resume.
   *
   * **Strict equality limitation:** a pipeline that is logically identical but
   * produces different identifier strings (e.g. tag bumps, version-stamped
   * strings) triggers `ResumeMismatchError("pipeline_mismatch")`. Pick a stable
   * string (e.g. `"deflate-raw-v1"`) and only change it when the pipeline's
   * *byte-level output* changes.
   *
   * **Compression non-determinism caveat:** even with identical
   * `pipelineIdentity`, a non-deterministic pipeline (e.g. gzip with `mtime`
   * headers, encryption with random salt) produces different bytes per run.
   * Resume against the same uploaded parts only works if the pipeline is
   * byte-deterministic. Verify your pipeline's determinism before relying on
   * this.
   */
  readonly pipelineIdentity?: string
  readonly maxConcurrency?: number
  readonly signal?: AbortSignal
  readonly retrySchedule?: Schedule.Schedule<unknown, PartUploadError>
  readonly circuitBreaker?: CircuitBreakerConfig
  /**
   * Opt-in recovery for a resume whose persisted `uploadId` the server has
   * deleted / garbage-collected. The predicate receives the **raw**
   * `reconcileCompletedParts` rejection (before it is wrapped as
   * `ReconcileError`); return `true` to classify it as a stale `uploadId`.
   *
   * On a `true` result, **and only when an `initiate` callback is supplied**,
   * the lib abandons the stale upload and re-initiates a fresh multipart from
   * part 1 (the reconciled-parts map is discarded), emitting a fresh
   * `UploadInitiated` for the new `uploadId`. Without an `initiate` callback the
   * stale failure surfaces as `ReconcileError` (current behaviour) — so this
   * option is purely additive.
   *
   * **Protocol-agnostic by design:** the core never inspects the cause shape
   * (e.g. an S3 `NoSuchUpload` code) — only the caller knows what "stale" means
   * for their backend. Default (`undefined`) preserves the fail-fast
   * `ReconcileError`.
   *
   * @example
   * ```ts
   * reinitOnStale: (cause) =>
   *   (cause as { Code?: string })?.Code === "NoSuchUpload"
   * ```
   */
  readonly reinitOnStale?: (cause: unknown) => boolean
}

const DEFAULT_MAX_CONCURRENCY = 4

// 3 total attempts: 1 initial + 2 retries, with exponential backoff
const DEFAULT_RETRY_SCHEDULE = Schedule.exponential("100 millis").pipe(
  Schedule.compose(Schedule.recurs(2))
)

export const uploadMultipartEffect = (
  options: UploadMultipartOptions
): Stream.Stream<UploadEvent, UploadError, LoggerService> => {
  const {
    stream,
    chunkSize,
    uploadPart,
    completeUpload,
    initiate,
    reconcileCompletedParts,
    resumeFrom,
    getContentDigest,
    pipelineIdentity,
    maxConcurrency = DEFAULT_MAX_CONCURRENCY,
    signal,
    retrySchedule = DEFAULT_RETRY_SCHEDULE,
    reinitOnStale,
  } = options

  if (!Number.isFinite(chunkSize) || chunkSize <= 0 || !Number.isInteger(chunkSize)) {
    throw new TypeError(
      `uploadMultipart: chunkSize must be a positive finite integer, got ${chunkSize}`
    )
  }

  if (resumeFrom !== undefined) {
    if (typeof resumeFrom.uploadId !== "string" || resumeFrom.uploadId === "") {
      throw new TypeError(
        "uploadMultipart: ResumeState.uploadId must be a non-empty string"
      )
    }
    if (resumeFrom.version !== 1) {
      throw new ResumeMismatchError("version_mismatch")
    }
    if (resumeFrom.chunkSize !== chunkSize) {
      throw new ResumeMismatchError("chunksize_mismatch")
    }
    if (resumeFrom.pipelineIdentity !== pipelineIdentity) {
      throw new ResumeMismatchError("pipeline_mismatch")
    }
    if (
      resumeFrom.contentDigestCaptured === true &&
      resumeFrom.contentDigest === undefined
    ) {
      throw new ResumeMismatchError("content_mismatch")
    }
  }

  return Stream.unwrap(
    Effect.gen(function* () {
      const logger = yield* LoggerService
      const semaphore = yield* Effect.makeSemaphore(maxConcurrency)
      const refParts = yield* Ref.make<CompletedPart[]>([])
      const refBytesUploaded = yield* Ref.make(0)
      const refUploadId = yield* Ref.make("")
      const refDigest = yield* Ref.make<Option.Option<string>>(Option.none())
      const breaker = options.circuitBreaker
        ? yield* makeCircuitBreaker(options.circuitBreaker)
        : null

      const runFreshInit: Effect.Effect<UploadInitiated, UploadError> = Effect.gen(
        function* () {
          const { uploadId } = yield* normalizeCallback(initiate!).pipe(
            Effect.mapError((cause): UploadError => new InitiateUploadError(cause))
          )
          yield* Ref.set(refUploadId, uploadId)
          if (getContentDigest !== undefined) {
            const digest = yield* normalizeCallback(getContentDigest).pipe(
              Effect.mapError((cause): UploadError => new InitiateUploadError(cause))
            )
            yield* Ref.set(refDigest, Option.some(digest))
          }
          const capturedDigest = yield* Ref.get(refDigest)
          return {
            _tag: "UploadInitiated" as const,
            uploadId,
            contentDigest: Option.getOrUndefined(capturedDigest),
            timestamp: Date.now(),
          } satisfies UploadInitiated
        }
      )

      // Reconcile previously-completed parts. On a reconcile failure the caller's
      // `reinitOnStale` predicate classifies as a stale/GC'd uploadId (e.g. S3
      // `NoSuchUpload`) — and only when an `initiate` callback is available —
      // abandon the stale upload and re-initiate a fresh multipart from part 1
      // (empty reconciled map, fresh `UploadInitiated`). The predicate inspects
      // the RAW rejection (pre-`ReconcileError`); staleness detection is
      // caller-supplied so the core stays protocol-agnostic. Default (no
      // predicate, or no `initiate`) preserves the fail-fast `ReconcileError`.
      const reconcileSetup: Effect.Effect<
        { map: Map<number, string>; reinitEvent: Option.Option<UploadInitiated> },
        UploadError
      > = reconcileCompletedParts
        ? normalizeCallback(reconcileCompletedParts).pipe(
            Effect.map((parts) => ({
              map: new Map<number, string>(parts.map((p) => [p.partNumber, p.etag] as const)),
              reinitEvent: Option.none<UploadInitiated>(),
            })),
            Effect.catchAll((rawCause) =>
              reinitOnStale !== undefined && reinitOnStale(rawCause) && initiate !== undefined
                ? runFreshInit.pipe(
                    Effect.map((event) => ({
                      map: new Map<number, string>(),
                      reinitEvent: Option.some(event),
                    }))
                  )
                : Effect.fail(new ReconcileError(rawCause))
            )
          )
        : Effect.succeed({
            map: new Map<number, string>(),
            reinitEvent: Option.none<UploadInitiated>(),
          })

      const { map: reconciledMap, reinitEvent } = yield* reconcileSetup

      const runResumeSetup: Effect.Effect<void, UploadError> = Effect.gen(function* () {
        // `resumeFrom` is non-undefined here (checked by setupStream selector below).
        const rf = resumeFrom!
        if (rf.contentDigest !== undefined && getContentDigest !== undefined) {
          const digest = yield* normalizeCallback(getContentDigest).pipe(
            Effect.mapError(
              (cause): UploadError => new ResumeMismatchError("content_mismatch", cause)
            )
          )
          if (digest !== rf.contentDigest) {
            return yield* Effect.fail(new ResumeMismatchError("content_mismatch"))
          }
          yield* Ref.set(refDigest, Option.some(digest))
        }
        yield* Ref.set(refUploadId, rf.uploadId)
      })

      // When a stale reconcile triggered a re-initiate, emit the fresh
      // `UploadInitiated` (refUploadId already set by `runFreshInit`) and skip
      // both resume-setup and a second initiate — exactly one initiate per upload.
      const setupStream: Stream.Stream<UploadEvent, UploadError, never> =
        Option.isSome(reinitEvent)
          ? Stream.make(reinitEvent.value)
          : resumeFrom !== undefined
            ? Stream.fromEffect(runResumeSetup).pipe(Stream.drain)
            : initiate !== undefined
              ? Stream.fromEffect(runFreshInit)
              : Stream.empty

      const makeUploadOne = (
        partNumber: number,
        chunk: Uint8Array
      ): Effect.Effect<PartCompleted, UploadError> =>
        Effect.gen(function* () {
          const reconciledEtag = reconciledMap.get(partNumber)
          if (reconciledEtag !== undefined) {
            const event: PartCompleted = {
              _tag: "PartCompleted" as const,
              partNumber,
              etag: reconciledEtag,
              bytesUploaded: chunk.length,
              timestamp: Date.now(),
            }
            yield* Ref.update(refParts, parts => [...parts, { partNumber, etag: reconciledEtag }])
            yield* safeLog(logger, "info", `Part ${partNumber} skipped (reconciled)`)
            return event
          }

          const refAttempts = yield* Ref.make(0)

          const single: Effect.Effect<string, PartUploadError> = Effect.gen(function* () {
            yield* Ref.update(refAttempts, n => n + 1)
            const attempt = yield* Ref.get(refAttempts)
            return yield* normalizeCallback(() => uploadPart(partNumber, chunk)).pipe(
              Effect.mapError(
                (cause): PartUploadError => new PartUploadError(partNumber, attempt, cause)
              )
            )
          })

          const etag = yield* Effect.retry(single, retrySchedule).pipe(
            Effect.catchAll(err =>
              Effect.gen(function* () {
                const totalAttempts = yield* Ref.get(refAttempts)
                if (totalAttempts <= 1) {
                  return yield* Effect.fail(err)
                }
                return yield* Effect.fail(
                  new MaxRetriesExceededError(partNumber, totalAttempts, err.cause)
                )
              })
            )
          )

          const event: PartCompleted = {
            _tag: "PartCompleted" as const,
            partNumber,
            etag,
            bytesUploaded: chunk.length,
            timestamp: Date.now(),
          }

          yield* Ref.update(refParts, parts => [...parts, { partNumber, etag }])
          yield* safeLog(logger, "info", `Part ${partNumber} completed`)
          return event
        })

      const partsStream: Stream.Stream<UploadEvent, UploadError, never> = chunkStream(
        stream,
        chunkSize
      ).pipe(
        Stream.mapError((cause): UploadError => new PartUploadError(0, 0, cause)),
        Stream.zipWithIndex,
        Stream.mapEffect(
          ([chunk, idx]) => {
            const partNumber = Number(idx) + 1

            if (!breaker) {
              const partEffect = semaphore.withPermits(1)(
                makeUploadOne(partNumber, chunk)
              )
              return signal ? Effect.raceFirst(partEffect, fromAbortSignal(signal)) : partEffect
            }

            const partEffect = Effect.gen(function* () {
              yield* breaker.guard
              return yield* semaphore.withPermits(1)(
                Effect.gen(function* () {
                  const exit = yield* Effect.exit(makeUploadOne(partNumber, chunk))
                  if (Exit.isSuccess(exit)) {
                    yield* breaker.onSuccess
                    return exit.value
                  }
                  const circuitEvent = yield* breaker.onFailure
                  if (circuitEvent !== null) {
                    return yield* Effect.fail(new CircuitOpenError(circuitEvent.failedParts))
                  }
                  return yield* Effect.fail(Cause.squash(exit.cause) as UploadError)
                })
              )
            })

            return signal ? Effect.raceFirst(partEffect, fromAbortSignal(signal)) : partEffect
          },
          { concurrency: "unbounded" }
        ),
        Stream.flatMap(
          (event): Stream.Stream<UploadEvent, UploadError, never> => {
            const tickEffect = Ref.updateAndGet(refBytesUploaded, (n) => n + event.bytesUploaded).pipe(
              Effect.map(
                (total): ProgressTick => ({
                  _tag: "ProgressTick" as const,
                  bytesUploaded: total,
                  totalBytes: Option.none(),
                  timestamp: Date.now(),
                })
              )
            )
            return Stream.concat(Stream.make(event), Stream.fromEffect(tickEffect))
          }
        ),
        Stream.catchAll((err: UploadError): Stream.Stream<UploadEvent, UploadError, never> => {
          if (breaker && err._tag === "CircuitOpenError") {
            const event: UploadEvent = {
              _tag: "CircuitOpen",
              failedParts: err.failedParts,
              timestamp: Date.now(),
            }
            return Stream.concat(Stream.succeed(event), Stream.fail(err))
          }
          return Stream.fail(err)
        })
      )

      const finalEffect: Effect.Effect<UploadEvent, UploadError, never> = Effect.gen(
        function* () {
          const uploadId = yield* Ref.get(refUploadId)
          const parts = yield* Ref.get(refParts)
          yield* normalizeCallback(() => completeUpload(uploadId, parts)).pipe(
            Effect.mapError(
              (cause): UploadError => new CompleteUploadError(cause)
            )
          )
          yield* safeLog(logger, "info", "Multipart upload completed")
          return {
            _tag: "UploadCompleted" as const,
            uploadId,
            totalParts: parts.length,
            timestamp: Date.now(),
          } satisfies UploadCompleted
        }
      )

      return Stream.concat(setupStream, partsStream.pipe(Stream.concat(Stream.fromEffect(finalEffect))))
    })
  )
}
