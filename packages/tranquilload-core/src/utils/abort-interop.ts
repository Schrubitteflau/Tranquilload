import { Effect } from "effect"
import { AbortError } from "../errors/upload-error.js"

export const fromAbortSignal = (signal?: AbortSignal): Effect.Effect<never, AbortError> =>
  Effect.async<never, AbortError>((resume) => {
    if (!signal) return
    if (signal.aborted) {
      resume(Effect.fail(new AbortError()))
      return
    }
    const handler = (): void => resume(Effect.fail(new AbortError()))
    signal.addEventListener("abort", handler, { once: true })
    return Effect.sync(() => signal.removeEventListener("abort", handler))
  })
