export function fromFile(file: File): { stream: ReadableStream<Uint8Array>; totalBytes: number } {
  return {
    stream: file.stream(),
    totalBytes: file.size,
  }
}
