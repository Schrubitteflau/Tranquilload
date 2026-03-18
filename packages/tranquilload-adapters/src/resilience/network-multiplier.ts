/**
 * Network throughput multiplier adapter.
 *
 * Measures upload throughput via a sliding window and returns a factor
 * in [0.1, 1.0] to scale chunk size dynamically.
 *
 * @module
 */

export interface NetworkMultiplierInstance {
  /** Record a completed upload measurement. Skips if durationMs <= 0. */
  record(bytes: number, durationMs: number): void
  /** Returns current throughput factor [0.1, 1.0]. Returns 1.0 with no samples. */
  factor(): number
}

export interface NetworkMultiplierOptions {
  /** Number of recent samples to average. Default: 5 */
  windowSize?: number
  /** Throughput (bytes/ms) that maps to factor=1.0. Default: ~10 MB/s */
  targetBytesPerMs?: number
}

const DEFAULT_WINDOW_SIZE = 5
const DEFAULT_TARGET_BYTES_PER_MS = (10 * 1024 * 1024) / 1000

export function networkMultiplier(
  options?: NetworkMultiplierOptions
): NetworkMultiplierInstance {
  const windowSize = options?.windowSize ?? DEFAULT_WINDOW_SIZE
  const targetBytesPerMs =
    options?.targetBytesPerMs ?? DEFAULT_TARGET_BYTES_PER_MS
  const samples: number[] = []

  return {
    record(bytes: number, durationMs: number): void {
      if (durationMs <= 0) return
      const throughput = bytes / durationMs
      if (samples.length >= windowSize) {
        samples.shift()
      }
      samples.push(throughput)
    },

    factor(): number {
      if (samples.length === 0) return 1.0
      const avg =
        samples.reduce((sum, s) => sum + s, 0) / samples.length
      return Math.max(0.1, Math.min(1.0, avg / targetBytesPerMs))
    },
  }
}
