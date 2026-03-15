# Project Context

## @effect/vitest — TestClock Gotcha

`@effect/vitest` uses `TestClock` by default in `it.effect(...)` tests.

- `Effect.sleep(duration)` **does NOT advance `Date.now()`**
- For tests involving real-time delays (e.g. circuit breaker `cooldown` that reads `Date.now()`): use `Effect.realDelay(duration)` instead of `Effect.sleep`
- For concurrency/scheduling tests: use `Effect.yieldNow()` to yield control without advancing real time
- For tests that must advance `TestClock`: use `TestClock.advance(duration)` explicitly
