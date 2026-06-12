---
"@tranquilload/core": patch
---

Add an opt-in `reinitOnStale` recovery for resumes against a deleted/GC'd `uploadId` (Epic 13, Story 13.2). When `uploadMultipart` is given a `reinitOnStale: (cause) => boolean` predicate and an `initiate` callback, a `reconcileCompletedParts` failure the predicate classifies as stale (e.g. an S3 `NoSuchUpload`) now abandons the stale upload and re-initiates a fresh multipart from part 1 — emitting a fresh `UploadInitiated` — instead of failing with `ReconcileError`. The predicate inspects the raw rejection, so the core stays protocol-agnostic. Default (no predicate) is unchanged: a stale reconcile still fails fast with `ReconcileError`.
