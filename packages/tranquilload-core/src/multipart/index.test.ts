import { describe, expect, it } from "@effect/vitest"
import { Cause, Effect, Exit, Option } from "effect"
import { AbortError } from "../errors/upload-error.js"
import { uploadMultipart } from "./index.js"
import { uploadMultipartEffect } from "./upload-stream.js"

// Helper: create a ReadableStream from a Uint8Array
const fromBytes = (bytes: Uint8Array): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start(c) {
      c.enqueue(bytes)
      c.close()
    },
  })

// Helper: read all events from the ReadableStream
const readAllEvents = async <T>(rs: ReadableStream<T>): Promise<T[]> => {
  const reader = rs.getReader()
  const events: T[] = []
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    events.push(value)
  }
  return events
}

describe("uploadMultipart — Dual API entry point", () => {
  it.effect("happy path: result resolves with UploadCompleted, events contains all events", () =>
    Effect.gen(function* () {
      const { result, events } = uploadMultipart({
        stream: fromBytes(new Uint8Array(20).fill(1)),
        chunkSize: 10,
        uploadPart: (n) => `etag-${n}`,
        completeUpload: () => {},
      })

      const [uploadResult, evts] = yield* Effect.all([
        Effect.promise(() => result),
        Effect.promise(() => readAllEvents(events)),
      ])

      expect(uploadResult._tag).toBe("UploadCompleted")
      expect(uploadResult.totalParts).toBe(2)

      const partEvents = evts.filter((e) => e._tag === "PartCompleted")
      expect(partEvents).toHaveLength(2)
      expect(evts.find((e) => e._tag === "UploadCompleted")).toBeDefined()
    })
  )

  it.effect("getProgress tracks bytesUploaded; totalBytes is Some when provided", () =>
    Effect.gen(function* () {
      const { result, getProgress } = uploadMultipart({
        stream: fromBytes(new Uint8Array(30).fill(1)),
        chunkSize: 10,
        uploadPart: () => "etag",
        completeUpload: () => {},
        totalBytes: 30,
      })

      yield* Effect.promise(() => result)

      const progress = yield* Effect.promise(() => getProgress())
      expect(progress.bytesUploaded).toBe(30)
      expect(progress.totalBytes).toEqual(Option.some(30))
    })
  )

  it.effect("getProgress returns None for totalBytes when not provided", () =>
    Effect.gen(function* () {
      const { result, getProgress } = uploadMultipart({
        stream: fromBytes(new Uint8Array(10).fill(1)),
        chunkSize: 10,
        uploadPart: () => "etag",
        completeUpload: () => {},
      })

      yield* Effect.promise(() => result)

      const progress = yield* Effect.promise(() => getProgress())
      expect(progress.totalBytes).toEqual(Option.none())
    })
  )

  it.effect("abort signal: result rejects with AbortError, events stream closes cleanly", () =>
    Effect.gen(function* () {
      const controller = new AbortController()
      const { result, events } = uploadMultipart({
        stream: fromBytes(new Uint8Array(10).fill(1)),
        chunkSize: 10,
        uploadPart: () =>
          new Promise<string>((_resolve) => {
            setTimeout(() => controller.abort(), 5)
          }),
        completeUpload: () => {},
        signal: controller.signal,
      })

      // result rejects with AbortError
      const resultExit = yield* Effect.exit(
        Effect.tryPromise({
          try: () => result,
          catch: (e) => e,
        })
      )
      expect(Exit.isFailure(resultExit)).toBe(true)
      if (Exit.isFailure(resultExit)) {
        const errOption = Cause.failureOption(resultExit.cause)
        expect(errOption._tag).toBe("Some")
        const err = (errOption as { _tag: "Some"; value: unknown }).value
        expect(err).toBeInstanceOf(AbortError)
        expect((err as AbortError)._tag).toBe("AbortError")
      }

      // events ReadableStream closes cleanly (no throw)
      const evts = yield* Effect.promise(() => readAllEvents(events))
      // Stream should close without throwing — length may be 0 (aborted before any parts complete)
      expect(Array.isArray(evts)).toBe(true)
    })
  )

  it(".effect property points to uploadMultipartEffect", () => {
    expect(uploadMultipart.effect).toBe(uploadMultipartEffect)
  })
})
