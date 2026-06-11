---
"@tranquilload/adapters": patch
---

Add S3 input-boundary guards (Epic 13, Story 13.1). `s3MultipartUpload` now rejects an S3 object key longer than 1024 bytes (UTF-8) pre-flight with `InitiateUploadError`, before any `createMultipartUpload` request. A new caller-side helper `assertS3PartCount(totalBytes, chunkSize)` (exported from `@tranquilload/adapters/optimalPartSize`, alongside `S3_MAX_PARTS`) throws a `RangeError` when an upload would exceed S3's 10,000-part maximum — the 10k cap is an S3 constraint, so it lives in the adapter layer rather than the protocol-agnostic core.
