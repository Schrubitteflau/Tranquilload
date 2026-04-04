# Story 9.1: CI Workflow

Status: review

## Story

As a developer contributing to the library,
I want a GitHub Actions `ci.yml` workflow that runs on every push and pull request,
so that typecheck failures, test failures, and build errors are caught before any code reaches `master`.

## Acceptance Criteria

1. **Given** a pull request is opened or a push is made to any branch **When** the CI workflow runs **Then** it executes typecheck, test, and build via Turborepo in dependency order **And** a failure in any step marks the workflow as failed and blocks merge.

2. **Given** no source files have changed in a package **When** CI runs **Then** Turborepo cache is used and the unchanged package's tasks are skipped.

## Tasks / Subtasks

- [x] Task 1: Create `.github/workflows/ci.yml` (AC: #1, #2)
  - [x] Create `.github/` and `.github/workflows/` directories (neither exists yet)
  - [x] Configure workflow trigger: `push` (all branches) + `pull_request` (all branches)
  - [x] Set up pnpm 9.0.0 via `pnpm/action-setup@v4`
  - [x] Set up Node.js 22 (minimum required) via `actions/setup-node@v4` with `cache: 'pnpm'`
  - [x] Run `pnpm install --frozen-lockfile`
  - [x] Cache `.turbo` directory between runs via `actions/cache@v4` (key on OS + turbo.json hash)
  - [x] Run `pnpm turbo build test typecheck` as a single command (Turborepo handles dependency order)
  - [x] Verify workflow fails the job if any task fails

- [x] Task 2: Validate (AC: #1, #2)
  - [x] YAML is syntactically valid (check with `npx js-yaml` or `yamllint`)
  - [x] Confirm `pnpm turbo build test typecheck` would run in correct order per `turbo.json`:
    - `build` → runs first (depended on by `test` and `typecheck`)
    - `test` → runs after `build`
    - `typecheck` → runs after `^build` (upstream packages built)

## Dev Notes

### What to create

Single file: `.github/workflows/ci.yml` at monorepo root. No other files need to be modified.

### Critical constraints

**Node.js version: 22 minimum** — `packages/tranquilload-core` and `packages/tranquilload-adapters` use tsdown 0.21.0 + rolldown which calls `process.getBuiltinModule`, available only in Node 22+. Using `node: 22` in the matrix. Do NOT use 18 or 20.

**Package manager: pnpm 9.0.0** — declared in `package.json` `packageManager` field. Use `pnpm/action-setup@v4` with `version: 9.0.0`.

**Branch naming: `master`** — this repo uses `master`, not `main`. The `.changeset/config.json` confirms `baseBranch: "master"`. The trigger must work on all branches (not restricted to `main`).

**Turborepo task dependency order** (from `turbo.json`):
```json
"build":     { "dependsOn": ["^build"], "outputs": ["dist/**"] }
"test":      { "dependsOn": ["build"],  "cache": false }
"typecheck": { "dependsOn": ["^build"] }
```
Running `pnpm turbo build test typecheck` as one command lets Turborepo resolve the full graph: builds core first, then adapters (^build deps), then runs test and typecheck in parallel after their deps are met.

**`test` is NOT cached** (`"cache": false` in turbo.json) — Turborepo will always run tests, never skip them from cache. `build` and `typecheck` ARE cached.

### Recommended workflow structure

```yaml
name: CI

on:
  push:
    branches: ["**"]
  pull_request:
    branches: ["**"]

jobs:
  ci:
    name: Typecheck, Test & Build
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: pnpm/action-setup@v4
        with:
          version: 9.0.0

      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: "pnpm"

      - name: Install dependencies
        run: pnpm install --frozen-lockfile

      - name: Cache Turborepo
        uses: actions/cache@v4
        with:
          path: .turbo
          key: ${{ runner.os }}-turbo-${{ hashFiles('turbo.json') }}
          restore-keys: |
            ${{ runner.os }}-turbo-

      - name: Build, Test & Typecheck
        run: pnpm turbo build test typecheck
```

**Why single `pnpm turbo build test typecheck` command**: Turborepo resolves the full dependency graph in one invocation, parallelizes what can run in parallel, and uses cache for build/typecheck. Splitting into multiple `pnpm turbo X` calls works too but is less efficient.

### Turborepo cache in CI

The `.turbo` directory is the local Turborepo cache. Caching it with `actions/cache@v4` preserves computed hashes between CI runs. Since `test` has `"cache": false`, tests always re-run even with cache hits. Build and typecheck artifacts ARE cached.

Cache key strategy: `${{ runner.os }}-turbo-${{ hashFiles('turbo.json') }}` — invalidates if pipeline config changes.

### Project Structure Notes

- `.github/workflows/ci.yml` — new file, new directory hierarchy
- No changes to `turbo.json`, `package.json`, or any source files
- `effect/` directory at root (cloned doc repo) is NOT a workspace package — Turborepo ignores it

### References

- [Source: _bmad-output/planning-artifacts/architecture.md#Versioning et CI/CD] — `ci.yml` on push/PR, `typecheck + test + build`
- [Source: _bmad-output/planning-artifacts/epics.md#Story 9.1] — acceptance criteria
- [Source: turbo.json] — task dependency graph
- [Source: package.json] — `engines: { node: ">=22" }`, `packageManager: "pnpm@9.0.0"`
- [Source: .changeset/config.json] — `baseBranch: "master"`
- [Source: memory — Node.js ≥ 22 required] — `process.getBuiltinModule` unavailable on Node 20

## Dev Agent Record

### Agent Model Used

claude-opus-4-6

### Debug Log References

### Completion Notes List

- Created `.github/workflows/ci.yml` following the recommended structure from Dev Notes
- Workflow triggers on push and pull_request to all branches (`"**"`)
- Uses pnpm 9.0.0 via `pnpm/action-setup@v4`, Node.js 22 via `actions/setup-node@v4` with pnpm cache
- Turborepo `.turbo` directory cached via `actions/cache@v4` (key: OS + turbo.json hash, with restore-keys fallback)
- Single `pnpm turbo build test typecheck` command lets Turborepo resolve full dependency graph
- YAML validated with `npx js-yaml` — syntactically correct
- Turborepo dry-run confirmed correct task ordering: build (core → adapters) → test + typecheck in parallel
- Full regression suite passed: 149 tests across 23 files, build and typecheck green
- No `continue-on-error` set — any task failure fails the workflow (GitHub Actions default behavior)

### Change Log

- 2026-04-04: Created `.github/workflows/ci.yml` — GitHub Actions CI workflow with Turborepo cache

### File List

- `.github/workflows/ci.yml` (new)
