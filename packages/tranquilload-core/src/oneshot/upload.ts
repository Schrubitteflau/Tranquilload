import { Effect, Stream } from "effect"
import type { UploadError } from "../errors/upload-error.js"
import { AbortError, CompleteUploadError } from "../errors/upload-error.js"
import { LoggerService } from "../services/logger-service.js"
import { fromAbortSignal } from "../utils/abort-interop.js"
import { normalizeCallback } from "../utils/normalize-callback.js"
import type { UploadEvent } from "../progress/upload-event.js"

export interface UploadOnceOptions {
  readonly stream: ReadableStream<Uint8Array>
  readonly upload: (
    stream: ReadableStream<Uint8Array>
  ) => void | Promise<void> | Effect.Effect<void, UploadError>
  readonly signal?: AbortSignal
}

export const uploadOnceEffect = (
  options: UploadOnceOptions
): Stream.Stream<UploadEvent, UploadError, LoggerService> => {
  const { stream, upload, signal } = options

  const program: Effect.Effect<UploadEvent, UploadError, LoggerService> = Effect.gen(
    function* () {
      const logger = yield* LoggerService
      yield* Effect.sync(() => logger.log("info", "One-shot upload starting"))

      const uploadEffect: Effect.Effect<void, UploadError> = normalizeCallback(
        () => upload(stream)
      ).pipe(
        Effect.mapError((cause): UploadError => {
          if (cause instanceof AbortError) return cause
          return new CompleteUploadError(cause)
        })
      )

      yield* signal
        ? Effect.raceFirst(uploadEffect, fromAbortSignal(signal))
        : uploadEffect

      yield* Effect.sync(() => logger.log("info", "One-shot upload completed"))

      return {
        _tag: "UploadCompleted" as const,
        uploadId: "",
        totalParts: 1,
        timestamp: Date.now(),
      } satisfies UploadEvent
    }
  )

  return Stream.fromEffect(program)
}
