# Story 9.2: Automated Release with Changesets

Status: review

## Story

As a maintainer of the library,
I want a GitHub Actions `release.yml` workflow using Changesets,
so that versioning, CHANGELOG generation, and npm publishing are fully automated on merge to `master`.

## Acceptance Criteria

1. **Given** a changeset file is present in a PR **When** the PR is merged to `master` **Then** the Changesets GitHub Action opens a "Version Packages" PR bumping the changed package(s) with an updated CHANGELOG per package.

2. **Given** the "Version Packages" PR is merged **When** the release workflow runs **Then** the changed package(s) are published to npm with their updated version numbers **And** a GitHub Release is created with the CHANGELOG entries.

3. **Given** no changeset file is present in a PR **When** it is merged to `master` **Then** no version bump or publish occurs — the release PR is not updated.

## Tasks / Subtasks

- [x] Task 1: Add `@changesets/cli` to root `package.json` (AC: #1, #2)
  - [x] Add `"@changesets/cli": "latest"` to root `devDependencies`
  - [x] Add scripts: `"changeset": "changeset"`, `"version-packages": "changeset version"`
  - [x] Run `pnpm install` to update lockfile

- [x] Task 2: Create `.github/workflows/release.yml` (AC: #1, #2, #3)
  - [x] Configure trigger: `push` to `master` branch only
  - [x] Set up pnpm via `pnpm/action-setup@v4` (no explicit version — reads from `packageManager` in root `package.json`)
  - [x] Set up Node.js 22 via `actions/setup-node@v4` with `cache: "pnpm"`
  - [x] Run `pnpm install --frozen-lockfile`
  - [x] Run `pnpm turbo build` to produce `dist/` before publishing
  - [x] Add `changesets/action@v1` step with `publish: pnpm changeset publish`
  - [x] Pass `GITHUB_TOKEN` and `NPM_TOKEN` as env vars to the Changesets action step

- [x] Task 3: Validate (AC: #1, #2, #3)
  - [x] YAML is syntactically valid (`npx js-yaml .github/workflows/release.yml`)
  - [x] Confirm trigger is `master`, not `main`
  - [x] Confirm `baseBranch: "master"` in `.changeset/config.json` matches workflow trigger
  - [x] Full CI passes: `pnpm turbo build test typecheck`

## Dev Notes

### Files to create / modify

- `.github/workflows/release.yml` — new file
- `package.json` (monorepo root) — add `@changesets/cli` devDep + scripts

### CRITICAL: Branch is `master`, NOT `main`

The architecture doc mentions "merge to main" — **this is wrong for this repo**. The `.changeset/config.json` explicitly sets `"baseBranch": "master"` and `ci.yml` was validated against `master`. The release workflow MUST trigger on `master`.

### pnpm action setup

Use `pnpm/action-setup@v4` WITHOUT explicit `version:` — it reads from `"packageManager": "pnpm@9.0.0"` in root `package.json`. This matches the pattern applied in story 9.1 review (removing explicit version to avoid drift). Same for `actions/setup-node@v4 node-version: 22` — Node 22 is required (`process.getBuiltinModule` unavailable on Node 20).

### Build before publish

`pnpm changeset publish` publishes the contents of each package, including the `dist/` folder. Running CI (`pnpm turbo build test typecheck`) is NOT part of this workflow — only `pnpm turbo build` is needed before publish. Failing to build first will publish packages with no `dist/`, breaking all consumers.

### How `changesets/action@v1` behaves

The action is dual-mode — it decides what to do based on current repo state:

- **Mode A — "open/update Version Packages PR"**: triggered when changesets are present in `.changeset/` and the "Version Packages" PR is NOT yet merged. The action runs `changeset version` internally, commits the version bumps + CHANGELOG updates to a PR branch.
- **Mode B — "publish"**: triggered when the "Version Packages" PR is merged (no changesets remain). The action runs the `publish` script you provide.

No changeset files → no-op (AC #3 satisfied automatically).

### Changeset config (already exists at `.changeset/config.json`)

```json
{
  "changelog": "@changesets/cli/changelog",
  "linked": [["@tranquilload/core", "@tranquilload/adapters"]],
  "access": "public",
  "baseBranch": "master",
  "updateInternalDependencies": "patch"
}
```

`"linked"` means both packages are versioned as a group — a single changeset bumps both to the same version. `"access": "public"` means no `--access public` flag needed on publish. `publishConfig.access: "public"` is also already set in both package `package.json` files.

### Required GitHub secret

`NPM_TOKEN` must be added in GitHub repo **Settings → Secrets and variables → Actions → Repository secrets**. The story only creates the workflow; the secret itself must be added by the maintainer. `GITHUB_TOKEN` is provided automatically by GitHub Actions — no configuration needed.

### Recommended `release.yml`

```yaml
name: Release

on:
  push:
    branches:
      - master

jobs:
  release:
    name: Release
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: pnpm/action-setup@v4

      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: "pnpm"

      - name: Install dependencies
        run: pnpm install --frozen-lockfile

      - name: Build packages
        run: pnpm turbo build

      - name: Create Release Pull Request or Publish to npm
        uses: changesets/action@v1
        with:
          publish: pnpm changeset publish
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          NPM_TOKEN: ${{ secrets.NPM_TOKEN }}
```

### Recommended root `package.json` scripts addition

```json
"scripts": {
  "build": "turbo build",
  "test": "turbo test",
  "dev": "turbo dev",
  "typecheck": "turbo typecheck",
  "changeset": "changeset",
  "version-packages": "changeset version"
}
```

And in `devDependencies`:
```json
"@changesets/cli": "latest"
```

### Project Structure Notes

- `.github/workflows/release.yml` — new file, same directory as `ci.yml`
- No changes to `turbo.json`, source files, or package-level `package.json` files
- `@changesets/cli` installed at root only — packages themselves do not need it

### References

- [Source: _bmad-output/planning-artifacts/architecture.md#Infrastructure & Publishing] — Changesets workflow, two GitHub Actions
- [Source: _bmad-output/planning-artifacts/epics.md#Story 9.2] — acceptance criteria
- [Source: .changeset/config.json] — `baseBranch: "master"`, linked packages, access: "public"
- [Source: package.json (root)] — `packageManager: "pnpm@9.0.0"`, `engines: { node: ">=22" }`
- [Source: packages/tranquilload-core/package.json + packages/tranquilload-adapters/package.json] — `publishConfig.access: "public"` already set
- [Source: .github/workflows/ci.yml] — action versions to reuse (checkout@v4, pnpm/action-setup@v4, setup-node@v4, no explicit pnpm version)
- [Source: memory — Node.js ≥ 22 required] — `process.getBuiltinModule` unavailable on Node 20

## Dev Agent Record

### Agent Model Used

Claude Opus 4.6

### Debug Log References

None — clean implementation, no issues encountered.

### Completion Notes List

- Task 1: Added `@changesets/cli@2.30.0` to root devDependencies, added `changeset` and `version-packages` scripts, lockfile updated.
- Task 2: Created `.github/workflows/release.yml` matching the recommended template — trigger on `master`, pnpm/action-setup@v4 (no explicit version), Node 22, `pnpm turbo build` before publish, `changesets/action@v1` with `GITHUB_TOKEN` + `NPM_TOKEN`.
- Task 3: YAML validated with `js-yaml`, trigger confirmed on `master`, `baseBranch` in `.changeset/config.json` matches. Full CI passes: 149 tests (122 core + 27 adapters), build and typecheck green.
- Note: `NPM_TOKEN` must be manually added as a GitHub repository secret by the maintainer before first publish.

### Change Log

- 2026-04-04: Story 9.2 implemented — release workflow + changeset CLI integration

### File List

- `package.json` (modified — added `@changesets/cli` devDep + `changeset`/`version-packages` scripts)
- `pnpm-lock.yaml` (modified — lockfile updated with @changesets/cli dependencies)
- `.github/workflows/release.yml` (new — automated release workflow)
