import { Cause, Effect, Exit, Option, Ref, Stream } from "effect"
import type { UploadCompleted, UploadEvent } from "../progress/upload-event.js"
import type { Transform } from "../pipeline/middleware.js"
import { CompressionServiceLive } from "../services/compression-service.js"
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
  readonly pipeline?: Transform | Effect.Effect<Transform, unknown, unknown>
}

export const uploadMultipart = (
  options: MultipartPublicOptions
): {
  events: ReadableStream<UploadEvent>
  result: Promise<UploadResult>
  getProgress: (() => Promise<Progress>) & { effect: Effect.Effect<Progress> }
  uploadId: Promise<string>
} => {
  const refProgress = Effect.runSync(
    Ref.make<Progress>({
      bytesUploaded: 0,
      totalBytes: options.totalBytes !== undefined ? Option.some(options.totalBytes) : Option.none(),
    })
  )

  let resolveUploadId!: (id: string) => void
  const uploadIdPromise: Promise<string> = new Promise<string>((resolve) => {
    resolveUploadId = resolve
  })

  const collected: Promise<ReadonlyArray<UploadEvent>> = (async () => {
    // Step 1: resolve pipeline to get the processed stream
    let processedStream = options.stream
    if (options.pipeline !== undefined) {
      if (typeof options.pipeline === "function") {
        processedStream = options.pipeline(options.stream)
      } else {
        // Effect pipeline — resolve with CompressionServiceLive
        const transform = await Effect.runPromise(
          Effect.provide(
            options.pipeline as Effect.Effect<Transform, unknown, never>,
            CompressionServiceLive
          )
        )
        processedStream = transform(options.stream)
      }
    }

    // Step 2: run upload with processedStream
    const program = uploadMultipartEffect({ ...options, stream: processedStream }).pipe(
      Stream.tap((event) => {
        if (event._tag === "UploadInitiated") {
          return Effect.sync(() => resolveUploadId(event.uploadId))
        }
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

    const exit = await Stream.runCollect(program).pipe(
      Effect.map((chunk) => Array.from(chunk)),
      Effect.runPromiseExit
    )
    if (Exit.isSuccess(exit)) return exit.value
    return Promise.reject(Cause.squash(exit.cause))
  })()

  collected.finally(() => resolveUploadId(""))

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

  return { events, result, getProgress, uploadId: uploadIdPromise }
}

// Effect escape hatch — LoggerService layer left open for user composition
uploadMultipart.effect = uploadMultipartEffect
