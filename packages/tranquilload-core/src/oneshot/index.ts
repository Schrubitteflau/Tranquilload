import { Cause, Effect, Exit, Stream } from "effect"
import type { UploadCompleted, UploadEvent } from "../progress/upload-event.js"
import { LoggerServiceLive } from "../services/logger-service.js"
import { uploadOnceEffect, type UploadOnceOptions } from "./upload.js"

export type UploadResult = UploadCompleted
export type { UploadOnceOptions }

export const uploadOnce = (
  options: UploadOnceOptions
): {
  events: ReadableStream<UploadEvent>
  result: Promise<UploadResult>
} => {
  const program = uploadOnceEffect(options).pipe(Stream.provideLayer(LoggerServiceLive))

  // Single run — collect all emitted events exactly once
  // Use runPromiseExit + squash so `result` rejects with the typed error (AbortError etc.)
  // rather than a FiberFailure wrapper
  const collected: Promise<ReadonlyArray<UploadEvent>> = Stream.runCollect(program).pipe(
    Effect.map((chunk) => Array.from(chunk)),
    Effect.runPromiseExit
  ).then((exit) => {
    if (Exit.isSuccess(exit)) return exit.value
    return Promise.reject(Cause.squash(exit.cause))
  })

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
