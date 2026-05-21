import { it, describe, expect } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { LoggerService, LoggerServiceLive, type LogLevel } from "./logger-service.js"

describe("LoggerService", () => {
  it.effect("F#64 — LoggerServiceLive is a no-op (produces zero output) (default logger is silent)", () =>
    Effect.gen(function* () {
      const logger = yield* LoggerService
      expect(() => logger.log("info", "test message", { key: "value" })).not.toThrow()
      expect(() => logger.log("debug", "debug msg")).not.toThrow()
      expect(() => logger.log("warn", "warn msg")).not.toThrow()
      expect(() => logger.log("error", "error msg")).not.toThrow()
    }).pipe(Effect.provide(LoggerServiceLive))
  )

  it.effect("F#65, F#75 — custom LoggerService Layer receives structured log entries (user-injected logger)", () =>
    Effect.gen(function* () {
      const received: Array<{ level: LogLevel; message: string; data?: unknown }> = []

      const TestLayer: Layer.Layer<LoggerService> = Layer.succeed(LoggerService, {
        log: (level: LogLevel, message: string, data?: unknown): void => {
          received.push({ level, message, data })
        },
      })

      yield* Effect.provide(
        Effect.gen(function* () {
          const logger = yield* LoggerService
          logger.log("info", "part completed", { partNumber: 1 })
          logger.log("warn", "retry attempt", { attempt: 2 })
        }),
        TestLayer
      )

      expect(received).toHaveLength(2)
      expect(received[0]).toEqual({ level: "info", message: "part completed", data: { partNumber: 1 } })
      expect(received[1]).toEqual({ level: "warn", message: "retry attempt", data: { attempt: 2 } })
    })
  )
})
