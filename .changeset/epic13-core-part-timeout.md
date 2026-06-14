---
"@tranquilload/core": patch
---

Add an opt-in `partTimeout` to `uploadMultipart` (Epic 13, Story 13.4). When set (any `Duration.DurationInput`, e.g. `"30 seconds"`), each `uploadPart` attempt that does not resolve within the duration fails with a `PartUploadError` whose `cause` is the new `PartTimeoutError` — which feeds the existing `retrySchedule` exactly like any other transient part failure (a bounded slow-loris part is retried, and if every attempt times out it surfaces as `MaxRetriesExceededError` carrying the `PartTimeoutError`). `PartTimeoutError` is exported but is a **cause-only** error (never a member of the `UploadError` union); inspect it via `err.cause instanceof PartTimeoutError`. Default (no `partTimeout`) is unchanged: no hardcoded client-side timeout. Note: the timeout interrupts the orchestration fiber's wait but does not cancel an in-flight request unless you also wire an `AbortSignal`.
