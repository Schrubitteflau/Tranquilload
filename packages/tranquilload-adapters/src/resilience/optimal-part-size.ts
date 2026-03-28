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
