import { describe, it, expect, vi, afterEach } from "vitest"
import { AbortError, CompleteUploadError } from "@tranquilload/core/errors"
import { simpleHttpUpload } from "./simple-http-upload.js"

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("simpleHttpUpload", () => {
  it("upload calls fetch with url, method, headers, and stream as body", async () => {
    const stream = new ReadableStream<Uint8Array>()
    const fetchMock = vi.fn().mockResolvedValue({ ok: true })
    vi.stubGlobal("fetch", fetchMock)

    const adapter = simpleHttpUpload({
      url: "https://example.com/upload",
      method: "PUT",
      headers: { "x-foo": "bar" },
    })
    await adapter.upload(stream)

    expect(fetchMock).toHaveBeenCalledWith(
      "https://example.com/upload",
      expect.objectContaining({
        method: "PUT",
        headers: { "x-foo": "bar" },
        body: stream,
      })
    )
  })

  it("method defaults to PUT when omitted", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true })
    vi.stubGlobal("fetch", fetchMock)

    const adapter = simpleHttpUpload({ url: "https://example.com/upload" })
    await adapter.upload(new ReadableStream())

    expect(fetchMock).toHaveBeenCalledWith(
      "https://example.com/upload",
      expect.objectContaining({ method: "PUT" })
    )
  })

  it("rejects with CompleteUploadError when response is not ok", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 403, statusText: "Forbidden" })
    )

    const adapter = simpleHttpUpload({ url: "https://example.com/upload" })
    await expect(adapter.upload(new ReadableStream())).rejects.toBeInstanceOf(
      CompleteUploadError
    )
  })

  it("rejects with AbortError when fetch is aborted", async () => {
    const abortError = new DOMException("The operation was aborted.", "AbortError")
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(abortError))

    const adapter = simpleHttpUpload({ url: "https://example.com/upload" })
    await expect(adapter.upload(new ReadableStream())).rejects.toBeInstanceOf(AbortError)
  })

  it("rejects with CompleteUploadError on network failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Failed to fetch")))

    const adapter = simpleHttpUpload({ url: "https://example.com/upload" })
    await expect(adapter.upload(new ReadableStream())).rejects.toBeInstanceOf(
      CompleteUploadError
    )
  })
})
