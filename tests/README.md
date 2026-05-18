# Tranquilload — Test Harness

End-to-end and integration tests for `@tranquilload/core` and `@tranquilload/adapters`, executed against a real MinIO via Playwright.

**Origin:** Story 10.2 of [Epic 10 — P1 Test Coverage](../_bmad-output/test-artifacts/test-design-epic-10.md).

---

## TL;DR

```bash
# 1. One-time install (from repo root)
pnpm install
pnpm test:e2e:install         # downloads Chromium/Firefox/WebKit (~500 MB)

# 2. Start MinIO (once per session)
pnpm --filter @tranquilload/tests minio:up

# 3. Run the suite (PR-grade smoke: Chromium UI + lib)
pnpm test:e2e:chromium

# 4. Full matrix (nightly)
pnpm test:e2e

# 5. Stop MinIO
pnpm --filter @tranquilload/tests minio:down
```

---

## Setup

### Prerequisites

| Tool | Version | Source |
|---|---|---|
| Node.js | ≥ 22 | `.nvmrc` at repo root |
| pnpm | 9.x | `packageManager` in root `package.json` |
| Docker | recent | MinIO runs via `examples/test-app/docker-compose.yml` |

### Install

```bash
pnpm install                  # installs all workspaces, including @tranquilload/tests
pnpm test:e2e:install         # `playwright install --with-deps` for browsers + system deps
```

The first `playwright install` downloads three browser engines. Subsequent runs use the cache.

### Environment

Copy the template and adjust if you point at a non-default MinIO:

```bash
cp tests/.env.example tests/.env
```

Defaults match `examples/test-app/docker-compose.yml`:

| Var | Default |
|---|---|
| `BASE_URL` | `http://localhost:5173` |
| `API_URL` | `http://localhost:3000` |
| `MINIO_ENDPOINT` | `http://localhost:9000` |
| `MINIO_ACCESS_KEY` / `MINIO_SECRET_KEY` | `minioadmin` / `minioadmin` |
| `MINIO_BUCKET` | `tranquilload-test` |

---

## Running tests

| Command | What it runs |
|---|---|
| `pnpm test:e2e` | All projects (chromium-ui + firefox-ui + webkit-ui + lib) — nightly target |
| `pnpm test:e2e:chromium` | `chromium-ui` + `lib` only — PR target, ~5 min budget |
| `pnpm --filter @tranquilload/tests test:e2e:ui` | All three UI browsers, no `lib` |
| `pnpm --filter @tranquilload/tests test:e2e:lib` | Library-direct project only |
| `pnpm --filter @tranquilload/tests test:e2e:headed` | Headed (visible browser) — local debug |
| `pnpm --filter @tranquilload/tests test:e2e:debug` | Playwright inspector / pause-and-step |
| `pnpm --filter @tranquilload/tests test:e2e:report` | Open the HTML report from the last run |

### `webServer` auto-start

`playwright.config.ts` runs `pnpm --filter @tranquilload/test-app dev` (Fastify + Vite) and waits for `BASE_URL` before tests start. Set `SKIP_WEBSERVER=1` if you've already started the test-app in another terminal.

### MinIO is NOT auto-started

Docker container startup is too slow to repay per-suite. Start once per session with `pnpm --filter @tranquilload/tests minio:up` (it's the same compose file the test-app uses, so a single MinIO serves both).

---

## Architecture

### Directory layout

```
tests/
├── playwright.config.ts        4 projects (chromium-ui · firefox-ui · webkit-ui · lib)
├── e2e/
│   ├── ui/                     PW-UI specs — drive examples/test-app/ in a browser
│   └── lib/                    PW-Lib specs — library-direct probes (no UI navigation)
├── integration/
│   ├── dist/                   DIST artifact validation (Story 10.5; vitest, not Playwright)
│   └── docs/                   Doctest harness (Story 10.6; vitest)
└── support/
    ├── fixtures/               Playwright fixtures composed via mergeTests
    ├── helpers/                Pure helpers (MinIO client, file factory, server probes)
    └── page-objects/           POM for the test-app UI
```

Harness codes match the Epic 10 test-design map (`PW-UI`, `PW-Lib`, `DIST`, `DOC`).

### Fixtures

Import `test` from `@support/fixtures` (TS path alias) to get the composed fixture set:

```ts
import { test, expect } from "@support/fixtures"

test("upload roundtrip", async ({ appPage, minio, makeUploadBytes }) => {
  const bytes = makeUploadBytes(25 * 1024 * 1024)  // 25 MiB
  // …
})
```

| Fixture | Scope | Provides |
|---|---|---|
| `minio` | test (worker-backed) | `{ client, env }` — S3 client + parsed `MINIO_*` env |
| `purgeUploads` | test | `() => Promise<number>` — wipe `uploads/` prefix for isolation |
| `appPage` | test | `Page`, pre-navigated to `BASE_URL` with `localStorage` cleared |
| `makeUploadBytes` | test | `(size, pattern?) => Uint8Array` — deterministic bytes |

**Adding a fixture:** create `support/fixtures/foo.fixture.ts` exporting its own extended `test`, then add it to the `mergeTests(...)` call in `support/fixtures/index.ts`. Don't mutate the existing fixtures — each one composes orthogonally.

### Helpers

- **`minio-client.ts`** — `loadMinioEnv()`, `makeMinioClient()`, `assertObjectBytesEqual()`, `purgeUploadsPrefix()`. The byte-equal helper is the contract enforcement for R1 Resume safety.
- **`file-factory.ts`** — `makeBytes(size, pattern)` with `zeros | random | incrementing`. The `makeBytesBrowserSource` string lets you inject identical logic into a `page.evaluate` so both sides of the realm produce the same bytes.
- **`wait-for-server.ts`** — polls `/api/health` until 200. Used in `appPage` to gate the test on Fastify being up (Playwright's `webServer` only checks the Vite URL).

### Page Objects

`support/page-objects/upload-page.ts` mirrors `examples/test-app/public/index.html`. Selectors use `#id` directly — the test-app is private to this repo so any UI rename will surface in both files together. Add new POMs in the same directory; one class per page.

---

## Best practices

### Selectors

- **Prefer `id` selectors** for the test-app (it's our private fixture; ids are stable). For production-facing apps in other contexts, use `data-testid`.
- **Never use Playwright auto-waiting + arbitrary `waitForTimeout`** — every wait should be tied to an assertion or a network event.

### Isolation

- `appPage` clears `localStorage` before every test. If your test depends on a pre-existing ResumeState, set it explicitly via `page.evaluate(() => localStorage.setItem(...))`.
- For tests that need a clean MinIO bucket, call `await purgeUploads()` at the top of the test. Worker-scoped re-use means leftover objects from a sibling test will be visible otherwise.

### Network

- Use `page.route()` + `page.waitForRequest()` for abort-cancellation assertions (R6).
- Avoid `cy.intercept`-style stubbing for happy-path tests; the real backend round-trip catches integration regressions that mocks hide.

### Cleanup

- The MinIO client is worker-scoped and `client.destroy()`d at worker teardown — don't construct your own S3 client in specs unless you also tear it down.
- Playwright traces / screenshots / videos are `retain-on-failure` — green runs leave no artifacts.

---

## CI integration

| Stage | Projects | Approx duration | Trigger |
|---|---|---|---|
| **PR smoke** | `chromium-ui` + `lib` | < 5 min | Every push / PR |
| **Nightly matrix** | `chromium-ui` + `firefox-ui` + `webkit-ui` + `lib` | 30–60 min | Cron |

CI must:

1. Install pnpm + Node 22 (matrix-driven)
2. Run `pnpm install --frozen-lockfile`
3. Run `pnpm test:e2e:install` (browser binaries)
4. Start MinIO via `docker compose -f examples/test-app/docker-compose.yml up -d --wait`
5. Run the project subset for the stage
6. Upload `tests/playwright-report/` + `tests/test-results/junit.xml` as artifacts

The actual GitHub Actions workflow is **not** created by this scaffold — it belongs to the Story 10.2 CI sub-task once the org's CI policy (workers count, sharding, artifact retention) is decided.

---

## Knowledge base references

- **Epic 10 test design (source of truth):** [`../_bmad-output/test-artifacts/test-design-epic-10.md`](../_bmad-output/test-artifacts/test-design-epic-10.md)
- **Brainstorming matrix (175 scenarios):** [`../_bmad-output/brainstorming/brainstorming-session-2026-05-17-001.md`](../_bmad-output/brainstorming/brainstorming-session-2026-05-17-001.md)
- **Library hardening spec:** [`../_bmad-output/implementation-artifacts/tech-spec-library-hardening-resume-and-http.md`](../_bmad-output/implementation-artifacts/tech-spec-library-hardening-resume-and-http.md)
- **Test-app harness:** [`../examples/test-app/README.md`](../examples/test-app/README.md)

---

## Next workflows

Per the Epic 10 design's "Follow-on Workflows" section:

1. **`bmad-testarch-atdd`** — generate failing P0 tests (R1 Resume + R2 cross-browser matrix) before implementing the rest.
2. **`bmad-testarch-automate`** — broader P1 coverage (Stories 10.5–10.8).
3. **`bmad-testarch-trace`** — generate the traceability matrix (scenario ↔ test ID) into `_bmad-output/test-artifacts/traceability/`.

This README is the entry-point any of those workflows should link back to.
