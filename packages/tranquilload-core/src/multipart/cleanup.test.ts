import { describe, expect, it } from "@effect/vitest"
import { it as plainIt } from "vitest"
import { Cause, Chunk, Effect, Exit, Layer, Schedule, Stream } from "effect"
import { PartUploadError } from "../errors/upload-error.js"
import { LoggerService, LoggerServiceLive } from "../services/logger-service.js"
import { uploadMultipart } from "./index.js"
import { uploadMultipartEffect } from "./upload-stream.js"

/**
 * Story 11.2 — Cleanup & resource safety (R-P2-2, HIGH).
 *
 * The 4 vitest-integration probes for the cleanup cluster. Each test follows the
 * three patterns surfaced by the Story 11.6 review (see
 * project_test_timing_boundary_patterns.md):
 *
 *   1. Gated callback for any "during X" timing claim.
 *   2. Surgical defect-refusal via Effect.runPromiseExit + Cause.dieOption +
 *      Cause.defects (the public `result` Promise's Cause.squash masks defects).
 *   3. Honest scope: if the platform doesn't allow testing X directly, the
 *      narrower honest lock is captured with an explicit Scope note.
 */

const tinyFiniteSource = (totalBytes: number): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start(c) {
      c.enqueue(new Uint8Array(totalBytes).fill(1))
      c.close()
    },
  })

const realtimeSleep = (ms: number): Promise<void> =>
  new Promise(r => setTimeout(r, ms))

describe("Story 11.2 — cleanup & resource safety (R-P2-2)", () => {
  // ────────────────────────────────────────────────────────────────────────────
  // 11.2-INT-010 (F#80) — Layer finalizer runs exactly once at scope close
  // (including on success, error, and abort paths)
  //
  // Pattern: scoped LoggerService Layer with a counter Ref incremented in the
  // finalizer. Three uploads — success, error, abort — each in their own scope.
  // Final counter MUST equal 3. If a path leaks the scope, the counter is < 3;
  // if a path runs the finalizer twice, counter > 3.
  //
  // Scope: locks the Effect-runtime guarantee at the lib's public surface, not
  // a finalizer registered by the lib itself (the lib uses Layer.succeed for
  // its own services). A user who provides a Layer.scoped is the realistic
  // load-bearing case (e.g. Pino/OpenTelemetry sinks with handles to flush).
  // ────────────────────────────────────────────────────────────────────────────
  // Uses plain `it` (vitest) + Effect.runPromise so we get the real-time Clock.
  // `it.effect` from @effect/vitest injects TestContext (TestClock-bound) which
  // wedges the `realtimeSleep`-based abort timing in Path C.
  plainIt(
    "11.2-INT-010 (F#80) — user Layer.scoped finalizer fires exactly once per upload scope across success+error+abort paths",
    async () => {
      let finalizerCount = 0

      const ScopedLogger = Layer.scoped(
        LoggerService,
        Effect.gen(function* () {
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              finalizerCount += 1
            }),
          )
          return { log: () => {} }
        }),
      )

      // Path A: success
      await Effect.runPromise(
        Stream.runDrain(
          uploadMultipartEffect({
            stream: tinyFiniteSource(30),
            chunkSize: 10,
            uploadPart: () => "etag-ok",
            completeUpload: () => {},
          }),
        ).pipe(Effect.provide(ScopedLogger)),
      )

      // Path B: terminal failure (no retries)
      const failExit = await Effect.runPromise(
        Effect.exit(
          Stream.runDrain(
            uploadMultipartEffect({
              stream: tinyFiniteSource(10),
              chunkSize: 10,
              uploadPart: () => Promise.reject(new Error("terminal")),
              completeUpload: () => {},
              retrySchedule: Schedule.recurs(0),
            }),
          ).pipe(Effect.provide(ScopedLogger)),
        ),
      )
      expect(Exit.isFailure(failExit)).toBe(true)

      // Path C: abort mid-upload via AbortController (gated callback so we
      // PROVE the abort lands while a part is genuinely in flight — Pattern 1
      // from project_test_timing_boundary_patterns.md).
      const controller = new AbortController()
      let resolvePartStarted: () => void = () => {}
      const partStarted = new Promise<void>(r => {
        resolvePartStarted = r
      })

      const abortPromise = Effect.runPromise(
        Effect.exit(
          Stream.runDrain(
            uploadMultipartEffect({
              stream: tinyFiniteSource(40),
              chunkSize: 10,
              uploadPart: async () => {
                resolvePartStarted()
                await realtimeSleep(100)
                return "etag-abort"
              },
              completeUpload: () => {},
              signal: controller.signal,
              maxConcurrency: 1,
            }),
          ).pipe(Effect.provide(ScopedLogger)),
        ),
      )
      await partStarted
      controller.abort()
      await abortPromise

      // Allow finalizer fibers to drain (Effect releases scopes on the next
      // microtask after the runtime promise resolves).
      await realtimeSleep(50)

      expect(
        finalizerCount,
        `expected finalizer to fire 3× (one per scope), got ${finalizerCount}`,
      ).toBe(3)
    },
  )

  // ────────────────────────────────────────────────────────────────────────────
  // 11.2-INT-012 (F#83) — Source ReadableStream released on error
  //
  // Pattern: source ReadableStream with an asynchronous `pull` (yields one chunk
  // per pull with a 5 ms gap, never closes itself). The upload fails terminally
  // on part 1 (Promise.reject inside uploadPart). When the upload's Effect
  // scope closes on error, chunkStream's `Stream.fromReadableStream` MUST
  // release its reader, which cancels the source — observed via the source's
  // `cancel(reason)` callback being invoked.
  //
  // Defect refusal: we wrap with Effect.exit and assert Cause.dieOption +
  // Cause.defects are empty — Pattern 2 from the 11.6 review.
  // ────────────────────────────────────────────────────────────────────────────
  it.effect(
    "11.2-INT-012 (F#83) — terminal uploadPart failure cancels the source ReadableStream (no dangling reader)",
    () =>
      Effect.gen(function* () {
        let cancelCalled = false
        let cancelReason: unknown = undefined

        const source = new ReadableStream<Uint8Array>({
          async pull(c) {
            await new Promise(r => setTimeout(r, 5))
            c.enqueue(new Uint8Array(10).fill(7))
          },
          cancel(reason) {
            cancelCalled = true
            cancelReason = reason
          },
        })

        const exit = yield* Effect.exit(
          Stream.runDrain(
            uploadMultipartEffect({
              stream: source,
              chunkSize: 10,
              uploadPart: () => Promise.reject(new Error("terminal part 1")),
              completeUpload: () => {},
              retrySchedule: Schedule.recurs(0),
              maxConcurrency: 1,
            }),
          ).pipe(Effect.provide(LoggerServiceLive)),
        )

        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          // No fiber DEFECT — failure must surface in the typed error channel.
          expect(Cause.dieOption(exit.cause)._tag).toBe("None")
          expect(Chunk.size(Cause.defects(exit.cause))).toBe(0)
        }

        // Reader release must propagate to source.cancel — otherwise the source
        // is leaked (e.g. a fetch body whose underlying socket stays open).
        expect(
          cancelCalled,
          `source.cancel was never called — reader leaked after terminal error; cancelReason=${String(cancelReason)}`,
        ).toBe(true)
      }),
  )

  // ────────────────────────────────────────────────────────────────────────────
  // 11.2-INT-013 (F#85) — Pipeline error cancels upstream source (no dangling reader)
  //
  // Pattern: pre-build a `processedStream` via a manual TransformStream that
  // errors on its second chunk. Pass the processedStream to uploadMultipartEffect.
  // chunkStream errors out via Stream.fromReadableStream → Stream.mapError →
  // PartUploadError(0, 0). The lib MUST cancel the chunkStream source, which
  // propagates through pipeThrough back to the user's source.
  //
  // Differs from INT-012 in WHERE the error originates: pipeline (before
  // chunkStream's transform) instead of uploadPart (downstream of chunkStream).
  // ────────────────────────────────────────────────────────────────────────────
  it.effect(
    "11.2-INT-013 (F#85) — pipeline mid-stream error cancels the upstream source via pipeThrough back-propagation",
    () =>
      Effect.gen(function* () {
        let cancelCalled = false

        const userSource = new ReadableStream<Uint8Array>({
          async pull(c) {
            await new Promise(r => setTimeout(r, 5))
            c.enqueue(new Uint8Array(10).fill(3))
          },
          cancel() {
            cancelCalled = true
          },
        })

        // Erroring pipeline stage: first chunk through, second chunk errors.
        let seen = 0
        const errPipeline = new TransformStream<Uint8Array, Uint8Array>({
          transform(chunk, c) {
            seen += 1
            if (seen > 1) {
              c.error(new Error("pipeline mid-stream error"))
              return
            }
            c.enqueue(chunk)
          },
        })
        const processedStream = userSource.pipeThrough(errPipeline)

        const exit = yield* Effect.exit(
          Stream.runDrain(
            uploadMultipartEffect({
              stream: processedStream,
              chunkSize: 10,
              uploadPart: () => "etag-ok",
              completeUpload: () => {},
              maxConcurrency: 1,
            }),
          ).pipe(Effect.provide(LoggerServiceLive)),
        )

        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          expect(Cause.dieOption(exit.cause)._tag).toBe("None")
          expect(Chunk.size(Cause.defects(exit.cause))).toBe(0)
          const failure = Cause.failureOption(exit.cause)
          expect(failure._tag).toBe("Some")
          if (failure._tag === "Some") {
            expect(failure.value).toBeInstanceOf(PartUploadError)
            expect((failure.value as PartUploadError).partNumber).toBe(0)
          }
        }

        expect(
          cancelCalled,
          "pipeline error must propagate cancellation through pipeThrough to the user's source",
        ).toBe(true)
      }),
  )

  // ────────────────────────────────────────────────────────────────────────────
  // 11.2-INT-016 (F#88) — Semaphore permit released on terminal error
  //
  // Scope (Pattern 3): the Effect.makeSemaphore instance is internal-per-upload
  // and not directly observable from a black-box test. We probe its CORRECTNESS
  // by observing two consequences of correct release:
  //
  //   (a) the upload terminates within a tight wall-clock budget (a leak would
  //       deadlock other parts on permit acquisition); we cap with
  //       Effect.timeout("2 seconds") and assert the upload settles in time.
  //   (b) every uploadPart invocation reaches its `finally` block (running ==
  //       0 after the upload settles); we use a try/finally counter so the
  //       in-flight parts that started before the terminal failure drain.
  //
  // Together (a)+(b) lock the permit-release contract from outside the lib.
  // The narrower-honest-lock per Pattern 3.
  // ────────────────────────────────────────────────────────────────────────────
  // Plain `it` for real-time Clock — the "upload settles" probe needs wall
  // time, not TestClock.
  plainIt(
    "11.2-INT-016 (F#88) — terminal error releases all in-flight semaphore permits (gated 2-permit overlap proven before failure)",
    async () => {
      let running = 0
      let maxObserved = 0
      let everStarted = 0

      // Gated callback (Pattern 1): part 1 holds its failure UNTIL part 2 has
      // entered uploadPart, PROVING the semaphore actually permitted two
      // concurrent in-flight parts at the moment the failure was raised. A
      // weaker test that only asserts `maxObserved <= 2` would pass even with
      // no concurrency at all (maxObserved=1) — Codex flagged this.
      let resolvePart2Entered: () => void = () => {}
      const part2Entered = new Promise<void>(r => {
        resolvePart2Entered = r
      })

      const uploadPart = async (partNumber: number): Promise<string> => {
        running += 1
        everStarted += 1
        maxObserved = Math.max(maxObserved, running)
        try {
          if (partNumber === 1) {
            // Hold the failure until part 2 has also entered uploadPart —
            // guarantees an observable 2-permit overlap. Bound with a 500ms
            // safety so a broken semaphore (part 2 never enters) doesn't
            // wedge the whole test indefinitely; the outer Promise.race +
            // assertion will catch that as a wall-clock timeout.
            await Promise.race([
              part2Entered,
              realtimeSleep(500),
            ])
            throw new Error("terminal part 1")
          }
          if (partNumber === 2) resolvePart2Entered()
          await realtimeSleep(30)
          return `etag-${partNumber}`
        } finally {
          running -= 1
        }
      }

      // (a) Upload must settle within a tight wall-clock budget — a leaked
      // permit would wedge Stream.mapEffect's concurrency limiter and the
      // upload would hang forever waiting for permits to free up.
      const settled = await Promise.race([
        Effect.runPromise(
          Effect.exit(
            Stream.runDrain(
              uploadMultipartEffect({
                stream: tinyFiniteSource(60), // 6 parts × 10 bytes
                chunkSize: 10,
                uploadPart,
                completeUpload: () => {},
                retrySchedule: Schedule.recurs(0),
                maxConcurrency: 2,
              }),
            ).pipe(Effect.provide(LoggerServiceLive)),
          ),
        ),
        realtimeSleep(2000).then(() => "WALL_CLOCK_TIMEOUT" as const),
      ])

      expect(
        settled,
        "upload did not settle within 2 s — suspected semaphore-permit leak (Stream.mapEffect wedged)",
      ).not.toBe("WALL_CLOCK_TIMEOUT")
      // Type-narrow: we've ruled out the timeout sentinel above.
      const exit = settled as Exit.Exit<void, unknown>

      // Allow the in-flight parts (started before the terminal error) to walk
      // through their finally blocks.
      await realtimeSleep(100)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(Cause.dieOption(exit.cause)._tag).toBe("None")
        expect(Chunk.size(Cause.defects(exit.cause))).toBe(0)
        const failure = Cause.failureOption(exit.cause)
        expect(failure._tag).toBe("Some")
        if (failure._tag === "Some") {
          expect(failure.value).toBeInstanceOf(PartUploadError)
        }
      }

      // Concurrency: lower bound PROVES the semaphore allowed 2 permits to be
      // held simultaneously at the moment of failure — the actual contract
      // under test. Upper bound is the maxConcurrency sanity check.
      expect(
        maxObserved,
        `expected 2 concurrent parts in flight at the moment of failure (gated via part2Entered); maxObserved=${maxObserved}`,
      ).toBeGreaterThanOrEqual(2)
      expect(maxObserved).toBeLessThanOrEqual(2)
      expect(everStarted).toBeGreaterThanOrEqual(2)

      // (b) Every started part reached its finally block — no stranded uploads
      // holding permits.
      expect(
        running,
        `expected all started parts to reach finally; running=${running} after upload settled with everStarted=${everStarted}`,
      ).toBe(0)
    },
  )

  // ────────────────────────────────────────────────────────────────────────────
  // 11.2-INT-017 (F#90 — cleanup lens) — Not reading the events stream does
  // NOT leak resources (pairs with 11.6-INT-027 latency lens)
  //
  // The `events` ReadableStream is built lazily from the internal `collected`
  // Promise — `controller.enqueue(...)` then `controller.close()`. If the
  // consumer ignores `events`, the lib MUST still:
  //   1. Complete the upload (no producer-side backpressure).
  //   2. Close the events stream cleanly so a late reader observes `done=true`
  //      after draining the buffered events.
  //
  // The cleanup lens locks (2): no dangling controller / no held-open reader.
  // ────────────────────────────────────────────────────────────────────────────
  it.effect(
    "11.2-INT-017 (F#90 — cleanup lens) — unread events stream closes cleanly after upload (no dangling controller)",
    () =>
      Effect.gen(function* () {
        const { result, events } = uploadMultipart({
          stream: tinyFiniteSource(50), // 5 parts × 10 bytes
          chunkSize: 10,
          uploadPart: (n) => `etag-${n}`,
          completeUpload: () => {},
        })

        // Deliberately do NOT read events while the upload runs — locks the
        // "no backpressure on producer" half from the cleanup angle.
        yield* Effect.promise(() => result)

        // Now drain the events stream AFTER completion. It must yield the
        // buffered events then cleanly reach `done = true`.
        const reader = events.getReader()
        let eventCount = 0
        let done = false
        while (!done) {
          const { value, done: d } = yield* Effect.promise(() => reader.read())
          done = d
          if (value !== undefined) eventCount += 1
        }
        // 5 parts → 5 PartCompleted + 5 ProgressTick + 1 UploadCompleted = 11
        // (the exact count is locked elsewhere; here we only need > 0 to know
        // the buffer wasn't dropped on the floor).
        expect(eventCount).toBeGreaterThan(0)
      }),
  )
})
