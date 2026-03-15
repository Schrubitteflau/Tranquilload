import { Effect, Ref } from "effect"
import { CircuitOpenError } from "../errors/upload-error.js"
import type { CircuitOpen } from "../progress/upload-event.js"

export interface CircuitBreakerConfig {
  readonly threshold: number
  readonly cooldown: number
}

type CircuitState =
  | { readonly _tag: "Closed"; readonly consecutiveFailures: number }
  | { readonly _tag: "Open"; readonly openedAt: number }
  | { readonly _tag: "HalfOpen" }

export interface CircuitBreaker {
  readonly guard: Effect.Effect<void, CircuitOpenError>
  readonly onSuccess: Effect.Effect<void>
  readonly onFailure: Effect.Effect<CircuitOpen | null>
}

export const makeCircuitBreaker = (config: CircuitBreakerConfig): Effect.Effect<CircuitBreaker> =>
  Effect.gen(function* () {
    const refState = yield* Ref.make<CircuitState>({ _tag: "Closed", consecutiveFailures: 0 })

    const guard: Effect.Effect<void, CircuitOpenError> = Effect.gen(function* () {
      const state = yield* Ref.get(refState)
      if (state._tag !== "Open") return
      const elapsed = Date.now() - state.openedAt
      if (elapsed < config.cooldown) {
        return yield* Effect.fail(new CircuitOpenError(config.threshold))
      }
      yield* Ref.update(refState, s =>
        s._tag === "Open" ? { _tag: "HalfOpen" as const } : s
      )
    })

    const onSuccess: Effect.Effect<void> = Ref.update(refState, state =>
      state._tag === "HalfOpen" || state._tag === "Closed"
        ? { _tag: "Closed" as const, consecutiveFailures: 0 }
        : state
    )

    const onFailure: Effect.Effect<CircuitOpen | null> = Ref.modify(refState, (state): [CircuitOpen | null, CircuitState] => {
      if (state._tag === "Closed") {
        const newFailures = state.consecutiveFailures + 1
        if (newFailures >= config.threshold) {
          const event: CircuitOpen = {
            _tag: "CircuitOpen",
            failedParts: newFailures,
            timestamp: Date.now(),
          }
          return [event, { _tag: "Open" as const, openedAt: Date.now() }]
        }
        return [null, { _tag: "Closed" as const, consecutiveFailures: newFailures }]
      }
      if (state._tag === "HalfOpen") {
        const event: CircuitOpen = {
          _tag: "CircuitOpen",
          failedParts: config.threshold,
          timestamp: Date.now(),
        }
        return [event, { _tag: "Open" as const, openedAt: Date.now() }]
      }
      return [null, state]
    })

    return { guard, onSuccess, onFailure }
  })
