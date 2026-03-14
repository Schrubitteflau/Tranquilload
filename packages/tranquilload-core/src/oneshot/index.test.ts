import { describe, expect, it } from "@effect/vitest"
import { Cause, Effect, Exit } from "effect"
import { AbortError } from "../errors/upload-error.js"
import { uploadOnce } from "./index.js"

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

describe("uploadOnce — Dual API entry point", () => {
  it.effect("success (plain void callback): events emits UploadCompleted, result resolves with UploadCompleted", () =>
    Effect.gen(function* () {
      const { events, result } = uploadOnce({
        stream: new ReadableStream(),
        upload: () => Promise.resolve(),
      })

      const [evts, res] = yield* Effect.all([
        Effect.promise(() => readAllEvents(events)),
        Effect.promise(() => result),
      ])

      expect(evts).toHaveLength(1)
      expect(evts[0]._tag).toBe("UploadCompleted")
      expect(evts[0].totalParts).toBe(1)
      expect(res._tag).toBe("UploadCompleted")
      expect(res).toBe(evts[0]) // same object reference
    })
  )

  it.effect("success (Promise callback): result resolves with UploadCompleted", () =>
    Effect.gen(function* () {
      let callCount = 0
      const { result } = uploadOnce({
        stream: new ReadableStream(),
        upload: (_stream) => {
          callCount++
          return Promise.resolve()
        },
      })

      const res = yield* Effect.promise(() => result)
      expect(res._tag).toBe("UploadCompleted")
      // Callback invoked exactly once (single-run guarantee)
      expect(callCount).toBe(1)
    })
  )

  it.effect("abort: result rejects with AbortError, events closes cleanly", () =>
    Effect.gen(function* () {
      const controller = new AbortController()
      controller.abort()

      const { events, result } = uploadOnce({
        stream: new ReadableStream(),
        upload: () => new Promise<void>(() => {}), // never resolves
        signal: controller.signal,
      })

      // events closes cleanly — no error thrown to stream consumer
      const evts = yield* Effect.promise(() => readAllEvents(events))
      expect(evts).toHaveLength(0)

      // result rejects with AbortError — use tryPromise to capture rejection as typed failure
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
    })
  )

  it.effect("uploadOnce.effect returns a Stream (effect escape hatch)", () =>
    Effect.gen(function* () {
      // Calling .effect should not throw — returns a Stream (lazy, not executed)
      const stream = uploadOnce.effect({
        stream: new ReadableStream(),
        upload: () => Promise.resolve(),
      })
      // Stream has a pipe method (duck-type check — we don't run it)
      expect(typeof stream.pipe).toBe("function")
    })
  )
})
