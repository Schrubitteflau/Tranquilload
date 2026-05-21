---
"@tranquilload/core": patch
"@tranquilload/adapters": patch
---

Story 10.8 — Cleanup invariants + peer-dep contract.

**README accuracy fix (no published surface change — root README is not in the npm tarballs):** the "Why `effect` is a peer dependency" section claimed `Context.Tag` uses reference equality for runtime lookup. Effect's `unsafeGet` is actually key-based (`self.unsafeMap.has(tag.key)`), so same-key Tags interop for `Layer.succeed`/`yield* Tag` even across copies. Rewrote the rationale to focus on what *does* break with two copies: class identity (Tag class objects, brand types), `instanceof` for `Cause`/`Exit`/`Fiber`, module-level singletons, version skew, and bundle bloat. The peer-dep declaration is still important — just for the right reasons.

**Test additions (test-only, no surface change):**

- **10.8-INT-002 (F#77)** — new `packages/tranquilload-core/src/peer-dep-contract.test.ts` locks down: (a) `Context.Tag(key)()` produces a new class object on every evaluation (Tag identity uniqueness), and (b) Effect's context lookup is string-key-based (same-key Tags interop via Layer). Both invariants are load-bearing for the peer-dep rationale; a future Effect change to either will surface here.
- **10.8-INT-001 (F#89)** — new test in `multipart/index.test.ts` proves two parallel `uploadMultipart` calls have isolated `getProgress()` state (no shared Ref cross-talk).
- **10.8-E2E-001 (F#82)** — new `tests/e2e/ui/cleanup.spec.ts` asserts that clicking the test-app's Abort button cancels in-flight PUTs to MinIO (Playwright `requestfailed` log shows ≥1 PUT aborted, not merely abandoned). Required threading `currentAbort.signal` through the test-app's `makeMultipartCallbacks` to the inner `fetch` calls — the lib's contract is "user wires their own signal"; the lib interrupts orchestration but `Effect.tryPromise`-wrapped Promises continue silently otherwise.

**`examples/test-app` (private workspace, no published surface):** `makeMultipartCallbacks(file, ctx, signal?)` now accepts an AbortSignal and threads it into every `fetch` call (initiate, sign, PUT, complete, parts). Aligns the harness with the lib's documented signal-propagation pattern.
