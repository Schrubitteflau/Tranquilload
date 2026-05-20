import { execFileSync, spawnSync } from "node:child_process"
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { pathToFileURL, fileURLToPath } from "node:url"
import { beforeAll, describe, expect, it } from "vitest"

import {
  extractReadmeBlocks,
  findBlock,
  type ReadmeBlock,
} from "./extract-readme-blocks.js"

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(__dirname, "../../..")
const TESTS_ROOT = resolve(__dirname, "../..")
const README_PATH = join(REPO_ROOT, "README.md")
const HARNESS_DIR = join(__dirname, ".doctest-tmp")

const requireEnv = (key: string): string => {
  const v = process.env[key]
  if (!v) {
    throw new Error(
      `${key} not set — vitest globalSetup may not have run. ` +
        `Run via pnpm --filter @tranquilload/tests test:integration.`,
    )
  }
  return v
}

interface WrapSpec {
  readonly id: string
  /** Typed parameter list, e.g. `{ file: File }`. Empty string for no params. */
  readonly paramSignature: string
  /** Lines injected ABOVE the block's imports. */
  readonly prelude?: string
  /** When false, body is spliced at top-level (compile-only Match.tag block). */
  readonly executable: boolean
}

const splitImports = (
  code: string,
): { imports: ReadonlyArray<string>; body: string } => {
  const lines = code.split(/\r?\n/)
  const imports: string[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i] ?? ""
    const trimmed = line.trim()
    if (
      trimmed === "" ||
      trimmed.startsWith("//") ||
      /^import\b/.test(trimmed)
    ) {
      imports.push(line)
      i++
      continue
    }
    break
  }
  return { imports, body: lines.slice(i).join("\n") }
}

const indent = (text: string, prefix: string): string =>
  text
    .split("\n")
    .map((l) => (l.length === 0 ? l : prefix + l))
    .join("\n")

const buildWrappedSource = (block: ReadmeBlock, spec: WrapSpec): string => {
  const { imports, body } = splitImports(block.code)
  const importsBlock = imports.join("\n")
  const preludeBlock = spec.prelude ?? ""
  if (!spec.executable) {
    return `${preludeBlock}\n${importsBlock}\n\n${body}\n`
  }
  return `${preludeBlock}
${importsBlock}

export async function run(${spec.paramSignature}): Promise<void> {
${indent(body, "  ")}
}
`
}

interface CompiledBlock {
  emittedJs: string
  sourceTs: string
}

const compileBlock = (
  fixtureDir: string,
  spec: WrapSpec,
  source: string,
  opts: { emit: boolean },
  block: ReadmeBlock,
): CompiledBlock => {
  const subDir = join(fixtureDir, "doctest", spec.id)
  rmSync(subDir, { recursive: true, force: true })
  mkdirSync(subDir, { recursive: true })

  const sourceTs = join(subDir, `${spec.id}.mts`)
  writeFileSync(sourceTs, source)

  const tsconfig = {
    compilerOptions: {
      target: "ES2022",
      module: "NodeNext",
      moduleResolution: "NodeNext",
      lib: ["ES2022", "DOM", "DOM.AsyncIterable"],
      strict: true,
      skipLibCheck: true,
      esModuleInterop: true,
      ...(opts.emit ? { outDir: "out" } : { noEmit: true }),
      types: [],
    },
    include: [`${spec.id}.mts`],
  }
  writeFileSync(
    join(subDir, "tsconfig.json"),
    JSON.stringify(tsconfig, null, 2),
  )

  const tscBin = join(fixtureDir, "node_modules", ".bin", "tsc")
  try {
    execFileSync(tscBin, ["-p", "tsconfig.json"], {
      cwd: subDir,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
      encoding: "utf8",
    })
  } catch (e) {
    const err = e as { stdout?: Buffer | string; stderr?: Buffer | string }
    const stdout = String(err.stdout ?? "")
    const stderr = String(err.stderr ?? "")
    throw new Error(
      `tsc failed for doctest "${spec.id}" (README "${block.heading}" @ line ${block.startLine}).\n` +
        `--- source ---\n${source}\n` +
        `--- tsc stdout ---\n${stdout}\n` +
        `--- tsc stderr ---\n${stderr}`,
    )
  }

  return {
    sourceTs,
    emittedJs: opts.emit ? join(subDir, "out", `${spec.id}.mjs`) : sourceTs,
  }
}

/**
 * Spawns a Node child process to run a harness script that loads a compiled
 * doctest block. Necessary because vitest's Vite-based loader can't
 * dynamic-import freshly-emitted files outside the project root — a clean
 * Node process resolves them via the standard ESM loader.
 *
 * Harness `cwd` is set to the tests workspace so the harness itself can
 * `import "@aws-sdk/..."` etc. via `tests/node_modules`. The harness then
 * loads the compiled .mjs from `/tmp/...` via an absolute file URL; that
 * .mjs's own `import "@tranquilload/..."` resolves via the fixture's
 * node_modules (where pnpm pack + npm install placed them in global-setup).
 */
interface HarnessResult {
  stdout: string
  stderr: string
  parsed: unknown
}

const runHarness = (
  id: string,
  harnessSource: string,
  env: Record<string, string>,
): HarnessResult => {
  mkdirSync(HARNESS_DIR, { recursive: true })
  const harnessPath = join(HARNESS_DIR, `${id}.mjs`)
  writeFileSync(harnessPath, harnessSource)

  const result = spawnSync(process.execPath, [harnessPath], {
    cwd: TESTS_ROOT,
    env: { ...process.env, ...env },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  })
  if (result.status !== 0) {
    throw new Error(
      `Harness "${id}" exited status=${result.status} signal=${result.signal}.\n` +
        `--- spawn error ---\n${result.error ? result.error.stack ?? String(result.error) : "(none)"}\n` +
        `--- harness ---\n${harnessSource}\n` +
        `--- env ---\n${JSON.stringify(Object.keys(env))}\n` +
        `--- stdout ---\n${result.stdout}\n` +
        `--- stderr ---\n${result.stderr}`,
    )
  }
  let parsed: unknown
  try {
    // Harness output convention: JSON on the last non-empty stdout line.
    const lastLine =
      result.stdout
        .trim()
        .split("\n")
        .filter((l) => l.trim().length > 0)
        .pop() ?? ""
    parsed = JSON.parse(lastLine)
  } catch (e) {
    parsed = null
  }
  return { stdout: result.stdout, stderr: result.stderr, parsed }
}

let fixtureDir: string
let blocks: ReadonlyArray<ReadmeBlock>

describe("Story 10.6 — README doctests (G#23, G#24, G#28)", () => {
  beforeAll(() => {
    fixtureDir = requireEnv("DIST_FIXTURE_DIR")
    blocks = extractReadmeBlocks(readFileSync(README_PATH, "utf8"))
  })

  // --- 10.6-D-001 (G#23) ---------------------------------------------------
  it(
    "10.6-D-001 — README one-shot example compiles and runs against a mocked HTTP server",
    async () => {
      const oneShot = findBlock(
        blocks,
        (b) => b.lang === "ts" && b.heading.startsWith("One-shot upload"),
        "One-shot upload",
      )
      const spec: WrapSpec = {
        id: "d001-oneshot",
        paramSignature: "{ file }: { file: File }",
        executable: true,
      }
      const source = buildWrappedSource(oneShot, spec)
      const { emittedJs } = compileBlock(
        fixtureDir,
        spec,
        source,
        { emit: true },
        oneShot,
      )

      const payload = new TextEncoder().encode("hello-doctest-oneshot")
      const harness = `
const captured = { url: "", method: "", contentType: "", bodyBase64: "" }
globalThis.fetch = async (input, init) => {
  captured.url = input instanceof URL ? input.toString() : String(input)
  captured.method = (init && init.method) || "GET"
  if (init && init.headers && typeof init.headers === "object") {
    const h = init.headers
    captured.contentType = h["Content-Type"] || h["content-type"] || ""
  }
  const body = init && init.body
  let bytes = new Uint8Array(0)
  if (body && typeof body.getReader === "function") {
    const reader = body.getReader()
    const chunks = []
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (value) chunks.push(value)
    }
    const total = chunks.reduce((acc, c) => acc + c.length, 0)
    bytes = new Uint8Array(total)
    let off = 0
    for (const c of chunks) { bytes.set(c, off); off += c.length }
  } else if (body instanceof Uint8Array) {
    bytes = body
  } else if (body && typeof body.arrayBuffer === "function") {
    bytes = new Uint8Array(await body.arrayBuffer())
  }
  captured.bodyBase64 = Buffer.from(bytes).toString("base64")
  return new Response(null, { status: 200 })
}

const { run } = await import(process.env.DOCTEST_MODULE_URL)
const fileBytes = Buffer.from(process.env.DOCTEST_FILE_B64, "base64")
const file = new File([fileBytes], process.env.DOCTEST_FILE_NAME, {
  type: process.env.DOCTEST_FILE_TYPE,
})
await run({ file })
process.stdout.write(JSON.stringify(captured))
`

      const result = runHarness("d001-oneshot", harness, {
        DOCTEST_MODULE_URL: pathToFileURL(emittedJs).href,
        DOCTEST_FILE_B64: Buffer.from(payload).toString("base64"),
        DOCTEST_FILE_NAME: "hello.txt",
        DOCTEST_FILE_TYPE: "text/plain",
      })

      const captured = result.parsed as {
        url: string
        method: string
        contentType: string
        bodyBase64: string
      }
      expect(captured.url).toBe("https://api.example.com/upload")
      expect(captured.method).toBe("PUT")
      expect(captured.contentType).toBe("text/plain")
      const receivedBytes = Buffer.from(captured.bodyBase64, "base64")
      expect(receivedBytes.toString("utf8")).toBe("hello-doctest-oneshot")
    },
  )

  // --- 10.6-D-002 (G#24) ---------------------------------------------------
  it(
    "10.6-D-002 — README multipart example compiles and runs against MinIO",
    async () => {
      const minioReachable = await isMinioReachable()
      if (!minioReachable) {
        if (process.env.MINIO_REQUIRED === "1") {
          throw new Error(
            `MINIO_REQUIRED=1 but MinIO at ${process.env.MINIO_ENDPOINT ?? "http://localhost:9000"} is unreachable.`,
          )
        }
        console.warn(
          "[10.6-D-002] MinIO not reachable — skipping. Run `pnpm minio:up` to enable.",
        )
        return
      }

      const multipart = findBlock(
        blocks,
        (b) => b.lang === "ts" && b.heading.startsWith("Multipart upload to S3"),
        "Multipart upload to S3",
      )
      const spec: WrapSpec = {
        id: "d002-multipart",
        paramSignature:
          "{ file, s3Client, localStorage }: { file: File; s3Client: import(\"@tranquilload/adapters/s3MultipartUpload\").S3Client; localStorage: { setItem(k: string, v: string): void; getItem(k: string): string | null; removeItem(k: string): void } }",
        executable: true,
      }
      const source = buildWrappedSource(multipart, spec)
      const { emittedJs } = compileBlock(
        fixtureDir,
        spec,
        source,
        { emit: true },
        multipart,
      )

      const headSize = 5 * 1024 * 1024
      const tailSize = 1 * 1024 * 1024
      const payload = new Uint8Array(headSize + tailSize)
      for (let i = 0; i < payload.length; i++) payload[i] = i & 0xff
      const filename = `doctest-d002-${Date.now()}.bin`
      // 6 MiB as base64 in an env var blows ARG_MAX (E2BIG). Stage to disk.
      mkdirSync(HARNESS_DIR, { recursive: true })
      const payloadPath = join(HARNESS_DIR, `d002-payload.bin`)
      writeFileSync(payloadPath, payload)
      // The README example hardcodes bucket "my-bucket"; pre-create it.
      const aws = await import("@aws-sdk/client-s3")
      const verifyClient = new aws.S3Client({
        endpoint: process.env.MINIO_ENDPOINT ?? "http://localhost:9000",
        region: process.env.MINIO_REGION ?? "us-east-1",
        credentials: {
          accessKeyId: process.env.MINIO_ACCESS_KEY ?? "minioadmin",
          secretAccessKey: process.env.MINIO_SECRET_KEY ?? "minioadmin",
        },
        forcePathStyle: true,
      })
      await ensureBucket(verifyClient, "my-bucket")

      const harness = `
import {
  S3Client,
  CreateMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  UploadPartCommand,
} from "@aws-sdk/client-s3"
import { getSignedUrl } from "@aws-sdk/s3-request-presigner"

const realClient = new S3Client({
  endpoint: process.env.MINIO_ENDPOINT,
  region: process.env.MINIO_REGION,
  credentials: {
    accessKeyId: process.env.MINIO_ACCESS_KEY,
    secretAccessKey: process.env.MINIO_SECRET_KEY,
  },
  forcePathStyle: true,
})

const bucket = process.env.DOCTEST_BUCKET
const key = process.env.DOCTEST_KEY

const s3Client = {
  createMultipartUpload: async (params) =>
    realClient.send(new CreateMultipartUploadCommand(params)),
  completeMultipartUpload: async (params) =>
    realClient.send(
      new CompleteMultipartUploadCommand({
        Bucket: params.Bucket,
        Key: params.Key,
        UploadId: params.UploadId,
        MultipartUpload: { Parts: [...params.MultipartUpload.Parts] },
      }),
    ),
}

const originalFetch = globalThis.fetch
globalThis.fetch = async (input, init) => {
  const url =
    input instanceof URL
      ? input.toString()
      : typeof input === "string"
        ? input
        : String(input.url)
  if (url.startsWith("/api/sign?")) {
    const params = new URL(url, "http://placeholder/").searchParams
    const uploadId = params.get("uploadId") || ""
    const partNumber = Number(params.get("part") || "1")
    const signed = await getSignedUrl(
      realClient,
      new UploadPartCommand({
        Bucket: bucket,
        Key: key,
        UploadId: uploadId,
        PartNumber: partNumber,
      }),
      { expiresIn: 600 },
    )
    return new Response(signed, { status: 200 })
  }
  return originalFetch(input, init)
}

const memStorage = new Map()
const localStorage = {
  setItem: (k, v) => memStorage.set(k, v),
  getItem: (k) => (memStorage.has(k) ? memStorage.get(k) : null),
  removeItem: (k) => memStorage.delete(k),
}

const { readFileSync } = await import("node:fs")
const fileBytes = readFileSync(process.env.DOCTEST_FILE_PATH)
const file = new File([fileBytes], process.env.DOCTEST_FILE_NAME, {
  type: process.env.DOCTEST_FILE_TYPE,
})

const { run } = await import(process.env.DOCTEST_MODULE_URL)
await run({ file, s3Client, localStorage })

process.stdout.write(
  JSON.stringify({
    persistedUploadId: memStorage.get("upload:current") || null,
  }),
)
`

      runHarness("d002-multipart", harness, {
        DOCTEST_MODULE_URL: pathToFileURL(emittedJs).href,
        DOCTEST_FILE_PATH: payloadPath,
        DOCTEST_FILE_NAME: filename,
        DOCTEST_FILE_TYPE: "application/octet-stream",
        DOCTEST_BUCKET: "my-bucket",
        DOCTEST_KEY: `uploads/${filename}`,
        MINIO_ENDPOINT: process.env.MINIO_ENDPOINT ?? "http://localhost:9000",
        MINIO_REGION: process.env.MINIO_REGION ?? "us-east-1",
        MINIO_ACCESS_KEY: process.env.MINIO_ACCESS_KEY ?? "minioadmin",
        MINIO_SECRET_KEY: process.env.MINIO_SECRET_KEY ?? "minioadmin",
      })

      const head = await verifyClient.send(
        new aws.HeadObjectCommand({
          Bucket: "my-bucket",
          Key: `uploads/${filename}`,
        }),
      )
      expect(head.ContentLength).toBe(payload.length)

      const got = await verifyClient.send(
        new aws.GetObjectCommand({
          Bucket: "my-bucket",
          Key: `uploads/${filename}`,
        }),
      )
      const bodyBytes = await got.Body!.transformToByteArray()
      expect(bodyBytes.length).toBe(payload.length)
      expect(bodyBytes[0]).toBe(payload[0])
      expect(bodyBytes[headSize]).toBe(payload[headSize])
      expect(bodyBytes[bodyBytes.length - 1]).toBe(payload[payload.length - 1])

      await verifyClient
        .send(
          new aws.DeleteObjectCommand({
            Bucket: "my-bucket",
            Key: `uploads/${filename}`,
          }),
        )
        .catch(() => undefined)
    },
    120_000,
  )

  // --- 10.6-D-003 (G#28) ---------------------------------------------------
  it("10.6-D-003 — README Match.tag block compiles exhaustively over the UploadError union", () => {
    const matchBlock = findBlock(
      blocks,
      (b) => b.lang === "ts" && b.heading.startsWith("Errors are data"),
      "Errors are data (Match.tag)",
    )
    const spec: WrapSpec = {
      id: "d003-matchtag",
      paramSignature: "",
      executable: false,
      prelude: [
        `import type { UploadError } from "@tranquilload/core/errors"`,
        `declare const result: Promise<unknown>`,
        ``,
      ].join("\n"),
    }
    const source = buildWrappedSource(matchBlock, spec)
    compileBlock(fixtureDir, spec, source, { emit: false }, matchBlock)
  })
})

const isMinioReachable = async (): Promise<boolean> => {
  const endpoint = process.env.MINIO_ENDPOINT ?? "http://localhost:9000"
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 1_500)
  try {
    const res = await fetch(`${endpoint}/minio/health/live`, {
      signal: controller.signal,
    })
    return res.ok
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

const ensureBucket = async (
  client: import("@aws-sdk/client-s3").S3Client,
  bucket: string,
): Promise<void> => {
  const { HeadBucketCommand, CreateBucketCommand } = await import(
    "@aws-sdk/client-s3"
  )
  try {
    await client.send(new HeadBucketCommand({ Bucket: bucket }))
  } catch {
    await client.send(new CreateBucketCommand({ Bucket: bucket }))
  }
}
