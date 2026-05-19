---
---

Test infrastructure: add DIST integrity harness (Story 10.5, Epic 10).

Five new vitest-based tests under `tests/integration/dist/` validate the
published artifacts before each release:

- **10.5-X-001 / 10.5-X-002** — a fresh consumer project (`pnpm pack` +
  `npm install`) imports every entry point via ESM and `require()`s every
  entry point via CJS.
- **10.5-X-003** — a strict TypeScript downstream (`strict +
  noUncheckedIndexedAccess + exactOptionalPropertyTypes`) compiles against the
  published `.d.mts` types.
- **10.5-X-004** — grep regression test asserting that `effect` is never
  bundled into either package's `dist/`; only bare-specifier references are
  allowed (peer-dep contract).
- **10.5-X-005** — every `package.json#exports` sub-path of both
  `@tranquilload/core` and `@tranquilload/adapters` resolves via dynamic
  `import()`.

Wired into CI as a new `dist-integrity` job (`.github/workflows/ci.yml`).

No public surface change; no version bump.
