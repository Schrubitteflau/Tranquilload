import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

import { extractReadmeBlocks } from "./extract-readme-blocks.js"
import { REPO_ROOT } from "./doctest-harness.js"

/**
 * Story 11.7 — 11.7-D-003 (G#29) — Test-app README reproducibility.
 *
 * A fresh clone + the `examples/test-app/README.md` setup sequence must bring
 * the test app to a working state. Re-cloning + re-installing per test is not
 * CI-friendly, so per the story we run a STATIC / dry-run check: every command
 * the README tells a new contributor to run must map to a real, correctly-named
 * pnpm script or a real file in the repo. This catches onboarding drift (a
 * renamed script, a deleted package) without a multi-minute clone.
 */

const TEST_APP_DIR = join(REPO_ROOT, "examples/test-app")
const TEST_APP_README = join(TEST_APP_DIR, "README.md")

interface PkgJson {
  scripts?: Record<string, string>
}

const readPkg = (path: string): PkgJson =>
  JSON.parse(readFileSync(path, "utf8")) as PkgJson

describe("Story 11.7 — Test-app README reproducibility (G#29)", () => {
  const readme = readFileSync(TEST_APP_README, "utf8")
  const blocks = extractReadmeBlocks(readme)
  const bashCommands = blocks
    .filter((b) => b.lang === "bash" || b.lang === "sh" || b.lang === "shell")
    .flatMap((b) => b.code.split(/\r?\n/))
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"))

  const rootPkg = readPkg(join(REPO_ROOT, "package.json"))
  const appPkg = readPkg(join(TEST_APP_DIR, "package.json"))

  it("11.7-D-003 (G#29) — README contains the documented setup commands", () => {
    // The setup sequence the README promises (repo-root install + build).
    expect(bashCommands.some((c) => c.startsWith("pnpm install"))).toBe(true)
    expect(bashCommands.some((c) => /pnpm turbo build/.test(c))).toBe(true)
    // And the run sequence (minio + dev).
    expect(bashCommands.some((c) => /pnpm minio:up/.test(c))).toBe(true)
    expect(bashCommands.some((c) => /pnpm dev\b/.test(c))).toBe(true)
  })

  it("11.7-D-003 (G#29) — every `pnpm <script>` in the README maps to a real script", () => {
    // Collect every `pnpm <token>` invocation that isn't a built-in
    // (install/turbo/--filter) and verify the script exists in either the
    // repo-root or the test-app package.json.
    const BUILTINS = new Set(["install", "turbo", "exec", "dlx", "add", "run"])
    const scriptRefs = new Set<string>()
    for (const cmd of bashCommands) {
      const m = /^pnpm\s+([a-z][\w:-]*)/.exec(cmd)
      if (!m) continue
      const token = m[1]!
      if (BUILTINS.has(token)) continue
      scriptRefs.add(token)
    }

    expect(scriptRefs.size, "expected at least one pnpm <script> in README").toBeGreaterThan(0)

    const rootScripts = new Set(Object.keys(rootPkg.scripts ?? {}))
    const appScripts = new Set(Object.keys(appPkg.scripts ?? {}))
    const missing = [...scriptRefs].filter(
      (s) => !rootScripts.has(s) && !appScripts.has(s),
    )
    expect(
      missing,
      `README references pnpm scripts that don't exist: ${missing.join(", ")}`,
    ).toEqual([])
  })

  it("11.7-D-003 (G#29) — the test-app's MinIO compose file referenced by minio:up exists", () => {
    // `minio:up` runs `docker compose up -d` from the test-app dir; a
    // docker-compose file must be present for a fresh clone to work.
    const minioUp = appPkg.scripts?.["minio:up"] ?? ""
    expect(minioUp).toMatch(/docker\s+compose/)
    const composeExists =
      existsSync(join(TEST_APP_DIR, "docker-compose.yml")) ||
      existsSync(join(TEST_APP_DIR, "docker-compose.yaml")) ||
      existsSync(join(TEST_APP_DIR, "compose.yml")) ||
      existsSync(join(TEST_APP_DIR, "compose.yaml"))
    expect(composeExists, "test-app docker compose file must exist for minio:up").toBe(true)
  })

  it("11.7-D-003 (G#29) — the library packages the README says to build exist", () => {
    // The README states `pnpm turbo build` builds @tranquilload/core and
    // @tranquilload/adapters; both package dirs must exist with a build script.
    const corePkg = readPkg(
      join(REPO_ROOT, "packages/tranquilload-core/package.json"),
    )
    const adaptersPkg = readPkg(
      join(REPO_ROOT, "packages/tranquilload-adapters/package.json"),
    )
    expect(corePkg.scripts?.["build"]).toBeTruthy()
    expect(adaptersPkg.scripts?.["build"]).toBeTruthy()
  })
})
