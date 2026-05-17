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
    const error = await adapter.upload(new ReadableStream()).catch((e) => e)
    expect(error).toBeInstanceOf(CompleteUploadError)
    expect(error.cause).toBeInstanceOf(Error)
    expect((error.cause as Error).message).toBe("HTTP 403 Forbidden")
  })

  it("rejects with AbortError when fetch is aborted", async () => {
    const abortError = new DOMException("The operation was aborted.", "AbortError")
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(abortError))

    const adapter = simpleHttpUpload({ url: "https://example.com/upload" })
    await expect(adapter.upload(new ReadableStream())).rejects.toBeInstanceOf(AbortError)
  })

  it("rejects with CompleteUploadError on network failure", async () => {
    const networkError = new Error("Failed to fetch")
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(networkError))

    const adapter = simpleHttpUpload({ url: "https://example.com/upload" })
    const error = await adapter.upload(new ReadableStream()).catch((e) => e)
    expect(error).toBeInstanceOf(CompleteUploadError)
    expect(error.cause).toBe(networkError)
  })

  it("passes duplex: 'half' on streaming uploads (default)", async () => {
    const stream = new ReadableStream<Uint8Array>()
    const fetchMock = vi.fn().mockResolvedValue({ ok: true })
    vi.stubGlobal("fetch", fetchMock)

    const adapter = simpleHttpUpload({ url: "https://example.com/upload" })
    await adapter.upload(stream)

    const [, init] = fetchMock.mock.calls[0]!
    expect(init.duplex).toBe("half")
    expect(init.body).toBe(stream)
  })

  it("buffers the stream into a Blob when bufferMode is true", async () => {
    const chunkA = new Uint8Array([1, 2, 3])
    const chunkB = new Uint8Array([4, 5])
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(chunkA)
        c.enqueue(chunkB)
        c.close()
      },
    })
    const fetchMock = vi.fn().mockResolvedValue({ ok: true })
    vi.stubGlobal("fetch", fetchMock)

    const adapter = simpleHttpUpload({
      url: "https://example.com/upload",
      bufferMode: true,
    })
    await adapter.upload(stream)

    const [, init] = fetchMock.mock.calls[0]!
    expect(init.body).toBeInstanceOf(Blob)
    expect((init.body as Blob).size).toBe(chunkA.length + chunkB.length)
    expect(init.duplex).toBeUndefined()
  })

  it("rejects with CompleteUploadError on mid-stream read errors when bufferMode is true", async () => {
    const readError = new Error("source read failed")
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new Uint8Array([1, 2, 3]))
      },
      pull(c) {
        c.error(readError)
      },
    })
    const fetchMock = vi.fn().mockResolvedValue({ ok: true })
    vi.stubGlobal("fetch", fetchMock)

    const adapter = simpleHttpUpload({
      url: "https://example.com/upload",
      bufferMode: true,
    })
    const error = await adapter.upload(stream).catch((e) => e)
    expect(error).toBeInstanceOf(CompleteUploadError)
    expect((error as CompleteUploadError).cause).toBe(readError)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("rejects with AbortError when signal aborts during bufferMode drain", async () => {
    const controller = new AbortController()
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new Uint8Array([1, 2, 3]))
      },
      pull(c) {
        // After the first chunk is consumed, abort before the next read resolves.
        controller.abort()
        // Then leave the stream pending so the loop checks `signal.aborted` first.
        setTimeout(() => c.enqueue(new Uint8Array([4, 5])), 10)
      },
    })
    const fetchMock = vi.fn().mockResolvedValue({ ok: true })
    vi.stubGlobal("fetch", fetchMock)

    const adapter = simpleHttpUpload({
      url: "https://example.com/upload",
      bufferMode: true,
      signal: controller.signal,
    })
    const error = await adapter.upload(stream).catch((e) => e)
    expect(error).toBeInstanceOf(AbortError)
    expect(error).not.toBeInstanceOf(CompleteUploadError)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
