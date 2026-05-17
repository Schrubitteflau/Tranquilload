import { it, describe, expect } from 'vitest'
import {
  PartUploadError,
  MaxRetriesExceededError,
  PresignedUrlError,
  InitiateUploadError,
  ReconcileError,
  CompleteUploadError,
  AbortError,
  CircuitOpenError,
  ResumeMismatchError,
  type UploadError,
} from './upload-error.js'

describe("PartUploadError", () => {
  it("is instanceof Error", () => {
    const err = new PartUploadError(1, 1, new Error("network"))
    expect(err instanceof Error).toBe(true)
  })
  it("has correct _tag", () => {
    const err = new PartUploadError(1, 1, new Error("network"))
    expect(err._tag).toBe("PartUploadError")
  })
  it("has human-readable message", () => {
    const err = new PartUploadError(3, 2, new Error("timeout"))
    expect(err.message).toBe("Part 3 failed on attempt 2")
  })
  it("name equals _tag for logger compat", () => {
    const err = new PartUploadError(1, 1, new Error("x"))
    expect(err.name).toBe("PartUploadError")
  })
  it("preserves cause", () => {
    const cause = new Error("network failure")
    const err = new PartUploadError(1, 1, cause)
    expect(err.cause).toBe(cause)
  })
  it("preserves partNumber and attempt", () => {
    const err = new PartUploadError(5, 3, null)
    expect(err.partNumber).toBe(5)
    expect(err.attempt).toBe(3)
  })
})

describe("MaxRetriesExceededError", () => {
  it("is instanceof Error", () => {
    const err = new MaxRetriesExceededError(2, 4, new Error("exhausted"))
    expect(err instanceof Error).toBe(true)
  })
  it("has correct _tag", () => {
    const err = new MaxRetriesExceededError(2, 4, new Error("exhausted"))
    expect(err._tag).toBe("MaxRetriesExceededError")
  })
  it("has human-readable message", () => {
    const err = new MaxRetriesExceededError(2, 4, new Error("exhausted"))
    expect(err.message).toBe("Part 2 failed after 4 attempts")
  })
  it("name equals _tag for logger compat", () => {
    const err = new MaxRetriesExceededError(2, 4, null)
    expect(err.name).toBe("MaxRetriesExceededError")
  })
  it("preserves partNumber and totalAttempts", () => {
    const err = new MaxRetriesExceededError(7, 10, null)
    expect(err.partNumber).toBe(7)
    expect(err.totalAttempts).toBe(10)
  })
  it("preserves cause", () => {
    const cause = new Error("last attempt failed")
    const err = new MaxRetriesExceededError(2, 4, cause)
    expect(err.cause).toBe(cause)
  })
})

describe("PresignedUrlError", () => {
  it("is instanceof Error", () => {
    const err = new PresignedUrlError(new Error("403 Forbidden"))
    expect(err instanceof Error).toBe(true)
  })
  it("has correct _tag", () => {
    const err = new PresignedUrlError(new Error("403 Forbidden"))
    expect(err._tag).toBe("PresignedUrlError")
  })
  it("has human-readable message", () => {
    const err = new PresignedUrlError(null)
    expect(err.message).toBe("Failed to obtain pre-signed URL")
  })
  it("name equals _tag for logger compat", () => {
    const err = new PresignedUrlError(null)
    expect(err.name).toBe("PresignedUrlError")
  })
  it("preserves cause", () => {
    const cause = new Error("403 Forbidden")
    const err = new PresignedUrlError(cause)
    expect(err.cause).toBe(cause)
  })
})

describe("InitiateUploadError", () => {
  it("is instanceof Error", () => {
    const err = new InitiateUploadError(new Error("S3 failure"))
    expect(err instanceof Error).toBe(true)
  })
  it("has correct _tag", () => {
    const err = new InitiateUploadError(new Error("S3 failure"))
    expect(err._tag).toBe("InitiateUploadError")
  })
  it("has human-readable message", () => {
    const err = new InitiateUploadError(null)
    expect(err.message).toBe("Failed to initiate multipart upload")
  })
  it("name equals _tag for logger compat", () => {
    const err = new InitiateUploadError(null)
    expect(err.name).toBe("InitiateUploadError")
  })
  it("preserves cause", () => {
    const cause = new Error("S3 failure")
    const err = new InitiateUploadError(cause)
    expect(err.cause).toBe(cause)
  })
})

describe("ReconcileError", () => {
  it("is instanceof Error", () => {
    const err = new ReconcileError(new Error("storage unavailable"))
    expect(err instanceof Error).toBe(true)
  })
  it("has correct _tag", () => {
    const err = new ReconcileError(new Error("storage unavailable"))
    expect(err._tag).toBe("ReconcileError")
  })
  it("has human-readable message", () => {
    const err = new ReconcileError(null)
    expect(err.message).toBe("Failed to reconcile completed parts")
  })
  it("name equals _tag for logger compat", () => {
    const err = new ReconcileError(null)
    expect(err.name).toBe("ReconcileError")
  })
  it("preserves cause", () => {
    const cause = new Error("storage unavailable")
    const err = new ReconcileError(cause)
    expect(err.cause).toBe(cause)
  })
})

describe("CompleteUploadError", () => {
  it("is instanceof Error", () => {
    const err = new CompleteUploadError(new Error("500 Internal"))
    expect(err instanceof Error).toBe(true)
  })
  it("has correct _tag", () => {
    const err = new CompleteUploadError(new Error("500 Internal"))
    expect(err._tag).toBe("CompleteUploadError")
  })
  it("has human-readable message", () => {
    const err = new CompleteUploadError(null)
    expect(err.message).toBe("Failed to complete multipart upload")
  })
  it("name equals _tag for logger compat", () => {
    const err = new CompleteUploadError(null)
    expect(err.name).toBe("CompleteUploadError")
  })
  it("preserves cause", () => {
    const cause = new Error("500 Internal")
    const err = new CompleteUploadError(cause)
    expect(err.cause).toBe(cause)
  })
})

describe("AbortError", () => {
  it("is instanceof Error", () => {
    const err = new AbortError()
    expect(err instanceof Error).toBe(true)
  })
  it("has correct _tag", () => {
    const err = new AbortError()
    expect(err._tag).toBe("AbortError")
  })
  it("has human-readable message", () => {
    const err = new AbortError()
    expect(err.message).toBe("Upload aborted")
  })
  it("name equals _tag for logger compat", () => {
    const err = new AbortError()
    expect(err.name).toBe("AbortError")
  })
  it("has no cause (abort is intentional, not an error chain)", () => {
    const err = new AbortError()
    expect(err.cause).toBeUndefined()
  })
})

describe("ResumeMismatchError", () => {
  it("is instanceof Error", () => {
    const err = new ResumeMismatchError("version_mismatch")
    expect(err instanceof Error).toBe(true)
  })
  it("has correct _tag", () => {
    const err = new ResumeMismatchError("chunksize_mismatch")
    expect(err._tag).toBe("ResumeMismatchError")
  })
  it("has human-readable message including reason", () => {
    const err = new ResumeMismatchError("pipeline_mismatch")
    expect(err.message).toBe("Resume state mismatch: pipeline_mismatch")
  })
  it("name equals _tag for logger compat", () => {
    const err = new ResumeMismatchError("content_mismatch")
    expect(err.name).toBe("ResumeMismatchError")
  })
  it("preserves the reason discriminant", () => {
    const err = new ResumeMismatchError("content_mismatch")
    expect(err.reason).toBe("content_mismatch")
  })
  it("preserves optional cause", () => {
    const cause = new Error("digest function threw")
    const err = new ResumeMismatchError("content_mismatch", cause)
    expect(err.cause).toBe(cause)
  })
  it("cause is undefined when omitted", () => {
    const err = new ResumeMismatchError("version_mismatch")
    expect(err.cause).toBeUndefined()
  })
})

it("UploadError union is exhaustive", () => {
  const check = (err: UploadError): string => {
    switch (err._tag) {
      case "PartUploadError": return "part"
      case "MaxRetriesExceededError": return "maxRetries"
      case "PresignedUrlError": return "presigned"
      case "InitiateUploadError": return "initiate"
      case "ReconcileError": return "reconcile"
      case "CompleteUploadError": return "complete"
      case "AbortError": return "abort"
      case "CircuitOpenError": return "circuitOpen"
      case "ResumeMismatchError": return "resumeMismatch"
      default: {
        // If a new variant is added to UploadError without a matching case above,
        // TypeScript will error here: "Type 'NewVariant' is not assignable to type 'never'"
        const _exhaustive: never = err
        return _exhaustive
      }
    }
  }
  expect(check(new AbortError())).toBe("abort")
  expect(check(new PresignedUrlError(null))).toBe("presigned")
  expect(check(new InitiateUploadError(null))).toBe("initiate")
  expect(check(new ReconcileError(null))).toBe("reconcile")
  expect(check(new CompleteUploadError(null))).toBe("complete")
  expect(check(new PartUploadError(1, 1, null))).toBe("part")
  expect(check(new MaxRetriesExceededError(1, 1, null))).toBe("maxRetries")
  expect(check(new CircuitOpenError(3))).toBe("circuitOpen")
  expect(check(new ResumeMismatchError("chunksize_mismatch"))).toBe("resumeMismatch")
})
