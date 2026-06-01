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
  // 11.2-INT-003 (F#68) — Default `CompressionServiceLive` round-trips on Node 22+
  //
  // Scope (Pattern 3): Node 22 (the minimum supported runtime per
  // `engines.node`) exposes `globalThis.CompressionStream` natively, so the
  // Layer's runtime probe MUST succeed and yield a WORKING compression
  // transform. We prove "working" via a deflate-raw → inflate-raw round-trip
  // and byte-identity assertion against the source — a non-empty-output check
  // alone could pass even if compress returned random garbage.
  //
  // Browser-side parameterization: vitest browser-mode is not configured in
  // this repo (deferred per epics.md / Epic 13 candidate). The 3-browser axis
  // (chromium / firefox / webkit) is discharged honestly by the existing
  // 10.4-E2E-005 PW-Lib spec (`tests/e2e/lib/deflate-raw.spec.ts`), which
  // runs the same `new CompressionStream("deflate-raw")` probe inside each
  // engine's DOM realm.
  // ────────────────────────────────────────────────────────────────────────────
  it.effect(
    "11.2-INT-003 (F#68) — CompressionServiceLive deflate-raw round-trips byte-identical on Node 22+",
    () =>
      Effect.gen(function* () {
        const svc = yield* Effect.provide(CompressionService, CompressionServiceLive)

        // Use a non-trivial source — random-ish bytes so compress() actually
        // does work (a zero-fill could degenerate into a near-empty payload
        // and mask a broken implementation).
        const source = new Uint8Array(256).map((_, i) => (i * 31 + 7) & 0xff)

        // Compress via the Live service.
        const compressed = svc.compress(fromBytes(source), "deflate-raw")
        const compressedBytes = yield* Effect.promise(() => collectAll(compressed))
        expect(compressedBytes.byteLength).toBeGreaterThan(0)

        // Decompress via DOM `DecompressionStream("deflate-raw")` — the inverse
        // primitive. Identity (decompress ∘ compress) must equal the source.
        const decompressed = fromBytes(compressedBytes).pipeThrough(
          new DecompressionStream("deflate-raw") as unknown as TransformStream<
            Uint8Array,
            Uint8Array
          >,
        )
        const roundTripped = yield* Effect.promise(() => collectAll(decompressed))

        expect(roundTripped.byteLength, "round-trip length must match source").toBe(
          source.byteLength,
        )
        expect(
          Array.from(roundTripped),
          "round-trip bytes must equal source byte-for-byte",
        ).toEqual(Array.from(source))
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
