import { execFileSync, spawnSync } from "node:child_process"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import type { ReadmeBlock } from "./extract-readme-blocks.js"

/**
 * Shared doctest harness helpers (extracted from Story 10.6's `doctest.test.ts`
 * so Story 11.7's resume/compression/test-app doctests can reuse the exact same
 * compile + `spawnSync` pipeline rather than reinventing it).
 *
 * Pattern (MEMORY): vitest's Vite loader can't dynamic-import freshly-emitted
 * /tmp files, so compiled doctest blocks are loaded inside a fresh Node child
 * process via `spawnSync(process.execPath, [harnessPath])`.
 */

const __dirname = dirname(fileURLToPath(import.meta.url))
export const REPO_ROOT = resolve(__dirname, "../../..")
export const TESTS_ROOT = resolve(__dirname, "../..")
export const README_PATH = join(REPO_ROOT, "README.md")
export const HARNESS_DIR = join(__dirname, ".doctest-tmp")

export const requireEnv = (key: string): string => {
  const v = process.env[key]
  if (!v) {
    throw new Error(
      `${key} not set — vitest globalSetup may not have run. ` +
        `Run via pnpm --filter @tranquilload/tests test:integration.`,
    )
  }
  return v
}

export interface WrapSpec {
  readonly id: string
  /** Typed parameter list, e.g. `{ file: File }`. Empty string for no params. */
  readonly paramSignature: string
  /** Lines injected ABOVE the block's imports. */
  readonly prelude?: string
  /** When false, body is spliced at top-level (compile-only block). */
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
    if (trimmed === "" || trimmed.startsWith("//") || /^import\b/.test(trimmed)) {
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

export const buildWrappedSource = (block: ReadmeBlock, spec: WrapSpec): string => {
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

export interface CompiledBlock {
  emittedJs: string
  sourceTs: string
}

export const compileBlock = (
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
  writeFileSync(join(subDir, "tsconfig.json"), JSON.stringify(tsconfig, null, 2))

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

export interface HarnessResult {
  stdout: string
  stderr: string
  parsed: unknown
}

export const runHarness = (
  id: string,
  harnessSource: string,
  env: Record<string, string>,
  /**
   * cwd for the spawned harness. Defaults to the tests workspace (so the
   * harness can `import "@aws-sdk/..."` via tests/node_modules). Pass the DIST
   * fixture dir when the harness imports bare `effect` / `@tranquilload/*`
   * (those resolve via the fixture's installed deps, not tests/node_modules).
   */
  cwd: string = TESTS_ROOT,
): HarnessResult => {
  // Node resolves a harness's bare imports relative to the harness FILE, not
  // the cwd — so place the harness inside `cwd` so its node_modules tree is the
  // intended one.
  const harnessHome = cwd === TESTS_ROOT ? HARNESS_DIR : cwd
  mkdirSync(harnessHome, { recursive: true })
  const harnessPath = join(harnessHome, `__doctest-harness-${id}.mjs`)
  writeFileSync(harnessPath, harnessSource)

  const result = spawnSync(process.execPath, [harnessPath], {
    cwd,
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
    const lastLine =
      result.stdout
        .trim()
        .split("\n")
        .filter((l) => l.trim().length > 0)
        .pop() ?? ""
    parsed = JSON.parse(lastLine)
  } catch {
    parsed = null
  }
  return { stdout: result.stdout, stderr: result.stderr, parsed }
}

export const isMinioReachable = async (): Promise<boolean> => {
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

export const ensureBucket = async (
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
