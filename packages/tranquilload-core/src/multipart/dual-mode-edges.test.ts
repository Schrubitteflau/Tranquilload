import { describe, expect, it } from "@effect/vitest"
import { Cause, Chunk, Effect, Exit, Stream } from "effect"
import {
  InitiateUploadError,
  PresignedUrlError,
} from "../errors/upload-error.js"
import type { UploadError } from "../errors/upload-error.js"
import { LoggerServiceLive } from "../services/logger-service.js"
import { uploadMultipartEffect } from "./upload-stream.js"

// Helper: single-shot ReadableStream from a Uint8Array.
const fromBytes = (bytes: Uint8Array): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start(c) {
      c.enqueue(bytes)
      c.close()
    },
  })

const runUpload = (options: Parameters<typeof uploadMultipartEffect>[0]) =>
  Stream.runCollect(uploadMultipartEffect(options)).pipe(
    Effect.map((c) => Array.from(c)),
    Effect.provide(LoggerServiceLive),
  )

describe("uploadMultipartEffect — Effect/Promise/sync dual-mode edges (Story 11.6)", () => {
  // --- 11.6-INT-004 (F#30) — sync completeUpload returning a non-void value ---
  // The public type signature is `void | Promise<void> | Effect.Effect<void,
  // UploadError>`, but `normalizeCallback` wraps any return shape through
  // `Effect.succeed(result)`. A sync callback returning `{ ok: true }` (the
  // F#30 brainstorming variant) must therefore complete the upload without
  // errors and emit UploadCompleted.
  it.effect(
    "11.6-INT-004 (F#30) — sync completeUpload returning a non-void value completes successfully",
    () =>
      Effect.gen(function* () {
        let completeUploadCalls = 0

        // Cast: F#30's variant returns `{ ok: true }`, deliberately wider than
        // the declared `void` return — `normalizeCallback` accepts it at
        // runtime; the cast unblocks the typecheck for this surface lock.
        const completeUpload = ((_uploadId, _parts) => {
          completeUploadCalls++
          return { ok: true } as unknown as void
        }) as Parameters<typeof uploadMultipartEffect>[0]["completeUpload"]

        const events = yield* runUpload({
          stream: fromBytes(new Uint8Array(10).fill(1)),
          chunkSize: 10,
          uploadPart: () => "etag-1",
          completeUpload,
        })

        expect(completeUploadCalls).toBe(1)
        const completeEvent = events.find((e) => e._tag === "UploadCompleted")
        expect(completeEvent).toMatchObject({
          _tag: "UploadCompleted",
          totalParts: 1,
        })
      }),
  )

  // --- 11.6-INT-005 (F#31) — Effect-typed initiate that fails -----------------
  // When `initiate` returns an Effect that fails with a typed UploadError, the
  // lib's `Effect.mapError(cause => new InitiateUploadError(cause))` wraps it.
  // The assertion that locks F#31 is: `cause === <the original typed error>`.
  // Without this, callers cannot recover the upstream typed error from the
  // boundary — they only see the `InitiateUploadError` opaque wrapper.
  it.effect(
    "11.6-INT-005 (F#31) — Effect-typed initiate failure: InitiateUploadError.cause === original typed error",
    () =>
      Effect.gen(function* () {
        const typed = new PresignedUrlError(new Error("STS expired"))
        const initiate = (): Effect.Effect<{ uploadId: string }, UploadError> =>
          Effect.fail(typed)

        const exit = yield* Effect.exit(
          runUpload({
            stream: fromBytes(new Uint8Array(10).fill(1)),
            chunkSize: 10,
            uploadPart: () => "etag-never-called",
            completeUpload: () => {},
            initiate,
          }),
        )

        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          // Typed failure, not a fiber DEFECT.
          expect(Cause.dieOption(exit.cause)._tag).toBe("None")
          expect(Chunk.size(Cause.defects(exit.cause))).toBe(0)

          const failure = Cause.failureOption(exit.cause)
          expect(failure._tag).toBe("Some")
          if (failure._tag === "Some") {
            expect(failure.value).toBeInstanceOf(InitiateUploadError)
            const err = failure.value as InitiateUploadError
            expect(err._tag).toBe("InitiateUploadError")
            // The lock: original typed error preserved as cause.
            expect(err.cause).toBe(typed)
            expect((err.cause as PresignedUrlError)._tag).toBe(
              "PresignedUrlError",
            )
          }
        }
      }),
  )
})
