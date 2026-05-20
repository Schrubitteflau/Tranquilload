---
"@tranquilload/adapters": patch
"@tranquilload/core": patch
---

Story 10.6 — Doctest harness for the README quick-start blocks, plus the adapter bug fix it surfaced.

**`@tranquilload/adapters` bug fix (s3MultipartUpload):** sort completed parts by `PartNumber` before calling `CompleteMultipartUpload`. S3 requires ascending order; the core completes parts concurrently, so the array arrives in arbitrary order. Any upload with `maxConcurrency > 1` (including the README's `4`) and ≥2 parts was failing with `InvalidPartOrder`. The test-app server route had a local workaround; the adapter itself didn't, so every direct consumer of `s3MultipartUpload` was affected. Caught by the new `10.6-D-002` doctest against MinIO. Adds a regression test (`completeUpload sorts parts by partNumber`).

**Doctest harness (test-only, no published surface change):** `tests/integration/docs/` with three tests:
- **10.6-D-001 (G#23)** — extract the README one-shot quick-start, compile against the published `.d.mts`, run against a mocked `fetch`. Assert body bytes.
- **10.6-D-002 (G#24)** — same pipeline against MinIO (5 MiB + 1 MiB → 2 parts). Skips locally when MinIO isn't up; CI gates with `MINIO_REQUIRED=1`.
- **10.6-D-003 (G#28)** — compile-only over the `Match.tag` block. Adding a new `UploadError` variant without updating the README block fails `tsc`.

**README fix (no published surface change — root README is not in the npm tarballs):** `() => /* comment */` was a parser error (no expression after `=>`). Replaced with `() => { /* comment */ }` to preserve the explanatory comment while compiling.

**New devDep**: `@aws-sdk/s3-request-presigner` in `@tranquilload/tests`.
