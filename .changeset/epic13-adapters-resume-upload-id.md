---
"@tranquilload/adapters": patch
---

Add an opt-in `resumeUploadId` option to `s3MultipartUpload` (Epic 13, Story 13.2). On a cross-session resume the consumer no longer calls `initiate`, which previously left the adapter's internal `storedUploadId` empty so `uploadPart` signed presigned URLs against `""`. Supplying `resumeUploadId` now seeds that value, so `getPresignedUrl(partNumber, uploadId)` receives the resumed `uploadId` without an `initiate` call. Default (no option) is unchanged — `storedUploadId` starts empty and is set only by `initiate`.
