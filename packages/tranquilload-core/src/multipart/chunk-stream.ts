import { Stream } from "effect"

export const chunkStream = (
  stream: ReadableStream<Uint8Array>,
  chunkSize: number
): Stream.Stream<Uint8Array, unknown> => {
  let buffer = new Uint8Array(0)

  const transform = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      // Concatenate incoming chunk into the buffer
      const merged = new Uint8Array(buffer.length + chunk.length)
      merged.set(buffer)
      merged.set(chunk, buffer.length)
      buffer = merged

      // Emit every full-size chunk
      while (buffer.length >= chunkSize) {
        controller.enqueue(buffer.slice(0, chunkSize))
        buffer = buffer.slice(chunkSize)
      }
    },
    flush(controller) {
      // Emit remaining bytes (last partial chunk)
      if (buffer.length > 0) {
        controller.enqueue(buffer)
      }
    },
  })

  const chunked = stream.pipeThrough(transform)

  return Stream.fromReadableStream(
    () => chunked,
    (e) => e
  )
}
