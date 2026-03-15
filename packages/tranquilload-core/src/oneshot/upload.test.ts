import { Cause, Effect, Exit, Fiber, Stream } from "effect"
import { it, describe, expect } from "@effect/vitest"
import { uploadOnceEffect } from "./upload.js"
import { AbortError, CompleteUploadError } from "../errors/upload-error.js"
import { LoggerServiceLive } from "../services/logger-service.js"
import type { UploadCompleted } from "../progress/upload-event.js"

const runStream = (opts: Parameters<typeof uploadOnceEffect>[0]) =>
  Stream.runCollect(uploadOnceEffect(opts)).pipe(
    Effect.provide(LoggerServiceLive),
    Effect.exit
  )

describe("uploadOnceEffect", () => {
  it.effect("emits UploadCompleted on success (plain value callback)", () =>
    Effect.gen(function* () {
      const mockStream = new ReadableStream()
      const exit = yield* runStream({
        stream: mockStream,
        upload: () => undefined,
      })
      expect(Exit.isSuccess(exit)).toBe(true)
      if (Exit.isSuccess(exit)) {
        const events = Array.from(exit.value)
        expect(events).toHaveLength(1)
        expect(events[0]!._tag).toBe("UploadCompleted")
        expect((events[0]! as UploadCompleted).totalParts).toBe(1)
        expect(typeof events[0]!.timestamp).toBe("number")
      }
    })
  )

  it.effect("emits UploadCompleted on success (Promise callback)", () =>
    Effect.gen(function* () {
      const mockStream = new ReadableStream()
      const exit = yield* runStream({
        stream: mockStream,
        upload: () => Promise.resolve(),
      })
      expect(Exit.isSuccess(exit)).toBe(true)
      if (Exit.isSuccess(exit)) {
        const events = Array.from(exit.value)
        expect(events).toHaveLength(1)
        expect(events[0]!._tag).toBe("UploadCompleted")
        expect((events[0]! as UploadCompleted).totalParts).toBe(1)
      }
    })
  )

  it.effect("sync throw from callback → CompleteUploadError with correct cause", () =>
    Effect.gen(function* () {
      const originalError = new Error("network failure")
      const exit = yield* runStream({
        stream: new ReadableStream(),
        upload: () => {
          throw originalError
        },
      })
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const failure = Cause.failureOption(exit.cause)
        expect(failure._tag).toBe("Some")
        const err = (failure as { _tag: "Some"; value: unknown }).value
        expect(err).toBeInstanceOf(CompleteUploadError)
        expect((err as CompleteUploadError)._tag).toBe("CompleteUploadError")
        expect((err as CompleteUploadError).cause).toBe(originalError)
      }
    })
  )

  it.effect("Promise rejection → CompleteUploadError with correct cause", () =>
    Effect.gen(function* () {
      const originalError = new Error("async failure")
      const exit = yield* runStream({
        stream: new ReadableStream(),
        upload: () => Promise.reject(originalError),
      })
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const failure = Cause.failureOption(exit.cause)
        expect(failure._tag).toBe("Some")
        const err = (failure as { _tag: "Some"; value: unknown }).value
        expect(err).toBeInstanceOf(CompleteUploadError)
        expect((err as CompleteUploadError)._tag).toBe("CompleteUploadError")
        expect((err as CompleteUploadError).cause).toBe(originalError)
      }
    })
  )

  it.effect("abort mid-upload → AbortError with correct tag and message", () =>
    Effect.gen(function* () {
      const controller = new AbortController()
      const fiber = yield* Effect.fork(
        Stream.runCollect(
          uploadOnceEffect({
            stream: new ReadableStream(),
            upload: () => new Promise<void>(() => {}), // never resolves
            signal: controller.signal,
          })
        ).pipe(Effect.provide(LoggerServiceLive))
      )
      yield* Effect.sync(() => controller.abort())
      const exit = yield* Fiber.await(fiber)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const failure = Cause.failureOption(exit.cause)
        expect(failure._tag).toBe("Some")
        const err = (failure as { _tag: "Some"; value: unknown }).value
        expect(err).toBeInstanceOf(AbortError)
        expect((err as AbortError)._tag).toBe("AbortError")
        expect((err as AbortError).message).toBe("Upload aborted")
      }
    })
  )

  it.effect("abort fires after upload completes → success (no spurious abort)", () =>
    Effect.gen(function* () {
      const controller = new AbortController()
      const exit = yield* runStream({
        stream: new ReadableStream(),
        upload: () => Promise.resolve(),
        signal: controller.signal,
      })
      // Abort after upload completes - should not affect the result
      yield* Effect.sync(() => controller.abort())
      expect(Exit.isSuccess(exit)).toBe(true)
    })
  )
})
