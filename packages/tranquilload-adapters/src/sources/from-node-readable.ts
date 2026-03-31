import { Readable } from "node:stream"

export function fromNodeReadable(readable: Readable): ReadableStream<Uint8Array> {
  return Readable.toWeb(readable) as ReadableStream<Uint8Array>
}
