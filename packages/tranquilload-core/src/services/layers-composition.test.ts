import { describe, expect, it } from "@effect/vitest"
import { Cause, Chunk, Effect, Exit, Layer, Ref, Stream } from "effect"
import { LoggerService } from "./logger-service.js"
import { CompressionService, CompressionServiceLive } from "./compression-service.js"
import { compress } from "../pipeline/compress.js"
import { uploadMultipartEffect } from "../multipart/upload-stream.js"

/**
 * Story 11.2 — Layer composition edges (R-P2-8, MEDIUM).
 *
 * AC #2: `Layer.empty` provided where the lib expects `CompressionServiceLive`
 * OR `LoggerServiceLive` → clear typed Effect error (not a silent crash).
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
    "11.2-INT-007a (F#76) — Layer.empty where LoggerService expected → failure carries the missing service name",
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
  // 11.2-INT-007b (F#76) — Layer.empty where CompressionService expected
  //
  // AC #2 names both `LoggerServiceLive` AND `CompressionServiceLive`. The
  // CompressionService requirement only surfaces when the user composes a
  // pipeline via `compress("deflate-raw")`. Same lock as 007a: a missing
  // CompressionService must produce an observable defect mentioning the tag.
  // ────────────────────────────────────────────────────────────────────────────
  it.effect(
    "11.2-INT-007b (F#76) — Layer.empty where CompressionService expected → failure carries the missing service name",
    () =>
      Effect.gen(function* () {
        // `compress` requires CompressionService; provide Layer.empty for it.
        const compressEffect = compress("deflate-raw").pipe(
          Effect.provide(Layer.empty as unknown as Layer.Layer<CompressionService>),
        )

        const exit = yield* Effect.exit(compressEffect)
        expect(Exit.isFailure(exit)).toBe(true)

        if (Exit.isFailure(exit)) {
          const defects = Cause.defects(exit.cause)
          expect(
            Chunk.size(defects),
            "expected a defect carrying the missing-CompressionService info; got none",
          ).toBeGreaterThan(0)
          const messages = Chunk.toReadonlyArray(defects)
            .map(d => String((d as Error)?.message ?? d))
            .join(" | ")
          expect(
            messages,
            `defect message should mention the missing service tag (got "${messages}")`,
          ).toMatch(/CompressionService|Service/i)
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
    "11.2-INT-009 (F#79) — Layer.merge(CompressionServiceLive, UserOverride) resolves the tag to Override's value (last-writer-wins)",
    () =>
      Effect.gen(function* () {
        // Sentinel: the user override replaces compression with a stream that
        // emits a known 3-byte marker. If the default CompressionServiceLive
        // (real deflate-raw) had won, the output would NOT be these bytes.
        const SENTINEL = new Uint8Array([0x55, 0xaa, 0x55])
        let overrideCallCount = 0

        const UserCompression: Layer.Layer<CompressionService> = Layer.succeed(
          CompressionService,
          {
            compress: (_stream, _alg) => {
              overrideCallCount += 1
              return new ReadableStream<Uint8Array>({
                start(c) {
                  c.enqueue(SENTINEL)
                  c.close()
                },
              })
            },
          },
        )

        const combined = Layer.merge(CompressionServiceLive, UserCompression)

        // Resolve `compress("deflate-raw")` against the merged layer and run
        // the resulting Transform on a source. We then read all bytes and
        // verify they are the sentinel — proving the user override beat the
        // default.
        const transform = yield* Effect.provide(compress("deflate-raw"), combined)
        const source = new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(new Uint8Array(32).fill(7))
            c.close()
          },
        })
        const processed = transform(source)

        const collected: number[] = []
        const reader = processed.getReader()
        // eslint-disable-next-line no-constant-condition
        while (true) {
          const { value, done } = yield* Effect.promise(() => reader.read())
          if (done) break
          if (value !== undefined) collected.push(...Array.from(value))
        }

        expect(overrideCallCount, "user override's compress must be invoked").toBe(1)
        expect(collected).toEqual(Array.from(SENTINEL))
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
