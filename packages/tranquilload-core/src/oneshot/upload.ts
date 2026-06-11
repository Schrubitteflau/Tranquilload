import { Effect, Stream } from "effect"
import type { UploadError } from "../errors/upload-error.js"
import { AbortError, CompleteUploadError } from "../errors/upload-error.js"
import { LoggerService, safeLog } from "../services/logger-service.js"
import { fromAbortSignal } from "../utils/abort-interop.js"
import { normalizeCallback } from "../utils/normalize-callback.js"
import type { UploadEvent } from "../progress/upload-event.js"

export interface UploadOnceOptions {
  readonly stream: ReadableStream<Uint8Array>
  readonly upload: (
    stream: ReadableStream<Uint8Array>
  ) => void | Promise<void> | Effect.Effect<void, UploadError>
  readonly signal?: AbortSignal
  /**
   * When `false`, a source stream that yields zero bytes is rejected with a
   * typed `CompleteUploadError` BEFORE the upload callback runs (a bounded
   * first-chunk peek detects emptiness without buffering the whole source).
   *
   * Default `true` preserves the one-shot semantic: an empty source still emits
   * a successful `UploadCompleted` with `totalParts: 1` — there is exactly one
   * PUT regardless of byte count. Set `false` to fail fast on empty uploads.
   */
  readonly allowEmpty?: boolean
}

/**
 * Reads the source until the first non-empty chunk to decide emptiness, then
 * re-prepends that chunk so the downstream consumer sees the full byte stream.
 * Bounded (one chunk of look-ahead, demand-driven via `pull`) — NOT a full
 * buffer. Leading zero-length chunks are skipped (they carry no bytes).
 */
const peekNonEmpty = async (
  source: ReadableStream<Uint8Array>
): Promise<
  { readonly empty: true } | { readonly empty: false; readonly stream: ReadableStream<Uint8Array> }
> => {
  const reader = source.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) {
      reader.releaseLock()
      return { empty: true }
    }
    if (value && value.length > 0) {
      const firstChunk = value
      const rebuilt = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(firstChunk)
        },
        async pull(controller) {
          const next = await reader.read()
          if (next.done) {
            controller.close()
            reader.releaseLock()
            return
          }
          controller.enqueue(next.value)
        },
        cancel(reason) {
          return reader.cancel(reason)
        },
      })
      return { empty: false, stream: rebuilt }
    }
    // zero-length chunk: keep reading
  }
}

export const uploadOnceEffect = (
  options: UploadOnceOptions
): Stream.Stream<UploadEvent, UploadError, LoggerService> => {
  const { stream, upload, signal, allowEmpty = true } = options

  const program: Effect.Effect<UploadEvent, UploadError, LoggerService> = Effect.gen(
    function* () {
      const logger = yield* LoggerService
      yield* safeLog(logger, "info", "One-shot upload starting")

      // allowEmpty: false → reject a zero-byte source before the PUT.
      let effectiveStream = stream
      if (allowEmpty === false) {
        const peeked = yield* Effect.tryPromise({
          try: () => peekNonEmpty(stream),
          catch: (cause): UploadError => new CompleteUploadError(cause),
        })
        if (peeked.empty) {
          return yield* Effect.fail(
            new CompleteUploadError(
              new Error("uploadOnce: empty source stream rejected (allowEmpty: false)")
            )
          )
        }
        effectiveStream = peeked.stream
      }

      const uploadEffect: Effect.Effect<void, UploadError> = normalizeCallback(
        () => upload(effectiveStream)
      ).pipe(
        Effect.mapError((cause): UploadError => {
          if (cause instanceof AbortError) return cause
          return new CompleteUploadError(cause)
        })
      )

      yield* signal
        ? Effect.raceFirst(uploadEffect, fromAbortSignal(signal))
        : uploadEffect

      yield* safeLog(logger, "info", "One-shot upload completed")

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
