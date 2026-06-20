---
"@tranquilload/core": patch
---

Document the ingest no-checksum trust boundary. The core deliberately does not checksum the bytes your pipeline produces — a digest of the uploaded bytes faithfully matches whatever a buggy compressor emitted, so it cannot detect that the compressor mangled its input. A new README section ("Ingest integrity") and a TSDoc note on `uploadPart` explain this and show the DIY path to server-verified **wire** integrity: every `uploadPart(partNumber, chunk)` hands you the exact post-pipeline bytes, so you can checksum `chunk` and forward a trailing checksum header (e.g. S3 `x-amz-checksum-sha256`) — no new library API required. Docs-only, no behaviour change. (Story 13.5b — Ingest Integrity Checksum; spike resolved to decline/document-only.)
