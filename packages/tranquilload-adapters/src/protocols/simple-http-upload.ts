import { AbortError, CompleteUploadError } from "@tranquilload/core/errors"

/**
 * Adapter for the simplest possible HTTP upload: PUT/POST a stream of bytes
 * directly to a single URL.
 *
 * **Streaming PUT requires HTTP/2 and `duplex: 'half'`.** This is the default
 * mode and is the most memory-efficient option. If your target only speaks
 * HTTP/1.x, or your runtime does not understand `duplex: 'half'`, set
 * `bufferMode: true` to buffer the whole source into a `Blob` before sending.
 */
export interface SimpleHttpUploadOptions {
  url: string
  method?: "PUT" | "POST"
  headers?: Record<string, string>
  signal?: AbortSignal
  /**
   * When `true`, drains the entire source stream into a `Blob` before issuing
   * the PUT/POST request. The request is then a normal buffered upload (no
   * `duplex: 'half'` required, works on HTTP/1.x).
   *
   * **Memory usage equals the source size — DO NOT enable for files larger
   * than available memory.** Use only when streaming PUT isn't supported
   * (HTTP/1.x, environments where `duplex: 'half'` is unavailable).
   *
   * Default: `false` (streaming with `duplex: 'half'`, requires HTTP/2).
   */
  bufferMode?: boolean
}

export function simpleHttpUpload(options: SimpleHttpUploadOptions): {
  upload: (stream: ReadableStream<Uint8Array>) => Promise<void>
} {
  const { url, method = "PUT", headers, signal, bufferMode = false } = options

  const upload = async (stream: ReadableStream<Uint8Array>): Promise<void> => {
    let response: Response
    try {
      if (bufferMode) {
        const reader = stream.getReader()
        const chunks: Uint8Array[] = []
        try {
          // Manual drain loop with per-iteration abort check: `Response#blob()`
          // ignores AbortSignal, so we cannot rely on `new Response(stream).blob()`.
          while (true) {
            if (signal?.aborted) {
              throw new AbortError()
            }
            const { done, value } = await reader.read()
            if (done) break
            if (value) chunks.push(value)
          }
        } finally {
          reader.releaseLock()
        }
        const blob = new Blob(chunks as BlobPart[])
        response = await fetch(url, {
          method,
          headers,
          body: blob,
          signal,
        })
      } else {
        // duplex: 'half' is not in lib.dom.d.ts but is required by modern
        // browsers/Node 22+ to accept a ReadableStream as a fetch body.
        response = await fetch(url, {
          method,
          headers,
          body: stream as unknown as BodyInit,
          signal,
          duplex: "half",
        } as RequestInit & { duplex: "half" })
      }
    } catch (cause) {
      if (cause instanceof AbortError) {
        throw cause
      }
      if (cause instanceof Error && cause.name === "AbortError") {
        throw new AbortError()
      }
      throw new CompleteUploadError(cause)
    }
    if (!response.ok) {
      throw new CompleteUploadError(
        new Error(`HTTP ${response.status} ${response.statusText}`)
      )
    }
  }

  return { upload }
}
