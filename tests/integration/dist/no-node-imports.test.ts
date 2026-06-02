import { readFileSync, readdirSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

/**
 * Story 11.7 — 11.7-X-002 (G#15) — No `node:*` imports in the browser bundle
 * (DIST harness), except behind the `fromNodeReadable` boundary.
 *
 * `node:stream` isolation (MEMORY): `from-node-readable.ts` is the ONLY module
 * permitted to import `node:*`. A browser consumer that does NOT import
 * `@tranquilload/adapters/fromNodeReadable` must ship ZERO `node:*` imports.
 *
 * tsdown emits per-entry bundles + shared chunks; we follow the transitive
 * closure of each entry over its relative chunk imports (bundler-free, matching
 * the rest of the DIST harness) and grep the closure for `node:*` specifiers.
 *
 *   - Case (a): a consumer importing only browser-safe entries (oneshot,
 *     multipart, pipeline, errors, s3MultipartUpload, simpleHttpUpload,
 *     fromFile, …) → 0 `node:*` matches.
 *   - Case (b): a consumer importing `fromNodeReadable` → matches confined to
 *     the `from-node-readable` module only.
 */

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(__dirname, "../../..")
const CORE_DIST = join(REPO_ROOT, "packages/tranquilload-core/dist")
const ADAPTERS_DIST = join(REPO_ROOT, "packages/tranquilload-adapters/dist")

const RELATIVE_IMPORT_RE = /(?:\bfrom\s*|\bimport\s*)["'](\.[^"']+)["']/g
const NODE_SPECIFIER_RE = /(?:\bfrom\s*|\bimport\s*|\brequire\s*\()\s*["'](node:[^"']+)["']/g

/** Transitive closure of an entry .mjs over its relative sibling imports. */
const collectClosure = (entryFile: string): Map<string, string> => {
  const seen = new Map<string, string>()
  const stack = [entryFile]
  while (stack.length > 0) {
    const file = stack.pop()!
    if (seen.has(file)) continue
    const content = readFileSync(file, "utf8")
    seen.set(file, content)
    for (const m of content.matchAll(RELATIVE_IMPORT_RE)) {
      const resolved = resolve(dirname(file), m[1]!)
      if (!seen.has(resolved)) stack.push(resolved)
    }
  }
  return seen
}

/** All `node:*` specifiers found in a closure, keyed by file. */
const nodeImportsInClosure = (
  closure: Map<string, string>,
): Array<{ file: string; spec: string }> => {
  const hits: Array<{ file: string; spec: string }> = []
  for (const [file, content] of closure) {
    for (const m of content.matchAll(NODE_SPECIFIER_RE)) {
      hits.push({ file, spec: m[1]! })
    }
  }
  return hits
}

describe("Story 11.7 — DIST no-node-imports (G#15)", () => {
  // Browser-safe entries: everything a browser consumer would import that is
  // NOT the explicit node boundary.
  const BROWSER_SAFE_ENTRIES: ReadonlyArray<[string, string]> = [
    [CORE_DIST, "oneshot.mjs"],
    [CORE_DIST, "multipart.mjs"],
    [CORE_DIST, "pipeline.mjs"],
    [CORE_DIST, "services.mjs"],
    [CORE_DIST, "errors.mjs"],
    [CORE_DIST, "progress.mjs"],
    [ADAPTERS_DIST, "from-file.mjs"],
    [ADAPTERS_DIST, "s3-multipart-upload.mjs"],
    [ADAPTERS_DIST, "simple-http-upload.mjs"],
    [ADAPTERS_DIST, "network-multiplier.mjs"],
    [ADAPTERS_DIST, "optimal-part-size.mjs"],
  ]

  // --- 11.7-X-002 (G#15) — case (a) ----------------------------------------
  it("11.7-X-002 (G#15) — browser-safe consumer (no fromNodeReadable) has ZERO node:* imports", () => {
    const offenders: Array<string> = []
    for (const [distDir, entry] of BROWSER_SAFE_ENTRIES) {
      const closure = collectClosure(join(distDir, entry))
      for (const hit of nodeImportsInClosure(closure)) {
        offenders.push(`${entry} closure → ${hit.file}: ${hit.spec}`)
      }
    }
    expect(
      offenders,
      `Browser-safe entries must not pull node:* imports:\n${offenders.join("\n")}`,
    ).toEqual([])
  })

  // --- 11.7-X-002 (G#15) — case (b) ----------------------------------------
  it("11.7-X-002 (G#15) — fromNodeReadable closure confines node:* to the from-node-readable module", () => {
    const closure = collectClosure(join(ADAPTERS_DIST, "from-node-readable.mjs"))
    const hits = nodeImportsInClosure(closure)
    // There must be at least one node:* import (that's the whole point of the
    // adapter) and every hit must live in the from-node-readable module.
    expect(hits.length, "from-node-readable must import node:*").toBeGreaterThan(0)
    const strays = hits.filter((h) => !/from-node-readable/.test(h.file))
    expect(
      strays,
      `node:* imports must be confined to from-node-readable, found strays:\n${strays
        .map((h) => `${h.file}: ${h.spec}`)
        .join("\n")}`,
    ).toEqual([])
    // And the specific boundary import is node:stream.
    expect(hits.some((h) => h.spec === "node:stream")).toBe(true)
  })

  // --- 11.7-X-002 (G#15) — global invariant --------------------------------
  it("11.7-X-002 (G#15) — across ALL dist .mjs, from-node-readable is the ONLY node:* importer", () => {
    const allFiles = [
      ...readdirSync(CORE_DIST)
        .filter((f) => f.endsWith(".mjs"))
        .map((f) => join(CORE_DIST, f)),
      ...readdirSync(ADAPTERS_DIST)
        .filter((f) => f.endsWith(".mjs"))
        .map((f) => join(ADAPTERS_DIST, f)),
    ]
    const importers = new Set<string>()
    for (const file of allFiles) {
      const content = readFileSync(file, "utf8")
      if (NODE_SPECIFIER_RE.test(content)) importers.add(file)
      NODE_SPECIFIER_RE.lastIndex = 0
    }
    const stray = [...importers].filter((f) => !/from-node-readable/.test(f))
    expect(
      stray,
      `Only from-node-readable.mjs may import node:*; strays:\n${stray.join("\n")}`,
    ).toEqual([])
  })
})
