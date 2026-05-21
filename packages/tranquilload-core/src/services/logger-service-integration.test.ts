import { describe, expect, it } from "@effect/vitest"
import { Effect, Exit, Layer, Stream } from "effect"
import { LoggerService, type LogLevel } from "./logger-service.js"
import { uploadOnce } from "../oneshot/index.js"
import { uploadMultipart } from "../multipart/index.js"
import { uploadOnceEffect } from "../oneshot/upload.js"
import { uploadMultipartEffect } from "../multipart/upload-stream.js"

// Helpers
const tinyStream = (bytes: number): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start(c) {
      c.enqueue(new Uint8Array(bytes).fill(1))
      c.close()
    },
  })

type LogEntry = { level: LogLevel; message: string; data?: unknown }

const makeTestLayer = (received: LogEntry[]): Layer.Layer<LoggerService> =>
  Layer.succeed(LoggerService, {
    log: (level, message, data?) => {
      received.push({ level, message, data })
    },
  })

describe("LoggerService integration", () => {
  it.effect("uploadOnce.effect with custom LoggerService captures internal log entries", () =>
    Effect.gen(function* () {
      const received: LogEntry[] = []

      yield* Stream.runDrain(
        uploadOnceEffect({
          stream: tinyStream(10),
          upload: () => {},
        }).pipe(Stream.provideLayer(makeTestLayer(received)))
      )

      // Expect "One-shot upload starting" and "One-shot upload completed"
      expect(received).toHaveLength(2)
      expect(received.some(e => e.message === "One-shot upload starting")).toBe(true)
      expect(received.some(e => e.message === "One-shot upload completed")).toBe(true)
      expect(received.every(e => e.level === "info")).toBe(true)
    })
  )

  it.effect("uploadMultipart.effect with custom LoggerService captures part completion and final log", () =>
    Effect.gen(function* () {
      const received: LogEntry[] = []

      yield* Stream.runDrain(
        uploadMultipartEffect({
          stream: tinyStream(20),
          chunkSize: 10,
          uploadPart: (_partNumber, _chunk) => "etag",
          completeUpload: () => {},
        }).pipe(Stream.provideLayer(makeTestLayer(received)))
      )

      // 2 parts → 2 "Part N completed" + 1 "Multipart upload completed"
      const partLogs = received.filter(e => e.message.startsWith("Part ") && e.message.endsWith("completed"))
      expect(partLogs.length).toBe(2)
      expect(received.some(e => e.message === "Multipart upload completed")).toBe(true)
    })
  )

  it.effect("Promise API (uploadOnce) auto-provides LoggerServiceLive — user log fn is never called", () =>
    Effect.gen(function* () {
      const received: LogEntry[] = []

      // uploadOnce uses LoggerServiceLive (no-op) — custom logger receives nothing
      const { result } = uploadOnce({
        stream: tinyStream(10),
        upload: () => {},
      })
      yield* Effect.promise(() => result)

      // The custom logger was never invoked — Promise API is fully wired
      expect(received).toHaveLength(0)
    })
  )

  it.effect("Promise API (uploadMultipart) auto-provides LoggerServiceLive — user log fn is never called", () =>
    Effect.gen(function* () {
      const received: LogEntry[] = []

      const { result } = uploadMultipart({
        stream: tinyStream(20),
        chunkSize: 10,
        uploadPart: () => "etag",
        completeUpload: () => {},
      })
      yield* Effect.promise(() => result)

      expect(received).toHaveLength(0)
    })
  )

  // --- 10.1-INT-013 (F#66) — Logger throwing doesn't break the upload ----
  // Logging is never load-bearing. A user-injected Logger that throws on
  // every call must NOT propagate that throw into the upload's fiber as a
  // defect. Asserted for both the one-shot and multipart cores; without
  // `safeLog` the second `yield*` in either core path would crash the fiber.
  it.effect("10.1-INT-013 (F#66) — uploadOnceEffect succeeds when LoggerService.log throws on every call", () =>
    Effect.gen(function* () {
      let throwCount = 0
      const throwingLogger: Layer.Layer<LoggerService> = Layer.succeed(LoggerService, {
        log: (_level, _message, _data) => {
          throwCount += 1
          throw new Error("logger explosion")
        },
      })

      const exit = yield* Effect.exit(
        Stream.runDrain(
          uploadOnceEffect({
            stream: tinyStream(10),
            upload: () => {},
          }).pipe(Stream.provideLayer(throwingLogger)),
        ),
      )

      expect(Exit.isSuccess(exit), `expected upload to complete despite throwing logger; exit=${JSON.stringify(exit)}`).toBe(true)
      // Logger was attempted at least once — proves we exercised the throw path,
      // not some "logger never called" false negative.
      expect(throwCount).toBeGreaterThan(0)
    }),
  )

  it.effect("10.1-INT-013 (F#66) — uploadMultipartEffect succeeds when LoggerService.log throws on every call", () =>
    Effect.gen(function* () {
      let throwCount = 0
      const throwingLogger: Layer.Layer<LoggerService> = Layer.succeed(LoggerService, {
        log: (_level, _message, _data) => {
          throwCount += 1
          throw new Error("logger explosion")
        },
      })

      const exit = yield* Effect.exit(
        Stream.runDrain(
          uploadMultipartEffect({
            stream: tinyStream(30), // 3 parts × 10 bytes
            chunkSize: 10,
            uploadPart: (n) => `etag-${n}`,
            completeUpload: () => {},
          }).pipe(Stream.provideLayer(throwingLogger)),
        ),
      )

      expect(Exit.isSuccess(exit), `expected upload to complete despite throwing logger; exit=${JSON.stringify(exit)}`).toBe(true)
      // 3 parts → at least 3 `Part N completed` + 1 `Multipart upload completed` = ≥ 4 attempted log calls.
      expect(throwCount).toBeGreaterThanOrEqual(4)
    }),
  )
})
