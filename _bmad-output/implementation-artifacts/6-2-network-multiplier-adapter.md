# Story 6.2: Network Multiplier Adapter

Status: review

## Story

As a developer consuming the library,
I want a `networkMultiplier()` adapter from `@tranquilload/adapters/networkMultiplier` that measures throughput and returns a factor between 0.1 and 1.0,
so that I can scale chunk size dynamically based on real network conditions.

## Acceptance Criteria

1. **Given** `networkMultiplier()` is called **When** it measures throughput over a sample window **Then** it returns a factor in `[0.1, 1.0]` where `1.0` means full target chunk size and `0.1` means minimum viable chunk size.

2. **Given** the factor is applied as `chunkSize = baseChunkSize * factor` **When** passed to `uploadMultipart({ chunkSize })` **Then** subsequent parts use the adjusted chunk size.

3. **Given** network conditions cannot be measured (e.g. no prior upload data) **When** `networkMultiplier()` is first called **Then** it returns `1.0` as a safe default.

## Tasks / Subtasks

- [x] Task 1: Implement `networkMultiplier()` in `packages/tranquilload-adapters/src/resilience/network-multiplier.ts` (AC: #1, #2, #3)
  - [x] Define `NetworkMultiplierInstance` interface with `record(bytes, durationMs)` and `factor()` methods
  - [x] Define `NetworkMultiplierOptions` interface (`windowSize?`, `targetBytesPerMs?`)
  - [x] Implement sliding window throughput tracking (last N samples, default N=5)
  - [x] Implement factor computation: `clamp(avgThroughput / targetBytesPerMs, 0.1, 1.0)`
  - [x] Return `1.0` when no samples have been recorded yet
  - [x] Fully replace the `_placeholder` export with the real implementation

- [x] Task 2: Create `packages/tranquilload-adapters/src/resilience/network-multiplier.test.ts` (AC: #1, #3)
  - [x] Test: no samples → `factor()` returns `1.0`
  - [x] Test: fast sample (throughput ≥ target) → `factor()` returns `1.0` (clamped at max)
  - [x] Test: slow sample (throughput = 10% of target) → `factor()` returns `0.1` (clamped at min)
  - [x] Test: rolling window evicts oldest sample — factor reflects only recent samples
  - [x] Test: `durationMs <= 0` is handled without throwing (skip or clamp)

- [x] Task 3: Build, test, typecheck (AC: all)
  - [x] `pnpm turbo build` — clean
  - [x] `pnpm turbo test` — all tests pass
  - [x] `pnpm turbo typecheck` — no errors

## Dev Notes

### Implementation Target

**File:** `packages/tranquilload-adapters/src/resilience/network-multiplier.ts`
**Current state:** Placeholder — fully replace `export const _placeholder: undefined = undefined`.

**Build config already wired — no changes needed:**
- `tsdown.config.ts` entry: `'network-multiplier': 'src/resilience/network-multiplier.ts'` ✅
- `package.json` export `./networkMultiplier` → `dist/network-multiplier.{js,cjs,d.ts}` ✅

### Suggested Public API

```ts
export interface NetworkMultiplierInstance {
  /** Record a completed upload measurement. */
  record(bytes: number, durationMs: number): void
  /** Returns current throughput factor [0.1, 1.0]. Returns 1.0 with no samples. */
  factor(): number
}

export interface NetworkMultiplierOptions {
  /** Number of recent samples to average. Default: 5 */
  windowSize?: number
  /** Throughput (bytes/ms) that maps to factor=1.0. Default: ~10 MB/s = 10485.76 bytes/ms */
  targetBytesPerMs?: number
}

export function networkMultiplier(options?: NetworkMultiplierOptions): NetworkMultiplierInstance
```

**Usage by library consumer:**
```ts
import { networkMultiplier } from "@tranquilload/adapters/networkMultiplier"

const multiplier = networkMultiplier()

// Before each part: compute adaptive chunk size
const chunkSize = BASE_CHUNK_SIZE * multiplier.factor()

// After each part: record actual performance
const start = Date.now()
await uploadPart(partNumber, chunk)
multiplier.record(chunk.byteLength, Date.now() - start)
```

### Algorithm

1. **State:** circular array of last `windowSize` samples, each = `bytes / durationMs` (bytes per ms)
2. **Average:** `mean(samples)` — `0` if empty
3. **Factor:** `Math.max(0.1, Math.min(1.0, avgThroughput / targetBytesPerMs))`
4. **No samples:** return `1.0` directly (skip division)
5. **Edge case:** `durationMs <= 0` → skip the sample (do not push to window, no throw)
6. **Default `targetBytesPerMs`:** `10 * 1024 * 1024 / 1000 ≈ 10485.76` — 10 MB/s represents a "good connection" baseline

### No Effect Required — Pure TypeScript Only

This adapter is a synchronous stateful utility. **Do NOT import from `effect`.**

```ts
// ✅ Correct — plain closure for state
export function networkMultiplier(options?: NetworkMultiplierOptions): NetworkMultiplierInstance {
  const windowSize = options?.windowSize ?? 5
  const targetBytesPerMs = options?.targetBytesPerMs ?? (10 * 1024 * 1024 / 1000)
  const samples: number[] = []
  // ...
}
```

Tests use **standard vitest** (NOT `@effect/vitest`):
```ts
import { describe, it, expect } from 'vitest'
import { networkMultiplier } from './network-multiplier.js'
```

### Files to Touch

1. `packages/tranquilload-adapters/src/resilience/network-multiplier.ts` — implement (replace placeholder)
2. `packages/tranquilload-adapters/src/resilience/network-multiplier.test.ts` — create (new file)

**Do NOT touch:**
- Any other adapter file (`from-file.ts`, `from-node-readable.ts`, `s3-multipart-upload.ts`, `simple-http-upload.ts`) — they are placeholders for later stories (8.x)
- `packages/tranquilload-adapters/src/scaffold.test.ts` — leave as-is
- Any file in `packages/tranquilload-core/`

### This Is the First Real Implementation in `@tranquilload/adapters`

All other adapter files are still placeholders. The scaffold test (`scaffold.test.ts`) will continue to serve as the package-level vitest guard — it does not interfere with the new test file.

### Project Structure Notes

- **Folder:** `packages/tranquilload-adapters/src/resilience/` (already exists)
- **Naming:** kebab-case file (`network-multiplier.ts`), camelCase function (`networkMultiplier`), PascalCase interfaces (`NetworkMultiplierInstance`, `NetworkMultiplierOptions`)
- **No import from `@tranquilload/core`** — pure throughput math, no dependency on upload logic
- **Test co-location:** `network-multiplier.test.ts` next to `network-multiplier.ts`

### Triptyque obligatoire

`pnpm turbo build && pnpm turbo test && pnpm turbo typecheck` — les trois doivent passer.

### References

- Story requirements: `_bmad-output/planning-artifacts/epics.md#Story 6.2`
- FR9 (network multiplier): `_bmad-output/planning-artifacts/epics.md#FR9`
- Architecture adapter location: `_bmad-output/planning-artifacts/architecture.md#packages/adapters/`
- Build entry: `packages/tranquilload-adapters/tsdown.config.ts`
- Package export: `packages/tranquilload-adapters/package.json` (`./networkMultiplier`)
- Placeholder to replace: `packages/tranquilload-adapters/src/resilience/network-multiplier.ts`
- Previous story (retry schedule): `_bmad-output/implementation-artifacts/6-1-injectable-retry-schedule.md`

## Dev Agent Record

### Agent Model Used

Claude Opus 4.6

### Debug Log References

None — clean implementation, no debugging needed.

### Completion Notes List

- Implemented `networkMultiplier()` factory function with sliding window throughput tracking
- Pure TypeScript, no Effect dependency — closure-based state management
- Interfaces: `NetworkMultiplierInstance` (record/factor), `NetworkMultiplierOptions` (windowSize/targetBytesPerMs)
- Algorithm: circular array of throughput samples, mean average, clamped to [0.1, 1.0]
- Default target: ~10 MB/s (10485.76 bytes/ms), default window: 5 samples
- Edge case: `durationMs <= 0` silently skipped (no throw)
- 6 unit tests covering: no samples, fast/slow throughput, clamping, window eviction, invalid duration
- Triptyque build + test + typecheck: all pass (111 total tests, 0 regressions)

### Change Log

- 2026-03-18: Implemented Story 6.2 — networkMultiplier adapter with full test coverage

### File List

- `packages/tranquilload-adapters/src/resilience/network-multiplier.ts` — replaced placeholder with full implementation
- `packages/tranquilload-adapters/src/resilience/network-multiplier.test.ts` — new, 6 unit tests
