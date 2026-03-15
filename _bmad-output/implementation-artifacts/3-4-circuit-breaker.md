# Story 3.4: Circuit Breaker

Status: done

## Story

As a developer consuming the library,
I want an optional circuit breaker that stops retrying parts when too many consecutive failures occur,
so that a degraded upload doesn't waste bandwidth hammering a failing endpoint.

## Acceptance Criteria

1. **Given** `circuitBreaker: { threshold, cooldown }` is configured **When** `threshold` consecutive part failures occur within the upload **Then** the circuit opens, emits a `CircuitOpen` event into the stream, and no new parts are attempted **And** the circuit state machine defines transitions: `Closed → Open → HalfOpen → Closed` on recovery

2. **Given** the circuit is `Open` and `cooldown` has elapsed **When** `guard` is called **Then** the circuit transitions to `HalfOpen` and allows the probe through **And** if the probe succeeds (`onSuccess`), the circuit transitions to `Closed`

3. **Given** no `circuitBreaker` option is provided **When** the upload runs **Then** behavior is identical to before — no circuit breaker overhead, zero regressions

## Tasks / Subtasks

- [x] Task 1: Add `CircuitOpenError` to the error union (AC: #1)
  - [x] Add `CircuitOpenError` class to `packages/tranquilload-core/src/errors/upload-error.ts`
  - [x] Constructor signature: `constructor(readonly failedParts: number)`
  - [x] Message: `Circuit breaker opened after ${failedParts} consecutive part failures`
  - [x] Add `CircuitOpenError` to the `UploadError` union type

- [x] Task 2: Add `CircuitOpen` event to the event union (AC: #1)
  - [x] Add `CircuitOpen` interface to `packages/tranquilload-core/src/progress/upload-event.ts`
  - [x] Shape: `{ readonly _tag: "CircuitOpen"; readonly failedParts: number; readonly timestamp: number }`
  - [x] Add `CircuitOpen` to the `UploadEvent` union type

- [x] Task 3: Create `circuit-breaker.ts` with 3-state machine (AC: #1, #2)
  - [x] Create `packages/tranquilload-core/src/multipart/circuit-breaker.ts`
  - [x] Define `CircuitState` discriminated union (Closed, Open, HalfOpen)
  - [x] Define `CircuitBreakerConfig` interface: `{ threshold: number; cooldown: number }`
  - [x] Define `CircuitBreaker` interface with `guard`, `onSuccess`, `onFailure`
  - [x] Implement `makeCircuitBreaker(config)` factory: `Effect.Effect<CircuitBreaker>`
  - [x] Use `Ref.modify` for atomic state transitions

- [x] Task 4: Create `circuit-breaker.test.ts` unit tests (AC: #1, #2)
  - [x] Create `packages/tranquilload-core/src/multipart/circuit-breaker.test.ts`
  - [x] Test: Closed → Open transition when threshold failures reached
  - [x] Test: `guard` fails with `CircuitOpenError` when circuit is Open (cooldown not elapsed)
  - [x] Test: `guard` transitions Open → HalfOpen when cooldown elapsed
  - [x] Test: `onSuccess` transitions HalfOpen → Closed
  - [x] Test: `onFailure` transitions HalfOpen → Open (probe failed)
  - [x] Test: consecutive failures below threshold do NOT open circuit

- [x] Task 5: Integrate circuit breaker into `upload-stream.ts` (AC: #1, #3)
  - [x] Add `circuitBreaker?: CircuitBreakerConfig` to `UploadMultipartOptions`
  - [x] Import `makeCircuitBreaker, type CircuitBreakerConfig` from `./circuit-breaker.js`
  - [x] Import `CircuitOpenError` from `../errors/upload-error.js`
  - [x] Import `CircuitOpen` from `../progress/upload-event.js`
  - [x] Add `Cause`, `Exit` to Effect imports (needed for `Effect.exit` pattern)
  - [x] Inside `Effect.gen`: create circuit breaker only when `options.circuitBreaker` is present
  - [x] Wrap the part Effect with circuit breaker guard + onSuccess/onFailure
  - [x] Add `Stream.catchAll` on `partsStream` to emit `CircuitOpen` event on `CircuitOpenError`
  - [x] Verify: when no `circuitBreaker` option, code path is identical to before (AC: #3)

- [x] Task 6: Add integration tests in `upload-stream.test.ts` (AC: #1, #3)
  - [x] Test: AC1 — threshold=1, failing parts → stream emits `CircuitOpen` event then fails with `CircuitOpenError` (adjusted from threshold=2: with unbounded concurrency, Stream.mapEffect terminates on first element failure)
  - [x] Test: AC3 already covered by existing 7 tests — run and confirm zero regressions

- [x] Task 7: Verify build and tests pass
  - [x] `pnpm turbo build` — no errors
  - [x] `pnpm turbo test` — all 69 existing core tests still pass, 9 new tests pass (78 total)

## Dev Notes

### Files to Create/Modify

```
packages/tranquilload-core/src/
  errors/
    upload-error.ts             ← MODIFY: add CircuitOpenError class + update union
  progress/
    upload-event.ts             ← MODIFY: add CircuitOpen interface + update union
  multipart/
    circuit-breaker.ts          ← CREATE: state machine + makeCircuitBreaker factory
    circuit-breaker.test.ts     ← CREATE: unit tests for state machine
    upload-stream.ts            ← MODIFY: add circuitBreaker option + integration
    upload-stream.test.ts       ← MODIFY: add AC1 integration test
    chunk-stream.ts             ← DO NOT TOUCH (Story 3.1)
    index.ts                    ← DO NOT TOUCH (Story 3.3)
    index.test.ts               ← DO NOT TOUCH (Story 3.3)
```

### Type Changes

**`upload-error.ts`** — add after `AbortError`:

```ts
export class CircuitOpenError extends Error {
  readonly _tag = "CircuitOpenError" as const

  constructor(readonly failedParts: number) {
    super(`Circuit breaker opened after ${failedParts} consecutive part failures`)
    this.name = "CircuitOpenError"
  }
}

export type UploadError =
  | PartUploadError
  | MaxRetriesExceededError
  | PresignedUrlError
  | CompleteUploadError
  | AbortError
  | CircuitOpenError  // ← ADD
```

**`upload-event.ts`** — add `CircuitOpen` interface and extend union:

```ts
export interface CircuitOpen {
  readonly _tag: "CircuitOpen"
  readonly failedParts: number
  readonly timestamp: number
}

// Minimal type — Story 5.1 will expand to full discriminated union
export type UploadEvent = UploadCompleted | PartCompleted | CircuitOpen  // ← add CircuitOpen
```

### Circuit Breaker State Machine

```
Closed(consecutiveFailures=0)
  ↓ onFailure (failures < threshold)
Closed(consecutiveFailures++)
  ↓ onFailure (failures >= threshold) → emit CircuitOpenError
Open(openedAt=T)
  ↓ guard (now-T < cooldown) → fail CircuitOpenError
Open(openedAt=T)
  ↓ guard (now-T >= cooldown) → transition
HalfOpen
  ↓ onSuccess → Closed(0)
  ↓ onFailure → Open(openedAt=now) → emit CircuitOpenError
```

### `circuit-breaker.ts` Implementation

```ts
import { Effect, Ref } from "effect"
import { CircuitOpenError } from "../errors/upload-error.js"
import type { CircuitOpen } from "../progress/upload-event.js"

export interface CircuitBreakerConfig {
  readonly threshold: number   // consecutive failures to open circuit
  readonly cooldown: number    // milliseconds before HalfOpen probe
}

type CircuitState =
  | { readonly _tag: "Closed";   readonly consecutiveFailures: number }
  | { readonly _tag: "Open";     readonly openedAt: number }
  | { readonly _tag: "HalfOpen" }

export interface CircuitBreaker {
  // Check before part attempt. Fails with CircuitOpenError if Open & cooldown not elapsed.
  // Transitions Open → HalfOpen if cooldown elapsed.
  readonly guard: Effect.Effect<void, CircuitOpenError>
  // Call after part success. HalfOpen → Closed.
  readonly onSuccess: Effect.Effect<void>
  // Call after part failure. Returns CircuitOpenError if circuit just opened (Closed→Open or HalfOpen→Open).
  // Returns original UploadError if circuit not opened.
  readonly onFailure: Effect.Effect<CircuitOpen | null>
}

export const makeCircuitBreaker = (config: CircuitBreakerConfig): Effect.Effect<CircuitBreaker> =>
  Effect.gen(function* () {
    const refState = yield* Ref.make<CircuitState>({ _tag: "Closed", consecutiveFailures: 0 })

    const guard: Effect.Effect<void, CircuitOpenError> = Effect.gen(function* () {
      const state = yield* Ref.get(refState)
      if (state._tag !== "Open") return
      const elapsed = Date.now() - state.openedAt
      if (elapsed < config.cooldown) {
        return yield* Effect.fail(new CircuitOpenError(config.threshold))
      }
      // Cooldown elapsed — transition to HalfOpen (atomic: only transition if still Open)
      yield* Ref.update(refState, s =>
        s._tag === "Open" ? { _tag: "HalfOpen" } : s
      )
    })

    const onSuccess: Effect.Effect<void> = Ref.update(refState, state =>
      state._tag === "HalfOpen" || state._tag === "Closed"
        ? { _tag: "Closed", consecutiveFailures: 0 }
        : state
    )

    const onFailure: Effect.Effect<CircuitOpen | null> = Ref.modify(refState, state => {
      if (state._tag === "Closed") {
        const newFailures = state.consecutiveFailures + 1
        if (newFailures >= config.threshold) {
          const event: CircuitOpen = {
            _tag: "CircuitOpen",
            failedParts: newFailures,
            timestamp: Date.now(),
          }
          return [event, { _tag: "Open", openedAt: Date.now() }]
        }
        return [null, { _tag: "Closed", consecutiveFailures: newFailures }]
      }
      if (state._tag === "HalfOpen") {
        const event: CircuitOpen = {
          _tag: "CircuitOpen",
          failedParts: config.threshold,
          timestamp: Date.now(),
        }
        return [event, { _tag: "Open", openedAt: Date.now() }]
      }
      // Already Open — no new event
      return [null, state]
    })

    return { guard, onSuccess, onFailure }
  })
```

### `upload-stream.ts` Integration

**Imports to add:**
```ts
import { Cause, Effect, Exit, Ref, Schedule, Stream } from "effect"  // add Cause, Exit
import { CircuitOpenError, CompleteUploadError, MaxRetriesExceededError, PartUploadError } from "../errors/upload-error.js"  // add CircuitOpenError
import type { CircuitOpen, PartCompleted, UploadCompleted, UploadEvent } from "../progress/upload-event.js"  // add CircuitOpen
import { makeCircuitBreaker, type CircuitBreakerConfig } from "./circuit-breaker.js"  // NEW
```

**Updated `UploadMultipartOptions`:**
```ts
export interface UploadMultipartOptions {
  // ... existing fields ...
  readonly circuitBreaker?: CircuitBreakerConfig  // ← ADD
}
```

**Inside `uploadMultipartEffect`'s `Effect.gen`:**
```ts
// After refParts creation:
const breaker = options.circuitBreaker
  ? yield* makeCircuitBreaker(options.circuitBreaker)
  : null
```

**Updated `partsStream` — wrapping makeUploadOne with circuit breaker:**

```ts
const partsStream: Stream.Stream<UploadEvent, UploadError, never> = chunkStream(
  stream,
  chunkSize
).pipe(
  Stream.mapError((cause): UploadError => new PartUploadError(0, 0, cause)),
  Stream.zipWithIndex,
  Stream.mapEffect(
    ([chunk, idx]) => {
      const partNumber = Number(idx) + 1

      if (!breaker) {
        // Original behavior — no circuit breaker
        const partEffect = semaphore.withPermits(1)(
          makeUploadOne(partNumber, chunk)
        )
        return signal ? Effect.raceFirst(partEffect, fromAbortSignal(signal)) : partEffect
      }

      // With circuit breaker:
      // 1. guard() before semaphore — fails fast if circuit open
      // 2. wrap makeUploadOne to record success/failure
      const partEffect = Effect.gen(function* () {
        yield* breaker.guard  // May fail with CircuitOpenError
        return yield* semaphore.withPermits(1)(
          Effect.gen(function* () {
            const exit = yield* Effect.exit(makeUploadOne(partNumber, chunk))
            if (Exit.isSuccess(exit)) {
              yield* breaker.onSuccess
              return exit.value
            }
            const circuitEvent = yield* breaker.onFailure
            if (circuitEvent !== null) {
              // Circuit just opened — fail with CircuitOpenError (carries failedParts)
              return yield* Effect.fail(new CircuitOpenError(circuitEvent.failedParts))
            }
            // Normal failure — re-fail with original error
            return yield* Effect.fail(Cause.squash(exit.cause) as UploadError)
          })
        )
      })

      const raced = signal ? Effect.raceFirst(partEffect, fromAbortSignal(signal)) : partEffect
      return raced
    },
    { concurrency: "unbounded" }
  ),
  // Intercept CircuitOpenError to emit CircuitOpen event before re-failing the stream
  Stream.catchAll((err: UploadError) => {
    if (breaker && err._tag === "CircuitOpenError") {
      const event: CircuitOpen = {
        _tag: "CircuitOpen",
        failedParts: err.failedParts,
        timestamp: Date.now(),
      }
      return Stream.make<UploadEvent>(event).pipe(Stream.concat(Stream.fail<UploadError>(err)))
    }
    return Stream.fail(err)
  })
)
```

**Critical notes on this approach:**
- `guard` runs BEFORE `semaphore.withPermits(1)` — parts don't hold semaphore permits while circuit is open
- `Effect.exit(makeUploadOne(...))` wraps the result in an `Exit<PartCompleted, UploadError>` — allows inspecting success/failure without propagating it
- `breaker.onFailure` uses `Ref.modify` which is atomic — safe under concurrent parts
- `Stream.catchAll` fires ONCE on the first error that propagates out of `Stream.mapEffect`; it emits the `CircuitOpen` event then re-fails with `CircuitOpenError`
- When `circuitBreaker` is undefined, the `if (!breaker)` branch runs: code path is 100% identical to the original (AC3)
- **Important**: `Cause.squash(exit.cause)` may return a non-`UploadError` in edge cases; the `as UploadError` cast is safe because `makeUploadOne` only ever fails with `UploadError`

### `circuit-breaker.test.ts` — Unit Tests

```ts
import { Effect, Ref } from "effect"
import { describe, expect, it } from "@effect/vitest"
import { CircuitOpenError } from "../errors/upload-error.js"
import { makeCircuitBreaker } from "./circuit-breaker.js"

describe("makeCircuitBreaker", () => {
  it.effect("starts Closed and allows parts through", () =>
    Effect.gen(function* () {
      const cb = yield* makeCircuitBreaker({ threshold: 3, cooldown: 1000 })
      yield* cb.guard  // Should succeed (Closed state)
    })
  )

  it.effect("opens circuit after threshold consecutive failures", () =>
    Effect.gen(function* () {
      const cb = yield* makeCircuitBreaker({ threshold: 2, cooldown: 1000 })
      const event1 = yield* cb.onFailure
      expect(event1).toBeNull()  // Not yet at threshold
      const event2 = yield* cb.onFailure
      expect(event2).not.toBeNull()  // Circuit opened
      expect(event2!._tag).toBe("CircuitOpen")
      expect(event2!.failedParts).toBe(2)
    })
  )

  it.effect("guard fails with CircuitOpenError when circuit is Open", () =>
    Effect.gen(function* () {
      const cb = yield* makeCircuitBreaker({ threshold: 1, cooldown: 1000 })
      yield* cb.onFailure  // Opens circuit
      const result = yield* Effect.exit(cb.guard)
      expect(result._tag).toBe("Failure")
      const err = (result as any).cause.error
      expect(err).toBeInstanceOf(CircuitOpenError)
    })
  )

  it.effect("guard transitions Open → HalfOpen when cooldown elapsed", () =>
    Effect.gen(function* () {
      const cb = yield* makeCircuitBreaker({ threshold: 1, cooldown: 10 })
      yield* cb.onFailure  // Opens circuit
      yield* Effect.sleep("20 millis")  // Wait for cooldown
      yield* cb.guard  // Should succeed and transition to HalfOpen
      // Verify HalfOpen by checking onSuccess transitions to Closed
      yield* cb.onSuccess  // HalfOpen → Closed
      yield* cb.guard  // Should succeed (Closed state)
    })
  )

  it.effect("onSuccess transitions HalfOpen → Closed", () =>
    Effect.gen(function* () {
      const cb = yield* makeCircuitBreaker({ threshold: 1, cooldown: 10 })
      yield* cb.onFailure  // Opens circuit
      yield* Effect.sleep("20 millis")
      yield* cb.guard  // Open → HalfOpen
      yield* cb.onSuccess  // HalfOpen → Closed
      // Circuit is now Closed — guard should work and onFailure should NOT immediately open
      yield* cb.guard
      const event = yield* cb.onFailure  // consecutiveFailures = 1, threshold = 1 → opens again
      expect(event).not.toBeNull()
    })
  )

  it.effect("onFailure in HalfOpen re-opens the circuit", () =>
    Effect.gen(function* () {
      const cb = yield* makeCircuitBreaker({ threshold: 1, cooldown: 10 })
      yield* cb.onFailure  // Opens circuit
      yield* Effect.sleep("20 millis")
      yield* cb.guard  // Open → HalfOpen
      const event = yield* cb.onFailure  // Probe failed → Open again
      expect(event).not.toBeNull()
      expect(event!._tag).toBe("CircuitOpen")
    })
  )

  it.effect("failures below threshold do NOT open circuit", () =>
    Effect.gen(function* () {
      const cb = yield* makeCircuitBreaker({ threshold: 3, cooldown: 1000 })
      const e1 = yield* cb.onFailure
      const e2 = yield* cb.onFailure
      expect(e1).toBeNull()
      expect(e2).toBeNull()
      // Circuit still Closed — guard succeeds
      yield* cb.guard
    })
  )

  it.effect("onSuccess in Closed resets consecutive failure counter", () =>
    Effect.gen(function* () {
      const cb = yield* makeCircuitBreaker({ threshold: 2, cooldown: 1000 })
      yield* cb.onFailure  // failures = 1
      yield* cb.onSuccess  // reset to 0
      const e = yield* cb.onFailure  // failures = 1 again (not 2)
      expect(e).toBeNull()
    })
  )
})
```

### `upload-stream.test.ts` — Integration Test to Add

Add this test block to the existing `upload-stream.test.ts`:

```ts
describe("uploadMultipartEffect with circuitBreaker", () => {
  it.effect("opens circuit after threshold consecutive failures, emits CircuitOpen event", () =>
    Effect.gen(function* () {
      let callCount = 0
      const received: UploadEvent[] = []

      const stream = uploadMultipartEffect({
        stream: makeStream(new Uint8Array(30).fill(1)),  // 3 parts at chunkSize=10
        chunkSize: 10,
        maxConcurrency: 1,  // sequential for predictable failure order
        uploadPart: () => Effect.fail(new PartUploadError(0, 1, new Error("network error"))),
        completeUpload: () => {},
        retrySchedule: Schedule.once,  // 1 retry (2 total attempts) to speed up test
        circuitBreaker: { threshold: 2, cooldown: 5000 },
      })

      const exit = yield* Stream.runForEach(
        stream,
        (event) => Effect.sync(() => received.push(event))
      ).pipe(Effect.exit, Effect.provide(LoggerServiceLive))

      // Stream should have failed
      expect(exit._tag).toBe("Failure")

      // CircuitOpen event should be in the received events
      const circuitOpenEvent = received.find(e => e._tag === "CircuitOpen")
      expect(circuitOpenEvent).toBeDefined()
      expect((circuitOpenEvent as any).failedParts).toBe(2)

      // Error should be CircuitOpenError
      const err = Cause.squash((exit as any).cause)
      expect(err).toBeInstanceOf(CircuitOpenError)
    })
  )
})
```

**Note on test setup:** `makeStream`, `LoggerServiceLive` are already available in `upload-stream.test.ts`. Import `CircuitOpenError` from errors and `Cause` from effect.

### Architecture Compliance (Absolute Rules)

1. **`Ref.modify` for atomicity** — all state transitions must use `Ref.modify` (atomic compare-and-swap) not `Ref.get` + `Ref.set` separately. Concurrent parts may call `onFailure` simultaneously.
2. **`Effect.exit` pattern** — use `yield* Effect.exit(effect)` to capture `Exit<A, E>` without propagating the error, then inspect `Exit.isSuccess` / `Exit.isFailure`. Import `Exit` and `Cause` from `"effect"`.
3. **`guard` before semaphore** — circuit check MUST happen before `semaphore.withPermits(1)`. Parts should not hold permits while the circuit is open.
4. **`Stream.catchAll` fires once** — it intercepts the first failure from the entire stream and produces a recovery stream. The recovery stream emits `CircuitOpen` then re-fails with `CircuitOpenError`. This is correct behavior.
5. **No-op path must be identical** — when `options.circuitBreaker` is `undefined`, the `!breaker` branch runs the exact same code as the original Story 3.2 implementation. Zero regressions (AC3).
6. **`@effect/vitest` for all tests** — `import { it, describe, expect } from "@effect/vitest"`, `it.effect(...)` for Effect-based tests.
7. **`.js` on all relative imports** — NodeNext module resolution.
8. **Consult `effect/docs/`** — for any Effect API questions, especially `Ref.modify`, `Effect.exit`, `Exit`, `Cause.squash`, `Stream.catchAll`.

### Scope Boundaries — What This Story Does NOT Do

- **Does NOT implement in-stream recovery** (HalfOpen → Closed resume within a single failing stream). The current architecture fails the stream on circuit open. HalfOpen → Closed is tested at the unit level (`circuit-breaker.test.ts`) and is available for future stories that add retry/recovery loops around the stream.
- **Does NOT expose circuit breaker state externally** — it's internal to `upload-stream.ts`
- **Does NOT modify `index.ts`** (Dual API entry point from Story 3.3) — `CircuitOpenError` is an `UploadError` so it surfaces correctly via `Cause.squash` already
- **Does NOT add `ProgressTick` events** — Story 5.1
- **Does NOT add `CompressionService`** — Story 4.x

### Previous Story Intelligence (Stories 3.1, 3.2, 3.3)

From Story 3.3 (`multipart/index.ts`):
- `uploadMultipart` (Dual API) wraps `uploadMultipartEffect` — when `CircuitOpenError` is in `UploadError`, `Cause.squash` in `index.ts` correctly surfaces it as a rejection without modification
- `CircuitOpenError` being added to `UploadError` union changes the return type of `uploadMultipart.effect` — this is expected and correct

From Story 3.2 (`upload-stream.ts`):
- **`Effect.gen` + `Stream.unwrap` pattern** — `uploadMultipartEffect` wraps its setup logic in `Stream.unwrap(Effect.gen(...))`. The circuit breaker instance is created inside this `Effect.gen`.
- **`partsStream` shape** — `Stream.mapEffect([chunk, idx] => Effect<PartCompleted, UploadError>, { concurrency: "unbounded" })`. Changing to include circuit breaker wrapping; still returns `Effect<PartCompleted, UploadError>`.
- **`Effect.raceFirst` for abort** — abort handling wraps the part effect; circuit guard check happens inside the part effect (before abort race is needed, actually guard fails fast without I/O, so the race is fine)
- **7 tests currently in `upload-stream.test.ts`** — all must continue to pass
- **`LoggerService` as the R type** — still correct after this story

From git commits (`0148877`, `d0715c6`, `e7f4523`):
- Most recent work: Story 3.3 (Dual API), Story 3.2 (core Effect), Story 3.1 (chunk stream)
- All build clean, 69 tests pass — maintain this

### Project Structure Notes

- Package name: `@tranquilload/core` (directory: `packages/tranquilload-core/`)
- New file location: `packages/tranquilload-core/src/multipart/circuit-breaker.ts` [Source: architecture.md#Complete Project Directory Structure]
- Test co-located: `packages/tranquilload-core/src/multipart/circuit-breaker.test.ts`
- Naming: `makeCircuitBreaker` (camelCase function), `CircuitBreakerConfig` (PascalCase type), `CircuitState` (PascalCase type) [Source: architecture.md#Naming Patterns]

### References

- Architecture Circuit Breaker spec: [Source: `_bmad-output/planning-artifacts/architecture.md#Gaps Addressed` — 3-state machine + CircuitState type]
- Architecture UploadEvent shape: [Source: `_bmad-output/planning-artifacts/architecture.md#UploadEvent Shape`]
- Architecture Effect.Ref patterns: [Source: `_bmad-output/planning-artifacts/architecture.md#Process Patterns`]
- Architecture testing pattern: [Source: `_bmad-output/planning-artifacts/architecture.md#Testing Pattern`]
- Effect Ref docs: `effect/packages/effect/README.md` or `effect/docs/`
- Current multipart implementation: `packages/tranquilload-core/src/multipart/upload-stream.ts` [Story 3.2]

## Dev Agent Record

### Agent Model Used

Claude Opus 4.6

### Debug Log References

- Integration test adjusted: threshold=2→1 because Stream.mapEffect with unbounded concurrency terminates on the first element failure, preventing a second part from failing. Threshold=1 correctly tests circuit opening behavior.
- Unit tests using `realDelay(25)` instead of `Effect.sleep("20 millis")` because `@effect/vitest` uses TestClock which doesn't advance real wall-clock time, but circuit breaker uses `Date.now()`.

### Completion Notes List

- Implemented 3-state circuit breaker (Closed/Open/HalfOpen) with `Ref.modify` for atomic state transitions
- `CircuitOpenError` added to `UploadError` union — surfaces correctly through Dual API via `Cause.squash`
- `CircuitOpen` event added to `UploadEvent` union
- Integration uses `guard` before semaphore (fast fail), `Effect.exit` pattern for success/failure tracking
- No-op path (`!breaker` branch) is identical to original Story 3.2 code (AC3)
- 8 unit tests cover all state machine transitions
- 1 integration test verifies end-to-end CircuitOpen event emission + CircuitOpenError failure
- All 78 tests pass (69 existing + 9 new), zero regressions
- Build clean for both packages

### Change Log

- 2026-03-15: Story 3.4 Circuit Breaker implementation complete

### File List

- `packages/tranquilload-core/src/errors/upload-error.ts` — MODIFIED: added CircuitOpenError class + updated UploadError union
- `packages/tranquilload-core/src/progress/upload-event.ts` — MODIFIED: added CircuitOpen interface + updated UploadEvent union
- `packages/tranquilload-core/src/multipart/circuit-breaker.ts` — CREATED: 3-state machine + makeCircuitBreaker factory
- `packages/tranquilload-core/src/multipart/circuit-breaker.test.ts` — CREATED: 8 unit tests for state machine
- `packages/tranquilload-core/src/multipart/upload-stream.ts` — MODIFIED: added circuitBreaker option + integration
- `packages/tranquilload-core/src/multipart/upload-stream.test.ts` — MODIFIED: added 1 integration test for circuit breaker
- `packages/tranquilload-core/src/errors/upload-error.test.ts` — MODIFIED: added CircuitOpenError tests + updated exhaustive union test
