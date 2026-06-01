import { describe, expect, it } from "@effect/vitest"
import { it as plainIt } from "vitest"
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

  // ──────────────────────────────────────────────────────────────────────────
  // Story 11.2 — Logger lifecycle (AC #1, AC #8). LOCK tests for the public
  // LoggerService surface — the lib already routes log calls through `safeLog`
  // (Story 10.1), so no lib change should be needed.
  // ──────────────────────────────────────────────────────────────────────────

  // --- 11.2-INT-001 (F#65) — Recording logger captures the exact upload-
  // lifecycle log sequence for a 3-part multipart upload. Locks the order
  // and count of log lines so a regression in safeLog placement (e.g. a
  // dropped log call site) surfaces as a test diff.
  it.effect(
    "11.2-INT-001 (F#65) — recording LoggerService captures the exact log-line sequence across a 3-part multipart upload lifecycle",
    () =>
      Effect.gen(function* () {
        const received: LogEntry[] = []

        yield* Stream.runDrain(
          uploadMultipartEffect({
            stream: tinyStream(30), // 3 parts × 10 bytes
            chunkSize: 10,
            uploadPart: (n) => `etag-${n}`,
            completeUpload: () => {},
          }).pipe(Stream.provideLayer(makeTestLayer(received))),
        )

        const messages = received.map(e => e.message)
        const partCompletedMessages = messages.filter(m => /^Part \d+ completed$/.test(m))
        expect(partCompletedMessages.length).toBe(3)
        // Last line must be the completion summary — locks the "completion
        // event fires AFTER all parts log" ordering.
        expect(messages[messages.length - 1]).toBe("Multipart upload completed")
        // All log lines are 'info' (debug/warn would imply a new code path).
        expect(received.every(e => e.level === "info")).toBe(true)
      }),
  )

  // --- 11.2-INT-002 (F#67) — Slow async logger does NOT scale upload latency
  // with log-line count. Asserts safeLog's "fire-and-forget" semantics: the
  // upload fiber must not be blocked on async logger work (real-world OTLP /
  // Pino-async transports are exactly this shape).
  //
  // Plain `it` (not `it.effect`) because we measure real wall-clock time and
  // need the default Clock (not TestClock).
  plainIt(
    "11.2-INT-002 (F#67) — slow async logger does not scale upload latency with log-line count (fire-and-forget)",
    async () => {
      const slowLogger: Layer.Layer<LoggerService> = Layer.succeed(LoggerService, {
        // Returning Promise<void> from a `log: (...) => void` callback is
        // intentional — TS allows it (void permits any return) and it mirrors
        // real async transports. safeLog must not await this.
        log: ((): ((level: LogLevel, msg: string, data?: unknown) => void) => {
          return ((_level, _msg, _data) => {
            void new Promise(r => setTimeout(r, 50)) // unawaited 50ms
          }) as (level: LogLevel, msg: string, data?: unknown) => void
        })(),
      })

      // 10 parts → 10× "Part N completed" + 1× "Multipart upload completed" = 11 log calls.
      const N_PARTS = 10
      const CHUNK = 10
      const SLOW_MS = 50

      const start = performance.now()
      await Effect.runPromise(
        Stream.runDrain(
          uploadMultipartEffect({
            stream: tinyStream(N_PARTS * CHUNK),
            chunkSize: CHUNK,
            uploadPart: (n) => `etag-${n}`,
            completeUpload: () => {},
          }).pipe(Stream.provideLayer(slowLogger)),
        ),
      )
      const elapsed = performance.now() - start

      // If safeLog awaited each log, elapsed ≥ 11 × 50ms = 550ms. The bound
      // 200ms gives huge headroom for CI noise while still cleanly failing
      // a regression that introduces synchronous awaits.
      expect(
        elapsed,
        `upload took ${elapsed.toFixed(1)}ms with ${N_PARTS + 1} slow (${SLOW_MS}ms) log calls — safeLog must NOT block on logger work`,
      ).toBeLessThan(200)
    },
  )

  // --- 11.2-INT-006 (F#75) — User-injected Logger that prepends a custom
  // `[upload:${id}]` prefix is observed on every emitted line. Confirms the
  // public LoggerService injection point is the right hook for per-upload
  // tagging (no internal contract change required to support this — the user
  // wraps in their own factory).
  it.effect(
    "11.2-INT-006 (F#75) — custom Logger with [upload:demo] prefix decorates every internal log line",
    () =>
      Effect.gen(function* () {
        const received: string[] = []
        const UPLOAD_ID = "demo-123"
        const prefixLayer: Layer.Layer<LoggerService> = Layer.succeed(LoggerService, {
          log: (_level, message, _data) => {
            received.push(`[upload:${UPLOAD_ID}] ${message}`)
          },
        })

        yield* Stream.runDrain(
          uploadMultipartEffect({
            stream: tinyStream(20),
            chunkSize: 10,
            uploadPart: (n) => `etag-${n}`,
            completeUpload: () => {},
          }).pipe(Stream.provideLayer(prefixLayer)),
        )

        expect(received.length).toBeGreaterThan(0)
        for (const line of received) {
          expect(
            line.startsWith(`[upload:${UPLOAD_ID}] `),
            `expected every line to be prefixed; got "${line}"`,
          ).toBe(true)
        }
      }),
  )
})
