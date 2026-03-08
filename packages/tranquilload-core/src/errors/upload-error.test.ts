import { it, describe, expect } from 'vitest'
import {
  PartUploadError,
  MaxRetriesExceededError,
  PresignedUrlError,
  CompleteUploadError,
  AbortError,
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
})

it("UploadError union is exhaustive", () => {
  const check = (err: UploadError): string => {
    switch (err._tag) {
      case "PartUploadError": return "part"
      case "MaxRetriesExceededError": return "maxRetries"
      case "PresignedUrlError": return "presigned"
      case "CompleteUploadError": return "complete"
      case "AbortError": return "abort"
    }
  }
  expect(check(new AbortError())).toBe("abort")
  expect(check(new PresignedUrlError(null))).toBe("presigned")
  expect(check(new CompleteUploadError(null))).toBe("complete")
  expect(check(new PartUploadError(1, 1, null))).toBe("part")
  expect(check(new MaxRetriesExceededError(1, 1, null))).toBe("maxRetries")
})
