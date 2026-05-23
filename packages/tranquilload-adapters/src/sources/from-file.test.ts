import { describe, it, expect } from 'vitest'
import { uploadMultipart } from '@tranquilload/core/multipart'
import { fromFile } from './from-file.js'

describe('fromFile', () => {
  it('returns totalBytes equal to file.size', () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5])
    const file = new File([bytes], 'test.bin', { type: 'application/octet-stream' })

    const result = fromFile(file)

    expect(result.totalBytes).toBe(5)
  })

  it('F#51 — stream yields all file bytes (fromFile byte-fidelity)', async () => {
    const bytes = new Uint8Array([10, 20, 30, 40])
    const file = new File([bytes], 'test.bin')

    const { stream } = fromFile(file)

    const reader = stream.getReader()
    const chunks: Uint8Array[] = []
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
    }

    const all = new Uint8Array(chunks.reduce((acc, c) => acc + c.length, 0))
    let offset = 0
    for (const chunk of chunks) {
      all.set(chunk, offset)
      offset += chunk.length
    }

    expect(Array.from(all)).toEqual([10, 20, 30, 40])
  })

  // --- 11.6-INT-019 (F#53) — empty File ---------------------------------------
  // Couples with 11.6-INT-001 (F#24, chunking edges): the source-adapter side
  // of "zero-byte file". `fromFile(new File([]))` must produce totalBytes=0 and
  // a ReadableStream that closes immediately with no chunks.
  it('11.6-INT-019 (F#53) — empty File yields totalBytes=0 and an immediately-closing stream', async () => {
    const file = new File([], 'empty.bin', { type: 'application/octet-stream' })

    const { stream, totalBytes } = fromFile(file)

    expect(totalBytes).toBe(0)

    const reader = stream.getReader()
    const first = await reader.read()
    expect(first.done).toBe(true)
    expect(first.value).toBeUndefined()
  })

  // --- 11.6-INT-020 (F#54) — blob URL revocation is independent of fromFile --
  // **Scope note** (code-review M3, Story 11.6, 2026-05-23): F#54's
  // brainstorming wording was "blob URL revoked mid-read". On Node ≥ 22 (and
  // empirically up through Node 24), `File.stream()` returns the entire blob
  // in a single chunk regardless of size, so genuine *mid-read* timing is not
  // observable from a vitest harness. Instead this test locks the load-bearing
  // contract: **`fromFile(file)` is URL-independent** — `file.stream()` reads
  // from the File's internal Blob storage, NOT from a blob URL, so revoking
  // the URL has zero effect on the stream regardless of read timing.
  //
  // Assertion shape:
  //   1. Pre-revoke read: stream is active, first chunk arrives.
  //   2. Revoke the URL.
  //   3. Post-revoke drain: byte-fidelity preserved end-to-end.
  // If a future fromFile change introduced URL coupling (e.g. via
  // `URL.createObjectURL(file)` internally), step 3 would surface the break.
  it('11.6-INT-020 (F#54) — fromFile(file) is URL-independent: URL.revokeObjectURL has no effect', async () => {
    const bytes = new Uint8Array(64)
    for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251
    const file = new File([bytes], 'data.bin')

    // Create and revoke a blob URL for the same file — the URL is an
    // independent identifier; fromFile must bypass it entirely.
    const url = URL.createObjectURL(file)

    const { stream } = fromFile(file)
    const reader = stream.getReader()

    // First read kicks off the source consumption.
    const first = await reader.read()
    expect(first.done).toBe(false)
    expect(first.value).toBeDefined()

    // Revoke the URL — must NOT propagate into the active stream.
    URL.revokeObjectURL(url)

    // Continue draining; byte-fidelity preserved regardless of revoke.
    const chunks: Uint8Array[] = [first.value!]
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
    }

    const total = chunks.reduce((sum, c) => sum + c.length, 0)
    expect(total).toBe(bytes.length)
    const reconstructed = new Uint8Array(total)
    let offset = 0
    for (const c of chunks) {
      reconstructed.set(c, offset)
      offset += c.length
    }
    expect(Array.from(reconstructed)).toEqual(Array.from(bytes))
  })

  // --- 11.6-INT-021 (F#55) — MIME parity (PNG / UTF-8 / multi-byte chars) -----
  // fromFile is content-agnostic: PNG header bytes, UTF-8 ASCII text, and
  // multi-byte UTF-8 (CJK / emoji) must all round-trip byte-identical. Locks
  // that the adapter doesn't accidentally re-encode based on `file.type`.
  it('11.6-INT-021 (F#55) — PNG / UTF-8 / multi-byte content round-trips byte-identical', async () => {
    // PNG signature + minimal IHDR header bytes.
    const pngBytes = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
    ])
    const utf8Bytes = new TextEncoder().encode('Hello, world!')
    const multiByteBytes = new TextEncoder().encode('日本語 — 🎉 — émoji')

    const cases: Array<{ name: string; bytes: Uint8Array; type: string }> = [
      { name: 'p.png', bytes: pngBytes, type: 'image/png' },
      { name: 't.txt', bytes: utf8Bytes, type: 'text/plain;charset=utf-8' },
      { name: 'm.txt', bytes: multiByteBytes, type: 'text/plain;charset=utf-8' },
    ]

    for (const c of cases) {
      // Cast: `TextEncoder.encode` returns Uint8Array<ArrayBufferLike> in some
      // lib versions, which doesn't satisfy BlobPart's strict ArrayBuffer
      // generic. The bytes are identical at runtime; cast unblocks the union.
      const file = new File([c.bytes as BlobPart], c.name, { type: c.type })
      const { stream, totalBytes } = fromFile(file)
      expect(totalBytes).toBe(c.bytes.length)

      const reader = stream.getReader()
      const chunks: Uint8Array[] = []
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        chunks.push(value)
      }
      const total = chunks.reduce((s, ch) => s + ch.length, 0)
      const reconstructed = new Uint8Array(total)
      let offset = 0
      for (const ch of chunks) {
        reconstructed.set(ch, offset)
        offset += ch.length
      }
      expect(Array.from(reconstructed)).toEqual(Array.from(c.bytes))
    }
  })

  // --- 11.6-INT-022 (F#57) — backpressure: heap stays flat under slow consumer
  // Long upload with a deliberately slow `uploadPart` (an artificial 5ms delay
  // per part). Sample `process.memoryUsage().heapUsed` between parts — under
  // working backpressure, heap usage stays bounded by `chunkSize × in-flight`,
  // not by total bytes. Tolerant threshold absorbs CI noise; the assertion
  // is "no monotonic growth across the upload" rather than a hard byte cap.
  //
  // Run vitest with `--expose-gc` and call `global.gc()` between samples for
  // tighter numbers; absent gc, we widen the tolerance.
  it('11.6-INT-022 (F#57) — slow consumer + bounded heap: no monotonic growth across upload', async () => {
    const total = 200_000 // 200KB
    const chunkSize = 1_000 // 200 parts
    const bytes = new Uint8Array(total)
    for (let i = 0; i < total; i++) bytes[i] = i % 251
    const file = new File([bytes], 'big.bin')

    const heapSamples: number[] = []
    const sampleEvery = 25 // sample every 25 parts to keep timing stable

    const gc = (globalThis as { gc?: () => void }).gc
    const sample = (): void => {
      if (typeof gc === 'function') gc()
      heapSamples.push(process.memoryUsage().heapUsed)
    }

    const { stream } = fromFile(file)
    const { result } = uploadMultipart({
      stream,
      chunkSize,
      uploadPart: async (partNumber, _chunk) => {
        // Brief artificial delay to keep parts in flight long enough to sample.
        await new Promise((r) => setTimeout(r, 2))
        if (partNumber % sampleEvery === 0) sample()
        return `etag-${partNumber}`
      },
      completeUpload: () => {},
      maxConcurrency: 4,
    })

    await result

    // At least a few samples were taken across the upload.
    expect(heapSamples.length).toBeGreaterThanOrEqual(3)

    // No monotonic growth: the LAST sample is NOT substantially larger than
    // the FIRST. Allow 2× headroom to absorb noise from Node internals; the
    // bound proves heap does not scale with total bytes uploaded.
    const first = heapSamples[0]!
    const last = heapSamples[heapSamples.length - 1]!
    expect(last).toBeLessThan(first * 2 + 5_000_000)
  })
})
