import { Effect, Exit, Fiber } from "effect"
import { it, describe, expect } from "@effect/vitest"
import { fromAbortSignal } from "./abort-interop.js"
import { AbortError } from "../errors/upload-error.js"

describe("fromAbortSignal", () => {
  it.effect("no signal: never settles on its own (race wins with other branch)", () =>
    Effect.gen(function* () {
      // fromAbortSignal with no signal never resolves; race with a succeeding Effect
      const result = yield* Effect.race(Effect.succeed("winner"), fromAbortSignal())
      expect(result).toBe("winner")
    })
  )

  it.effect("signal already aborted: fails immediately with AbortError", () =>
    Effect.gen(function* () {
      const controller = new AbortController()
      controller.abort()
      const exit = yield* Effect.exit(fromAbortSignal(controller.signal))
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const cause = exit.cause
        // The error should be an AbortError
        expect(cause._tag).toBe("Fail")
        if (cause._tag === "Fail") {
          expect(cause.error).toBeInstanceOf(AbortError)
          expect((cause.error as AbortError)._tag).toBe("AbortError")
        }
      }
    })
  )

  it.effect("controller.abort() after fromAbortSignal: fails with AbortError", () =>
    Effect.gen(function* () {
      const controller = new AbortController()
      const fiber = yield* Effect.fork(fromAbortSignal(controller.signal))
      yield* Effect.sync(() => controller.abort())
      const exit = yield* Fiber.await(fiber)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const cause = exit.cause
        expect(cause._tag).toBe("Fail")
        if (cause._tag === "Fail") {
          expect(cause.error).toBeInstanceOf(AbortError)
        }
      }
    })
  )

  it.effect("AbortError shape: _tag, instanceof Error, message", () =>
    Effect.gen(function* () {
      const controller = new AbortController()
      controller.abort()
      const exit = yield* Effect.exit(fromAbortSignal(controller.signal))
      if (Exit.isFailure(exit) && exit.cause._tag === "Fail") {
        const error = exit.cause.error as AbortError
        expect(error._tag).toBe("AbortError")
        expect(error).toBeInstanceOf(Error)
        expect(error.message).toBe("Upload aborted")
      } else {
        expect.fail("Expected a Fail exit")
      }
    })
  )
})
