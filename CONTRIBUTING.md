# Contributing to Tranquilload

## Development Prerequisites

| Tool    | Version  | Why                                  |
| ------- | -------- | ------------------------------------ |
| Node.js | **≥ 22** | Build tools only (see below)         |
| pnpm    | ≥ 9      | Package manager — workspaces support |

### Node.js ≥ 22 — build time only

The `>=22` constraint enforced by `engines` in `package.json` is a **build-time requirement**, not a runtime one.

`tsdown 0.21.0` bundles via `rolldown`, which calls `process.getBuiltinModule` (available since Node 21.2). Node 20 LTS fails silently with a cryptic rolldown error.

The compiled library output in `dist/` does not use `process.getBuiltinModule`. The **runtime** Node.js requirement for consumers of `@tranquilload/core` and `@tranquilload/adapters` will be determined and documented once the library implementation matures.

## Setup

```bash
node --version   # must be >= 22
pnpm install
pnpm turbo build
pnpm turbo test
```

## Monorepo structure

```
packages/tranquilload-core/      → @tranquilload/core
packages/tranquilload-adapters/  → @tranquilload/adapters
```

> **Note on directory naming:** pnpm treats `packages/core/` as a scope directory when the package name is `@tranquilload/core`, causing broken symlinks. Directories use the full prefix (`tranquilload-core`, `tranquilload-adapters`) to avoid this.
