---
"@tranquilload/core": patch
---

Add an opt-in `failFast` predicate to `uploadMultipart` (Epic 13, Story 13.4). When given `failFast: (cause) => boolean`, a part whose `uploadPart` rejection the predicate classifies as unrecoverable (e.g. `failFast: (cause) => cause instanceof PresignedUrlError`) fails immediately on that attempt — **without consuming the retry budget** — instead of being retried uniformly. The predicate receives the raw error thrown by `uploadPart`, so the core stays protocol-agnostic (symmetric with `reinitOnStale`). It composes with `retrySchedule` (a part is retried only while the schedule recurs and `failFast` returns `false`), so you can add fail-fast to the default schedule without rebuilding it. This is ergonomic sugar over the equivalent `Schedule.whileInput` composition. Default (no `failFast`) is unchanged: uniform retry per the schedule.
