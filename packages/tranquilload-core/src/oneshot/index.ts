import { Cause, Effect, Exit, Stream } from "effect"
import type { UploadCompleted, UploadEvent } from "../progress/upload-event.js"
import type { Transform } from "../pipeline/middleware.js"
import { CompressionServiceLive } from "../services/compression-service.js"
import { LoggerServiceLive } from "../services/logger-service.js"
import { uploadOnceEffect, type UploadOnceOptions } from "./upload.js"

export type UploadResult = UploadCompleted
export type { UploadOnceOptions }

export interface OneShotPublicOptions extends UploadOnceOptions {
  readonly pipeline?: Transform | Effect.Effect<Transform, unknown, unknown>
}

export const uploadOnce = (
  options: OneShotPublicOptions
): {
  events: ReadableStream<UploadEvent>
  result: Promise<UploadResult>
} => {
  const collected: Promise<ReadonlyArray<UploadEvent>> = (async () => {
    let processedStream = options.stream
    if (options.pipeline !== undefined) {
      if (typeof options.pipeline === "function") {
        processedStream = options.pipeline(options.stream)
      } else {
        const transform = await Effect.runPromise(
          Effect.provide(
            options.pipeline as Effect.Effect<Transform, unknown, never>,
            CompressionServiceLive
          )
        )
        processedStream = transform(options.stream)
      }
    }

    const program = uploadOnceEffect({ ...options, stream: processedStream }).pipe(
      Stream.provideLayer(LoggerServiceLive)
    )

    const exit = await Stream.runCollect(program).pipe(
      Effect.map((chunk) => Array.from(chunk)),
      Effect.runPromiseExit
    )
    if (Exit.isSuccess(exit)) return exit.value
    return Promise.reject(Cause.squash(exit.cause))
  })()

  // events: ReadableStream built from collected array; closes cleanly on error
  const events = new ReadableStream<UploadEvent>({
    async start(controller) {
      try {
        const evts = await collected
        for (const event of evts) controller.enqueue(event)
        controller.close()
      } catch (_) {
        // Close cleanly — abort/upload errors surface via `result` only
        controller.close()
      }
    },
  })

  // result: resolves with UploadCompleted, rejects with UploadError on failure
  const result: Promise<UploadResult> = collected.then((evts) => {
    const last = evts[evts.length - 1]
    if (last === undefined) {
      return Promise.reject(new Error("uploadOnce: stream ended without emitting an event"))
    }
    return last as UploadResult
  })

  return { events, result }
}

// Effect escape hatch — LoggerService layer left open for user composition
uploadOnce.effect = uploadOnceEffect
