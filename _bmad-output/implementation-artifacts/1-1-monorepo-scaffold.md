# Story 1.1: Monorepo Scaffold

Status: review

## Story

As a developer building the library,
I want a fully configured monorepo with build, test, and watch pipelines,
so that I can develop, test, and build both packages with a single toolchain.

## Acceptance Criteria

1. **Given** an empty project directory, **When** the developer runs `pnpm install` then `pnpm turbo build`, **Then** both `packages/core` and `packages/adapters` compile successfully — each `dist/` contains `.js` (ESM), `.cjs` (CJS), and `.d.ts` (types) for every entry point. **And** the exports map in each `package.json` satisfies all named sub-path entries (`./multipart`, `./oneshot`, `./pipeline`, `./services`, `./errors`, `./progress` for core; `./fromFile`, `./fromNodeReadable`, `./s3MultipartUpload`, `./simpleHttpUpload`, `./networkMultiplier` for adapters).

2. **Given** a source file change in `packages/core`, **When** the developer runs `pnpm turbo test`, **Then** vitest runs all `*.test.ts` files co-located with source files. **And** the Turborepo cache skips unchanged packages on subsequent runs.

3. **Given** the monorepo root, **When** the developer inspects `tsconfig.base.json`, **Then** `strict: true` and `isolatedDeclarations: true` are set. **And** each package's `tsconfig.json` extends the base config with `"extends": "../../tsconfig.base.json"`.

## Tasks / Subtasks

- [x] Task 1: Create root monorepo configuration files (AC: #1, #2, #3)
  - [x] Create `package.json` (private:true, pnpm scripts, turbo)
  - [x] Create `pnpm-workspace.yaml`
  - [x] Create `turbo.json` with build→test pipeline and remote caching off
  - [x] Create `tsconfig.base.json` with strict + isolatedDeclarations
  - [x] Update `.gitignore` (dist, node_modules, .turbo)

- [x] Task 2: Scaffold `packages/core` (`@tranquilload`) (AC: #1, #3)
  - [x] Create `packages/core/package.json` with full exports map and `effect` as peerDep
  - [x] Create `packages/core/tsconfig.json` extending base
  - [x] Create `packages/core/tsdown.config.ts` with all 6 entry points
  - [x] Create `packages/core/vitest.config.ts`

- [x] Task 3: Create placeholder source stubs for `packages/core` (AC: #1)
  - [x] `src/errors/index.ts` — export placeholder
  - [x] `src/multipart/index.ts` — export placeholder
  - [x] `src/oneshot/index.ts` — export placeholder
  - [x] `src/pipeline/index.ts` — export placeholder
  - [x] `src/services/index.ts` — export placeholder
  - [x] `src/progress/index.ts` — export placeholder
  - [x] `src/utils/normalize-callback.ts` — export placeholder
  - [x] `src/utils/abort-interop.ts` — export placeholder

- [x] Task 4: Scaffold `packages/adapters` (`@tranquilload/adapters`) (AC: #1, #3)
  - [x] Create `packages/adapters/package.json` with exports map and `workspace:*` dep on core
  - [x] Create `packages/adapters/tsconfig.json` extending base
  - [x] Create `packages/adapters/tsdown.config.ts` with 5 entry points
  - [x] Create `packages/adapters/vitest.config.ts`

- [x] Task 5: Create placeholder source stubs for `packages/adapters` (AC: #1)
  - [x] `src/sources/from-file.ts`
  - [x] `src/sources/from-node-readable.ts`
  - [x] `src/protocols/s3-multipart-upload.ts`
  - [x] `src/protocols/simple-http-upload.ts`
  - [x] `src/resilience/network-multiplier.ts`

- [x] Task 6: Initialize Changesets for lockstep versioning (AC: #1)
  - [x] Create `.changeset/config.json` with linked packages for lockstep

- [x] Task 7: Verify full pipeline works (AC: #1, #2)
  - [x] Run `pnpm install`
  - [x] Run `pnpm turbo build` → both packages succeed
  - [x] Run `pnpm turbo test` → vitest exits 0 (no tests yet, but runner works)
  - [x] Run `pnpm turbo build` again → Turborepo cache used (all tasks skipped)

## Dev Notes

### Context: Existing Project Root

The project root at `tranquilload/` already contains:
- `effect/` — local Effect repo clone (NEVER delete or modify)
- `smoothmultipartupload/` — reference code (NEVER modify)
- `docs/`, `_bmad/`, `_bmad-output/` — project management files (NEVER modify)
- `INITIAL_PROMPT.md` — requirements doc (NEVER modify)
- `.git/` — existing git repo

This story adds NEW files alongside these. Do NOT touch the existing directories.

### Critical Tooling Rules

- **tsdown, NOT tsup** — tsup is abandoned. Never create a tsup.config.ts.
- **pnpm, NOT npm or yarn** — all install commands use pnpm.
- **`effect` as peerDependency** — NEVER add `effect` to `dependencies`. Two runtime copies silently break `Context.Tag` equality.
- **`isolatedDeclarations: true`** — required by tsdown for `.d.ts` generation. This means every exported function/value MUST have an explicit return type annotation. No type inference on exports.

### File-by-File Specifications

#### Root `package.json`

```json
{
  "name": "tranquilload-monorepo",
  "private": true,
  "packageManager": "pnpm@9.0.0",
  "scripts": {
    "build": "turbo build",
    "test": "turbo test",
    "dev": "turbo dev",
    "typecheck": "turbo typecheck"
  },
  "devDependencies": {
    "turbo": "latest",
    "typescript": "^5.5.0"
  }
}
```

#### `pnpm-workspace.yaml`

```yaml
packages:
  - 'packages/*'
```

#### `turbo.json`

```json
{
  "$schema": "https://turbo.build/schema.json",
  "tasks": {
    "build": {
      "dependsOn": ["^build"],
      "outputs": ["dist/**"]
    },
    "test": {
      "dependsOn": ["build"],
      "cache": false
    },
    "typecheck": {
      "dependsOn": ["^build"]
    },
    "dev": {
      "cache": false,
      "persistent": true
    }
  }
}
```

**Rationale:** `"dependsOn": ["^build"]` for `build` means `packages/adapters` builds only after `packages/core` is built. `test` depends on `build` so tests always run against fresh builds.

#### `tsconfig.base.json`

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2022", "DOM"],
    "strict": true,
    "isolatedDeclarations": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "noUncheckedIndexedAccess": true
  }
}
```

**Critical:** `isolatedDeclarations: true` — This is TypeScript 5.5+ feature required by tsdown for type generation. Every exported symbol needs an explicit type annotation.

#### `packages/core/package.json`

```json
{
  "name": "@tranquilload",
  "version": "0.1.0",
  "description": "Type-safe upload library built on Effect",
  "license": "MIT",
  "type": "module",
  "exports": {
    "./multipart": {
      "import": "./dist/multipart.js",
      "require": "./dist/multipart.cjs",
      "types": "./dist/multipart.d.ts"
    },
    "./oneshot": {
      "import": "./dist/oneshot.js",
      "require": "./dist/oneshot.cjs",
      "types": "./dist/oneshot.d.ts"
    },
    "./pipeline": {
      "import": "./dist/pipeline.js",
      "require": "./dist/pipeline.cjs",
      "types": "./dist/pipeline.d.ts"
    },
    "./services": {
      "import": "./dist/services.js",
      "require": "./dist/services.cjs",
      "types": "./dist/services.d.ts"
    },
    "./errors": {
      "import": "./dist/errors.js",
      "require": "./dist/errors.cjs",
      "types": "./dist/errors.d.ts"
    },
    "./progress": {
      "import": "./dist/progress.js",
      "require": "./dist/progress.cjs",
      "types": "./dist/progress.d.ts"
    }
  },
  "peerDependencies": {
    "effect": ">=3.19.19"
  },
  "devDependencies": {
    "@effect/vitest": "latest",
    "effect": "3.19.19",
    "tsdown": "latest",
    "typescript": "^5.5.0",
    "vitest": "^2.0.0"
  },
  "scripts": {
    "build": "tsdown",
    "dev": "tsdown --watch",
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  }
}
```

**Critical:** `effect` in `peerDependencies` AND `devDependencies`. PeerDep = what users install. DevDep = what we use during development. Never in `dependencies`.

#### `packages/core/tsconfig.json`

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "dist"
  },
  "include": ["src/**/*.ts"]
}
```

#### `packages/core/tsdown.config.ts`

```ts
import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: {
    multipart: 'src/multipart/index.ts',
    oneshot: 'src/oneshot/index.ts',
    pipeline: 'src/pipeline/index.ts',
    services: 'src/services/index.ts',
    errors: 'src/errors/index.ts',
    progress: 'src/progress/index.ts',
  },
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  sourcemap: true,
})
```

**Note:** tsdown is ESM-first. The `format: ['esm', 'cjs']` generates both `.js` (ESM) and `.cjs` (CJS) files in `dist/`. The `dts: true` generates `.d.ts` files. The export map in `package.json` must match these exact output filenames.

#### `packages/core/vitest.config.ts`

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
  },
})
```

#### Core Placeholder Source Stubs

Each stub exports an empty placeholder. Since `isolatedDeclarations: true` is required, every export needs an explicit type.

`src/errors/index.ts`:
```ts
// Placeholder — implemented in Story 1.2
export const _placeholder: undefined = undefined
```

Wait — for a pure scaffold story, we just need tsdown to compile. The simplest valid stub:

`src/errors/index.ts`:
```ts
// Placeholder — implemented in Story 1.2
export const _placeholder: undefined = undefined
```

`src/multipart/index.ts`:
```ts
// Placeholder — implemented in Epic 3
export const _placeholder: undefined = undefined
```

`src/oneshot/index.ts`:
```ts
// Placeholder — implemented in Epic 2
export const _placeholder: undefined = undefined
```

`src/pipeline/index.ts`:
```ts
// Placeholder — implemented in Epic 4
export const _placeholder: undefined = undefined
```

`src/services/index.ts`:
```ts
// Placeholder — implemented in Story 1.3
export const _placeholder: undefined = undefined
```

`src/progress/index.ts`:
```ts
// Placeholder — implemented in Epic 5
export const _placeholder: undefined = undefined
```

`src/utils/normalize-callback.ts`:
```ts
// Placeholder — implemented in Story 1.4
export const _placeholder: undefined = undefined
```

`src/utils/abort-interop.ts`:
```ts
// Placeholder — implemented in Story 1.4
export const _placeholder: undefined = undefined
```

#### `packages/adapters/package.json`

```json
{
  "name": "@tranquilload/adapters",
  "version": "0.1.0",
  "description": "Adapters for Tranquilload (S3, File, Node, HTTP)",
  "license": "MIT",
  "type": "module",
  "exports": {
    "./fromFile": {
      "import": "./dist/from-file.js",
      "require": "./dist/from-file.cjs",
      "types": "./dist/from-file.d.ts"
    },
    "./fromNodeReadable": {
      "import": "./dist/from-node-readable.js",
      "require": "./dist/from-node-readable.cjs",
      "types": "./dist/from-node-readable.d.ts"
    },
    "./s3MultipartUpload": {
      "import": "./dist/s3-multipart-upload.js",
      "require": "./dist/s3-multipart-upload.cjs",
      "types": "./dist/s3-multipart-upload.d.ts"
    },
    "./simpleHttpUpload": {
      "import": "./dist/simple-http-upload.js",
      "require": "./dist/simple-http-upload.cjs",
      "types": "./dist/simple-http-upload.d.ts"
    },
    "./networkMultiplier": {
      "import": "./dist/network-multiplier.js",
      "require": "./dist/network-multiplier.cjs",
      "types": "./dist/network-multiplier.d.ts"
    }
  },
  "peerDependencies": {
    "effect": ">=3.19.19",
    "@tranquilload": "workspace:*"
  },
  "devDependencies": {
    "@effect/vitest": "latest",
    "@tranquilload": "workspace:*",
    "effect": "3.19.19",
    "tsdown": "latest",
    "typescript": "^5.5.0",
    "vitest": "^2.0.0"
  },
  "scripts": {
    "build": "tsdown",
    "dev": "tsdown --watch",
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  }
}
```

**Critical:** `@tranquilload: "workspace:*"` in BOTH `peerDependencies` and `devDependencies`. The workspace reference allows TypeScript path resolution during dev without needing a published package.

#### `packages/adapters/tsconfig.json`

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "dist"
  },
  "include": ["src/**/*.ts"]
}
```

#### `packages/adapters/tsdown.config.ts`

```ts
import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: {
    'from-file': 'src/sources/from-file.ts',
    'from-node-readable': 'src/sources/from-node-readable.ts',
    's3-multipart-upload': 'src/protocols/s3-multipart-upload.ts',
    'simple-http-upload': 'src/protocols/simple-http-upload.ts',
    'network-multiplier': 'src/resilience/network-multiplier.ts',
  },
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  sourcemap: true,
})
```

**Note on output filenames:** The entry key `'from-file'` produces `dist/from-file.js`, `dist/from-file.cjs`, `dist/from-file.d.ts`. These MUST match the export map paths above exactly.

#### `packages/adapters/vitest.config.ts`

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
  },
})
```

#### Adapters Placeholder Stubs

`src/sources/from-file.ts`:
```ts
// Placeholder — implemented in Story 8.1
export const _placeholder: undefined = undefined
```

`src/sources/from-node-readable.ts`:
```ts
// Placeholder — implemented in Story 8.2
export const _placeholder: undefined = undefined
```

`src/protocols/s3-multipart-upload.ts`:
```ts
// Placeholder — implemented in Story 8.3
export const _placeholder: undefined = undefined
```

`src/protocols/simple-http-upload.ts`:
```ts
// Placeholder — implemented in Story 8.4
export const _placeholder: undefined = undefined
```

`src/resilience/network-multiplier.ts`:
```ts
// Placeholder — implemented in Story 6.2
export const _placeholder: undefined = undefined
```

#### `.changeset/config.json`

```json
{
  "$schema": "https://unpkg.com/@changesets/config@3.0.0/schema.json",
  "changelog": "@changesets/cli/changelog",
  "commit": false,
  "fixed": [],
  "linked": [["@tranquilload", "@tranquilload/adapters"]],
  "access": "public",
  "baseBranch": "master",
  "updateInternalDependencies": "patch",
  "ignore": []
}
```

**Critical:** `"linked": [["@tranquilload", "@tranquilload/adapters"]]` enforces lockstep versioning — both packages always get the same version bump.

#### `.gitignore` additions

Add these entries if not present:
```
node_modules/
dist/
.turbo/
*.tsbuildinfo
.changeset/*.md
!.changeset/config.json
```

### Project Structure Notes

**Complete target directory structure for this story:**

```
tranquilload/                         ← existing git root (do NOT modify existing files)
├── .changeset/
│   └── config.json                   ← NEW: lockstep versioning config
├── .gitignore                        ← UPDATE: add dist/, .turbo/, node_modules/
├── package.json                      ← NEW: private root, turbo scripts
├── pnpm-workspace.yaml               ← NEW: packages/* glob
├── turbo.json                        ← NEW: build→test pipeline
├── tsconfig.base.json                ← NEW: strict + isolatedDeclarations
├── packages/
│   ├── core/                         ← NEW: @tranquilload
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   ├── tsdown.config.ts
│   │   ├── vitest.config.ts
│   │   └── src/
│   │       ├── errors/index.ts       ← placeholder stub
│   │       ├── multipart/index.ts    ← placeholder stub
│   │       ├── oneshot/index.ts      ← placeholder stub
│   │       ├── pipeline/index.ts     ← placeholder stub
│   │       ├── services/index.ts     ← placeholder stub
│   │       ├── progress/index.ts     ← placeholder stub
│   │       └── utils/
│   │           ├── normalize-callback.ts  ← placeholder stub
│   │           └── abort-interop.ts       ← placeholder stub
│   └── adapters/                     ← NEW: @tranquilload/adapters
│       ├── package.json
│       ├── tsconfig.json
│       ├── tsdown.config.ts
│       ├── vitest.config.ts
│       └── src/
│           ├── sources/
│           │   ├── from-file.ts           ← placeholder stub
│           │   └── from-node-readable.ts  ← placeholder stub
│           ├── protocols/
│           │   ├── s3-multipart-upload.ts ← placeholder stub
│           │   └── simple-http-upload.ts  ← placeholder stub
│           └── resilience/
│               └── network-multiplier.ts  ← placeholder stub
├── effect/                           ← EXISTING: do not touch
├── smoothmultipartupload/            ← EXISTING: do not touch
├── docs/                             ← EXISTING: do not touch
└── _bmad-output/                     ← EXISTING: do not touch
```

### Architecture Compliance

**These constraints are ABSOLUTE — violating any of them creates silent failures:**

1. **No `effect` in `dependencies`** — must be in `peerDependencies` only. Two copies = `Context.Tag` breaks silently.
2. **`isolatedDeclarations: true`** — every exported value/function needs an explicit TypeScript type annotation. Without this, tsdown `.d.ts` generation fails.
3. **Export map filenames must match tsdown outputs exactly** — key `'from-file'` in tsdown config → `dist/from-file.js`. If there's a mismatch, `require('@tranquilload/adapters/fromFile')` fails at runtime.
4. **`type: "module"`** in all package.json files — tsdown is ESM-first. Without this, Node.js misidentifies `.js` files.
5. **`workspace:*` in adapters for `@tranquilload`** — enables local TypeScript path resolution without publishing. Without this, adapters cannot import from core during dev.

### Testing Notes

This story has no business logic, so no `*.test.ts` files with real assertions are created. A minimal scaffold test is included in each package to ensure vitest runs and exits 0.

**Verify with:**
```bash
pnpm install
pnpm turbo build     # Both packages must show "Build succeeded"
pnpm turbo test      # vitest exits 0
pnpm turbo build     # Second run → "FULL TURBO" (all cached)
```

### Lessons Learned

- **Node.js ≥ 22 required** — `tsdown@0.21.0` + `rolldown@1.0.0-rc.7` use `process.getBuiltinModule` (Node 21.2+). Node 20 fails.
- **vitest 3.x exits code 1 with no test files** — add a scaffold test rather than `passWithNoTests`.
- **Export map order matters** — `types` must come before `import`/`require` to avoid bundler warnings.

### References

- Architecture source of truth: [Source: _bmad-output/planning-artifacts/architecture.md#Starter Template Evaluation]
- Export map pattern: [Source: _bmad-output/planning-artifacts/architecture.md#Module & Package Architecture]
- tsdown config: [Source: _bmad-output/planning-artifacts/architecture.md#Build Tooling]
- Naming conventions: [Source: _bmad-output/planning-artifacts/architecture.md#Naming Patterns]
- Changesets lockstep: [Source: _bmad-output/planning-artifacts/architecture.md#Infrastructure & Publishing]
- tsdown is successor to tsup: [Source: _bmad-output/project-context.md#Technology Stack & Versions]
- isolatedDeclarations requirement: [Source: _bmad-output/project-context.md#Language-Specific Rules]

## Dev Agent Record

### Agent Model Used

claude-sonnet-4-6

### Debug Log References

- Node.js v20 incompatible with tsdown 0.21.0 / rolldown 1.0.0-rc.7 (`process.getBuiltinModule` missing) → upgraded to Node 22
- pnpm optional dep issue with `@rolldown/binding-linux-x64-gnu` on Node 20 → resolved by Node 22 upgrade
- vitest 3.x exits code 1 with zero test files → added scaffold test in each package
- Export map `types` field must precede `import`/`require` → fixed ordering in both package.json files

### Completion Notes List

- Monorepo scaffold complete: `@tranquilload` (core) and `@tranquilload/adapters` build to ESM + CJS + `.d.ts` via tsdown 0.21.0 / rolldown 1.0.0-rc.7
- Turborepo pipeline: `build → test` with cache working (FULL TURBO on second run)
- All 6 core entry points and 5 adapter entry points compile cleanly
- `tsconfig.base.json` enforces `strict: true` and `isolatedDeclarations: true`
- `.changeset/config.json` configured for lockstep versioning of both packages
- Requires Node.js ≥ 22 (tsdown 0.21.0 minimum)

### File List

- `.gitignore` (modified)
- `.changeset/config.json`
- `package.json`
- `pnpm-workspace.yaml`
- `turbo.json`
- `tsconfig.base.json`
- `packages/core/package.json`
- `packages/core/tsconfig.json`
- `packages/core/tsdown.config.ts`
- `packages/core/vitest.config.ts`
- `packages/core/src/scaffold.test.ts`
- `packages/core/src/errors/index.ts`
- `packages/core/src/multipart/index.ts`
- `packages/core/src/oneshot/index.ts`
- `packages/core/src/pipeline/index.ts`
- `packages/core/src/services/index.ts`
- `packages/core/src/progress/index.ts`
- `packages/core/src/utils/normalize-callback.ts`
- `packages/core/src/utils/abort-interop.ts`
- `packages/adapters/package.json`
- `packages/adapters/tsconfig.json`
- `packages/adapters/tsdown.config.ts`
- `packages/adapters/vitest.config.ts`
- `packages/adapters/src/scaffold.test.ts`
- `packages/adapters/src/sources/from-file.ts`
- `packages/adapters/src/sources/from-node-readable.ts`
- `packages/adapters/src/protocols/s3-multipart-upload.ts`
- `packages/adapters/src/protocols/simple-http-upload.ts`
- `packages/adapters/src/resilience/network-multiplier.ts`

## Change Log

- 2026-03-08: Story 1.1 implemented — monorepo scaffold with build/test/cache pipeline (claude-sonnet-4-6)
