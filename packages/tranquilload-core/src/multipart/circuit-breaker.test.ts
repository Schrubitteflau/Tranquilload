import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { CircuitOpenError } from "../errors/upload-error.js"
import { makeCircuitBreaker } from "./circuit-breaker.js"

const realDelay = (ms: number) => Effect.promise(() => new Promise<void>(r => setTimeout(r, ms)))

describe("makeCircuitBreaker", () => {
  it.effect("starts Closed and allows parts through", () =>
    Effect.gen(function* () {
      const cb = yield* makeCircuitBreaker({ threshold: 3, cooldown: 1000 })
      yield* cb.guard
    })
  )

  it.effect("opens circuit after threshold consecutive failures", () =>
    Effect.gen(function* () {
      const cb = yield* makeCircuitBreaker({ threshold: 2, cooldown: 1000 })
      const event1 = yield* cb.onFailure
      expect(event1).toBeNull()
      const event2 = yield* cb.onFailure
      expect(event2).not.toBeNull()
      expect(event2!._tag).toBe("CircuitOpen")
      expect(event2!.failedParts).toBe(2)
    })
  )

  it.effect("guard fails with CircuitOpenError when circuit is Open", () =>
    Effect.gen(function* () {
      const cb = yield* makeCircuitBreaker({ threshold: 1, cooldown: 1000 })
      yield* cb.onFailure
      const result = yield* Effect.exit(cb.guard)
      expect(result._tag).toBe("Failure")
      const err = (result as any).cause.error
      expect(err).toBeInstanceOf(CircuitOpenError)
    })
  )

  it.effect("guard transitions Open → HalfOpen when cooldown elapsed", () =>
    Effect.gen(function* () {
      const cb = yield* makeCircuitBreaker({ threshold: 1, cooldown: 10 })
      yield* cb.onFailure
      yield* realDelay(25)
      yield* cb.guard
      yield* cb.onSuccess
      yield* cb.guard
    })
  )

  it.effect("onSuccess transitions HalfOpen → Closed", () =>
    Effect.gen(function* () {
      const cb = yield* makeCircuitBreaker({ threshold: 1, cooldown: 10 })
      yield* cb.onFailure
      yield* realDelay(25)
      yield* cb.guard
      yield* cb.onSuccess
      yield* cb.guard
      const event = yield* cb.onFailure
      expect(event).not.toBeNull()
    })
  )

  it.effect("onFailure in HalfOpen re-opens the circuit", () =>
    Effect.gen(function* () {
      const cb = yield* makeCircuitBreaker({ threshold: 1, cooldown: 10 })
      yield* cb.onFailure
      yield* realDelay(25)
      yield* cb.guard
      const event = yield* cb.onFailure
      expect(event).not.toBeNull()
      expect(event!._tag).toBe("CircuitOpen")
    })
  )

  it.effect("failures below threshold do NOT open circuit", () =>
    Effect.gen(function* () {
      const cb = yield* makeCircuitBreaker({ threshold: 3, cooldown: 1000 })
      const e1 = yield* cb.onFailure
      const e2 = yield* cb.onFailure
      expect(e1).toBeNull()
      expect(e2).toBeNull()
      yield* cb.guard
    })
  )

  it.effect("onSuccess in Closed resets consecutive failure counter", () =>
    Effect.gen(function* () {
      const cb = yield* makeCircuitBreaker({ threshold: 2, cooldown: 1000 })
      yield* cb.onFailure
      yield* cb.onSuccess
      const e = yield* cb.onFailure
      expect(e).toBeNull()
    })
  )
})
