# Story 1.2: Error Types Definition

Status: done

## Story

As a developer consuming the library,
I want a typed, exhaustive error union with `_tag` discriminants,
so that I can handle all upload failure cases with full TypeScript exhaustiveness checks and Effect `catchTag` compatibility.

## Acceptance Criteria

1. **Given** the `@tranquilload/errors` sub-path export, **When** the developer imports `UploadError`, **Then** the type is a closed union of `PartUploadError | MaxRetriesExceededError | PresignedUrlError | CompleteUploadError | AbortError`. **And** each variant extends `Error` (stack trace, `instanceof Error` works). **And** each variant has a `readonly _tag` literal property.

2. **Given** a `PartUploadError` instance, **When** caught in a Promise `.catch()` handler, **Then** `err instanceof Error` is `true` and `err.message` is human-readable. **And** `err._tag === "PartUploadError"` narrows the type in TypeScript.

3. **Given** a switch statement on `uploadError._tag`, **When** all variants are handled, **Then** TypeScript infers the `default` branch as `never` (exhaustiveness enforced). **And** `Match.tag` from Effect works equivalently on the same union.

## Tasks / Subtasks

- [x] Task 1: Create `upload-error.ts` with all 5 error classes (AC: #1, #2, #3)
  - [x] Define `PartUploadError extends Error` with `_tag`, `partNumber`, `attempt`, `cause`
  - [x] Define `MaxRetriesExceededError extends Error` with `_tag`, `partNumber`, `totalAttempts`, `cause`
  - [x] Define `PresignedUrlError extends Error` with `_tag`, `cause`
  - [x] Define `CompleteUploadError extends Error` with `_tag`, `cause`
  - [x] Define `AbortError extends Error` with `_tag`
  - [x] Define `UploadError` closed union type
  - [x] Export all types with explicit type annotations (`isolatedDeclarations: true`)

- [x] Task 2: Update `src/errors/index.ts` to re-export from `upload-error.ts` (AC: #1)
  - [x] Replace placeholder stub with real re-exports

- [x] Task 3: Write `upload-error.test.ts` co-located with source (AC: #1, #2, #3)
  - [x] Test `instanceof Error` for each variant
  - [x] Test `_tag` literal value for each variant
  - [x] Test `message` is human-readable for each variant
  - [x] Test TypeScript exhaustiveness via `switch (_tag)` with `default: never` assertion
  - [x] Test `name` property equals `_tag` string (for Sentry / logger compat)

- [x] Task 4: Verify build still passes (AC: #1)
  - [x] `pnpm turbo build` — `@tranquilload/core` compiles with new exports
  - [x] `pnpm turbo test` — `upload-error.test.ts` runs and exits 0

## Dev Notes

### Context: What Story 1.1 Left Behind

Story 1.1 created the full monorepo scaffold. The current state of `packages/tranquilload-core/src/errors/index.ts` is a placeholder stub:

```ts
// Placeholder — implemented in Story 1.2
export const _placeholder: undefined = undefined
```

**This story replaces that stub entirely.** Do NOT keep the `_placeholder` export — it will clash with the real exports and break tree-shaking.

### File Target: `packages/tranquilload-core/` (NOT `packages/core/`)

The package folder is named `tranquilload-core` (full prefix) to avoid pnpm scope symlink conflict. The npm package name inside is `@tranquilload/core`. **Never** create or write to a `packages/core/` directory.

### Critical Constraint: `isolatedDeclarations: true`

`tsconfig.base.json` sets `isolatedDeclarations: true` (required by tsdown for `.d.ts` generation). This means:
- Every exported class, type alias, function, and constant **MUST** have an explicit TypeScript type annotation
- No type inference on exports — TypeScript will error at `tsc --noEmit` otherwise
- Class constructors must annotate parameters with explicit types

### Error Class Implementation Pattern

From `architecture.md` (Error Handling Architecture section), every error class follows this exact pattern:

```ts
// packages/tranquilload-core/src/errors/upload-error.ts

export class PartUploadError extends Error {
  readonly _tag = "PartUploadError" as const

  constructor(
    readonly partNumber: number,
    readonly attempt: number,
    override readonly cause: unknown
  ) {
    super(`Part ${partNumber} failed on attempt ${attempt}`)
    this.name = "PartUploadError"
  }
}
```

**Rationale for `this.name = "PartUploadError"`:** Without this, `error.name` defaults to `"Error"`, which breaks error display in Sentry, browser DevTools, and structured logging. Setting `name` to match `_tag` gives consistent identification.

**Rationale for `override readonly cause: unknown`:** `Error.cause` was standardized in ES2022. Using `override` is required by `strict: true` when the parent class declares `cause`. The type is `unknown` to accept any upstream error.

### Complete Error Union Specification

```ts
// PartUploadError: a single part upload attempt failed
export class PartUploadError extends Error {
  readonly _tag = "PartUploadError" as const
  // partNumber: 1-based index of the chunk that failed
  // attempt: how many times this specific part was tried (1-based)
  // cause: the underlying error (network, HTTP status, etc.)
  constructor(readonly partNumber: number, readonly attempt: number, override readonly cause: unknown) { ... }
}

// MaxRetriesExceededError: all retry attempts for a part exhausted
export class MaxRetriesExceededError extends Error {
  readonly _tag = "MaxRetriesExceededError" as const
  // partNumber: 1-based index of the chunk
  // totalAttempts: total number of attempts made (equals schedule length + 1)
  // cause: the last PartUploadError that triggered exhaustion
  constructor(readonly partNumber: number, readonly totalAttempts: number, override readonly cause: unknown) { ... }
}

// PresignedUrlError: failed to obtain a pre-signed URL for a part
export class PresignedUrlError extends Error {
  readonly _tag = "PresignedUrlError" as const
  // cause: rejection from the user-provided getPresignedUrl callback
  constructor(override readonly cause: unknown) { ... }
}

// CompleteUploadError: failed to finalize the multipart upload
export class CompleteUploadError extends Error {
  readonly _tag = "CompleteUploadError" as const
  // cause: rejection from the user-provided completeUpload callback
  constructor(override readonly cause: unknown) { ... }
}

// AbortError: upload was aborted via AbortController.signal
export class AbortError extends Error {
  readonly _tag = "AbortError" as const
  constructor() {
    super("Upload aborted")
    this.name = "AbortError"
  }
}

// Closed union — exhaustive in TypeScript and Effect Match.tag
export type UploadError =
  | PartUploadError
  | MaxRetriesExceededError
  | PresignedUrlError
  | CompleteUploadError
  | AbortError
```

### `src/errors/index.ts` — Re-export Pattern

Replace the stub with direct re-exports. Since `isolatedDeclarations: true` requires explicit types on exports, use `export { ... }` (named re-exports of already-typed identifiers are fine):

```ts
// packages/tranquilload-core/src/errors/index.ts
export {
  PartUploadError,
  MaxRetriesExceededError,
  PresignedUrlError,
  CompleteUploadError,
  AbortError,
  type UploadError,
} from "./upload-error.js"
```

**Note the `.js` extension on the import path.** With `"module": "NodeNext"` in `tsconfig.base.json`, TypeScript requires explicit `.js` extensions for relative imports (even though the source file is `.ts`). Omitting `.js` causes `ERR_MODULE_NOT_FOUND` at runtime with ESM.

### Testing Pattern

Use `vitest` directly (no `@effect/vitest` needed here — error classes are plain JS, no Effect). Use `import { it, describe, expect } from 'vitest'`.

```ts
// packages/tranquilload-core/src/errors/upload-error.test.ts
import { it, describe, expect } from 'vitest'
import {
  PartUploadError,
  MaxRetriesExceededError,
  PresignedUrlError,
  CompleteUploadError,
  AbortError,
  type UploadError,
} from './upload-error.js'

describe("PartUploadError", () => {
  it("is instanceof Error", () => {
    const err = new PartUploadError(1, 1, new Error("network"))
    expect(err instanceof Error).toBe(true)
  })
  it("has correct _tag", () => {
    const err = new PartUploadError(1, 1, new Error("network"))
    expect(err._tag).toBe("PartUploadError")
  })
  it("has human-readable message", () => {
    const err = new PartUploadError(3, 2, new Error("timeout"))
    expect(err.message).toBe("Part 3 failed on attempt 2")
  })
  it("name equals _tag for logger compat", () => {
    const err = new PartUploadError(1, 1, new Error("x"))
    expect(err.name).toBe("PartUploadError")
  })
})
// ... similar for all 5 variants

// TypeScript exhaustiveness test (compile-time check baked in)
it("UploadError union is exhaustive", () => {
  const check = (err: UploadError): string => {
    switch (err._tag) {
      case "PartUploadError": return "part"
      case "MaxRetriesExceededError": return "maxRetries"
      case "PresignedUrlError": return "presigned"
      case "CompleteUploadError": return "complete"
      case "AbortError": return "abort"
      // If a new variant is added without a case, TypeScript errors here:
      // default: { const _exhaustive: never = err; return _exhaustive }
    }
  }
  expect(check(new AbortError())).toBe("abort")
})
```

### Architecture Compliance

These constraints are **ABSOLUTE** for this story:

1. **Never use `try/catch` inside Effect code** — not relevant here since error classes are plain TS, but document for future stories
2. **`readonly _tag`** — the discriminant must be `readonly` to prevent accidental mutation that would break narrowing
3. **`as const`** — the literal type `"PartUploadError"` (not `string`) is required for `catchTag` in Effect and exhaustive `switch`
4. **Extend `Error`** — never a plain object. Stack traces (`err.stack`), Sentry breadcrumbs, and `instanceof Error` all depend on real Error inheritance
5. **`cause` as `unknown`** — never type cause as `Error` — user callbacks can throw strings, numbers, or anything

### Dependency Notes

- **No new runtime dependencies** — error classes are pure TypeScript, zero deps
- **`effect` not needed** in this file — `_tag` discriminants work natively with TypeScript's discriminated unions without importing Effect
- **`@effect/vitest` NOT needed for tests** — error classes don't use Effect internals; plain `vitest` `it()` suffices

### Project Structure Notes

- **Files to create**:
  - `packages/tranquilload-core/src/errors/upload-error.ts` ← new file (all 5 classes + union type)
  - `packages/tranquilload-core/src/errors/upload-error.test.ts` ← new file (co-located tests)
- **Files to modify**:
  - `packages/tranquilload-core/src/errors/index.ts` ← replace stub with re-exports
- **Files NOT to touch**: everything in `packages/tranquilload-adapters/`, root config files, `effect/`, `smoothmultipartupload/`

### References

- Error class pattern: [Source: _bmad-output/planning-artifacts/architecture.md#Error Handling Architecture]
- `UploadError` union definition: [Source: _bmad-output/planning-artifacts/epics.md#Story 1.2: Error Types Definition]
- `isolatedDeclarations` constraint: [Source: _bmad-output/implementation-artifacts/1-1-monorepo-scaffold.md#Critical Tooling Rules]
- NodeNext `.js` extension requirement: [Source: _bmad-output/implementation-artifacts/1-1-monorepo-scaffold.md#Architecture Compliance]
- Naming conventions (PascalCase classes, camelCase functions, kebab-case files): [Source: _bmad-output/planning-artifacts/architecture.md#Naming Patterns]
- Test co-location pattern: [Source: _bmad-output/planning-artifacts/architecture.md#Testing Pattern]

## Dev Agent Record

### Agent Model Used

claude-sonnet-4-6

### Debug Log References

_None_

### Completion Notes List

- Implemented 5 error classes (`PartUploadError`, `MaxRetriesExceededError`, `PresignedUrlError`, `CompleteUploadError`, `AbortError`) all extending `Error` with `readonly _tag as const` discriminants.
- Replaced `_placeholder` stub in `src/errors/index.ts` with named re-exports using `.js` extension (NodeNext compliance).
- 28 tests written covering: `instanceof Error`, `_tag` value, human-readable messages, `name` property, `cause` preservation (all 4 classes with cause field), field values, `AbortError.cause === undefined`, and union exhaustiveness with `default: never` assertion.
- All 29 tests pass (`pnpm turbo test`), build succeeds for both packages (`pnpm turbo build`), zero regressions.

### Change Log

- 2026-03-08: Story 1.2 implemented — created `upload-error.ts` with 5 error classes and `UploadError` union, replaced `errors/index.ts` stub, added `upload-error.test.ts` with 24 tests.
- 2026-03-08: Code review fixes — added `cause` preservation tests for `MaxRetriesExceededError`, `PresignedUrlError`, `CompleteUploadError`; added `AbortError.cause === undefined` test; added `default: never` assertion to exhaustiveness test; corrected test count to 28 (29 total with scaffold). Total: +4 tests.

### File List

- `packages/tranquilload-core/src/errors/upload-error.ts` (created)
- `packages/tranquilload-core/src/errors/upload-error.test.ts` (created)
- `packages/tranquilload-core/src/errors/index.ts` (modified)
- `_bmad-output/implementation-artifacts/sprint-status.yaml` (modified)
