import { execFileSync } from "node:child_process"
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { beforeAll, describe, expect, it } from "vitest"

const __dirname = dirname(fileURLToPath(import.meta.url))

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

let FIXTURE_DIR: string
let REPO_ROOT: string

beforeAll(() => {
  FIXTURE_DIR = requireEnv("DIST_FIXTURE_DIR")
  REPO_ROOT = requireEnv("DIST_REPO_ROOT")
})

type PackageExports = Record<
  string,
  { types?: string; import?: string; require?: string } | string
>

const corePkgPath = (root: string) =>
  join(root, "packages/tranquilload-core/package.json")
const adaptersPkgPath = (root: string) =>
  join(root, "packages/tranquilload-adapters/package.json")

const readPkg = (path: string): { name: string; exports: PackageExports } =>
  JSON.parse(readFileSync(path, "utf8"))

const exec = (
  bin: string,
  args: ReadonlyArray<string>,
  cwd: string,
): { stdout: string; stderr: string } => {
  // execFileSync throws on non-zero exit; on success returns stdout buffer.
  // We want both streams to surface useful failure messages, so wrap.
  try {
    const stdout = execFileSync(bin, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
      encoding: "utf8",
    })
    return { stdout, stderr: "" }
  } catch (e) {
    const err = e as NodeJS.ErrnoException & {
      stdout?: Buffer
      stderr?: Buffer
      status?: number
    }
    const stdout = err.stdout?.toString("utf8") ?? ""
    const stderr = err.stderr?.toString("utf8") ?? ""
    throw new Error(
      `${bin} ${args.join(" ")} (cwd=${cwd}) failed with status ${err.status}\n` +
        `--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`,
    )
  }
}

describe("Story 10.5 — DIST integrity (G#9–G#14)", () => {
  // --- 10.5-X-001 (G#9) ----------------------------------------------------
  it("10.5-X-001 — ESM consumer can import every published entry (fresh node esm-import.mjs)", () => {
    const { stdout } = exec("node", ["esm-import.mjs"], FIXTURE_DIR)
    expect(stdout.trim().split("\n").pop()).toBe("ESM_OK")
  })

  // --- 10.5-X-002 (G#10) ---------------------------------------------------
  it("10.5-X-002 — CJS consumer can require() every published entry", () => {
    const { stdout } = exec("node", ["cjs-require.cjs"], FIXTURE_DIR)
    expect(stdout.trim().split("\n").pop()).toBe("CJS_OK")
  })

  // --- 10.5-X-003 (G#11) ---------------------------------------------------
  it("10.5-X-003 — Strict TypeScript downstream compiles against published .d.mts", () => {
    // Use the fixture's local tsc so version + lib resolution match a downstream consumer's.
    const tscBin = join(FIXTURE_DIR, "node_modules", ".bin", "tsc")
    exec(tscBin, ["-p", "."], FIXTURE_DIR)
  })

  // --- 10.5-X-004 (G#12) ---------------------------------------------------
  describe("10.5-X-004 — `effect` is not bundled into dist (peer-dep contract)", () => {
    const collectDistFiles = (distDir: string): Array<string> =>
      readdirSync(distDir)
        .filter((name) => /\.(mjs|cjs)$/.test(name))
        .map((name) => join(distDir, name))

    // Pull import/require specifiers from a file (handles `from "x"`,
    // `import "x"`, `require("x")`).
    const specifierRegex =
      /(?:\bfrom\s*|\bimport\s*|\brequire\s*\()\s*["']([^"']+)["']/g

    const checkPackageExternalizesEffect = (
      pkgRel: string,
      distRel: string,
    ): void => {
      const distDir = join(REPO_ROOT, pkgRel, distRel)
      const files = collectDistFiles(distDir)
      expect(files.length, `Expected dist files in ${distDir}`).toBeGreaterThan(0)

      const issues: Array<string> = []
      let totalBytes = 0

      for (const file of files) {
        const content = readFileSync(file, "utf8")
        totalBytes += statSync(file).size
        const specs = [...content.matchAll(specifierRegex)].map((m) => m[1]!)
        for (const spec of specs) {
          // Bare `effect` or `effect/<sub>` is acceptable — peer-dep contract.
          if (spec === "effect" || spec.startsWith("effect/")) continue
          // Bundled-effect smoke: any other form that references effect by path.
          if (
            spec.includes("/effect/") ||
            spec.includes("\\effect\\") ||
            spec.endsWith("/effect")
          ) {
            issues.push(`${file}: non-bare effect specifier: ${spec}`)
          }
        }
      }

      expect(
        issues,
        `Effect appears as a non-bare specifier:\n${issues.join("\n")}`,
      ).toEqual([])
      // Sanity ceiling: if effect runtime (~hundreds of KB) were bundled,
      // dist would balloon by an order of magnitude.
      expect(
        totalBytes,
        `Dist size for ${pkgRel} unexpectedly large (${totalBytes} bytes) — effect may be bundled.`,
      ).toBeLessThan(1_000_000)
    }

    it("@tranquilload/core dist externalizes effect", () => {
      checkPackageExternalizesEffect("packages/tranquilload-core", "dist")
    })

    it("@tranquilload/adapters dist externalizes effect", () => {
      checkPackageExternalizesEffect("packages/tranquilload-adapters", "dist")
    })
  })

  // --- 10.5-X-005 (G#14) ---------------------------------------------------
  describe("10.5-X-005 — every package.json#exports sub-path resolves", () => {
    const collectSubpaths = (
      pkgName: string,
      exportsMap: PackageExports,
    ): Array<string> =>
      Object.keys(exportsMap).map((sub) =>
        sub === "." ? pkgName : `${pkgName}${sub.slice(1)}`,
      )

    const writeResolveScript = (specs: ReadonlyArray<string>) => {
      // Sequentially await each import so failures point at the right subpath.
      // A successful resolution is enough — empty modules (type-only subpaths
      // like `@tranquilload/core/progress`) are valid and intentional.
      const lines = specs
        .map(
          (s, i) =>
            `import("${s}").then(() => { process.stdout.write("OK:${i}:${s}\\n") }).catch((e) => { console.error("FAIL:${s}:" + (e && e.message)); process.exit(1) })`,
        )
        .join("\nawait ")
      return `await ${lines}\nconsole.log("ALL_OK")\n`
    }

    it("every subpath in @tranquilload/core and @tranquilload/adapters resolves via ESM", () => {
      const corePkg = readPkg(corePkgPath(REPO_ROOT))
      const adaptersPkg = readPkg(adaptersPkgPath(REPO_ROOT))
      const subpaths = [
        ...collectSubpaths(corePkg.name, corePkg.exports),
        ...collectSubpaths(adaptersPkg.name, adaptersPkg.exports),
      ]

      expect(subpaths.length).toBeGreaterThan(0)

      const scriptPath = join(FIXTURE_DIR, "resolve-all.mjs")
      writeFileSync(scriptPath, writeResolveScript(subpaths))

      const { stdout } = exec("node", ["resolve-all.mjs"], FIXTURE_DIR)
      const last = stdout.trim().split("\n").pop()
      expect(last, `resolve-all output: ${stdout}`).toBe("ALL_OK")
      // And every individual subpath logged OK.
      for (const spec of subpaths) {
        expect(stdout, `Missing OK marker for ${spec}`).toContain(`:${spec}`)
      }
    })
  })
})
