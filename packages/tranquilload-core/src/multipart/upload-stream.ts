import { Cause, Effect, Exit, Option, Ref, Schedule, Stream } from "effect"
import type { UploadError } from "../errors/upload-error.js"
import { CircuitOpenError, CompleteUploadError, MaxRetriesExceededError, PartUploadError } from "../errors/upload-error.js"
import type { CircuitOpen, PartCompleted, ProgressTick, UploadCompleted, UploadEvent, UploadInitiated } from "../progress/upload-event.js"
import { LoggerService } from "../services/logger-service.js"
import { fromAbortSignal } from "../utils/abort-interop.js"
import { normalizeCallback } from "../utils/normalize-callback.js"
import { makeCircuitBreaker, type CircuitBreakerConfig } from "./circuit-breaker.js"
import { chunkStream } from "./chunk-stream.js"

export interface CompletedPart {
  readonly partNumber: number
  readonly etag: string
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
  readonly maxConcurrency?: number
  readonly signal?: AbortSignal
  readonly retrySchedule?: Schedule.Schedule<unknown, PartUploadError>
  readonly circuitBreaker?: CircuitBreakerConfig
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
    maxConcurrency = DEFAULT_MAX_CONCURRENCY,
    signal,
    retrySchedule = DEFAULT_RETRY_SCHEDULE,
  } = options

  return Stream.unwrap(
    Effect.gen(function* () {
      const logger = yield* LoggerService
      const semaphore = yield* Effect.makeSemaphore(maxConcurrency)
      const refParts = yield* Ref.make<CompletedPart[]>([])
      const refBytesUploaded = yield* Ref.make(0)
      const refUploadId = yield* Ref.make("")
      const breaker = options.circuitBreaker
        ? yield* makeCircuitBreaker(options.circuitBreaker)
        : null

      const initiateStream: Stream.Stream<UploadEvent, UploadError, never> = initiate
        ? Stream.fromEffect(
            normalizeCallback(initiate).pipe(
              Effect.mapError((cause): UploadError => new CompleteUploadError(cause)),
              Effect.flatMap(({ uploadId }) =>
                Ref.set(refUploadId, uploadId).pipe(
                  Effect.as({
                    _tag: "UploadInitiated" as const,
                    uploadId,
                    timestamp: Date.now(),
                  } satisfies UploadInitiated)
                )
              )
            )
          )
        : Stream.empty

      const makeUploadOne = (
        partNumber: number,
        chunk: Uint8Array
      ): Effect.Effect<PartCompleted, UploadError> =>
        Effect.gen(function* () {
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
          yield* Effect.sync(() => logger.log("info", `Part ${partNumber} completed`))
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
          yield* Effect.sync(() => logger.log("info", "Multipart upload completed"))
          return {
            _tag: "UploadCompleted" as const,
            uploadId,
            totalParts: parts.length,
            timestamp: Date.now(),
          } satisfies UploadCompleted
        }
      )

      return Stream.concat(initiateStream, partsStream.pipe(Stream.concat(Stream.fromEffect(finalEffect))))
    })
  )
}
