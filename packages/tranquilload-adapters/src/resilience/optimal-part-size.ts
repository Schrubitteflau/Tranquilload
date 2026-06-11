/**
 * Optimal part size calculator for multipart uploads.
 *
 * Pure function — computes the ideal chunk size given file size,
 * target part count, and protocol constraints (min/max part size).
 *
 * @module
 */

export interface OptimalPartSizeOptions {
  /** Total file size in bytes. Pass `undefined` if unknown (streaming). */
  totalBytes?: number
  /** Desired number of parts. */
  targetPartCount: number
  /** Protocol minimum part size (e.g. 5 * 1024 * 1024 for S3). Always returned as floor. */
  minPartSize: number
  /** Optional maximum part size. Clamps result if provided. */
  maxPartSize?: number
}

export function computeOptimalPartSize(options: OptimalPartSizeOptions): number {
  const { totalBytes, targetPartCount, minPartSize, maxPartSize } = options

  if (totalBytes === undefined) return minPartSize

  const raw = Math.ceil(totalBytes / targetPartCount)
  let result = Math.max(raw, minPartSize)

  if (maxPartSize !== undefined) {
    result = Math.min(result, maxPartSize)
  }

  return result
}

/** S3 hard limit: a multipart upload may contain at most 10,000 parts. */
export const S3_MAX_PARTS = 10_000

/**
 * Caller-side guard: asserts that splitting `totalBytes` into `chunkSize`-byte
 * parts does not exceed S3's {@link S3_MAX_PARTS} maximum. Throws a `RangeError`
 * when it would.
 *
 * This lives in the adapters layer (not the protocol-agnostic core) because the
 * 10,000-part cap is an S3 constraint, and because only the caller knows
 * `totalBytes` — the core upload orchestration never sees it. Invoke this before
 * starting a multipart upload; raise `chunkSize` (e.g. via
 * {@link computeOptimalPartSize}) until it passes.
 */
export function assertS3PartCount(totalBytes: number, chunkSize: number): void {
  if (!Number.isFinite(chunkSize) || chunkSize <= 0) {
    throw new TypeError(
      `assertS3PartCount: chunkSize must be a positive finite number, got ${chunkSize}`
    )
  }
  const partCount = Math.ceil(totalBytes / chunkSize)
  if (partCount > S3_MAX_PARTS) {
    throw new RangeError(
      `S3 multipart upload would require ${partCount} parts, exceeding the ${S3_MAX_PARTS}-part maximum. ` +
        `Increase chunkSize (e.g. via computeOptimalPartSize).`
    )
  }
}
