import { readFileSync, statSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { beforeAll, describe, expect, it } from "vitest"

/**
 * Story 11.7 — 11.7-X-001 (G#13) — Tree-shake proof (DIST harness).
 *
 * A oneshot-only consumer must NOT pull multipart code into its bundle.
 *
 * tsdown/rolldown emits one self-contained bundle per export entry plus shared
 * chunks. So "what a `@tranquilload/core/oneshot` consumer ships" is exactly the
 * transitive closure of `dist/oneshot.mjs` over its relative chunk imports.
 * We follow that closure statically (no bundler dependency — matches the
 * bundler-free approach the rest of the DIST harness uses) and assert the
 * reachable code contains NONE of the multipart-only identifiers.
 *
 * Bonus (peer-dep contract, MEMORY): the closure must NOT statically include
 * the `effect` runtime — `effect` is a bare external specifier, never inlined.
 */

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(__dirname, "../../..")
const CORE_DIST = join(REPO_ROOT, "packages/tranquilload-core/dist")

// Identifiers that only exist in the multipart code path. If any appears in the
// oneshot closure, multipart code leaked into a oneshot-only bundle.
const MULTIPART_ONLY_IDENTIFIERS = [
  "uploadMultipart",
  "uploadMultipartEffect",
  "chunkStream",
  "makeCircuitBreaker",
  "CircuitBreaker",
] as const

// Pull *relative* import specifiers (sibling chunks) from an ESM dist file.
const RELATIVE_IMPORT_RE = /(?:\bfrom\s*|\bimport\s*)["'](\.[^"']+)["']/g
// Any import/require specifier (used for the effect-not-bundled check).
const ANY_SPECIFIER_RE = /(?:\bfrom\s*|\bimport\s*|\brequire\s*\()\s*["']([^"']+)["']/g

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
      const rel = m[1]!
      const resolved = resolve(dirname(file), rel)
      if (!seen.has(resolved)) stack.push(resolved)
    }
  }
  return seen
}

let oneshotClosure: Map<string, string>
let multipartClosure: Map<string, string>

describe("Story 11.7 — DIST tree-shake (G#13)", () => {
  beforeAll(() => {
    oneshotClosure = collectClosure(join(CORE_DIST, "oneshot.mjs"))
    multipartClosure = collectClosure(join(CORE_DIST, "multipart.mjs"))
  })

  // --- 11.7-X-001 (G#13) ---------------------------------------------------
  it("11.7-X-001 (G#13) — oneshot-only bundle excludes every multipart-only identifier", () => {
    const offenders: Array<string> = []
    for (const [file, content] of oneshotClosure) {
      for (const id of MULTIPART_ONLY_IDENTIFIERS) {
        // Word-boundary match so `uploadMultipart` doesn't accidentally match
        // an unrelated substring.
        if (new RegExp(`\\b${id}\\b`).test(content)) {
          offenders.push(`${file}: contains "${id}"`)
        }
      }
    }
    expect(
      offenders,
      `Multipart code leaked into the oneshot closure:\n${offenders.join("\n")}`,
    ).toEqual([])
  })

  it("11.7-X-001 (G#13) — sanity: the multipart bundle DOES contain those identifiers", () => {
    // Guards against a false-negative where the identifiers were renamed and
    // the exclusion check above became vacuous.
    const present = MULTIPART_ONLY_IDENTIFIERS.filter((id) =>
      [...multipartClosure.values()].some((c) => new RegExp(`\\b${id}\\b`).test(c)),
    )
    expect(
      present.length,
      `Expected multipart.mjs closure to contain multipart identifiers; found ${present.join(", ")}`,
    ).toBeGreaterThanOrEqual(3)
  })

  it("11.7-X-001 (G#13) — oneshot closure does not inline the effect runtime (peer-dep contract)", () => {
    const issues: Array<string> = []
    for (const [file, content] of oneshotClosure) {
      for (const m of content.matchAll(ANY_SPECIFIER_RE)) {
        const spec = m[1]!
        // Bare `effect` / `effect/<sub>` is the peer-dep contract — fine.
        if (spec === "effect" || spec.startsWith("effect/")) continue
        if (
          spec.includes("/effect/") ||
          spec.includes("\\effect\\") ||
          spec.endsWith("/effect")
        ) {
          issues.push(`${file}: non-bare effect specifier ${spec}`)
        }
      }
    }
    expect(
      issues,
      `effect appears inlined into the oneshot closure (peer-dep contract violated):\n${issues.join("\n")}`,
    ).toEqual([])
  })

  it("11.7-X-001 (G#13) — oneshot closure is materially smaller than the multipart closure", () => {
    const sizeOf = (closure: Map<string, string>): number => {
      let bytes = 0
      for (const file of closure.keys()) bytes += statSync(file).size
      return bytes
    }
    const oneshotBytes = sizeOf(oneshotClosure)
    const multipartBytes = sizeOf(multipartClosure)
    // Generous budget: a oneshot consumer must ship well under the full
    // multipart footprint. (If multipart code leaked in, the two would
    // converge.) 80% ceiling catches gross regressions without being brittle.
    expect(
      oneshotBytes,
      `oneshot closure (${oneshotBytes}B) should be < 80% of multipart closure (${multipartBytes}B)`,
    ).toBeLessThan(multipartBytes * 0.8)
  })
})
