---
"@tranquilload/core": patch
---

Event-stream flush-before-error: `uploadMultipart().events` (and `uploadOnce().events`) now flush every `UploadEvent` emitted before a failure or abort, instead of closing empty on the failure path. Events are enqueued live as they are produced; the typed `UploadError` still surfaces only via `result` (the events channel is split from the result channel, so the error is never masked). Observability on the failure path is no longer lost. Non-breaking: the success path is unchanged, and a failed/aborted upload still rejects `result` with the same typed error. (Story 13.5 — Observability. The optional ingest checksum half was carved out to a follow-up story.)
