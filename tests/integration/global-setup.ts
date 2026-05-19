import { execSync } from "node:child_process"
import {
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(__dirname, "../..")

const log = (msg: string) => console.log(`[dist-integrity setup] ${msg}`)

const sh = (cmd: string, cwd: string) =>
  execSync(cmd, { cwd, stdio: "inherit", env: { ...process.env } })

const TYPED_CONSUMER_TS = `import { uploadMultipart } from "@tranquilload/core/multipart"
import type { ResumeState } from "@tranquilload/core/multipart"
import { uploadOnce } from "@tranquilload/core/oneshot"
import { fromFile } from "@tranquilload/adapters/fromFile"
import { s3MultipartUpload } from "@tranquilload/adapters/s3MultipartUpload"
import { Match } from "effect"
import type { UploadError } from "@tranquilload/core/errors"

// Smoke: verify the public surface is named-exported and types resolve under
// strict + noUncheckedIndexedAccess + exactOptionalPropertyTypes.
const _uploadMultipart: typeof uploadMultipart = uploadMultipart
const _uploadOnce: typeof uploadOnce = uploadOnce
const _fromFile: typeof fromFile = fromFile
const _s3: typeof s3MultipartUpload = s3MultipartUpload

// Exhaustive switch over UploadError union — would fail to compile if a new
// variant is added without updating the dispatcher.
declare const err: UploadError
const _matched: string = Match.value(err).pipe(
  Match.tag("PartUploadError", () => "part"),
  Match.tag("MaxRetriesExceededError", () => "retries"),
  Match.tag("PresignedUrlError", () => "presign"),
  Match.tag("InitiateUploadError", () => "initiate"),
  Match.tag("ReconcileError", () => "reconcile"),
  Match.tag("CompleteUploadError", () => "complete"),
  Match.tag("AbortError", () => "abort"),
  Match.tag("CircuitOpenError", () => "circuit"),
  Match.tag("ResumeMismatchError", () => "resume"),
  Match.exhaustive,
)

declare const rs: ResumeState
const _rsCheck: string = rs.uploadId

export { _matched, _rsCheck, _uploadMultipart, _uploadOnce, _fromFile, _s3 }
`

const STRICT_TSCONFIG = JSON.stringify(
  {
    compilerOptions: {
      target: "ES2022",
      module: "NodeNext",
      moduleResolution: "NodeNext",
      lib: ["ES2022", "DOM"],
      strict: true,
      noUncheckedIndexedAccess: true,
      exactOptionalPropertyTypes: true,
      esModuleInterop: true,
      skipLibCheck: true,
      noEmit: true,
      types: [],
    },
    include: ["typed-consumer.ts"],
  },
  null,
  2,
)

const ESM_IMPORT_MJS = `import { uploadMultipart } from "@tranquilload/core/multipart"
import { uploadOnce } from "@tranquilload/core/oneshot"
import { fromFile } from "@tranquilload/adapters/fromFile"
import { s3MultipartUpload } from "@tranquilload/adapters/s3MultipartUpload"

if (typeof uploadMultipart !== "function") {
  console.error("uploadMultipart is not a function")
  process.exit(1)
}
if (typeof uploadOnce !== "function") {
  console.error("uploadOnce is not a function")
  process.exit(1)
}
if (typeof fromFile !== "function") {
  console.error("fromFile is not a function")
  process.exit(1)
}
if (typeof s3MultipartUpload !== "function") {
  console.error("s3MultipartUpload is not a function")
  process.exit(1)
}
console.log("ESM_OK")
`

const CJS_REQUIRE_CJS = `const { uploadMultipart } = require("@tranquilload/core/multipart")
const { uploadOnce } = require("@tranquilload/core/oneshot")
const { fromFile } = require("@tranquilload/adapters/fromFile")
const { s3MultipartUpload } = require("@tranquilload/adapters/s3MultipartUpload")

if (typeof uploadMultipart !== "function") {
  console.error("uploadMultipart is not a function")
  process.exit(1)
}
if (typeof uploadOnce !== "function") {
  console.error("uploadOnce is not a function")
  process.exit(1)
}
if (typeof fromFile !== "function") {
  console.error("fromFile is not a function")
  process.exit(1)
}
if (typeof s3MultipartUpload !== "function") {
  console.error("s3MultipartUpload is not a function")
  process.exit(1)
}
console.log("CJS_OK")
`

export default async function setup(): Promise<() => Promise<void>> {
  const skipBuild = process.env.DIST_SKIP_BUILD === "1"

  if (!skipBuild) {
    log("Running pnpm turbo build to refresh dist artifacts...")
    sh("pnpm turbo build", REPO_ROOT)
  } else {
    log("DIST_SKIP_BUILD=1 — assuming dist is up to date.")
  }

  const packDir = mkdtempSync(join(tmpdir(), "tranquilload-packs-"))
  log(`Packing core + adapters to ${packDir}`)
  sh(
    `pnpm pack --pack-destination ${packDir}`,
    join(REPO_ROOT, "packages/tranquilload-core"),
  )
  sh(
    `pnpm pack --pack-destination ${packDir}`,
    join(REPO_ROOT, "packages/tranquilload-adapters"),
  )

  const packed = readdirSync(packDir).filter((f) => f.endsWith(".tgz"))
  const coreTgz = packed.find((f) => f.startsWith("tranquilload-core-"))
  const adaptersTgz = packed.find((f) => f.startsWith("tranquilload-adapters-"))
  if (!coreTgz || !adaptersTgz) {
    throw new Error(
      `Expected core and adapters tarballs in ${packDir}, got: ${packed.join(", ")}`,
    )
  }

  const consumerDir = mkdtempSync(join(tmpdir(), "tranquilload-consumer-"))
  log(`Building consumer fixture at ${consumerDir}`)

  const consumerPkg = {
    name: "tranquilload-dist-consumer",
    version: "0.0.0",
    private: true,
    type: "module",
    dependencies: {
      "@tranquilload/core": `file:${join(packDir, coreTgz)}`,
      "@tranquilload/adapters": `file:${join(packDir, adaptersTgz)}`,
      effect: "3.19.19",
    },
    devDependencies: {
      typescript: "^5.5.0",
    },
  }
  writeFileSync(
    join(consumerDir, "package.json"),
    JSON.stringify(consumerPkg, null, 2),
  )
  writeFileSync(join(consumerDir, "tsconfig.json"), STRICT_TSCONFIG)
  writeFileSync(join(consumerDir, "typed-consumer.ts"), TYPED_CONSUMER_TS)
  writeFileSync(join(consumerDir, "esm-import.mjs"), ESM_IMPORT_MJS)
  writeFileSync(join(consumerDir, "cjs-require.cjs"), CJS_REQUIRE_CJS)

  log("Installing consumer fixture (npm install)...")
  execSync(
    "npm install --no-audit --no-fund --no-package-lock --prefer-offline --loglevel=error",
    {
      cwd: consumerDir,
      stdio: "inherit",
      env: { ...process.env },
    },
  )

  process.env.DIST_FIXTURE_DIR = consumerDir
  process.env.DIST_REPO_ROOT = REPO_ROOT
  process.env.DIST_PACK_DIR = packDir

  log(`Setup complete. Consumer fixture: ${consumerDir}`)

  return async () => {
    if (process.env.DIST_KEEP_FIXTURE === "1") {
      log(`DIST_KEEP_FIXTURE=1 — leaving ${consumerDir} and ${packDir} intact.`)
      return
    }
    rmSync(packDir, { recursive: true, force: true })
    rmSync(consumerDir, { recursive: true, force: true })
  }
}
