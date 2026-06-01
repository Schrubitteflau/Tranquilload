import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer, Stream } from "effect"
import { CompressionService, CompressionServiceLive } from "./compression-service.js"
import { LoggerServiceLive } from "./logger-service.js"
import { compress } from "../pipeline/compress.js"
import { uploadMultipartEffect } from "../multipart/upload-stream.js"

/**
 * Story 11.2 — CompressionService edges (AC #8). LOCK tests for the
 * CompressionService injection surface — no lib change expected.
 *
 * Coverage split for F#68 (default works in browser + Node):
 *   - This file (Node): 11.2-INT-003 — `CompressionServiceLive` resolves and
 *     round-trips through `CompressionStream("deflate-raw")` under Node 22+
 *     (which exposes `globalThis.CompressionStream` natively).
 *   - Cross-browser side: 10.4-E2E-005 (existing PW-Lib `deflate-raw.spec.ts`)
 *     covers chromium/firefox/webkit. Vitest browser mode is not configured
 *     in this repo (deferred Epic 13) — Node + the 3-browser PW-Lib matrix
 *     together discharge the "browser + Node 22" axis honestly.
 */

const fromBytes = (bytes: Uint8Array): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start(c) {
      c.enqueue(bytes)
      c.close()
    },
  })

const collectAll = async (stream: ReadableStream<Uint8Array>): Promise<Uint8Array> => {
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let totalLength = 0
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    if (value !== undefined) {
      chunks.push(value)
      totalLength += value.byteLength
    }
  }
  const merged = new Uint8Array(totalLength)
  let offset = 0
  for (const c of chunks) {
    merged.set(c, offset)
    offset += c.byteLength
  }
  return merged
}

describe("Story 11.2 — CompressionService edges (R-P2-8)", () => {
  // ────────────────────────────────────────────────────────────────────────────
  // 11.2-INT-003 (F#68) — Default `CompressionServiceLive` resolves on Node 22+
  //
  // Scope (Pattern 3): Node 22 (the minimum supported runtime per
  // `engines.node`) exposes `globalThis.CompressionStream` natively, so the
  // Layer's runtime probe MUST succeed and yield a working compression
  // transform. The browser side is covered by 10.4-E2E-005 (existing PW-Lib).
  // ────────────────────────────────────────────────────────────────────────────
  it.effect(
    "11.2-INT-003 (F#68) — CompressionServiceLive resolves to a working CompressionStream on Node 22+ (DOM globals)",
    () =>
      Effect.gen(function* () {
        const svc = yield* Effect.provide(CompressionService, CompressionServiceLive)
        const input = new Uint8Array(64).map((_, i) => i)
        const compressed = svc.compress(fromBytes(input), "deflate-raw")
        const bytes = yield* Effect.promise(() => collectAll(compressed))
        // We don't assert on the compressed byte count (compression ratio is
        // input-dependent) — only that compression yielded SOME output.
        expect(bytes.byteLength).toBeGreaterThan(0)
      }),
  )

  // ────────────────────────────────────────────────────────────────────────────
  // 11.2-INT-004 (F#69) — No-op CompressionService → object size === source
  // size (proves injection actually overrides the default)
  // ────────────────────────────────────────────────────────────────────────────
  it.effect(
    "11.2-INT-004 (F#69) — no-op CompressionService passes bytes through unchanged (size invariant)",
    () =>
      Effect.gen(function* () {
        const NoOpLayer: Layer.Layer<CompressionService> = Layer.succeed(
          CompressionService,
          {
            // Pass the source stream through untouched — identity transform.
            compress: (stream) => stream,
          },
        )

        const transform = yield* Effect.provide(compress("deflate-raw"), NoOpLayer)

        const input = new Uint8Array(128).map((_, i) => i % 256)
        const processed = transform(fromBytes(input))

        let totalBytes = 0
        yield* Stream.runDrain(
          uploadMultipartEffect({
            stream: processed,
            chunkSize: 32,
            uploadPart: (_n, chunk) => {
              totalBytes += chunk.byteLength
              return "etag"
            },
            completeUpload: () => {},
          }).pipe(Stream.provideLayer(LoggerServiceLive)),
        )

        // No-op compressor → uploaded byte count exactly equals source byte count.
        expect(
          totalBytes,
          `expected ${input.byteLength} bytes (source size), got ${totalBytes}`,
        ).toBe(input.byteLength)
      }),
  )

  // ────────────────────────────────────────────────────────────────────────────
  // 11.2-INT-005 (F#70) — Malformed CompressionService output → upload
  // "succeeds" with a corrupt object (codifies the no-checksum trust boundary)
  //
  // This is a CONTRACT lock, not a defect: the lib trusts the user-injected
  // CompressionService and does not validate its output. If the compressor
  // produces nonsense bytes, the upload still completes — the resulting object
  // is corrupt. This is intentional (the lib has no content checksum on the
  // ingest side); we lock it as a foot-gun for future readers.
  //
  // Epic 13 candidate: optional ingest checksum to surface "compressor
  // produced unreadable bytes" before the upload completes.
  // ────────────────────────────────────────────────────────────────────────────
  it.effect(
    "11.2-INT-005 (F#70) — malformed CompressionService output → upload completes with corrupt bytes (no-checksum trust boundary)",
    () =>
      Effect.gen(function* () {
        const MalformedLayer: Layer.Layer<CompressionService> = Layer.succeed(
          CompressionService,
          {
            // Return a stream that emits bytes UNRELATED to the input — this
            // is what a buggy compressor would do.
            compress: (_stream) =>
              new ReadableStream<Uint8Array>({
                start(c) {
                  c.enqueue(new Uint8Array([0xff, 0xfe, 0xfd, 0xfc]))
                  c.close()
                },
              }),
          },
        )

        const transform = yield* Effect.provide(compress("deflate-raw"), MalformedLayer)

        const input = new Uint8Array(64).fill(7)
        const processed = transform(fromBytes(input))

        const uploadedChunks: Uint8Array[] = []
        let completed = false
        yield* Stream.runDrain(
          uploadMultipartEffect({
            stream: processed,
            chunkSize: 16,
            uploadPart: (_n, chunk) => {
              uploadedChunks.push(chunk)
              return "etag"
            },
            completeUpload: () => {
              completed = true
            },
          }).pipe(Stream.provideLayer(LoggerServiceLive)),
        )

        // Upload reached `completeUpload` — the lib did NOT detect the
        // corruption. This is the codified trust-boundary contract.
        expect(completed).toBe(true)
        // Bytes uploaded are the malformed ones, NOT the source.
        const uploaded = uploadedChunks.flatMap(c => Array.from(c))
        expect(uploaded).toEqual([0xff, 0xfe, 0xfd, 0xfc])
        expect(uploaded.length).not.toBe(input.byteLength)
      }),
  )
})
