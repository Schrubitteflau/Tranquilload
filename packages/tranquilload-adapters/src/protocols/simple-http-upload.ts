import { AbortError, CompleteUploadError } from "@tranquilload/core/errors"

export interface SimpleHttpUploadOptions {
  url: string
  method?: "PUT" | "POST"
  headers?: Record<string, string>
  signal?: AbortSignal
}

export function simpleHttpUpload(options: SimpleHttpUploadOptions): {
  upload: (stream: ReadableStream<Uint8Array>) => Promise<void>
} {
  const { url, method = "PUT", headers, signal } = options

  const upload = async (stream: ReadableStream<Uint8Array>): Promise<void> => {
    let response: Response
    try {
      response = await fetch(url, {
        method,
        headers,
        body: stream as unknown as BodyInit,
        signal,
      })
    } catch (cause) {
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
