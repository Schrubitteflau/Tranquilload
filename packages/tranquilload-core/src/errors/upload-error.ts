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

export type UploadError =
  | PartUploadError
  | MaxRetriesExceededError
  | PresignedUrlError
  | InitiateUploadError
  | ReconcileError
  | CompleteUploadError
  | AbortError
  | CircuitOpenError
