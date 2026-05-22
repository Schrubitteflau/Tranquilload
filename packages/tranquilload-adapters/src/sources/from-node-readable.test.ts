import { describe, it, expect } from "vitest"
import { createReadStream } from "node:fs"
import { Readable } from "node:stream"
import { uploadMultipart } from "@tranquilload/core/multipart"
import { PartUploadError } from "@tranquilload/core/errors"
import { fromNodeReadable } from "./from-node-readable.js"

describe("fromNodeReadable", () => {
  it("F#56 — streams all bytes from a Node Readable (CLI scenario, byte-fidelity)", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5])
    const readable = Readable.from([Buffer.from(bytes)])

    const webStream = fromNodeReadable(readable)

    const reader = webStream.getReader()
    const chunks: Uint8Array[] = []
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
    }

    const totalLength = chunks.reduce((n, c) => n + c.length, 0)
    const all = new Uint8Array(totalLength)
    let offset = 0
    for (const chunk of chunks) {
      all.set(chunk, offset)
      offset += chunk.length
    }

    expect(Array.from(all)).toEqual([1, 2, 3, 4, 5])
  })

  it("propagates Readable errors to the ReadableStream", async () => {
    const readable = new Readable({
      read() {
        this.emit("error", new Error("read failure"))
      },
    })

    const webStream = fromNodeReadable(readable)
    const reader = webStream.getReader()

    await expect(reader.read()).rejects.toThrow("read failure")
  })

  // --- 11.6-INT-023 (F#58) — ENOENT propagates as PartUploadError -------------
  // `createReadStream` of a missing path emits an ENOENT 'error' event on the
  // Readable. Through fromNodeReadable → chunkStream → upload-stream.ts, this
  // surfaces in the typed Effect channel as PartUploadError(0, 0, cause) — NOT
  // as an uncaught exception or a fiber DEFECT.
  it("11.6-INT-023 (F#58) — createReadStream of missing path: ENOENT surfaces as PartUploadError", async () => {
    const missingPath = "/tmp/tranquilload-does-not-exist-" + Date.now()
    const readable = createReadStream(missingPath)
    const stream = fromNodeReadable(readable)

    const { result } = uploadMultipart({
      stream,
      chunkSize: 10,
      uploadPart: () => "etag-never-called",
      completeUpload: () => {},
    })

    let caught: unknown
    try {
      await result
    } catch (e) {
      caught = e
    }

    expect(caught).toBeInstanceOf(PartUploadError)
    const err = caught as PartUploadError
    expect(err._tag).toBe("PartUploadError")
    expect(err.partNumber).toBe(0)
    expect(err.attempt).toBe(0)
    // Original cause is an ENOENT-like Error.
    expect(err.cause).toBeDefined()
    const causeMessage = String((err.cause as Error)?.message ?? err.cause)
    expect(causeMessage).toMatch(/ENOENT|no such file/i)
  })

  // --- 11.6-INT-024 (F#59) — Readable.destroy(err) mid-stream -----------------
  // A Readable that emits a chunk then destroys itself with an error must
  // surface that error as a PartUploadError through the upload pipeline. Locks
  // the mid-stream-failure contract that mirrors F#25 at the Node-source layer.
  it("11.6-INT-024 (F#59) — Readable.destroy(err) mid-stream: typed PartUploadError, no fiber DEFECT", async () => {
    const cause = new Error("EIO mid-stream")
    let chunkPushed = false
    const readable = new Readable({
      read() {
        if (!chunkPushed) {
          chunkPushed = true
          this.push(Buffer.from(new Uint8Array(5).fill(1)))
          // Schedule destroy for the next tick so the chunk is observable
          // before the error.
          setImmediate(() => this.destroy(cause))
        }
      },
    })

    const stream = fromNodeReadable(readable)

    const { result } = uploadMultipart({
      stream,
      chunkSize: 10, // chunk size > prelude, so flush would emit if no error
      uploadPart: () => "etag-never-called",
      completeUpload: () => {},
    })

    let caught: unknown
    try {
      await result
    } catch (e) {
      caught = e
    }

    expect(caught).toBeInstanceOf(PartUploadError)
    const err = caught as PartUploadError
    expect(err._tag).toBe("PartUploadError")
    expect(err.partNumber).toBe(0)
    expect(err.attempt).toBe(0)
    expect((err.cause as Error)?.message).toBe("EIO mid-stream")
  })

  // --- 11.6-INT-025 (F#60) — paused Readable auto-resumes via Readable.toWeb --
  // A Readable that has been explicitly `.pause()`-d before being passed to
  // `fromNodeReadable` (which calls `Readable.toWeb` internally) must still
  // produce bytes when the web stream's consumer pulls — Node's toWeb adapter
  // attaches its own pull-driven flow control and effectively resumes the
  // Readable. Locks that the adapter does NOT require callers to manage the
  // paused/resumed state themselves.
  it("11.6-INT-025 (F#60) — paused Readable: Readable.toWeb auto-resumes, bytes flow", async () => {
    const bytes = new Uint8Array([10, 20, 30, 40, 50])
    const readable = Readable.from([Buffer.from(bytes)])
    readable.pause() // explicitly paused before conversion
    expect(readable.isPaused()).toBe(true)

    const stream = fromNodeReadable(readable)
    const reader = stream.getReader()

    const chunks: Uint8Array[] = []
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
    }

    const total = chunks.reduce((s, c) => s + c.length, 0)
    expect(total).toBe(bytes.length)
    const reconstructed = new Uint8Array(total)
    let offset = 0
    for (const c of chunks) {
      reconstructed.set(c, offset)
      offset += c.length
    }
    expect(Array.from(reconstructed)).toEqual([10, 20, 30, 40, 50])
  })

  // --- 11.6-INT-026 (F#61) — Buffer source: byteLength preserved (no realloc) -
  // Pass a Buffer source through fromNodeReadable. The bytes received at the
  // consumer side must preserve byteLength and content exactly — no padding,
  // no truncation, no encoding round-trip. This is the byteLength invariant
  // the test design names; a strict identity-of-storage check would over-bind
  // implementation details of Readable.toWeb across Node versions.
  it("11.6-INT-026 (F#61) — Buffer source: byteLength invariant preserved end-to-end", async () => {
    const sentinel = new Uint8Array(64)
    for (let i = 0; i < sentinel.length; i++) sentinel[i] = (i * 7 + 3) % 251
    const sourceBuffer = Buffer.from(sentinel)
    expect(sourceBuffer.byteLength).toBe(sentinel.length)

    const readable = Readable.from([sourceBuffer])
    const stream = fromNodeReadable(readable)

    const reader = stream.getReader()
    const chunks: Uint8Array[] = []
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
    }

    const total = chunks.reduce((s, c) => s + c.length, 0)
    // byteLength invariant: total === sourceBuffer.byteLength → no padding/trunc.
    expect(total).toBe(sourceBuffer.byteLength)

    // Content invariant: bytes match exactly.
    const reconstructed = new Uint8Array(total)
    let offset = 0
    for (const c of chunks) {
      reconstructed.set(c, offset)
      offset += c.length
    }
    expect(Array.from(reconstructed)).toEqual(Array.from(sentinel))
  })
})
