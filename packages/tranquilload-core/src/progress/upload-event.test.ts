import { it, describe, expect } from "@effect/vitest"
import { Effect, Match, Option } from "effect"
import type { UploadEvent, ProgressTick } from "./upload-event.js"
import { uploadMultipart } from "../multipart/index.js"

describe("UploadEvent type system", () => {
  it("exhaustive switch on _tag compiles and handles all variants", () => {
    const handle = (event: UploadEvent): string => {
      switch (event._tag) {
        case "PartCompleted":
          return "part"
        case "ProgressTick":
          return "progress"
        case "UploadCompleted":
          return "done"
        case "CircuitOpen":
          return "circuit"
      }
    }
    const event: UploadEvent = {
      _tag: "ProgressTick",
      bytesUploaded: 500,
      totalBytes: Option.none(),
      timestamp: 0,
    }
    expect(handle(event)).toBe("progress")
  })

  it.effect("Match.tag handles all variants exhaustively", () =>
    Effect.gen(function* () {
      const event: UploadEvent = {
        _tag: "PartCompleted",
        partNumber: 1,
        etag: "abc",
        bytesUploaded: 100,
        timestamp: 0,
      }
      const result = Match.type<UploadEvent>().pipe(
        Match.tag("PartCompleted", (e) => `part:${e.partNumber}`),
        Match.tag("ProgressTick", (e) => `progress:${e.bytesUploaded}`),
        Match.tag("UploadCompleted", (e) => `done:${e.totalParts}`),
        Match.tag("CircuitOpen", (e) => `circuit:${e.failedParts}`),
        Match.exhaustive
      )(event)
      expect(result).toBe("part:1")
    })
  )

  it("all variants have _tag and timestamp fields", () => {
    const variants: UploadEvent[] = [
      { _tag: "PartCompleted", partNumber: 1, etag: "e", bytesUploaded: 10, timestamp: 1 },
      { _tag: "ProgressTick", bytesUploaded: 10, totalBytes: Option.some(100), timestamp: 2 },
      { _tag: "UploadCompleted", uploadId: "id", totalParts: 1, timestamp: 3 },
      { _tag: "CircuitOpen", failedParts: 3, timestamp: 4 },
    ]
    for (const v of variants) {
      expect(typeof v._tag).toBe("string")
      expect(typeof v.timestamp).toBe("number")
    }
  })

  it.effect("uploadMultipart emits ProgressTick after each PartCompleted", () =>
    Effect.gen(function* () {
      const allEvents: UploadEvent[] = []
      const { result, events } = uploadMultipart({
        stream: new ReadableStream({
          start(c) {
            c.enqueue(new Uint8Array([1, 2, 3]))
            c.enqueue(new Uint8Array([4, 5, 6]))
            c.close()
          },
        }),
        chunkSize: 3,
        uploadPart: (_partNumber, _chunk) => "etag",
        completeUpload: () => {},
      })

      const consumeEvents = async () => {
        const reader = events.getReader()
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          allEvents.push(value)
        }
      }

      yield* Effect.promise(() => Promise.all([result, consumeEvents()]))
      const progressTicks = allEvents.filter((e) => e._tag === "ProgressTick")
      expect(progressTicks).toHaveLength(2)
      const tick1 = progressTicks[0] as ProgressTick
      const tick2 = progressTicks[1] as ProgressTick
      expect(tick1.bytesUploaded).toBe(3)
      expect(tick2.bytesUploaded).toBe(6)
    })
  )
})
