import { AbortError, CompleteUploadError } from "@tranquilload/core/errors"

/**
 * Adapter for the simplest possible HTTP upload: PUT/POST a stream of bytes
 * directly to a single URL.
 *
 * **Streaming PUT requires HTTP/2 and `duplex: 'half'`.** This is the default
 * mode and is the most memory-efficient option. If your target only speaks
 * HTTP/1.x, or your runtime does not understand `duplex: 'half'`, set
 * `bufferMode: true` to buffer the whole source into a `Blob` before sending.
 *
 * For sources of a **known size**, prefer size-bounded auto-buffering over the
 * manual `bufferMode` toggle: set {@link SimpleHttpUploadOptions.contentLength}
 * and {@link SimpleHttpUploadOptions.maxAutoBufferBytes}, and the adapter picks
 * the HTTP/1.1-safe buffered path automatically when the source is small enough
 * to be memory-safe, falling back to streaming for larger sources.
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
   * Takes precedence over {@link maxAutoBufferBytes} (explicit mode wins).
   *
   * Default: `false` (streaming with `duplex: 'half'`, requires HTTP/2).
   */
  bufferMode?: boolean
  /**
   * Byte length of the source stream, when known. Used **only** for the
   * size-bounded auto-buffer decision (see {@link maxAutoBufferBytes}); it is
   * not sent as a `Content-Length` header. The size must be known up front
   * because the source `ReadableStream` is single-use — it cannot be measured
   * without consuming it, after which neither a buffered retry nor a streamed
   * send is possible.
   */
  contentLength?: number
  /**
   * Opt-in **size-bounded auto-buffer** threshold, in bytes. When set, the
   * adapter chooses the transport up front — before the single-use stream is
   * consumed — based on {@link contentLength}:
   *
   *   - `contentLength <= maxAutoBufferBytes` → **buffered** PUT/POST
   *     (HTTP/1.1-safe, works in every engine, no manual `bufferMode`).
   *   - `contentLength >  maxAutoBufferBytes` → **streamed** PUT/POST
   *     (`duplex: 'half'`, requires HTTP/2) — the memory-safe choice for large
   *     sources, which are never buffered into memory.
   *
   * Requires {@link contentLength}: if `maxAutoBufferBytes` is set without it,
   * the factory throws a `TypeError` rather than risk buffering an unsized
   * source. Ignored when {@link bufferMode} is set.
   *
   * Default: `undefined` (no auto-buffering; behaviour is the byte-for-byte
   * streaming default).
   */
  maxAutoBufferBytes?: number
}

export function simpleHttpUpload(options: SimpleHttpUploadOptions): {
  upload: (stream: ReadableStream<Uint8Array>) => Promise<void>
} {
  const {
    url,
    method = "PUT",
    headers,
    signal,
    bufferMode = false,
    contentLength,
    maxAutoBufferBytes,
  } = options

  // Decide the transport ONCE, up front, before the single-use stream is
  // touched. Explicit `bufferMode` wins; otherwise size-bounded auto-buffer
  // (`maxAutoBufferBytes`) kicks in for sources small enough to be HTTP/1.1-safe
  // without holding an oversized file in memory.
  const useBuffer = ((): boolean => {
    if (bufferMode) return true
    if (maxAutoBufferBytes === undefined) return false
    if (!Number.isFinite(maxAutoBufferBytes) || maxAutoBufferBytes < 0) {
      throw new TypeError(
        `simpleHttpUpload: \`maxAutoBufferBytes\` must be a non-negative finite number, got ${maxAutoBufferBytes}.`
      )
    }
    if (contentLength === undefined) {
      throw new TypeError(
        "simpleHttpUpload: `maxAutoBufferBytes` requires `contentLength` — the " +
          "source size must be known before consuming the single-use stream to " +
          "auto-buffer safely."
      )
    }
    if (!Number.isFinite(contentLength) || contentLength < 0) {
      throw new TypeError(
        `simpleHttpUpload: \`contentLength\` must be a non-negative finite number, got ${contentLength}.`
      )
    }
    return contentLength <= maxAutoBufferBytes
  })()

  const upload = async (stream: ReadableStream<Uint8Array>): Promise<void> => {
    let response: Response
    try {
      if (useBuffer) {
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
