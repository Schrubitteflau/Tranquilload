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
  // events: a live ReadableStream fed incrementally as each UploadEvent is
  // produced (Story 13.5 — flush-before-error; symmetric with `uploadMultipart`
  // so the two public wrappers don't diverge). One-shot emits only its terminal
  // `UploadCompleted`, so there is never a pre-failure event to flush here — the
  // change is behaviour-preserving for one-shot (a failed/aborted upload still
  // closes the stream cleanly with zero events). The typed UploadError surfaces
  // via `result` only; enqueue/close are guarded against consumer cancel.
  let eventsController: ReadableStreamDefaultController<UploadEvent> | undefined
  let eventsClosed = false
  const events = new ReadableStream<UploadEvent>({
    start(controller) {
      eventsController = controller
    },
    cancel() {
      eventsClosed = true
    },
  })
  const enqueueEvent = (event: UploadEvent): void => {
    if (eventsClosed) return
    try {
      eventsController?.enqueue(event)
    } catch {
      eventsClosed = true
    }
  }
  const closeEvents = (): void => {
    if (eventsClosed) return
    eventsClosed = true
    try {
      eventsController?.close()
    } catch {
      // Already closed/cancelled — ignore.
    }
  }

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
      // Flush each event into the public `events` stream live (Story 13.5).
      Stream.tap((event) => Effect.sync(() => enqueueEvent(event))),
      Stream.provideLayer(LoggerServiceLive)
    )

    const exit = await Stream.runCollect(program).pipe(
      Effect.map((chunk) => Array.from(chunk)),
      Effect.runPromiseExit
    )
    // Close the live events stream cleanly regardless of success/failure.
    closeEvents()
    if (Exit.isSuccess(exit)) return exit.value
    return Promise.reject(Cause.squash(exit.cause))
  })()

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
