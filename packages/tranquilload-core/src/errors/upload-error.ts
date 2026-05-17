export class PartUploadError extends Error {
  readonly _tag = "PartUploadError" as const

  constructor(
    readonly partNumber: number,
    readonly attempt: number,
    override readonly cause: unknown
  ) {
    super(`Part ${partNumber} failed on attempt ${attempt}`)
    this.name = "PartUploadError"
  }
}

export class MaxRetriesExceededError extends Error {
  readonly _tag = "MaxRetriesExceededError" as const

  constructor(
    readonly partNumber: number,
    readonly totalAttempts: number,
    override readonly cause: unknown
  ) {
    super(`Part ${partNumber} failed after ${totalAttempts} attempts`)
    this.name = "MaxRetriesExceededError"
  }
}

export class PresignedUrlError extends Error {
  readonly _tag = "PresignedUrlError" as const

  constructor(override readonly cause: unknown) {
    super("Failed to obtain pre-signed URL")
    this.name = "PresignedUrlError"
  }
}

export class InitiateUploadError extends Error {
  readonly _tag = "InitiateUploadError" as const

  constructor(override readonly cause: unknown) {
    super("Failed to initiate multipart upload")
    this.name = "InitiateUploadError"
  }
}

export class ReconcileError extends Error {
  readonly _tag = "ReconcileError" as const

  constructor(override readonly cause: unknown) {
    super("Failed to reconcile completed parts")
    this.name = "ReconcileError"
  }
}

export class CompleteUploadError extends Error {
  readonly _tag = "CompleteUploadError" as const

  constructor(override readonly cause: unknown) {
    super("Failed to complete multipart upload")
    this.name = "CompleteUploadError"
  }
}

export class AbortError extends Error {
  readonly _tag = "AbortError" as const

  constructor() {
    super("Upload aborted")
    this.name = "AbortError"
  }
}

export class CircuitOpenError extends Error {
  readonly _tag = "CircuitOpenError" as const

  constructor(readonly failedParts: number) {
    super(`Circuit breaker opened after ${failedParts} consecutive part failures`)
    this.name = "CircuitOpenError"
  }
}

/**
 * Raised when a resume attempt fails pre-flight validation (before any byte is
 * uploaded). The `reason` discriminant identifies *why* the resume is unsafe.
 *
 * **Stylistic exception:** unlike the other variants (one class per `_tag`),
 * `ResumeMismatchError` is a single class with a `reason` discriminant. The
 * pre-flight validation refusal is *one* kind of error; `reason` carries its
 * specific cause. Per-reason dispatch is via `Match.value(err.reason)` inside
 * a `Match.tag("ResumeMismatchError", ...)` handler, or a `switch (err.reason)`.
 */
export class ResumeMismatchError extends Error {
  readonly _tag = "ResumeMismatchError" as const

  constructor(
    readonly reason:
      | "version_mismatch"
      | "chunksize_mismatch"
      | "pipeline_mismatch"
      | "content_mismatch",
    override readonly cause?: unknown
  ) {
    super(`Resume state mismatch: ${reason}`)
    this.name = "ResumeMismatchError"
  }
}

export type UploadError =
  | PartUploadError
  | MaxRetriesExceededError
  | PresignedUrlError
  | InitiateUploadError
  | ReconcileError
  | CompleteUploadError
  | AbortError
  | CircuitOpenError
  | ResumeMismatchError
