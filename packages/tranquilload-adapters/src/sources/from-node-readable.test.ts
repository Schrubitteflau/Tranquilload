import { describe, it, expect } from "vitest"
import { Readable } from "node:stream"
import { fromNodeReadable } from "./from-node-readable.js"

describe("fromNodeReadable", () => {
  it("F#56 — streams all bytes from a Node Readable (CLI scenario, byte-fidelity)", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5])
    const readable = Readable.from([Buffer.from(bytes)])

    const webStream = fromNodeReadable(readable)

    const reader = webStream.getReader()
    const chunks: Uint8Array[] = []
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
    }

    const totalLength = chunks.reduce((n, c) => n + c.length, 0)
    const all = new Uint8Array(totalLength)
    let offset = 0
    for (const chunk of chunks) {
      all.set(chunk, offset)
      offset += chunk.length
    }

    expect(Array.from(all)).toEqual([1, 2, 3, 4, 5])
  })

  it("propagates Readable errors to the ReadableStream", async () => {
    const readable = new Readable({
      read() {
        this.emit("error", new Error("read failure"))
      },
    })

    const webStream = fromNodeReadable(readable)
    const reader = webStream.getReader()

    await expect(reader.read()).rejects.toThrow("read failure")
  })
})
