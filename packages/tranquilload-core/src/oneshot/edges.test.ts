import { describe, expect, it } from "@effect/vitest"
import { Cause, Effect, Exit } from "effect"
import { AbortError, CompleteUploadError } from "../errors/upload-error.js"
import { uploadOnce } from "./index.js"
import type { UploadCompleted, UploadEvent } from "../progress/upload-event.js"

// Helper: read all events from the ReadableStream returned by uploadOnce.
const readAllEvents = async <T>(rs: ReadableStream<T>): Promise<T[]> => {
  const reader = rs.getReader()
  const out: T[] = []
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    out.push(value)
  }
  return out
}

// Helper: ReadableStream that emits a single chunk then closes.
const fromBytes = (bytes: Uint8Array): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start(c) {
      c.enqueue(bytes)
      c.close()
    },
  })

// Helper: ReadableStream that closes immediately, no bytes.
const emptyStream = (): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start(c) {
      c.close()
    },
  })

describe("uploadOnce — one-shot edges (Story 11.6)", () => {
  // --- 11.6-INT-010 (F#37) — one-shot abort mid-stream -----------------------
  // The upload callback starts reading the stream, then a *mid-flight* abort
  // signal interrupts the orchestration fiber via `Effect.raceFirst` against
  // `fromAbortSignal`. `result` rejects with AbortError. The `events` stream
  // closes cleanly (no events emitted, no error surfaced through it — errors
  // surface via `result` only, per the public API contract).
  it.effect(
    "11.6-INT-010 (F#37) — abort mid-stream: result rejects with AbortError, events closes cleanly",
    () =>
      Effect.gen(function* () {
        const controller = new AbortController()

        const { events, result } = uploadOnce({
          stream: fromBytes(new Uint8Array(16).fill(1)),
          upload: async (stream) => {
            // Start consuming, then trigger mid-stream abort.
            const reader = stream.getReader()
            await reader.read()
            controller.abort()
            // Never resolve — let the abort race win.
            await new Promise<void>(() => {})
          },
          signal: controller.signal,
        })

        // events closes cleanly — no items, no thrown error.
        const evts = yield* Effect.promise(() => readAllEvents(events))
        expect(evts).toEqual([])

        // result rejects with AbortError (the typed surface).
        const exit = yield* Effect.exit(
          Effect.tryPromise({ try: () => result, catch: (e) => e }),
        )
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          const failure = Cause.failureOption(exit.cause)
          expect(failure._tag).toBe("Some")
          if (failure._tag === "Some") {
            expect(failure.value).toBeInstanceOf(AbortError)
            expect((failure.value as AbortError)._tag).toBe("AbortError")
          }
        }
      }),
  )

  // --- 11.6-INT-011 (F#38) — one-shot server 4xx → CompleteUploadError -------
  // The upload callback rejects with a server-like error (4xx). `uploadOnce`
  // wraps any non-AbortError failure in `CompleteUploadError(cause)`. The lock
  // is: `cause === <original error>` so callers can match on the upstream
  // error type when needed.
  it.effect(
    "11.6-INT-011 (F#38) — upload callback rejects with 4xx: CompleteUploadError, cause preserved",
    () =>
      Effect.gen(function* () {
        const cause = new Error("HTTP 403 Forbidden")

        const { events, result } = uploadOnce({
          stream: fromBytes(new Uint8Array(8).fill(1)),
          upload: () => Promise.reject(cause),
        })

        // events closes cleanly even on failure.
        const evts = yield* Effect.promise(() => readAllEvents(events))
        expect(evts).toEqual([])

        const exit = yield* Effect.exit(
          Effect.tryPromise({ try: () => result, catch: (e) => e }),
        )
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          const failure = Cause.failureOption(exit.cause)
          expect(failure._tag).toBe("Some")
          if (failure._tag === "Some") {
            expect(failure.value).toBeInstanceOf(CompleteUploadError)
            expect((failure.value as CompleteUploadError)._tag).toBe(
              "CompleteUploadError",
            )
            expect((failure.value as CompleteUploadError).cause).toBe(cause)
          }
        }
      }),
  )

  // --- 11.6-INT-012 (F#39) — one-shot empty stream ---------------------------
  // Empty source stream → the upload callback receives a stream that yields no
  // bytes. The lib treats this as a successful one-shot: UploadCompleted is
  // emitted with `totalParts: 1` (the hardcoded one-shot semantic — there is
  // exactly one PUT regardless of byte count). Locks current behaviour; a
  // future refinement to reject empty one-shots is an Epic 13 candidate.
  it.effect(
    "11.6-INT-012 (F#39) — empty stream: UploadCompleted emitted with totalParts=1 (locks current behaviour)",
    () =>
      Effect.gen(function* () {
        let uploadCallbackInvocations = 0
        let bytesObserved = 0

        const { events, result } = uploadOnce({
          stream: emptyStream(),
          upload: async (stream) => {
            uploadCallbackInvocations++
            const reader = stream.getReader()
            while (true) {
              const { done, value } = await reader.read()
              if (done) break
              bytesObserved += value.length
            }
          },
        })

        const [evts, res] = yield* Effect.all([
          Effect.promise(() => readAllEvents(events)),
          Effect.promise(() => result),
        ])

        // Upload callback invoked exactly once with an empty stream.
        expect(uploadCallbackInvocations).toBe(1)
        expect(bytesObserved).toBe(0)

        // Single UploadCompleted with the hardcoded totalParts=1.
        expect(evts).toHaveLength(1)
        const evt = evts[0] as UploadEvent
        expect(evt._tag).toBe("UploadCompleted")
        expect((evt as UploadCompleted).totalParts).toBe(1)

        // result === the same UploadCompleted reference.
        expect(res).toBe(evt)
      }),
  )
})
