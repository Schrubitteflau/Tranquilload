import { test as base } from "@playwright/test"
import { makeBytes, MiB, type FilePattern } from "../helpers/file-factory.js"

export interface UploadFileFixtures {
  /**
   * Generate a `Uint8Array` of `size` bytes, deterministic for `pattern`.
   * The bytes live in the test (Node) realm; injection into the page is the
   * caller's responsibility (`page.evaluate`, `setInputFiles` with a Buffer,
   * etc.).
   */
  makeUploadBytes: (size: number, pattern?: FilePattern) => Uint8Array
}

export const test = base.extend<UploadFileFixtures>({
  makeUploadBytes: async ({}, use) => {
    await use((size, pattern = "random") => makeBytes(size, pattern))
  },
})

export { expect } from "@playwright/test"
export { MiB }
