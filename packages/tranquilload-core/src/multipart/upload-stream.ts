import { Effect, Ref, Schedule, Stream } from "effect"
import type { UploadError } from "../errors/upload-error.js"
import { CompleteUploadError, MaxRetriesExceededError, PartUploadError } from "../errors/upload-error.js"
import type { PartCompleted, UploadCompleted, UploadEvent } from "../progress/upload-event.js"
import { LoggerService } from "../services/logger-service.js"
import { fromAbortSignal } from "../utils/abort-interop.js"
import { normalizeCallback } from "../utils/normalize-callback.js"
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
    parts: ReadonlyArray<CompletedPart>
  ) => void | Promise<void> | Effect.Effect<void, UploadError>
  readonly maxConcurrency?: number
  readonly signal?: AbortSignal
  readonly retrySchedule?: Schedule.Schedule<unknown, PartUploadError>
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
    maxConcurrency = DEFAULT_MAX_CONCURRENCY,
    signal,
    retrySchedule = DEFAULT_RETRY_SCHEDULE,
  } = options

  return Stream.unwrap(
    Effect.gen(function* () {
      const logger = yield* LoggerService
      const semaphore = yield* Effect.makeSemaphore(maxConcurrency)
      const refParts = yield* Ref.make<CompletedPart[]>([])

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
            const partEffect = semaphore.withPermits(1)(
              makeUploadOne(Number(idx) + 1, chunk)
            )
            return signal ? Effect.raceFirst(partEffect, fromAbortSignal(signal)) : partEffect
          },
          { concurrency: "unbounded" }
        )
      )

      const finalEffect: Effect.Effect<UploadEvent, UploadError, never> = Effect.gen(
        function* () {
          const parts = yield* Ref.get(refParts)
          yield* normalizeCallback(() => completeUpload(parts)).pipe(
            Effect.mapError(
              (cause): UploadError =>
                cause instanceof Error
                  ? (cause as UploadError)
                  : new CompleteUploadError(cause)
            )
          )
          yield* Effect.sync(() => logger.log("info", "Multipart upload completed"))
          return {
            _tag: "UploadCompleted" as const,
            uploadId: "",
            totalParts: parts.length,
            timestamp: Date.now(),
          } satisfies UploadCompleted
        }
      )

      return partsStream.pipe(Stream.concat(Stream.fromEffect(finalEffect)))
    })
  )
}
