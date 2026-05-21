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
  it.effect("F#35 — getProgress() returns increasing bytesUploaded during an in-progress upload (and final value after completion)", () =>
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

  // --- 10.1-INT-010 (F#52) — `fromFile.totalBytes` flows into getProgress ---
  // Playwright's R2 progress-bar assertions multiply `bytesUploaded /
  // totalBytes` to read the bar's width. This test locks the round-trip
  // from File.size → fromFile.totalBytes → uploadMultipart({ totalBytes }) →
  // getProgress().totalBytes → meaningful percentage.
  it.effect("10.1-INT-010 (F#52) — fromFile.totalBytes flows into getProgress(); mid-upload % is computable", () =>
    Effect.gen(function* () {
      const fileSize = 40 // 4 parts of 10 bytes
      const file = new File([new Uint8Array(fileSize).fill(0xab)], "progress.bin", {
        type: "application/octet-stream",
      })
      const fileTotalBytes = file.size

      const percentSnapshots: number[] = []

      const { result, getProgress } = uploadMultipart({
        stream: slowStream(fileSize / 10, 10),
        chunkSize: 10,
        totalBytes: fileTotalBytes,
        uploadPart: async (partNumber, _chunk) => {
          // Sample percentage from part 2 onward (Ref updates *after* uploadPart
          // resolves for the part that triggered it — see project_context.md
          // "Ref.update post-uploadPart timing").
          if (partNumber >= 2) {
            const p = await getProgress()
            const total = Option.isSome(p.totalBytes) ? p.totalBytes.value : 0
            const pct = total > 0 ? (p.bytesUploaded / total) * 100 : 0
            percentSnapshots.push(pct)
          }
          return `etag-${partNumber}`
        },
        completeUpload: () => {},
      })

      yield* Effect.promise(() => result)

      // totalBytes round-trip: getProgress.totalBytes equals fileTotalBytes.
      const finalProgress = yield* Effect.promise(() => getProgress())
      expect(finalProgress.totalBytes).toEqual(Option.some(fileSize))
      expect(finalProgress.bytesUploaded).toBe(fileSize)

      // Mid-upload percentages were captured and are monotonically non-decreasing.
      expect(percentSnapshots.length).toBeGreaterThan(0)
      for (let i = 1; i < percentSnapshots.length; i++) {
        expect(
          percentSnapshots[i]! >= percentSnapshots[i - 1]!,
          `pct should be non-decreasing: ${JSON.stringify(percentSnapshots)}`,
        ).toBe(true)
      }
      // At least one snapshot must reflect partial progress (>0% and <100%).
      const anyPartial = percentSnapshots.some((p) => p > 0 && p < 100)
      expect(anyPartial, `expected at least one mid-upload partial percentage; got ${JSON.stringify(percentSnapshots)}`).toBe(true)
    }),
  )

  it.effect("F#34 — getProgress.effect reads from Ref without launching the upload (returns 0 before initiate)", () =>
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

      // Call getProgress.effect BEFORE awaiting result — proves it doesn't launch the upload
      const before = yield* getProgress.effect
      expect(before.bytesUploaded).toBe(0)
      expect(before.totalBytes).toEqual(Option.some(15))

      yield* Effect.promise(() => result)

      // After completion, Ref reflects final state
      const after = yield* getProgress.effect
      expect(after.bytesUploaded).toBe(15)
      expect(after.totalBytes).toEqual(Option.some(15))
    })
  )
})
