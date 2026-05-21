import { Context, Effect, Layer } from "effect"

export type LogLevel = "debug" | "info" | "warn" | "error"

export interface Logger {
  readonly log: (level: LogLevel, message: string, data?: unknown) => void
}

export class LoggerService extends Context.Tag("@tranquilload/LoggerService")<
  LoggerService,
  Logger
>() {}

export const LoggerServiceLive: Layer.Layer<LoggerService> = Layer.succeed(
  LoggerService,
  {
    log: (_level: LogLevel, _message: string, _data?: unknown): void => {
      // intentional no-op
    },
  }
)

/**
 * Logging is never load-bearing — a user-injected `Logger` that throws must
 * NOT break the upload (F#66, Story 10.1-INT-013). Wrap every `logger.log`
 * call site in this helper to absorb throws into the void.
 *
 * `Effect.try` puts the throw into the error channel; `Effect.ignore`
 * discards both success and error and yields `Effect<void, never, never>`.
 */
export const safeLog = (
  logger: Logger,
  level: LogLevel,
  message: string,
  data?: unknown,
): Effect.Effect<void> =>
  Effect.ignore(Effect.try(() => logger.log(level, message, data)))
