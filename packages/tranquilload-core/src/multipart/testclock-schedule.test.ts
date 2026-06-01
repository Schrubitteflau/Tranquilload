import { describe, expect, it } from "@effect/vitest"
import { Effect, Fiber, Schedule, Stream, TestClock } from "effect"
import { LoggerServiceLive } from "../services/logger-service.js"
import { uploadMultipartEffect } from "./upload-stream.js"

/**
 * Story 11.2 — TestClock + Schedule.exponential canonical pattern (AC #8).
 *
 * Locks the `@effect/vitest` `it.effect` + `Effect.fork` + `TestClock.adjust`
 * pattern from auto-memory (`feedback_typecheck_mandatory.md` and the
 * "TestClock for time-based Schedules" note). Real-time tests of
 * `Schedule.exponential` would either flake (depend on the host's setTimeout
 * fidelity) or be slow. TestClock advances time deterministically.
 */

const tinyStream = (bytes: number): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start(c) {
      c.enqueue(new Uint8Array(bytes).fill(1))
      c.close()
    },
  })

describe("Story 11.2 — TestClock + Schedule.exponential (R-P2-8)", () => {
  // ────────────────────────────────────────────────────────────────────────────
  // 11.2-INT-008 (F#78) — TestClock-driven `Schedule.exponential` retry timing
  //
  // A custom `Schedule.exponential("100 millis")` composed with `recurs(5)`
  // gives up to 6 attempts with delays 100ms, 200ms, 400ms, 800ms, 1600ms.
  // We fail attempts 1–3, succeed at attempt 4 — total simulated delay must
  // be 100+200+400 = 700ms; TestClock advances exactly that amount.
  //
  // Locks the canonical pattern for future time-dependent specs: any test of
  // a Schedule's *delays* (as opposed to its *count*) must fork + adjust the
  // clock — never rely on wall time inside `it.effect`.
  // ────────────────────────────────────────────────────────────────────────────
  it.effect(
    "11.2-INT-008 (F#78) — Schedule.exponential('100 millis') retries on TestClock-driven backoff (4 attempts × 100/200/400ms)",
    () =>
      Effect.gen(function* () {
        let attempts = 0
        const cause = new Error("transient-503")

        const fiber = yield* Effect.fork(
          Stream.runDrain(
            uploadMultipartEffect({
              stream: tinyStream(10),
              chunkSize: 10,
              uploadPart: () => {
                attempts += 1
                if (attempts < 4) return Promise.reject(cause)
                return "etag-ok"
              },
              completeUpload: () => {},
              retrySchedule: Schedule.exponential("100 millis").pipe(
                Schedule.compose(Schedule.recurs(5)),
              ),
            }),
          ).pipe(Effect.provide(LoggerServiceLive)),
        )

        // Advance the clock by exactly the sum of expected backoffs: 100 + 200
        // + 400 = 700ms. Each TestClock.adjust gives the runtime a turn to
        // wake the next retry; one big adjust at the end works too because
        // Effect's Schedule observes the cumulative clock.
        yield* TestClock.adjust("100 millis") // unblocks attempt 2
        yield* TestClock.adjust("200 millis") // unblocks attempt 3
        yield* TestClock.adjust("400 millis") // unblocks attempt 4 (success)

        yield* Fiber.join(fiber)
        expect(attempts).toBe(4)
      }),
  )
})
