import { Effect, Exit } from "effect"
import { it, describe, expect } from "@effect/vitest"
import { normalizeCallback } from "./normalize-callback.js"

describe("normalizeCallback", () => {
  it.effect("plain value: succeeds with the value", () =>
    Effect.gen(function* () {
      const result = yield* normalizeCallback(() => 42)
      expect(result).toBe(42)
    })
  )

  it.effect("Promise: succeeds with resolved value", () =>
    Effect.gen(function* () {
      const result = yield* normalizeCallback(() => Promise.resolve("hello"))
      expect(result).toBe("hello")
    })
  )

  it.effect("Effect: passes through unchanged", () =>
    Effect.gen(function* () {
      const result = yield* normalizeCallback(() => Effect.succeed(true))
      expect(result).toBe(true)
    })
  )

  it.effect("throwing function: fails in error channel (not unhandled)", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        normalizeCallback(() => {
          throw new Error("boom")
        })
      )
      expect(Exit.isFailure(exit)).toBe(true)
    })
  )

  it.effect("Promise rejection: fails in error channel", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        normalizeCallback(() => Promise.reject(new Error("async fail")))
      )
      expect(Exit.isFailure(exit)).toBe(true)
    })
  )
})
