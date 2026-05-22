import { describe, expect, it } from "@effect/vitest"
import { Cause, Chunk, Effect, Exit, Layer, Stream } from "effect"
import { afterEach, beforeEach, vi } from "vitest"
import { PartUploadError } from "../errors/upload-error.js"
import { uploadMultipartEffect } from "../multipart/upload-stream.js"
import {
  CompressionService,
  CompressionServiceLive,
  CompressionUnavailableError,
} from "../services/compression-service.js"
import { LoggerServiceLive } from "../services/logger-service.js"
import { compress } from "./compress.js"

const fromBytes = (bytes: Uint8Array): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start: (c) => {
      c.enqueue(bytes)
      c.close()
    },
  })

const runUpload = (stream: ReadableStream<Uint8Array>) =>
  Stream.runCollect(
    uploadMultipartEffect({
      stream,
      chunkSize: 16,
      uploadPart: () => "etag",
      completeUpload: () => {},
    })
  ).pipe(
    Effect.map((c) => Array.from(c)),
    Effect.provide(LoggerServiceLive)
  )

const expectPartUploadError = (
  exit: Exit.Exit<unknown, unknown>,
  expectedCauseMessage?: string
): void => {
  expect(Exit.isFailure(exit)).toBe(true)
  if (Exit.isFailure(exit)) {
    // Critical: must surface in the typed Effect error channel, NOT as a fiber defect.
    expect(Cause.dieOption(exit.cause)._tag).toBe("None")
    expect(Chunk.size(Cause.defects(exit.cause))).toBe(0)
    const failure = Cause.failureOption(exit.cause)
    expect(failure._tag).toBe("Some")
    if (failure._tag === "Some") {
      expect(failure.value).toBeInstanceOf(PartUploadError)
      const err = failure.value as PartUploadError
      expect(err._tag).toBe("PartUploadError")
      expect(err.partNumber).toBe(0)
      expect(err.attempt).toBe(0)
      if (expectedCauseMessage !== undefined) {
        expect((err.cause as Error).message).toBe(expectedCauseMessage)
      }
    }
  }
}

describe("compress — error-path integration (Story 11.1)", () => {
  // --- 11.1-INT-001 (F#17) — sync-throwing CompressionService ----------------
  // Locks the analog of the `safeLog` precedent (Story 10.1-INT-013) for
  // CompressionService: a user-injected `compress` that throws synchronously
  // MUST surface as `PartUploadError` in the typed Effect error channel — never
  // as a fiber DEFECT. The wrapping happens at the `compress(...)` boundary so
  // chunkStream's `Stream.mapError` can turn it into PartUploadError(0, 0).
  it.effect(
    "11.1-INT-001 (F#17) — sync-throwing CompressionService surfaces as PartUploadError, no fiber DEFECT",
    () =>
      Effect.gen(function* () {
        const ThrowingLayer = Layer.succeed(CompressionService, {
          compress: () => {
            throw new Error("svc sync throw")
          },
        })
        const transform = yield* Effect.provide(compress("deflate-raw"), ThrowingLayer)
        const processed = transform(fromBytes(new Uint8Array(32).fill(7)))
        const exit = yield* Effect.exit(runUpload(processed))
        expectPartUploadError(exit, "svc sync throw")
      })
  )

  // --- 11.1-INT-002 (F#18) — happy path with CompressionServiceLive ----------
  // Confirms the Effect-typed pipeline + Live layer composes correctly through
  // the public `compress()` helper. Round-trips bytes via DecompressionStream
  // to verify actual compression occurred (not a no-op or identity).
  it.effect(
    "11.1-INT-002 (F#18) — Effect-typed pipeline with CompressionServiceLive round-trips through DecompressionStream",
    () =>
      Effect.gen(function* () {
        const original = new Uint8Array(64)
        for (let i = 0; i < original.length; i++) original[i] = i % 251
        const transform = yield* Effect.provide(compress("deflate-raw"), CompressionServiceLive)
        const processed = transform(fromBytes(original))
        const decompressed = processed.pipeThrough(
          new DecompressionStream("deflate-raw") as unknown as TransformStream<Uint8Array, Uint8Array>
        )
        const reader = decompressed.getReader()
        const chunks: Uint8Array[] = []
        while (true) {
          const { done, value } = yield* Effect.promise(() => reader.read())
          if (done) break
          chunks.push(value)
        }
        const total = chunks.reduce((acc, c) => acc + c.length, 0)
        const merged = new Uint8Array(total)
        let offset = 0
        for (const c of chunks) {
          merged.set(c, offset)
          offset += c.length
        }
        expect(merged.length).toBe(original.length)
        expect(Array.from(merged)).toEqual(Array.from(original))
      })
  )

  // --- 11.1-INT-003 (F#20) — absent globalThis.CompressionStream -------------
  // Real `CompressionServiceLive` with the global stripped at runtime. Locks
  // the F#20 contract at the *integration* level — Story 10's existing
  // `compress.test.ts:51` covers the *unit* level (Layer-stub failure path).
  describe("absent globalThis.CompressionStream", () => {
    beforeEach(() => {
      vi.stubGlobal("CompressionStream", undefined)
    })
    afterEach(() => {
      vi.unstubAllGlobals()
    })

    it.effect(
      "11.1-INT-003 (F#20) — CompressionServiceLive fails with typed CompressionUnavailableError (no defect)",
      () =>
        Effect.gen(function* () {
          const exit = yield* Effect.exit(
            Effect.provide(compress("deflate-raw"), CompressionServiceLive)
          )
          expect(Exit.isFailure(exit)).toBe(true)
          if (Exit.isFailure(exit)) {
            expect(Cause.dieOption(exit.cause)._tag).toBe("None")
            const failure = Cause.failureOption(exit.cause)
            expect(failure._tag).toBe("Some")
            if (failure._tag === "Some") {
              expect(failure.value).toBeInstanceOf(CompressionUnavailableError)
              expect(failure.value._tag).toBe("CompressionUnavailableError")
            }
          }
        })
    )
  })

  // --- 11.1-INT-004 / 11.1-INT-005 — parametrized F#71 sync / F#72 async -----
  // Both shapes normalize to PartUploadError(0, 0, cause). The async-reject
  // variant produces an erroring ReadableStream (deferred error on read) which
  // exercises the chunkStream `Stream.fromReadableStream` error path.
  describe.each([
    {
      id: "11.1-INT-004",
      fTag: "F#71",
      kind: "sync-throw" as const,
      label: "sync throw",
      makeService: (): { compress: CompressionService["Type"]["compress"] } => ({
        compress: () => {
          throw new Error("F#71 sync cause")
        },
      }),
      expectedMessage: "F#71 sync cause",
    },
    {
      id: "11.1-INT-005",
      fTag: "F#72",
      kind: "async-reject" as const,
      label: "async rejection (stream errors lazily)",
      makeService: (): { compress: CompressionService["Type"]["compress"] } => ({
        compress: () =>
          new ReadableStream<Uint8Array>({
            pull(ctrl) {
              ctrl.error(new Error("F#72 async cause"))
            },
          }),
      }),
      expectedMessage: "F#72 async cause",
    },
  ])("$id ($fTag) — $label", ({ id, fTag, makeService, expectedMessage }) => {
    it.effect(
      `${id} (${fTag}) — CompressionService failure normalizes to PartUploadError`,
      () =>
        Effect.gen(function* () {
          const TestLayer = Layer.succeed(CompressionService, makeService())
          const transform = yield* Effect.provide(compress("deflate-raw"), TestLayer)
          const processed = transform(fromBytes(new Uint8Array(32).fill(9)))
          const exit = yield* Effect.exit(runUpload(processed))
          expectPartUploadError(exit, expectedMessage)
        })
    )
  })

  // --- 11.1-INT-006 (F#73) — Worker-context polyfilled-undefined -------------
  // Some polyfill chains explicitly assign `CompressionStream = undefined` in
  // Worker scopes (instead of leaving the global undefined). The Live layer's
  // `typeof cs === "undefined"` check must catch both shapes. Parity test vs
  // 11.1-INT-003 — different mechanism (explicit assignment vs missing) but
  // same observable outcome.
  describe("Worker-context polyfilled-undefined CompressionStream", () => {
    let restore: PropertyDescriptor | undefined
    beforeEach(() => {
      restore = Object.getOwnPropertyDescriptor(globalThis, "CompressionStream")
      Object.defineProperty(globalThis, "CompressionStream", {
        value: undefined,
        configurable: true,
        writable: true,
      })
    })
    afterEach(() => {
      if (restore !== undefined) {
        Object.defineProperty(globalThis, "CompressionStream", restore)
      } else {
        delete (globalThis as { CompressionStream?: unknown }).CompressionStream
      }
    })

    it.effect(
      "11.1-INT-006 (F#73) — polyfilled-undefined CompressionStream surfaces typed CompressionUnavailableError (Worker parity)",
      () =>
        Effect.gen(function* () {
          // Confirm the setup actually wrote `undefined` rather than removing.
          expect(
            Object.prototype.hasOwnProperty.call(globalThis, "CompressionStream")
          ).toBe(true)
          expect(
            (globalThis as { CompressionStream?: unknown }).CompressionStream
          ).toBeUndefined()

          const exit = yield* Effect.exit(
            Effect.provide(compress("deflate-raw"), CompressionServiceLive)
          )
          expect(Exit.isFailure(exit)).toBe(true)
          if (Exit.isFailure(exit)) {
            expect(Cause.dieOption(exit.cause)._tag).toBe("None")
            const failure = Cause.failureOption(exit.cause)
            expect(failure._tag).toBe("Some")
            if (failure._tag === "Some") {
              expect(failure.value).toBeInstanceOf(CompressionUnavailableError)
              expect(failure.value._tag).toBe("CompressionUnavailableError")
            }
          }
        })
    )
  })
})
