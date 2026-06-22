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

/**
 * Story 13.6 — size-bounded auto-buffer (R-P2-4 / Decision D1).
 *
 * Net-new UNIT locks for the opt-in `maxAutoBufferBytes` path. The named lock
 * `11.7-E2E-002` empirically probes RAW browser `fetch` HTTP/1.1 streaming
 * capability — a platform fact this adapter cannot change — so it stays as-is
 * (re-tagged), and the deterministic buffer-vs-stream DECISION is locked here at
 * the unit tier instead. This is what 13.6 actually delivers: small bounded
 * sources take the HTTP/1.1-safe buffered path with no manual `bufferMode`.
 */
describe("simpleHttpUpload — size-bounded auto-buffer (Story 13.6)", () => {
  it("13.6-INT-001 (F#40) — auto-buffers (no manual bufferMode) when contentLength <= maxAutoBufferBytes", async () => {
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
      contentLength: 5,
      maxAutoBufferBytes: 10,
    })
    await adapter.upload(stream)

    const [, init] = fetchMock.mock.calls[0]!
    expect(init.body).toBeInstanceOf(Blob)
    expect((init.body as Blob).size).toBe(chunkA.length + chunkB.length)
    expect(init.duplex).toBeUndefined()
  })

  it("13.6-INT-002 (F#40) — streams (duplex:'half', never buffered) when contentLength > maxAutoBufferBytes", async () => {
    const stream = new ReadableStream<Uint8Array>()
    const fetchMock = vi.fn().mockResolvedValue({ ok: true })
    vi.stubGlobal("fetch", fetchMock)

    const adapter = simpleHttpUpload({
      url: "https://example.com/upload",
      contentLength: 100,
      maxAutoBufferBytes: 10,
    })
    await adapter.upload(stream)

    const [, init] = fetchMock.mock.calls[0]!
    expect(init.body).toBe(stream)
    expect(init.duplex).toBe("half")
  })

  it("13.6-INT-003 (F#40) — boundary: contentLength === maxAutoBufferBytes buffers (threshold is inclusive)", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new Uint8Array([1, 2, 3, 4, 5]))
        c.close()
      },
    })
    const fetchMock = vi.fn().mockResolvedValue({ ok: true })
    vi.stubGlobal("fetch", fetchMock)

    const adapter = simpleHttpUpload({
      url: "https://example.com/upload",
      contentLength: 5,
      maxAutoBufferBytes: 5,
    })
    await adapter.upload(stream)

    const [, init] = fetchMock.mock.calls[0]!
    expect(init.body).toBeInstanceOf(Blob)
    expect(init.duplex).toBeUndefined()
  })

  it("13.6-INT-004 (F#40) — explicit bufferMode:true overrides maxAutoBufferBytes even when the source exceeds the threshold", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new Uint8Array([1, 2, 3]))
        c.close()
      },
    })
    const fetchMock = vi.fn().mockResolvedValue({ ok: true })
    vi.stubGlobal("fetch", fetchMock)

    const adapter = simpleHttpUpload({
      url: "https://example.com/upload",
      bufferMode: true,
      contentLength: 100,
      maxAutoBufferBytes: 10,
    })
    await adapter.upload(stream)

    const [, init] = fetchMock.mock.calls[0]!
    expect(init.body).toBeInstanceOf(Blob)
    expect(init.duplex).toBeUndefined()
  })

  it("13.6-INT-005 (F#40) — throws TypeError when maxAutoBufferBytes is set without contentLength (refuses to size an unsized stream)", () => {
    expect(() =>
      simpleHttpUpload({
        url: "https://example.com/upload",
        maxAutoBufferBytes: 10,
      })
    ).toThrow(TypeError)
    expect(() =>
      simpleHttpUpload({
        url: "https://example.com/upload",
        maxAutoBufferBytes: 10,
      })
    ).toThrow(/contentLength/)
  })

  it("13.6-INT-006 (F#40) — throws TypeError on a negative or non-finite threshold", () => {
    expect(() =>
      simpleHttpUpload({
        url: "https://example.com/upload",
        contentLength: 5,
        maxAutoBufferBytes: -1,
      })
    ).toThrow(TypeError)
    expect(() =>
      simpleHttpUpload({
        url: "https://example.com/upload",
        contentLength: -1,
        maxAutoBufferBytes: 10,
      })
    ).toThrow(TypeError)
  })

  it("13.6-INT-007 (F#40) — without maxAutoBufferBytes the default is byte-for-byte streaming (contentLength alone is inert)", async () => {
    const stream = new ReadableStream<Uint8Array>()
    const fetchMock = vi.fn().mockResolvedValue({ ok: true })
    vi.stubGlobal("fetch", fetchMock)

    const adapter = simpleHttpUpload({
      url: "https://example.com/upload",
      contentLength: 5,
    })
    await adapter.upload(stream)

    const [, init] = fetchMock.mock.calls[0]!
    expect(init.body).toBe(stream)
    expect(init.duplex).toBe("half")
  })
})
