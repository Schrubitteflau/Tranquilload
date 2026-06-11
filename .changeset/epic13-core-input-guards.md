---
"@tranquilload/core": patch
---

Add pre-flight input-boundary guards (Epic 13, Story 13.1). `uploadMultipart` now rejects a non-integer `chunkSize` with a `TypeError` at the API boundary (previously a non-integer like `1024.7` was silently accepted). `uploadOnce` gains an opt-in `allowEmpty: false` that rejects a zero-byte source with a typed `CompleteUploadError` before the PUT, via a bounded first-chunk peek. Defaults are unchanged — `allowEmpty` defaults to `true`, preserving the existing one-shot semantic; only previously-invalid `chunkSize` input is newly rejected.
