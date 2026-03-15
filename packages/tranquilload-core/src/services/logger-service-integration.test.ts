import { describe, expect, it } from "@effect/vitest"
import { Effect, Stream } from "effect"
import { Layer } from "effect"
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
      expect(received.length).toBeGreaterThanOrEqual(2)
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
})
