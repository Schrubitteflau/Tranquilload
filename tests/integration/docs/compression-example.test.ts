import { readFileSync } from "node:fs"
import { beforeAll, describe, expect, it } from "vitest"

import {
  buildWrappedSource,
  compileBlock,
  README_PATH,
  requireEnv,
  runHarness,
  type WrapSpec,
} from "./doctest-harness.js"
import {
  extractReadmeBlocks,
  findBlock,
  type ReadmeBlock,
} from "./extract-readme-blocks.js"

/**
 * Story 11.7 — 11.7-D-002 (G#27) — README compression example.
 *
 * Two guarantees:
 *   1. COMPILE — the README "Client-side compression in the pipeline" block
 *      type-checks against the published `.d.mts` (free vars `stream`,
 *      `totalBytes`, `s3` declared in the prelude, mirroring the multipart
 *      example wiring).
 *   2. RUN + SIZE ASSERTION — `compress("deflate-raw")` is resolved via the
 *      published `CompressionServiceLive` layer and driven over highly
 *      compressible bytes; the OUTPUT must be materially smaller than the INPUT,
 *      proving compression actually happens (not a no-op transform).
 */

let fixtureDir: string
let blocks: ReadonlyArray<ReadmeBlock>

describe("Story 11.7 — README compression doctest (G#27)", () => {
  beforeAll(() => {
    fixtureDir = requireEnv("DIST_FIXTURE_DIR")
    blocks = extractReadmeBlocks(readFileSync(README_PATH, "utf8"))
  })

  it("11.7-D-002 (G#27) — compression example compiles and compress(deflate-raw) shrinks bytes", () => {
    const block = findBlock(
      blocks,
      (b) => b.lang === "ts" && b.heading.startsWith("Client-side compression"),
      "Client-side compression in the pipeline",
    )

    // COMPILE: the example references free vars `stream`, `totalBytes`, `s3`.
    // Declare them so the README body type-checks against the published types.
    const spec: WrapSpec = {
      id: "d002-compression",
      paramSignature: "",
      executable: false,
      prelude: [
        `import { s3MultipartUpload } from "@tranquilload/adapters/s3MultipartUpload"`,
        `declare const stream: ReadableStream<Uint8Array>`,
        `declare const totalBytes: number`,
        // `...s3` injects chunkSize + initiate + uploadPart + completeUpload —
        // i.e. the s3MultipartUpload adapter's return type.
        `declare const s3: ReturnType<typeof s3MultipartUpload>`,
        ``,
      ].join("\n"),
    }
    const source = buildWrappedSource(block, spec)
    compileBlock(fixtureDir, spec, source, { emit: false }, block)

    // RUN + SIZE ASSERTION: resolve compress("deflate-raw") via the published
    // CompressionServiceLive layer and measure the byte reduction over 64 KiB
    // of highly-compressible input (all zeros → near-maximum deflate ratio).
    const harness = `
import { compress } from "@tranquilload/core/pipeline"
import { CompressionServiceLive } from "@tranquilload/core/services"
import { Effect } from "effect"

const transform = await Effect.runPromise(
  Effect.provide(compress("deflate-raw"), CompressionServiceLive),
)

const INPUT_BYTES = 64 * 1024
const input = new Uint8Array(INPUT_BYTES) // all zeros — maximally compressible
const inputStream = new Response(input).body

const out = transform(inputStream)
const reader = out.getReader()
let outputBytes = 0
for (;;) {
  const { value, done } = await reader.read()
  if (done) break
  if (value) outputBytes += value.byteLength
}

process.stdout.write(JSON.stringify({ inputBytes: INPUT_BYTES, outputBytes }))
`

    // Run from the DIST fixture dir so the harness's bare imports
    // (`@tranquilload/core/*`, `effect`) resolve via the fixture's installed
    // deps — the published packages exactly as a downstream consumer sees them.
    const result = runHarness("d002-compression", harness, {}, fixtureDir)
    const { inputBytes, outputBytes } = result.parsed as {
      inputBytes: number
      outputBytes: number
    }

    expect(inputBytes).toBe(64 * 1024)
    expect(outputBytes).toBeGreaterThan(0)
    // Compression genuinely happened: output is a small fraction of input.
    expect(
      outputBytes,
      `Expected deflate-raw to shrink ${inputBytes}B; got ${outputBytes}B output.`,
    ).toBeLessThan(inputBytes)
    // For all-zeros, deflate should achieve well over 90% reduction — a strict
    // ratio assertion documents the example's size claim and guards regressions.
    expect(outputBytes).toBeLessThan(inputBytes * 0.1)
  })
})
