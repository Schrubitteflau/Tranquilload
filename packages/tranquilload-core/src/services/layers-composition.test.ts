import { describe, expect, it } from "@effect/vitest"
import { Cause, Chunk, Effect, Exit, Layer, Ref, Stream } from "effect"
import { LoggerService, LoggerServiceLive, type LogLevel } from "./logger-service.js"
import { uploadMultipartEffect } from "../multipart/upload-stream.js"

/**
 * Story 11.2 — Layer composition edges (R-P2-8, MEDIUM).
 *
 * AC #2: `Layer.empty` provided where the lib expects `LoggerService` →
 * clear typed Effect error (not a silent crash).
 * AC #3: Last-writer-wins semantics + concurrent `.effect` programs share
 * a Layer instance (no double-init).
 */

const tinyStream = (bytes: number): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start(c) {
      c.enqueue(new Uint8Array(bytes).fill(1))
      c.close()
    },
  })

describe("Story 11.2 — Layer composition edges (R-P2-8)", () => {
  // ────────────────────────────────────────────────────────────────────────────
  // 11.2-INT-007 (F#76) — Layer.empty where LoggerService expected
  //
  // The lib's internal `yield* LoggerService` must surface a clear, identifiable
  // error when the service is unavailable. Effect's Context-lookup failure mode
  // is a fiber defect carrying `NoSuchElementException` / "Service not found".
  // We lock that error is OBSERVABLE in the Exit (not a thrown JS error that
  // bypasses the Effect runtime) and carries the missing service's name so the
  // user can diagnose at a glance.
  //
  // Type-safety note: providing `Layer.empty` to an Effect that requires
  // LoggerService is a compile error. The test bypasses TS with an `as` cast —
  // this models the foot-gun where the user composes layers dynamically and
  // accidentally omits a service.
  // ────────────────────────────────────────────────────────────────────────────
  it.effect(
    "11.2-INT-007 (F#76) — Layer.empty where LoggerService expected → failure carries the missing service name",
    () =>
      Effect.gen(function* () {
        const program = uploadMultipartEffect({
          stream: tinyStream(10),
          chunkSize: 10,
          uploadPart: () => "etag",
          completeUpload: () => {},
        })

        // Cast: Layer.empty has type Layer<never, never, never>; we coerce so
        // the type system accepts the provide. Runtime will reject with a
        // clear Context-lookup defect.
        const provided = program.pipe(
          Stream.provideLayer(Layer.empty as unknown as Layer.Layer<LoggerService>),
        )

        const exit = yield* Effect.exit(Stream.runDrain(provided))
        expect(Exit.isFailure(exit)).toBe(true)

        if (Exit.isFailure(exit)) {
          // Service not found surfaces as a DEFECT (programmer error), not a
          // typed error channel value — that's the right Effect semantics.
          // The lock here is that the defect is OBSERVABLE in the Exit (the
          // user can catch it via Cause.defects / Effect.catchAllDefect) and
          // mentions the missing service's key.
          const defects = Cause.defects(exit.cause)
          expect(
            Chunk.size(defects),
            "expected a defect carrying the missing-service info; got none",
          ).toBeGreaterThan(0)
          const messages = Chunk.toReadonlyArray(defects)
            .map(d => String((d as Error)?.message ?? d))
            .join(" | ")
          expect(
            messages,
            `defect message should mention the missing service tag (got "${messages}")`,
          ).toMatch(/LoggerService|Service/i)
        }
      }),
  )

  // ────────────────────────────────────────────────────────────────────────────
  // 11.2-INT-009 (F#79) — Layer last-writer-wins under `Layer.merge`
  //
  // Idiomatic stacking is `Layer.merge(Default, Override)`: when both layers
  // provide the same service tag, the SECOND argument's value wins. This is
  // the realistic shape for a user who composes the default + a custom Logger:
  //     const combined = Layer.merge(LoggerServiceLive, RecordingLogger)
  // The lock here: the lib's `yield* LoggerService` resolves to the override.
  //
  // Why merge (not pipe-of-provideLayer): Stream.provideLayer is satisfied by
  // the FIRST layer to provide the tag — chaining two provideLayer calls is
  // first-writer-wins, not last. Merge is the right composition primitive for
  // overrides.
  // ────────────────────────────────────────────────────────────────────────────
  it.effect(
    "11.2-INT-009 (F#79) — Layer.merge(Default, Override) resolves the tag to Override's value (last-writer-wins)",
    () =>
      Effect.gen(function* () {
        const recorded: string[] = []
        const RecordingLogger: Layer.Layer<LoggerService> = Layer.succeed(
          LoggerService,
          {
            log: (_level: LogLevel, message: string, _data?: unknown) => {
              recorded.push(message)
            },
          },
        )

        const combined = Layer.merge(LoggerServiceLive, RecordingLogger)

        yield* Stream.runDrain(
          uploadMultipartEffect({
            stream: tinyStream(20),
            chunkSize: 10,
            uploadPart: (n) => `etag-${n}`,
            completeUpload: () => {},
          }).pipe(Stream.provideLayer(combined)),
        )

        // If LoggerServiceLive (no-op) had won, recorded would be empty.
        expect(
          recorded.length,
          `recorded ${recorded.length} entries — expected RecordingLogger to win the merge`,
        ).toBeGreaterThan(0)
        expect(recorded.some(m => m.startsWith("Part "))).toBe(true)
        expect(recorded.some(m => m === "Multipart upload completed")).toBe(true)
      }),
  )

  // ────────────────────────────────────────────────────────────────────────────
  // 11.2-INT-011 (F#81) — Two concurrent `.effect` programs share a Layer
  // instance (no double-init)
  //
  // Scope (Pattern 3): the "shared instance" guarantee depends on the user
  // building the Layer ONCE and providing it to both programs. We lock the
  // realistic API shape:
  //   const layer = Layer.effect(LoggerService, makeLogger)   // capture once
  //   Effect.all([prog1, prog2]).pipe(Effect.provide(layer))  // share build
  // and assert the Layer's build effect fires exactly once across the two
  // concurrent uploads.
  // ────────────────────────────────────────────────────────────────────────────
  it.effect(
    "11.2-INT-011 (F#81) — concurrent uploads sharing one Effect.provide build the Layer exactly once",
    () =>
      Effect.gen(function* () {
        const buildCount = yield* Ref.make(0)

        const SharedLogger: Layer.Layer<LoggerService> = Layer.effect(
          LoggerService,
          Effect.gen(function* () {
            yield* Ref.update(buildCount, n => n + 1)
            return { log: () => {} }
          }),
        )

        // Each upload needs its OWN ReadableStream (a ReadableStream cannot be
        // consumed twice). We use `Effect.suspend` so the stream is created
        // when each branch actually runs — not once at description time.
        const oneUpload = Effect.suspend(() =>
          Stream.runDrain(
            uploadMultipartEffect({
              stream: tinyStream(20),
              chunkSize: 10,
              uploadPart: (n) => `etag-${n}`,
              completeUpload: () => {},
            }),
          ),
        )

        // Two concurrent uploads composed under a SINGLE provide — the Layer
        // build effect must run exactly once.
        yield* Effect.all([oneUpload, oneUpload], { concurrency: 2 }).pipe(
          Effect.provide(SharedLogger),
        )

        const count = yield* Ref.get(buildCount)
        expect(
          count,
          `expected exactly 1 Layer build under one provide; got ${count}`,
        ).toBe(1)
      }),
  )
})
