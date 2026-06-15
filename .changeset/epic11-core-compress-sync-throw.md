---
"@tranquilload/core": patch
---

Fix `compress()` so a synchronous throw from a user-injected `CompressionService` becomes a typed `PartUploadError` instead of an unrecoverable fiber DEFECT (Epic 11, Story 11.1). Previously, if a custom `CompressionService.compress(stream, algorithm)` threw synchronously (rather than returning a stream that errors), the throw escaped as a fiber defect and crashed the upload. `compress()` now wraps the call and converts a sync throw into a `ReadableStream` that immediately errors with the cause, so it flows through `chunkStream`'s `Stream.mapError` and surfaces as a typed `PartUploadError` — mirroring the `safeLog` user-boundary established for the logger in Story 10.1. Default behaviour for a well-behaved `CompressionService` is unchanged.
