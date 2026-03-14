import { Context, Layer } from "effect"

export type LogLevel = "debug" | "info" | "warn" | "error"

export class LoggerService extends Context.Tag("@tranquilload/LoggerService")<
  LoggerService,
  { readonly log: (level: LogLevel, message: string, data?: unknown) => void }
>() {}

export const LoggerServiceLive: Layer.Layer<LoggerService> = Layer.succeed(
  LoggerService,
  {
    log: (_level: LogLevel, _message: string, _data?: unknown): void => {
      // intentional no-op
    },
  }
)
