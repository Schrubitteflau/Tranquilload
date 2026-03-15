import { Cause, Effect, Exit, Option, Ref, Stream } from "effect"
import type { UploadCompleted, UploadEvent } from "../progress/upload-event.js"
import { LoggerServiceLive } from "../services/logger-service.js"
import { uploadMultipartEffect, type CompletedPart, type UploadMultipartOptions } from "./upload-stream.js"

export type UploadResult = UploadCompleted
export type { CompletedPart, UploadMultipartOptions }

export interface Progress {
  readonly bytesUploaded: number
  readonly totalBytes: Option.Option<number>
}

export interface MultipartPublicOptions extends UploadMultipartOptions {
  readonly totalBytes?: number
}

export const uploadMultipart = (
  options: MultipartPublicOptions
): {
  events: ReadableStream<UploadEvent>
  result: Promise<UploadResult>
  getProgress: (() => Promise<Progress>) & { effect: Effect.Effect<Progress> }
} => {
  const refProgress = Effect.runSync(
    Ref.make<Progress>({
      bytesUploaded: 0,
      totalBytes: options.totalBytes !== undefined ? Option.some(options.totalBytes) : Option.none(),
    })
  )

  const program = uploadMultipartEffect(options).pipe(
    Stream.tap((event) => {
      if (event._tag === "PartCompleted") {
        return Ref.update(refProgress, (p) => ({
          ...p,
          bytesUploaded: p.bytesUploaded + event.bytesUploaded,
        }))
      }
      return Effect.void
    }),
    Stream.provideLayer(LoggerServiceLive)
  )

  // Single execution — collect all events to completion
  // Effect.runPromiseExit + Cause.squash ensures result rejects with typed error (AbortError, etc.)
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
        // Close cleanly — upload errors surface via `result` only
        controller.close()
      }
    },
  })

  // result: resolves with UploadCompleted, rejects with UploadError on failure
  const result: Promise<UploadResult> = collected.then((evts) => {
    const last = evts[evts.length - 1]
    if (last === undefined) {
      return Promise.reject(new Error("uploadMultipart: stream ended without emitting an event"))
    }
    return last as UploadResult
  })

  const getProgress = Object.assign(
    (): Promise<Progress> => Effect.runPromise(Ref.get(refProgress)),
    { effect: Ref.get(refProgress) }
  )

  return { events, result, getProgress }
}

// Effect escape hatch — LoggerService layer left open for user composition
uploadMultipart.effect = uploadMultipartEffect
