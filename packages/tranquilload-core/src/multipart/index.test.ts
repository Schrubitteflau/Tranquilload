import { describe, expect, it } from "@effect/vitest"
import { Cause, Effect, Exit, Option } from "effect"
import { afterEach, vi } from "vitest"
import { AbortError, CompleteUploadError, InitiateUploadError } from "../errors/upload-error.js"
import { compress } from "../pipeline/compress.js"
import { compose, type Transform } from "../pipeline/middleware.js"
import { uploadMultipart, type ResumeState } from "./index.js"
import { uploadMultipartEffect } from "./upload-stream.js"

afterEach(() => {
  vi.restoreAllMocks()
})

// Helper: create a ReadableStream from a Uint8Array
const fromBytes = (bytes: Uint8Array): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start(c) {
      c.enqueue(bytes)
      c.close()
    },
  })

// Helper: read all events from the ReadableStream
const readAllEvents = async <T>(rs: ReadableStream<T>): Promise<T[]> => {
  const reader = rs.getReader()
  const events: T[] = []
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    events.push(value)
  }
  return events
}

describe("uploadMultipart — Dual API entry point", () => {
  it.effect("happy path: result resolves with UploadCompleted, events contains all events", () =>
    Effect.gen(function* () {
      const { result, events } = uploadMultipart({
        stream: fromBytes(new Uint8Array(20).fill(1)),
        chunkSize: 10,
        uploadPart: (n) => `etag-${n}`,
        completeUpload: () => {},
      })

      const [uploadResult, evts] = yield* Effect.all([
        Effect.promise(() => result),
        Effect.promise(() => readAllEvents(events)),
      ])

      expect(uploadResult._tag).toBe("UploadCompleted")
      expect(uploadResult.totalParts).toBe(2)

      const partEvents = evts.filter((e) => e._tag === "PartCompleted")
      expect(partEvents).toHaveLength(2)
      expect(evts.find((e) => e._tag === "UploadCompleted")).toBeDefined()
    })
  )

  it.effect("getProgress tracks bytesUploaded; totalBytes is Some when provided", () =>
    Effect.gen(function* () {
      const { result, getProgress } = uploadMultipart({
        stream: fromBytes(new Uint8Array(30).fill(1)),
        chunkSize: 10,
        uploadPart: () => "etag",
        completeUpload: () => {},
        totalBytes: 30,
      })

      yield* Effect.promise(() => result)

      const progress = yield* Effect.promise(() => getProgress())
      expect(progress.bytesUploaded).toBe(30)
      expect(progress.totalBytes).toEqual(Option.some(30))
    })
  )

  it.effect("getProgress returns None for totalBytes when not provided", () =>
    Effect.gen(function* () {
      const { result, getProgress } = uploadMultipart({
        stream: fromBytes(new Uint8Array(10).fill(1)),
        chunkSize: 10,
        uploadPart: () => "etag",
        completeUpload: () => {},
      })

      yield* Effect.promise(() => result)

      const progress = yield* Effect.promise(() => getProgress())
      expect(progress.totalBytes).toEqual(Option.none())
    })
  )

  it.effect("abort signal: result rejects with AbortError, events stream closes cleanly", () =>
    Effect.gen(function* () {
      const controller = new AbortController()
      const { result, events } = uploadMultipart({
        stream: fromBytes(new Uint8Array(10).fill(1)),
        chunkSize: 10,
        uploadPart: () =>
          new Promise<string>((_resolve) => {
            setTimeout(() => controller.abort(), 5)
          }),
        completeUpload: () => {},
        signal: controller.signal,
      })

      // result rejects with AbortError
      const resultExit = yield* Effect.exit(
        Effect.tryPromise({
          try: () => result,
          catch: (e) => e,
        })
      )
      expect(Exit.isFailure(resultExit)).toBe(true)
      if (Exit.isFailure(resultExit)) {
        const errOption = Cause.failureOption(resultExit.cause)
        expect(errOption._tag).toBe("Some")
        const err = (errOption as { _tag: "Some"; value: unknown }).value
        expect(err).toBeInstanceOf(AbortError)
        expect((err as AbortError)._tag).toBe("AbortError")
      }

      // events ReadableStream closes cleanly (no throw)
      const evts = yield* Effect.promise(() => readAllEvents(events))
      // Stream should close without throwing — length may be 0 (aborted before any parts complete)
      expect(Array.isArray(evts)).toBe(true)
    })
  )

  it(".effect property points to uploadMultipartEffect", () => {
    expect(uploadMultipart.effect).toBe(uploadMultipartEffect)
  })

  it.effect("applies plain Transform pipeline before chunking (data reaches uploadPart transformed)", () =>
    Effect.gen(function* () {
      const received: Uint8Array[] = []
      // Transform: replace every byte with 0xAA
      const markerTransform: Transform = (stream) =>
        stream.pipeThrough(
          new TransformStream<Uint8Array, Uint8Array>({
            transform(chunk, controller) {
              controller.enqueue(new Uint8Array(chunk.length).fill(0xaa))
            },
          })
        )

      const { result } = uploadMultipart({
        stream: new ReadableStream({
          start(c) { c.enqueue(new Uint8Array([1, 2, 3])); c.close() },
        }),
        chunkSize: 3,
        pipeline: markerTransform,
        uploadPart: (_, chunk) => {
          received.push(chunk)
          return "etag-1"
        },
        completeUpload: () => {},
      })

      yield* Effect.promise(() => result)
      expect(received).toHaveLength(1)
      expect(Array.from(received[0]!)).toEqual([0xaa, 0xaa, 0xaa])
    })
  )

  it.effect("applies Effect pipeline (compress) before chunking — PartCompleted.bytesUploaded reflects compressed size", () =>
    Effect.gen(function* () {
      const received: Uint8Array[] = []
      const original = new Uint8Array([1, 2, 3, 4, 5])

      const { result } = uploadMultipart({
        stream: new ReadableStream({
          start(c) { c.enqueue(original); c.close() },
        }),
        chunkSize: 4096, // large enough to receive all compressed output in one part
        pipeline: compress("deflate-raw"),
        uploadPart: (_, chunk) => {
          received.push(chunk)
          return "etag-1"
        },
        completeUpload: () => {},
      })

      yield* Effect.promise(() => result)
      expect(received).toHaveLength(1)
      // Compressed output is non-empty
      expect(received[0]!.length).toBeGreaterThan(0)
      // Compressed bytes differ from raw input
      expect(Array.from(received[0]!)).not.toEqual(Array.from(original))
    })
  )

  it.effect("compose(compress()) can be passed as pipeline — same as compress() directly", () =>
    Effect.gen(function* () {
      const received: Uint8Array[] = []

      const { result } = uploadMultipart({
        stream: new ReadableStream({
          start(c) { c.enqueue(new Uint8Array([10, 20, 30])); c.close() },
        }),
        chunkSize: 4096,
        pipeline: compose(compress("deflate-raw")),
        uploadPart: (_, chunk) => {
          received.push(chunk)
          return "etag-1"
        },
        completeUpload: () => {},
      })

      yield* Effect.promise(() => result)
      expect(received).toHaveLength(1)
      expect(received[0]!.length).toBeGreaterThan(0)
    })
  )

  it.effect("initiate callback: UploadInitiated event emitted first, uploadId resolves to correct value", () =>
    Effect.gen(function* () {
      const { result, events, uploadId } = uploadMultipart({
        stream: fromBytes(new Uint8Array(10).fill(1)),
        chunkSize: 10,
        initiate: () => Promise.resolve({ uploadId: "upload-abc-123" }),
        uploadPart: () => "etag-1",
        completeUpload: (uid, _parts) => {
          expect(uid).toBe("upload-abc-123")
        },
      })

      yield* Effect.promise(() => result)
      const resolvedId = yield* Effect.promise(() => uploadId)
      expect(resolvedId).toBe("upload-abc-123")

      const evts = yield* Effect.promise(() => readAllEvents(events))
      const initiatedEvent = evts.find(e => e._tag === "UploadInitiated")
      expect(initiatedEvent).toMatchObject({ _tag: "UploadInitiated", uploadId: "upload-abc-123" })
      expect(evts[0]!._tag).toBe("UploadInitiated")

      const completedEvent = evts.find(e => e._tag === "UploadCompleted")
      expect(completedEvent).toMatchObject({ _tag: "UploadCompleted", uploadId: "upload-abc-123" })
    })
  )

  it.effect("no initiate: no UploadInitiated event, uploadId resolves to empty string", () =>
    Effect.gen(function* () {
      const { result, events, uploadId } = uploadMultipart({
        stream: fromBytes(new Uint8Array(10).fill(1)),
        chunkSize: 10,
        uploadPart: () => "etag-1",
        completeUpload: () => {},
      })

      yield* Effect.promise(() => result)
      const resolvedId = yield* Effect.promise(() => uploadId)
      expect(resolvedId).toBe("")

      const evts = yield* Effect.promise(() => readAllEvents(events))
      expect(evts.find(e => e._tag === "UploadInitiated")).toBeUndefined()
    })
  )

  it.effect("initiate failure: result rejects with InitiateUploadError, uploadId resolves to empty string", () =>
    Effect.gen(function* () {
      const cause = new Error("initiation failed")
      const { result, uploadId } = uploadMultipart({
        stream: fromBytes(new Uint8Array(10).fill(1)),
        chunkSize: 10,
        initiate: () => { throw cause },
        uploadPart: () => "etag-1",
        completeUpload: () => {},
      })

      const resultExit = yield* Effect.exit(
        Effect.tryPromise({
          try: () => result,
          catch: (e) => e,
        })
      )
      expect(Exit.isFailure(resultExit)).toBe(true)
      if (Exit.isFailure(resultExit)) {
        const err = (Cause.failureOption(resultExit.cause) as { _tag: "Some"; value: unknown }).value
        expect(err).toBeInstanceOf(InitiateUploadError)
        expect((err as InitiateUploadError).cause).toBe(cause)
      }

      const resolvedId = yield* Effect.promise(() => uploadId)
      expect(resolvedId).toBe("")
    })
  )
})

describe("uploadMultipart — resumeState surface", () => {
  it.effect("resumeState resolves with correct shape on fresh init (no digest)", () =>
    Effect.gen(function* () {
      const { result, resumeState } = uploadMultipart({
        stream: fromBytes(new Uint8Array(10).fill(1)),
        chunkSize: 10,
        initiate: () => ({ uploadId: "fresh-up-1" }),
        pipelineIdentity: "ident-1",
        uploadPart: () => "etag-1",
        completeUpload: () => {},
      })

      yield* Effect.promise(() => result)
      const state = yield* Effect.promise(() => resumeState)
      expect(state).toEqual({
        version: 1,
        uploadId: "fresh-up-1",
        chunkSize: 10,
        pipelineIdentity: "ident-1",
        contentDigestCaptured: false,
      })
    })
  )

  it.effect("resumeState includes contentDigest when getContentDigest is provided (fresh init)", () =>
    Effect.gen(function* () {
      const { result, resumeState } = uploadMultipart({
        stream: fromBytes(new Uint8Array(10).fill(1)),
        chunkSize: 10,
        initiate: () => ({ uploadId: "fresh-up-2" }),
        getContentDigest: () => "digest-xyz",
        uploadPart: () => "etag-1",
        completeUpload: () => {},
      })

      yield* Effect.promise(() => result)
      const state = yield* Effect.promise(() => resumeState)
      expect(state).toMatchObject({
        version: 1,
        uploadId: "fresh-up-2",
        contentDigest: "digest-xyz",
        contentDigestCaptured: true,
      })
    })
  )

  it.effect("resumeState resolves with the passed resumeFrom shape on resume", () =>
    Effect.gen(function* () {
      const passed: ResumeState = {
        version: 1,
        uploadId: "stored-up-1",
        chunkSize: 10,
        contentDigestCaptured: false,
      }
      const { result, resumeState, uploadId } = uploadMultipart({
        stream: fromBytes(new Uint8Array(10).fill(1)),
        chunkSize: 10,
        uploadPart: () => "etag-1",
        completeUpload: () => {},
        resumeFrom: passed,
      })

      // uploadId resolves synchronously (AC22) — no need to await `result`
      const id = yield* Effect.promise(() => uploadId)
      expect(id).toBe("stored-up-1")

      yield* Effect.promise(() => result)
      const state = yield* Effect.promise(() => resumeState)
      expect(state).toBe(passed)
    })
  )
})

describe("uploadMultipart — legacy-pattern warn", () => {
  it("warns once when initiate + reconcile + no resumeFrom (AC16)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})

    const { result } = uploadMultipart({
      stream: fromBytes(new Uint8Array(10).fill(1)),
      chunkSize: 10,
      initiate: () => ({ uploadId: "u-1" }),
      reconcileCompletedParts: () => [{ partNumber: 1, etag: "etag-1" }],
      uploadPart: () => "should-not-be-called",
      completeUpload: () => {},
    })
    await result

    const legacyWarns = warnSpy.mock.calls.filter((c) =>
      typeof c[0] === "string" && c[0].startsWith("Tranquilload: detected legacy resume pattern")
    )
    expect(legacyWarns).toHaveLength(1)
  })

  it("does NOT warn when resumeFrom is provided alongside initiate + reconcile (AC17)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})

    const { result } = uploadMultipart({
      stream: fromBytes(new Uint8Array(10).fill(1)),
      chunkSize: 10,
      initiate: () => ({ uploadId: "ignored" }),
      reconcileCompletedParts: () => [{ partNumber: 1, etag: "etag-1" }],
      uploadPart: () => "should-not-be-called",
      completeUpload: () => {},
      resumeFrom: {
        version: 1,
        uploadId: "stored",
        chunkSize: 10,
        contentDigestCaptured: false,
      },
    })
    await result

    const legacyWarns = warnSpy.mock.calls.filter((c) =>
      typeof c[0] === "string" && c[0].startsWith("Tranquilload: detected legacy resume pattern")
    )
    expect(legacyWarns).toHaveLength(0)
  })

  it("warns even when reconcileCompletedParts returns an empty array (AC18)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})

    const { result } = uploadMultipart({
      stream: fromBytes(new Uint8Array(10).fill(1)),
      chunkSize: 10,
      initiate: () => ({ uploadId: "u-1" }),
      reconcileCompletedParts: () => [],
      uploadPart: () => "etag-1",
      completeUpload: () => {},
    })
    await result

    const legacyWarns = warnSpy.mock.calls.filter((c) =>
      typeof c[0] === "string" && c[0].startsWith("Tranquilload: detected legacy resume pattern")
    )
    expect(legacyWarns).toHaveLength(1)
  })

  it("warns when pipeline is set without pipelineIdentity (AC24)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})

    const noopTransform: Transform = (stream) => stream

    const { result } = uploadMultipart({
      stream: fromBytes(new Uint8Array(10).fill(1)),
      chunkSize: 10,
      pipeline: noopTransform,
      uploadPart: () => "etag-1",
      completeUpload: () => {},
    })
    await result

    const identityWarns = warnSpy.mock.calls.filter((c) =>
      typeof c[0] === "string" && c[0].includes("pipeline is set but pipelineIdentity is not")
    )
    expect(identityWarns).toHaveLength(1)
  })
})
