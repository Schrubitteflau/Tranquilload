import { describe, expect, it } from "@effect/vitest"
import { Effect, Option } from "effect"
import { uploadMultipart, type Progress } from "../multipart/index.js"

// Helper: create a ReadableStream from repeated chunks with a delay
const slowStream = (chunkCount: number, chunkSize: number): ReadableStream<Uint8Array> =>
  new ReadableStream({
    async start(controller) {
      for (let i = 0; i < chunkCount; i++) {
        controller.enqueue(new Uint8Array(chunkSize).fill(i))
        await new Promise((r) => setTimeout(r, 5))
      }
      controller.close()
    },
  })

describe("getProgress()", () => {
  it.effect("getProgress() returns increasing bytesUploaded during an in-progress upload", () =>
    Effect.gen(function* () {
      let snapshotDuringUpload: Progress | null = null

      const { result, getProgress } = uploadMultipart({
        stream: slowStream(3, 10), // 3 parts × 10 bytes = 30 bytes total
        chunkSize: 10,
        uploadPart: async (partNumber, _chunk) => {
          // Poll getProgress mid-upload (while part 2 is uploading — part 1 already completed)
          if (partNumber === 2) {
            snapshotDuringUpload = await getProgress()
          }
          return `etag-${partNumber}`
        },
        completeUpload: () => {},
      })

      yield* Effect.promise(() => result)

      // snapshot taken while part 2 is uploading → part 1 completed → bytesUploaded ≥ 10
      expect(snapshotDuringUpload).not.toBeNull()
      expect((snapshotDuringUpload as unknown as Progress).bytesUploaded).toBeGreaterThanOrEqual(10)

      // After completion, full 30 bytes accounted
      const finalProgress = yield* Effect.promise(() => getProgress())
      expect(finalProgress.bytesUploaded).toBe(30)
    })
  )

  it.effect("calling getProgress() multiple times does not affect the upload", () =>
    Effect.gen(function* () {
      const { result, getProgress } = uploadMultipart({
        stream: new ReadableStream({
          start(c) {
            c.enqueue(new Uint8Array(20).fill(1))
            c.close()
          },
        }),
        chunkSize: 10,
        uploadPart: () => "etag",
        completeUpload: () => {},
      })

      yield* Effect.promise(() => result)

      const p1 = yield* Effect.promise(() => getProgress())
      const p2 = yield* Effect.promise(() => getProgress())
      const p3 = yield* Effect.promise(() => getProgress())

      expect(p1.bytesUploaded).toBe(20)
      expect(p2.bytesUploaded).toBe(20)
      expect(p3.bytesUploaded).toBe(20)
      expect(p1.totalBytes).toEqual(Option.none())
    })
  )

  it.effect("getProgress.effect reads from Ref without launching the upload", () =>
    Effect.gen(function* () {
      const { result, getProgress } = uploadMultipart({
        stream: new ReadableStream({
          start(c) {
            c.enqueue(new Uint8Array(15).fill(1))
            c.close()
          },
        }),
        chunkSize: 15,
        uploadPart: () => "etag",
        completeUpload: () => {},
        totalBytes: 15,
      })

      yield* Effect.promise(() => result)

      // getProgress.effect is an Effect<Progress> — run it via yield*
      const progress = yield* getProgress.effect
      expect(progress.bytesUploaded).toBe(15)
      expect(progress.totalBytes).toEqual(Option.some(15))
    })
  )
})
