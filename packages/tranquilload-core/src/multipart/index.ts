import { Cause, Effect, Exit, Option, Ref, Stream } from "effect"
import type { UploadCompleted, UploadEvent } from "../progress/upload-event.js"
import type { Transform } from "../pipeline/middleware.js"
import { CompressionServiceLive } from "../services/compression-service.js"
import { LoggerServiceLive } from "../services/logger-service.js"
import { uploadMultipartEffect, type CompletedPart, type ResumeState, type UploadMultipartOptions } from "./upload-stream.js"

export type UploadResult = UploadCompleted
export type { CompletedPart, ResumeState, UploadMultipartOptions }

export interface Progress {
  readonly bytesUploaded: number
  readonly totalBytes: Option.Option<number>
}

export interface MultipartPublicOptions extends UploadMultipartOptions {
  readonly totalBytes?: number
  readonly pipeline?: Transform | Effect.Effect<Transform, unknown, unknown>
}

const NO_RESUME_CONTEXT_ERROR_MESSAGE =
  "uploadMultipart: resumeState is only available when `initiate` or `resumeFrom` is provided"

export const uploadMultipart = (
  options: MultipartPublicOptions
): {
  events: ReadableStream<UploadEvent>
  result: Promise<UploadResult>
  getProgress: (() => Promise<Progress>) & { effect: Effect.Effect<Progress> }
  uploadId: Promise<string>
  resumeState: Promise<ResumeState>
} => {
  // Legacy-pattern detection: warns unconditionally so first-time-after-upgrade
  // users also see the migration message (per G3 — empty reconcile would have
  // hidden the warning under the old "warn when reconcile returned >= 1" rule).
  if (
    options.initiate !== undefined &&
    options.reconcileCompletedParts !== undefined &&
    options.resumeFrom === undefined
  ) {
    console.warn(
      "Tranquilload: detected legacy resume pattern. You're passing `initiate` " +
        "and `reconcileCompletedParts` without `resumeFrom: ResumeState`. The new " +
        "API requires the persisted ResumeState to validate chunkSize/pipeline/" +
        "digest match across sessions. See MIGRATION.md for migration steps."
    )
  }
  // Pipeline-without-identity: the resume validation cannot detect a pipeline
  // mismatch across sessions when the user runs a pipeline but provides no
  // identity. We warn so the user is aware their resume safety is reduced.
  if (options.pipeline !== undefined && options.pipelineIdentity === undefined) {
    console.warn(
      "Tranquilload: pipeline is set but pipelineIdentity is not. Without an " +
        "identity, the resume validation cannot detect a pipeline mismatch " +
        "across sessions. See README → Resume Safety."
    )
  }

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

  let resolveResumeState!: (s: ResumeState) => void
  let rejectResumeState!: (e: unknown) => void
  let resumeStateSettled = false
  const resumeStatePromise: Promise<ResumeState> = new Promise<ResumeState>((resolve, reject) => {
    resolveResumeState = (s) => {
      if (resumeStateSettled) return
      resumeStateSettled = true
      resolve(s)
    }
    rejectResumeState = (e) => {
      if (resumeStateSettled) return
      resumeStateSettled = true
      reject(e)
    }
  })
  // Avoid unhandled-rejection warnings: callers may not await resumeState.
  resumeStatePromise.catch(() => {})

  // Resume branch: resolve uploadId AND resumeState synchronously before the
  // stream runs. uploadId per AC22; resumeState per Task 4.1 (the lib has no
  // new state to add — the user already has the value they passed in).
  if (options.resumeFrom !== undefined) {
    resolveUploadId(options.resumeFrom.uploadId)
    resolveResumeState(options.resumeFrom)
  }

  // events: a live ReadableStream fed incrementally as each UploadEvent is
  // produced (Story 13.5 — flush-before-error). Previously this stream was
  // built by awaiting the fully-collected event array, so on the failure /
  // abort path that array REJECTED and the stream closed EMPTY — every event
  // emitted before the failure was lost. We now enqueue each event live (via a
  // Stream.tap in the program below) and close the stream cleanly on settle, so
  // events emitted before a failure remain observable. The typed UploadError is
  // NOT surfaced on this channel — it still rejects `result` only (the events
  // channel is split from the result channel, so the error is never masked).
  // enqueue/close are guarded so a consumer that cancels the reader cannot
  // crash the upload fiber.
  let eventsController: ReadableStreamDefaultController<UploadEvent> | undefined
  let eventsClosed = false
  const events = new ReadableStream<UploadEvent>({
    start(controller) {
      eventsController = controller
    },
    cancel() {
      // Consumer cancelled the reader — stop enqueuing; the upload continues and
      // its outcome still surfaces via `result`.
      eventsClosed = true
    },
  })
  const enqueueEvent = (event: UploadEvent): void => {
    if (eventsClosed) return
    try {
      eventsController?.enqueue(event)
    } catch {
      // Stream already closed/cancelled by the consumer — stop enqueuing.
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
      // Flush each event into the public `events` stream live, before any
      // downstream failure can discard it (Story 13.5). Runs ahead of the
      // uploadId/progress side-effect tap below — neither depends on the other.
      Stream.tap((event) => Effect.sync(() => enqueueEvent(event))),
      Stream.tap((event) => {
        if (event._tag === "UploadInitiated") {
          // Fresh-init branch: resolve uploadId on the event, and build the
          // ResumeState from the event payload + caller-supplied fields.
          return Effect.sync(() => {
            resolveUploadId(event.uploadId)
            const state: ResumeState = {
              version: 1,
              uploadId: event.uploadId,
              chunkSize: options.chunkSize,
              ...(options.pipelineIdentity !== undefined
                ? { pipelineIdentity: options.pipelineIdentity }
                : {}),
              ...(event.contentDigest !== undefined
                ? { contentDigest: event.contentDigest }
                : {}),
              contentDigestCaptured: options.getContentDigest !== undefined,
            }
            resolveResumeState(state)
          })
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
    // Close the live events stream cleanly regardless of success/failure — every
    // event emitted before this point has already been enqueued (flushed). The
    // failure, if any, surfaces only via `result` below.
    closeEvents()
    if (Exit.isSuccess(exit)) return exit.value
    return Promise.reject(Cause.squash(exit.cause))
  })()

  // Rejection is surfaced via `result`; suppress the propagated rejection from .finally()
  collected
    .then(() => {
      // Success-but-no-context: neither initiate nor resumeFrom produced state.
      if (!resumeStateSettled) {
        rejectResumeState(new Error(NO_RESUME_CONTEXT_ERROR_MESSAGE))
      }
    })
    .catch((err) => {
      if (!resumeStateSettled) {
        rejectResumeState(err)
      }
    })
    .finally(() => resolveUploadId(""))

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

  return {
    events,
    result,
    getProgress,
    uploadId: uploadIdPromise,
    resumeState: resumeStatePromise,
  }
}

// Effect escape hatch — LoggerService layer left open for user composition
uploadMultipart.effect = uploadMultipartEffect
