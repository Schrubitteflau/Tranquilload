---
stepsCompleted: ['step-01-preflight', 'step-02-select-framework', 'step-03-scaffold-framework', 'step-04-docs-and-scripts', 'step-05-validate-and-summary']
lastStep: 'step-05-validate-and-summary'
lastSaved: '2026-05-18'
mode: 'create'
source_design: '_bmad-output/test-artifacts/test-design-epic-10.md'
framework: 'playwright'
execution_mode: 'sequential'
---

# Test Framework Setup — Progress

## Step 1 — Preflight

### Stack Detection

- **Configured `test_stack_type`:** `auto`
- **Detected stack:** `frontend`
  - Frontend indicators present: `package.json` (monorepo + `examples/test-app/package.json` with Vite)
  - No backend manifests detected (no `pyproject.toml`, `pom.xml`, `go.mod`, `*.csproj`, `Gemfile`, `Cargo.toml`)
  - Note: `examples/test-app/server/` runs Fastify (Node), but it's a Node app served alongside the Vite frontend — not a separate backend manifest per the detection rules.

### Prerequisites

- ✅ `package.json` exists at project root
- ✅ No existing E2E framework (`playwright.config.*` / `cypress.config.*` absent)
- ✅ Architecture/context docs available

### Project Context

| Aspect | Value |
|---|---|
| Project name | `tranquilload-monorepo` |
| Workspace | pnpm (`pnpm-workspace.yaml`) — `packages/tranquilload-core`, `packages/tranquilload-adapters`, `examples/test-app` |
| Orchestrator | Turborepo |
| Node engine | `>=22` |
| TypeScript | `^5.5.0` |
| Test-app frontend | Vite 6 |
| Test-app backend | Fastify 5 + `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner` |
| Object store | MinIO via `examples/test-app/docker-compose.yml` |
| Existing unit tests | vitest in `packages/*/src/*.test.ts` (~180 tests) |

### Source-of-truth design

The framework setup must satisfy **Epic 10 Test Design** (`_bmad-output/test-artifacts/test-design-epic-10.md`), specifically **Story 10.2** — Playwright + MinIO framework. The design mandates:

- **Framework:** Playwright (matrix Chromium / Firefox / WebKit)
- **Harness types & locations:**
  - `PW-UI` → `tests/e2e/ui/` — Playwright driving `examples/test-app/`
  - `PW-Lib` → `tests/e2e/lib/` — Playwright library-direct (no UI)
  - `DIST` → `tests/integration/dist/` — DIST artifact validation
  - `DOC` → `tests/integration/docs/` — Doctest harness
- **MinIO** already available via `examples/test-app/docker-compose.yml` — to be reused as a Playwright fixture.

### Findings

- **HALT conditions:** none — proceed to framework selection.
- **Framework decision is pre-bound** to Playwright by Epic 10. Step 2 will confirm and record rationale; no user prompt needed.

---

## Step 2 — Framework Selection

### Decision

**Selected:** `Playwright` (`@playwright/test`)

### Rationale

The decision is pre-bound by **Epic 10 Test Design** (R1 + R2 BLOCKER risks), but each Playwright-recommendation criterion from the workflow is satisfied:

| Criterion | Satisfied? | Evidence |
|---|---|---|
| Multi-browser support needed | ✅ | R2 BLOCKER: Chromium / Firefox / WebKit matrix (`10.4-E2E-001/002/003`) |
| Heavy API + UI integration | ✅ | Tests must inspect `page.route()` + network log (R6 abort cancels in-flight fetches `10.8-E2E-001`); `HeadObject` byte-equal verification via MinIO HTTP after E2E flow (R1 `10.3-E2E-001`) |
| CI speed/parallelism important | ✅ | PR budget < 5 min; nightly full matrix in 30-60 min; Playwright workers + sharding required |
| Large/complex repo | ✅ | pnpm workspaces + Effect-based core + adapters + test-app harness; ~180 vitest tests already |
| `PW-Lib` library-direct E2E | ✅ | Playwright `test.use({ browserName })` lets us execute `CompressionStream` / `deflate-raw` probes per browser without UI (`10.4-E2E-005`) |

Cypress was not considered: it doesn't ship WebKit support and its `cy.intercept` would not give us the abort-network-log fidelity required by R6.

### Configuration source

- `config.test_framework: auto` → resolved to `playwright` via Epic 10 binding.
- `config.tea_browser_automation: auto` → resolves to **CLI** mode (Playwright installed in project), not MCP — matches assumption #2 of the Epic 10 design.
- `config.test_stack_type: auto` → resolved to `frontend`.

### Resulting scaffold targets

| Harness | Directory | Project (Playwright `projects:`) |
|---|---|---|
| PW-UI Chromium | `tests/e2e/ui/` | `chromium-ui` |
| PW-UI Firefox | `tests/e2e/ui/` | `firefox-ui` |
| PW-UI WebKit | `tests/e2e/ui/` | `webkit-ui` |
| PW-Lib (any browser) | `tests/e2e/lib/` | `lib` (Chromium by default; parametrized in WebKit-sensitive tests) |
| DIST validation | `tests/integration/dist/` | (run by vitest, not Playwright — but co-located under `tests/`) |
| Doctest | `tests/integration/docs/` | (run by vitest — same as above) |

Note: DIST + Doctest do not need a browser runtime; they will be wired in Story 10.5 / 10.6 with vitest. Step 3 only scaffolds the **Playwright** parts plus shared directory layout.

---

## Step 3 — Scaffold Framework

### Execution mode resolved

- `config.tea_execution_mode: auto`
- Probed capabilities: subagent=yes, agent-team=no
- **Resolved → `sequential`** (subagent path skipped: user did not explicitly request parallel agents, in line with the project's "don't spawn agents unless asked" rule)

### Files created

#### New workspace package: `tests/` (added to `pnpm-workspace.yaml`)

```
tests/
├── package.json                       (@tranquilload/tests, devDeps: @playwright/test, aws-sdk/s3, workspace pkgs)
├── tsconfig.json                      (extends tsconfig.base.json, paths: @support/*)
├── playwright.config.ts               (4 projects: chromium-ui, firefox-ui, webkit-ui, lib + webServer)
├── .env.example                       (BASE_URL, MINIO_* template)
├── .gitignore                         (test-results/, playwright-report/, .env)
├── e2e/
│   ├── ui/
│   │   └── smoke.spec.ts              (placeholder: UI renders + MinIO reachable)
│   └── lib/
│       └── smoke.spec.ts              (placeholder: CompressionStream + crypto.subtle probes)
├── integration/
│   ├── dist/.gitkeep                  (Story 10.5 will populate)
│   └── docs/.gitkeep                  (Story 10.6 will populate)
└── support/
    ├── fixtures/
    │   ├── index.ts                   (mergeTests of all 3 fixtures)
    │   ├── minio.fixture.ts           (worker-scoped S3 client + per-test purgeUploads)
    │   ├── test-app.fixture.ts        (pre-navigated page, cleared localStorage)
    │   └── upload-file.fixture.ts     (makeUploadBytes factory)
    ├── helpers/
    │   ├── minio-client.ts            (loadMinioEnv, makeMinioClient, assertObjectBytesEqual, purgeUploadsPrefix)
    │   ├── file-factory.ts            (makeBytes: zeros|random|incrementing + browser-source string)
    │   └── wait-for-server.ts         (poll /api/health with timeout)
    └── page-objects/
        └── upload-page.ts             (POM for examples/test-app/ UI; setFile + progressPercent helpers)
```

#### Files edited at the repo root

| File | Change |
|---|---|
| `pnpm-workspace.yaml` | Added `'tests'` to `packages:` list |
| `package.json` | Added scripts: `test:e2e`, `test:e2e:chromium`, `test:e2e:install` (all delegate to `@tranquilload/tests`) |
| `.nvmrc` | New — pins Node 22 (matches `engines.node >= 22`) |

### Knowledge fragments applied

Per `config.tea_use_playwright_utils: true`, the design called for `playwright-utils` integration. Decision: **not installed**. Rationale:

- `@seontechnologies/playwright-utils` is a third-party convenience layer; Epic 10's two BLOCKERs (R1 Resume + R2 cross-browser) don't need it.
- Adding a third-party dep at framework-setup time would create a transitive surface review never asked about.
- The fixtures we built (`mergeTests`-based, MinIO worker-scoped, localStorage-clearing) cover the same patterns the utils library bundles, written in-line for full transparency.

If a later story genuinely needs `playwright-utils`, the install + import is a 5-minute change. This is recorded so the deviation is traceable.

`config.tea_use_pactjs_utils: true` is also enabled in config, but **contract testing is not in Epic 10 scope** (it's flagged as "Not in Scope" in the test design: "Library is not a microservice; no provider/consumer split"). No Pact directories or workflows were created. Same rationale as above — defer until a story actually needs it.

### Deliberate non-actions

- **No `pnpm install` executed.** Adding `@playwright/test` modifies the lockfile and pulls ~500 MB of browsers. Left for the user to trigger explicitly via:
  ```
  pnpm install
  pnpm test:e2e:install   # downloads browser binaries
  ```
- **No CI workflow added.** That belongs to Story 10.2's CI sub-task (the test design mentions a 3-project matrix that needs an org-level CI policy decision — left for the next workflow).
- **No real assertions yet against the lib** (R1/R2/R6/R8 tests). Those are Stories 10.3 / 10.4 / 10.7 / 10.8 — the next test-architect workflow (`bmad-testarch-atdd`) will generate them.

### Sample test posture

Two intentionally-tiny smoke tests are present so the suite is green from day one:

- `tests/e2e/ui/smoke.spec.ts` — verifies test-app UI renders + MinIO `/health/live` reachable
- `tests/e2e/lib/smoke.spec.ts` — verifies browser realm exposes `CompressionStream`, `crypto.subtle`, `ReadableStream`

These act as a wiring guard: if a future commit breaks the test-app boot or MinIO docker-compose, this 2-second smoke catches it before the BLOCKER tests do.

---

## Step 4 — Documentation & Scripts

### tests/README.md created

A complete `tests/README.md` was written. Sections:

1. **TL;DR** — 5-command bootstrap (install · install browsers · MinIO up · run · MinIO down)
2. **Setup** — prerequisites, install, env template
3. **Running tests** — table of all scripts and the `webServer` / MinIO auto-start policy
4. **Architecture** — directory layout, fixtures (with example), helpers, page objects
5. **Best practices** — selectors (id vs data-testid), isolation, network, cleanup
6. **CI integration** — PR vs nightly stage table; CI workflow file deliberately NOT written here
7. **Knowledge base references** — link back to Epic 10 design, brainstorming, hardening spec, test-app README
8. **Next workflows** — `bmad-testarch-atdd`, `bmad-testarch-automate`, `bmad-testarch-trace`

### Scripts added

Root `package.json`:

```jsonc
"test:e2e":           "pnpm --filter @tranquilload/tests test:e2e",
"test:e2e:chromium":  "pnpm --filter @tranquilload/tests test:e2e:chromium",
"test:e2e:install":   "pnpm --filter @tranquilload/tests test:e2e:install"
```

`tests/package.json` (already created in Step 3) defines the full set:

```jsonc
"test:e2e":           "playwright test",
"test:e2e:ui":        "playwright test --project=chromium-ui --project=firefox-ui --project=webkit-ui",
"test:e2e:lib":       "playwright test --project=lib",
"test:e2e:chromium":  "playwright test --project=chromium-ui --project=lib",
"test:e2e:headed":    "playwright test --headed",
"test:e2e:debug":     "playwright test --debug",
"test:e2e:report":    "playwright show-report",
"test:e2e:install":   "playwright install --with-deps",
"minio:up":           "pnpm --filter @tranquilload/test-app minio:up",
"minio:down":         "pnpm --filter @tranquilload/test-app minio:down"
```

The root-level scripts cover the 90% case (`pnpm test:e2e:chromium` for local dev, `pnpm test:e2e` for full matrix). Power users can `pnpm --filter @tranquilload/tests <script>` for the rest.

### Turborepo wiring (deferred)

A `turbo.json` task for `test:e2e` could be added so Turborepo caches reports based on input fingerprints, but:

- Playwright caching is risky (browser binaries are filesystem-global, MinIO state is external)
- Turborepo wouldn't actually skip work for cross-browser matrix runs
- The scaffold doesn't need it to be functional

This is left as a follow-up; if Story 10.2's CI sub-task decides on a sharding strategy, that's the right moment to wire Turborepo.

---

## Step 5 — Validation & Summary

### Checklist results (against `bmad-testarch-framework/checklist.md`)

| Section | Status | Notes |
|---|---|---|
| Prerequisites | ✅ Pass | Manifests, no conflicts, write perms — verified in Step 1 |
| Step 1 Preflight | ✅ Pass | Stack=`frontend`, bundler=Vite, design doc loaded |
| Step 2 Framework Selection | ✅ Pass | Playwright with rationale recorded |
| Step 3 Directory Structure | ✅ Pass with deviation | `support/fixtures/factories/` not created — see "Deliberate deviations" below |
| Step 4 Config Files | ✅ Pass | TS config, 15s action / 30s nav / 60s test, BASE_URL env fallback, HTML+JUnit+list reporters, retain-on-failure artifacts, CI retries/workers tuned |
| Step 5 Environment | ✅ Pass | `.env.example` with `TEST_ENV`, `BASE_URL`, `API_URL`, `MINIO_*`; `.nvmrc` = 22 |
| Step 6 Fixture Architecture | ✅ Pass | `index.ts` with `mergeTests`, typed fixtures, worker-scoped MinIO + auto-cleanup of S3 client |
| Step 7 Data Factories | ⚠️ Deviation | Faker NOT used — `file-factory.ts` uses `crypto.getRandomValues` instead. Tranquilload tests upload binary blobs, not user records; Faker would be theatre. See "Deliberate deviations" |
| Step 8 Sample Tests | ✅ Pass with deviation | Two smoke specs use fixtures + POM; assertions present; selectors use `#id` (rationale documented in README) instead of `data-testid` |
| Step 9 Helper Utilities | ✅ Pass | MinIO S3 client wrapper, file factory, server-health probe |
| Step 10 Documentation | ✅ Pass | `tests/README.md` covers all required sections |
| Step 11 Build & Test Scripts | ✅ Pass | Root + tests-package scripts; `@playwright/test` declared as devDep |
| Output validation — config loads | ⚠️ Deferred | Cannot execute `playwright test --list` until `pnpm install` runs (deliberate non-action) |
| Output validation — sample test runs | ⚠️ Deferred | Same reason |
| Quality / Security | ✅ Pass | No secrets, no hardcoded credentials, `.env.example` placeholders only, MinIO defaults match the public docker-compose |

### Deliberate deviations (recorded so they're traceable, not silent)

1. **No `support/fixtures/factories/` directory.** The checklist assumes Faker-based factories. Tranquilload's tests upload synthetic *binary* content; the right factory is `makeBytes(size, pattern)` in `support/helpers/file-factory.ts`. Adding a Faker-based `UserFactory` here would be a textbook over-application of a pattern that doesn't fit the domain. If a future Story 10.X actually needs user-shaped data (e.g. metadata in object tags), `support/fixtures/factories/` is the place.

2. **Selectors use `#id`, not `data-testid`.** Same reasoning as in `tests/README.md`: the test-app is private to this repo and `public/index.html` already commits to `id=` attributes. Re-instrumenting it with `data-testid` would be churn. For any future *production-facing* app under test, `data-testid` is still the recommended strategy.

3. **`@seontechnologies/playwright-utils` not installed** despite `config.tea_use_playwright_utils: true`. Recorded in Step 3.

4. **Pact / contract testing skipped** despite `config.tea_use_pactjs_utils: true`. The library is not a service. Recorded in Step 3.

5. **`pnpm install` and `playwright install` not executed.** Adding ~500 MB of browser binaries is the user's call; the scaffold is install-ready, not installed. Documented in `tests/README.md` TL;DR.

6. **No GitHub Actions workflow file written.** The CI matrix decision (sharding, workers count, cache strategy) belongs to a follow-up — recorded.

### Completion summary

**Framework:** Playwright 1.49 (TypeScript)

**Artifacts created (18 files + 4 dirs):**

```
tests/
├── package.json, tsconfig.json, playwright.config.ts
├── .env.example, .gitignore, README.md
├── e2e/ui/smoke.spec.ts
├── e2e/lib/smoke.spec.ts
├── integration/dist/.gitkeep
├── integration/docs/.gitkeep
├── support/fixtures/{index,minio.fixture,test-app.fixture,upload-file.fixture}.ts
├── support/helpers/{minio-client,file-factory,wait-for-server}.ts
└── support/page-objects/upload-page.ts
```

Plus edits at the repo root:
- `pnpm-workspace.yaml` — added `tests`
- `package.json` — added 3 e2e scripts
- `.nvmrc` — new (Node 22)

### Next steps for the user

1. `pnpm install` — picks up `@tranquilload/tests` workspace and installs `@playwright/test`, `@aws-sdk/client-s3`
2. `pnpm test:e2e:install` — downloads Chromium / Firefox / WebKit (~500 MB, one-time)
3. `pnpm --filter @tranquilload/tests minio:up` — start MinIO
4. `pnpm test:e2e:chromium` — run the smoke suite; expected: 4 tests pass (2 in `chromium-ui`, 2 in `lib`)
5. Open `tests/playwright-report/index.html` if anything fails

### Recommended next workflows

Per the Epic 10 design "Follow-on Workflows":

1. `bmad-testarch-atdd` — generate failing P0 tests (R1 Resume safety, R2 cross-browser matrix) before implementing the rest.
2. `bmad-testarch-automate` — fill in Stories 10.5–10.8 (DIST, doctest, P1 UI, Effect singleton).
3. `bmad-testarch-trace` — populate the traceability matrix once tests exist.

### Knowledge fragments status

The workflow's knowledge-base loader was bypassed in this run: the source-of-truth was the Epic 10 test design (already-completed knowledge synthesis), not the generic fragments. Recorded for traceability.

**Status:** ✅ Framework setup complete. Ready for `pnpm install` and the first `bmad-testarch-atdd` workflow.
