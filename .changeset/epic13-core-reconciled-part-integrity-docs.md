---
"@tranquilload/core": patch
---

Document the **stale-reconcile trust boundary** (Epic 13, Story 13.7 — spike resolved decline/document-only). When a resume's `reconcileCompletedParts` reports a part the backend has since garbage-collected (e.g. an S3 lifecycle rule expiring incomplete-multipart parts between the probe and `/complete`), the upload fails with `CompleteUploadError` at the complete phase.

The core deliberately does **not** auto-detect and re-upload the missing part: the complete-phase error does not structurally identify which part is gone (parsing it would tie the protocol-agnostic core to S3 error strings), and the skipped part's bytes are already discarded with the source stream drained by the complete phase — so an in-band re-upload would require retaining every reconciled part in memory, defeating resume. Instead, the trust boundary is documented with two honest, caller-side remedies:

- **Verify before you skip** — only report parts you have confirmed still exist in `reconcileCompletedParts`.
- **Re-probe and re-invoke** — catch `CompleteUploadError`, re-probe, and re-run with a fresh source stream (the lib is idempotent across invocations).

Docs-only: a new README "Reconciled-part integrity" section + a TSDoc note on `reconcileCompletedParts`. No new API, no behaviour change — the default upload path is byte-for-byte unchanged.
