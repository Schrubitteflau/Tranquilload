import { uploadMultipart } from "@tranquilload/core/multipart"
import { uploadOnce } from "@tranquilload/core/oneshot"
import type { UploadEvent } from "@tranquilload/core/progress"
import { Duration, Schedule } from "effect"

/**
 * Bench harness for PW-Lib tests (Story 11.2-E2E-001 — F#84 heap stability;
 * Story 11.5 — chaos cluster).
 *
 * Exposes lib entrypoints on `window.__tlBench__` so Playwright `page.evaluate`
 * can invoke them without UI navigation.
 *
 *   - Story 11.2 heap test runs the loop ENTIRELY in memory (no network).
 *   - Story 11.5 chaos specs drive REAL presigned multipart uploads against
 *     MinIO from `bench.html` (same origin as the `/api/*` Vite proxy), and
 *     inject failures via Playwright `context.route`. They need `Schedule` +
 *     `Duration` in-browser to build long-backoff retry schedules (e.g.
 *     11.5-E2E-007 aborts while a part is parked in exponential backoff).
 */
declare global {
  interface Window {
    __tlBench__: {
      readonly uploadMultipart: typeof uploadMultipart
      readonly uploadOnce: typeof uploadOnce
      readonly Schedule: typeof Schedule
      readonly Duration: typeof Duration
    }
  }
}

window.__tlBench__ = {
  uploadMultipart,
  uploadOnce,
  Schedule,
  Duration,
}

// Touch a UploadEvent type reference so the import survives tree-shaking.
const _t: UploadEvent | undefined = undefined
void _t
