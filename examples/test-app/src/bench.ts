import { uploadMultipart } from "@tranquilload/core/multipart"
import { uploadOnce } from "@tranquilload/core/oneshot"
import type { UploadEvent } from "@tranquilload/core/progress"

/**
 * Bench harness for PW-Lib tests (Story 11.2-E2E-001 — F#84 heap stability).
 *
 * Exposes lib entrypoints on `window.__tlBench__` so Playwright `page.evaluate`
 * can invoke them without UI navigation. The bench loop runs ENTIRELY in
 * memory — no network — so the heap signal is the lib, not MinIO/fetch.
 */
declare global {
  interface Window {
    __tlBench__: {
      readonly uploadMultipart: typeof uploadMultipart
      readonly uploadOnce: typeof uploadOnce
    }
  }
}

window.__tlBench__ = {
  uploadMultipart,
  uploadOnce,
}

// Touch a UploadEvent type reference so the import survives tree-shaking.
const _t: UploadEvent | undefined = undefined
void _t
