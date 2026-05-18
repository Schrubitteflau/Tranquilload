import { webcrypto } from "node:crypto"

/**
 * Deterministic synthetic file bytes for upload tests.
 *
 * Patterns:
 *   - "zeros":      all 0x00 — useful for compression ratio checks
 *   - "random":     crypto-random — high entropy, compression is no-op
 *   - "incrementing": byte = (i % 256) — easy visual diff on mismatch
 *
 * Default sizes follow Epic 10 Test Design (Resource Estimates):
 *   - 1 KiB        (< chunk; one-shot)
 *   - 10 MiB       (exactly 2 parts of 5 MiB)
 *   - 25 MiB       (5 parts; resume scenarios)
 *   - 50 MiB       (resume + heavy)
 */
export const KiB = 1024
export const MiB = 1024 * KiB

export type FilePattern = "zeros" | "random" | "incrementing"

export function makeBytes(size: number, pattern: FilePattern = "random"): Uint8Array {
  const buf = new Uint8Array(size)
  switch (pattern) {
    case "zeros":
      return buf
    case "incrementing": {
      for (let i = 0; i < size; i++) buf[i] = i & 0xff
      return buf
    }
    case "random": {
      // Web Crypto getRandomValues has a 64 KiB per-call cap.
      const chunk = 64 * KiB
      for (let offset = 0; offset < size; offset += chunk) {
        webcrypto.getRandomValues(buf.subarray(offset, Math.min(offset + chunk, size)))
      }
      return buf
    }
  }
}

/**
 * Browser-side helper. To be injected via `page.addInitScript` or called inside
 * `page.evaluate` so the resulting `File` lives in the page's realm.
 *
 * We expose the source string of `makeBytes` here so tests can keep the file
 * generation deterministic on both sides of the page boundary.
 */
export const makeBytesBrowserSource = `
  function makeBytes(size, pattern) {
    const buf = new Uint8Array(size);
    if (pattern === "zeros") return buf;
    if (pattern === "incrementing") {
      for (let i = 0; i < size; i++) buf[i] = i & 0xff;
      return buf;
    }
    const chunk = 65536;
    for (let offset = 0; offset < size; offset += chunk) {
      crypto.getRandomValues(buf.subarray(offset, Math.min(offset + chunk, size)));
    }
    return buf;
  }
`
