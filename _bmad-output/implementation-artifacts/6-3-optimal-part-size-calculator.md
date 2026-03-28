# Story 6.3: Optimal Part Size Calculator

Status: review

## Story

As a developer consuming the library,
I want a `computeOptimalPartSize({ totalBytes, targetPartCount, minPartSize, maxPartSize })` helper,
so that I can calculate the correct chunk size for any upload without manual math or violating protocol constraints.

## Acceptance Criteria

1. **Given** `totalBytes = 100MB`, `targetPartCount = 10`, `minPartSize = 5MB` (S3 constraint) **When** `computeOptimalPartSize` is called **Then** it returns `10MB` (satisfies both target count and min size).

2. **Given** a file so small that `totalBytes / targetPartCount < minPartSize` **When** `computeOptimalPartSize` is called **Then** it returns `minPartSize` and the actual part count is less than `targetPartCount`.

3. **Given** `totalBytes` is unknown (`undefined`) **When** `computeOptimalPartSize` is called **Then** it returns `minPartSize` as a safe floor value.

## Tasks / Subtasks

- [x] Task 1: Implement `computeOptimalPartSize` in `packages/tranquilload-adapters/src/resilience/optimal-part-size.ts` (AC: #1, #2, #3)
  - [x] Define `OptimalPartSizeOptions` interface (`totalBytes?`, `targetPartCount`, `minPartSize`, `maxPartSize?`)
  - [x] Implement: `totalBytes` undefined → return `minPartSize`
  - [x] Implement: `Math.ceil(totalBytes / targetPartCount)`, clamp to `[minPartSize, maxPartSize]`
  - [x] Export `computeOptimalPartSize` function

- [x] Task 2: Wire build config (AC: all)
  - [x] Add entry `'optimal-part-size': 'src/resilience/optimal-part-size.ts'` to `packages/tranquilload-adapters/tsdown.config.ts`
  - [x] Add `./optimalPartSize` export entry to `packages/tranquilload-adapters/package.json`

- [x] Task 3: Create `packages/tranquilload-adapters/src/resilience/optimal-part-size.test.ts` (AC: #1, #2, #3)
  - [x] Test: `totalBytes = undefined` → returns `minPartSize`
  - [x] Test: optimal path (AC1 example: 100MB / 10 = 10MB > 5MB min → 10MB)
  - [x] Test: small file — `totalBytes / targetPartCount < minPartSize` → returns `minPartSize`
  - [x] Test: `maxPartSize` clamps result when raw part size exceeds max
  - [x] Test: exact boundary — `totalBytes / targetPartCount === minPartSize` → returns that exact value

- [x] Task 4: Build, test, typecheck (AC: all)
  - [x] `pnpm turbo build` — clean
  - [x] `pnpm turbo test` — all tests pass
  - [x] `pnpm turbo typecheck` — no errors

## Dev Notes

### Implementation Target

**New file:** `packages/tranquilload-adapters/src/resilience/optimal-part-size.ts`

No placeholder to replace — this is a net-new file in an existing folder.

### Public API

```ts
export interface OptimalPartSizeOptions {
  /** Total file size in bytes. Pass `undefined` if unknown (streaming). */
  totalBytes?: number
  /** Desired number of parts. */
  targetPartCount: number
  /** Protocol minimum part size (e.g. 5 * 1024 * 1024 for S3). Always returned as floor. */
  minPartSize: number
  /** Optional maximum part size. Clamps result if provided. */
  maxPartSize?: number
}

export function computeOptimalPartSize(options: OptimalPartSizeOptions): number
```

### Algorithm

```
1. If totalBytes === undefined → return minPartSize
2. raw = Math.ceil(totalBytes / targetPartCount)
3. result = Math.max(raw, minPartSize)
4. if maxPartSize !== undefined: result = Math.min(result, maxPartSize)
5. return result
```

**AC walkthrough:**
- AC1: `Math.ceil(100MB / 10) = 10MB`, `Math.max(10MB, 5MB) = 10MB` ✓
- AC2: `Math.ceil(8MB / 10) = 1MB`, `Math.max(1MB, 5MB) = 5MB` ✓
- AC3: `totalBytes = undefined` → `5MB` directly ✓

### No Effect Required — Pure TypeScript Only

Same pattern as `networkMultiplier`:
- Synchronous pure function, no state, no I/O
- **Do NOT import from `effect`**
- **Do NOT import from `@tranquilload/core`**

### Build Wiring Required

**Two files to update:**

**`packages/tranquilload-adapters/tsdown.config.ts`** — add entry:
```ts
'optimal-part-size': 'src/resilience/optimal-part-size.ts',
```

**`packages/tranquilload-adapters/package.json`** — add export (maintain `types` BEFORE `import`/`require`):
```json
"./optimalPartSize": {
  "types": "./dist/optimal-part-size.d.ts",
  "import": "./dist/optimal-part-size.js",
  "require": "./dist/optimal-part-size.cjs"
}
```

### Tests Pattern

Standard vitest (NOT `@effect/vitest`) — same as `network-multiplier.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { computeOptimalPartSize } from './optimal-part-size.js'

const MB = 1024 * 1024

describe('computeOptimalPartSize', () => {
  it('returns minPartSize when totalBytes is undefined', () => {
    expect(computeOptimalPartSize({
      totalBytes: undefined,
      targetPartCount: 10,
      minPartSize: 5 * MB,
    })).toBe(5 * MB)
  })
  // ...
})
```

Use `.js` extension in import path (ESM resolution).

### Files to Touch

**Create (new):**
1. `packages/tranquilload-adapters/src/resilience/optimal-part-size.ts`
2. `packages/tranquilload-adapters/src/resilience/optimal-part-size.test.ts`

**Update:**
3. `packages/tranquilload-adapters/tsdown.config.ts` — add `'optimal-part-size'` entry
4. `packages/tranquilload-adapters/package.json` — add `./optimalPartSize` export

**Do NOT touch:**
- Any other adapter file (placeholders for stories 8.x)
- `packages/tranquilload-adapters/src/scaffold.test.ts`
- `packages/tranquilload-core/` — this is an adapter utility, not core

### Project Structure Notes

- **Folder:** `packages/tranquilload-adapters/src/resilience/` (already exists, where `network-multiplier.ts` lives)
- **Naming:** kebab-case file (`optimal-part-size.ts`), camelCase export key (`./optimalPartSize`), PascalCase interface (`OptimalPartSizeOptions`), camelCase function (`computeOptimalPartSize`)
- **Test co-location:** `optimal-part-size.test.ts` next to `optimal-part-size.ts`
- **Export map order:** `types` MUST come before `import`/`require` in package.json exports (established project rule)

### Triptyque obligatoire

`pnpm turbo build && pnpm turbo test && pnpm turbo typecheck` — les trois doivent passer.

### References

- Story requirements: `_bmad-output/planning-artifacts/epics.md#Story 6.3`
- FR10 definition: `_bmad-output/planning-artifacts/epics.md#FR10`
- Adapter resilience folder: `packages/tranquilload-adapters/src/resilience/`
- Build config reference: `packages/tranquilload-adapters/tsdown.config.ts` (see `network-multiplier` entry pattern)
- Package exports reference: `packages/tranquilload-adapters/package.json` (see `./networkMultiplier` pattern)
- Previous story (network multiplier): `_bmad-output/implementation-artifacts/6-2-network-multiplier-adapter.md`

## Dev Agent Record

### Agent Model Used

Claude Opus 4.6

### Debug Log References

### Completion Notes List

- Implemented `computeOptimalPartSize` pure function with `OptimalPartSizeOptions` interface
- Algorithm: undefined totalBytes → minPartSize; otherwise ceil(totalBytes/targetPartCount) clamped to [minPartSize, maxPartSize]
- 5 tests covering all ACs: undefined totalBytes, optimal path, small file floor, maxPartSize clamp, exact boundary
- Build wired: tsdown entry + package.json export map (`./optimalPartSize`)
- Triptyque build/test/typecheck: all green, 0 regressions (117 total tests)

### Change Log

- 2026-03-28: Implemented Story 6.3 — computeOptimalPartSize function, tests, build wiring

### File List

**Created:**
- `packages/tranquilload-adapters/src/resilience/optimal-part-size.ts`
- `packages/tranquilload-adapters/src/resilience/optimal-part-size.test.ts`

**Modified:**
- `packages/tranquilload-adapters/tsdown.config.ts`
- `packages/tranquilload-adapters/package.json`
