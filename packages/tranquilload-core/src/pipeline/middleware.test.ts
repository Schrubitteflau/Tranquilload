import { describe, expect, it } from "vitest"
import { compose } from "./middleware.js"

// Helper: creates a ReadableStream emitting a single Uint8Array chunk
function makeStream(data: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(data)
      controller.close()
    }
  })
}

// Helper: collects all chunks from a ReadableStream
async function collect(stream: ReadableStream<Uint8Array>): Promise<Uint8Array[]> {
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
  }
  return chunks
}

describe("compose", () => {
  it("zero transforms: stream passes through unchanged", async () => {
    const data = new Uint8Array([1, 2, 3])
    const pipeline = compose()
    const result = await collect(pipeline(makeStream(data)))
    expect(result).toEqual([data])
  })

  it("single transform: applied to stream", async () => {
    const data = new Uint8Array([1, 2, 3])
    const double = (stream: ReadableStream<Uint8Array>) =>
      new ReadableStream<Uint8Array>({
        async start(controller) {
          const chunks = await collect(stream)
          for (const chunk of chunks) controller.enqueue(chunk.map(b => b * 2))
          controller.close()
        }
      })
    const result = await collect(compose(double)(makeStream(data)))
    expect(result).toEqual([new Uint8Array([2, 4, 6])])
  })

  it("two transforms: applied left-to-right", async () => {
    const order: string[] = []
    const t1 = (stream: ReadableStream<Uint8Array>) => { order.push("t1"); return stream }
    const t2 = (stream: ReadableStream<Uint8Array>) => { order.push("t2"); return stream }
    compose(t1, t2)(makeStream(new Uint8Array([1])))
    expect(order).toEqual(["t1", "t2"])
  })

  it("three transforms: applied left-to-right", async () => {
    const order: string[] = []
    const t1 = (stream: ReadableStream<Uint8Array>) => { order.push("t1"); return stream }
    const t2 = (stream: ReadableStream<Uint8Array>) => { order.push("t2"); return stream }
    const t3 = (stream: ReadableStream<Uint8Array>) => { order.push("t3"); return stream }
    compose(t1, t2, t3)(makeStream(new Uint8Array([1])))
    expect(order).toEqual(["t1", "t2", "t3"])
  })
})
