---
stepsCompleted: ['step-01-detect-mode', 'step-02-load-context', 'step-03-risk-and-testability', 'step-04-coverage-plan', 'step-05-generate-output']
lastStep: 'step-05-generate-output'
lastSaved: '2026-05-17'
mode: 'epic-level'
execution_mode: 'sequential'
epic_num: 10
epic_title: 'P1 Test Coverage'
source_matrix: '_bmad-output/brainstorming/brainstorming-session-2026-05-17-001.md'
related_specs:
  - '_bmad-output/implementation-artifacts/tech-spec-library-hardening-resume-and-http.md'
  - '_bmad-output/planning-artifacts/architecture.md'
---

# Test Design: Epic 10 — P1 Test Coverage

**Date:** 2026-05-17
**Author:** Grochonnou
**Status:** Draft

---

## Executive Summary

**Scope:** Epic-level test design for Epic 10 — the first test-coverage epic for the Tranquilload library, derived from the 175-scenario brainstorming matrix (`brainstorming-session-2026-05-17-001`) by applying formal Probability × Impact risk scoring to the P1 subset.

**Risk Summary:**
- Total risks identified (clusters scored): 21
- **🔴 Critical (Score=9, BLOCK):** 2 — `R1 Resume safety E2E`, `R2 Cross-browser smoke`
- **🟠 High (Score 6-8, MITIGATE):** 8
- **🟡 Medium (Score 4-5, MONITOR):** 2
- **🟢 Low (Score 1-3, DOCUMENT):** 9
- **Critical categories:** DATA (silent corruption), OPS (release integrity), TECH (Effect singleton)

**Coverage Summary:**
- **P0 (BLOCKERS — R1+R2):** 7 tests, ~12–20 hours
- **P1 net-new:** 20 tests, ~20–35 hours
- **P1 trace-only (existing vitest coverage):** 22 tests, ~2–4 hours documentation
- **Total Epic 10 effort:** ~40–65 hours (~1.5–2 sprint-weeks for one dev)
- **Future epics (estimates):** Epic 11 (P2 Nightly) ~40–60h · Epic 12 (P3 Weekly) ~10–20h · Epic 13 (Library Hardening v1.x) ~30–50h

---

## Not in Scope

| Item | Reasoning | Mitigation |
|---|---|---|
| **P2 scenarios (~85)** | Brainstorming priority bucket below release-critical | Future Epic 11; ran nightly |
| **P3 scenarios (~48)** | Deep chaos, exotic edges, persona corner cases | Future Epic 12; on-demand |
| **Auto-re-initiate on dead uploadId** | Deferred from hardening spec v2 (Stream-level event injection too complex; needs own design) | Future Epic 13; users currently see `PartUploadError(1, 1, <404>)` — no regression |
| **Web Locks multi-tab coordination** | Original brainstorm v2 feature (Adapt #3); not implemented | Future Epic 13 |
| **Performance / SLA regression suite** | Library has no documented perf SLA | Out of v0.2.0 scope; consider for v1.0 |
| **Security audit / fuzz testing** | No auth surface, no data-exfiltration paths | Reevaluate at v1.0 |
| **Pact contract testing** | Library is not a microservice; no provider/consumer split | N/A |

---

## Risk Assessment

### Critical Risks (Score = 9) — BLOCKERS for v0.2.0

| Risk ID | Category | Description | Probability | Impact | Score | Mitigation | Owner | Timeline |
|---|---|---|---|---|---|---|---|---|
| **R1** | DATA | Resume safety end-to-end against real S3 (P#C1) — the just-shipped ResumeState machinery has zero E2E coverage; a regression in `runResumeSetup` would not be caught by unit tests | 3 | 3 | **9** | Story 10.3: Playwright E2E against MinIO exercising persist → reload → resume → `HeadObject` byte-equal | dev | Before v0.2.0 |
| **R2** | OPS | Cross-browser smoke (Chromium / Firefox / WebKit) — README claims "modern browsers" but features like `CompressionStream`, `fetch + duplex: 'half'`, `deflate-raw` vary across browsers; WebKit historically lacks `deflate-raw` | 3 | 3 | **9** | Story 10.4: Playwright matrix run on three browsers covering multipart golden + bufferMode adapter | dev | Before v0.2.0 |

### High-Priority Risks (Score = 6)

| Risk ID | Category | Description | P | I | Score | Mitigation | Owner |
|---|---|---|---|---|---|---|---|
| R3 | DATA | ResumeMismatchError regression (4 reasons + dropped-digest + empty-uploadId) | 2 | 3 | 6 | Story 10.1 — already covered by hardening tests; trace-only | dev |
| R4 | BUS | Golden multipart path regression | 2 | 3 | 6 | Story 10.1 — existing vitest coverage; trace + 1 new E2E (10.7-E2E-001) | dev |
| R5 | BUS | Named error paths (PartUploadError, MaxRetries, Initiate/Complete, Abort) | 2 | 3 | 6 | Story 10.1 — existing vitest coverage; trace-only | dev |
| R6 | TECH | Abort cancels in-flight fetches (no leaked promises) | 2 | 3 | 6 | Story 10.8 (10.8-E2E-001 net-new Playwright network-log test) | dev |
| R7 | TECH | Two parallel uploads have isolated Refs | 2 | 3 | 6 | Story 10.8 — existing pattern, +1 trace | dev |
| R8 | TECH | Effect singleton Tag identity — dual-copy silent failure | 2 | 3 | 6 | Story 10.8 (10.8-INT-002 net-new) | dev |
| R9 | OPS | DIST integrity — ESM/CJS/strict-TS consumer integration | 2 | 3 | 6 | Story 10.5 (5 net-new DIST validation tests) | dev |
| R10 | OPS | No `effect` internals in dist (peer-dep contract) | 2 | 3 | 6 | Story 10.5 (grep-based regression test) | dev |

### Medium-Priority Risks (Score = 4)

| Risk ID | Category | Description | P | I | Score | Mitigation | Owner |
|---|---|---|---|---|---|---|---|
| R11 | DATA | Compression actually shrinks data (size assertion) | 2 | 2 | 4 | Story 10.1 — existing vitest; trace-only | dev |
| R12 | OPS | README quick-start examples + Match.tag doc regression | 2 | 2 | 4 | Story 10.6 — new doctest harness (3 tests) | dev |

### Low-Priority Risks (Score 1-3)

| Risk ID | Category | Description | P | I | Score | Action |
|---|---|---|---|---|---|---|
| R13 | BUS | One-shot golden path | 1 | 3 | 3 | DOCUMENT (existing coverage) |
| R14 | OPS | Exports map resolution | 1 | 3 | 3 | DOCUMENT (Story 10.5-X-005) |
| R15 | BUS | No pipeline (passthrough control) | 1 | 2 | 2 | DOCUMENT |
| R16 | BUS | Cross-adapter smoke (fromFile, fromNodeReadable) | 1 | 2 | 2 | DOCUMENT |
| R17 | TECH | Logger default silent + non-load-bearing | 1 | 2 | 2 | DOCUMENT |
| R18 | BUS | S3 adapter chunkSize <5MiB guard | 1 | 2 | 2 | DOCUMENT |
| R19 | BUS | Effect-typed callbacks (dual-mode) | 1 | 2 | 2 | DOCUMENT |
| R20 | BUS | Concurrency endpoints | 1 | 2 | 2 | DOCUMENT |
| R21 | BUS | File size edges (< chunk, == × N, +1 byte) | 2 | 2 | 4 | MONITOR (existing coverage) |

### Risk Category Legend

- **DATA**: Data integrity (silent corruption, byte-fidelity, resume mismatches)
- **BUS**: Business logic (golden paths, retry, abort, concurrency)
- **TECH**: Technical fragility (Effect singleton, cleanup leaks, runtime feature gaps)
- **OPS**: Release / distribution (DIST artifact integrity, doctest drift, cross-browser)
- **PERF**: Performance — N/A (no v1 SLA)
- **SEC**: Security — N/A (no auth or sensitive-data paths)

---

## Entry Criteria

- [x] Brainstorming scenario matrix exists (`brainstorming-session-2026-05-17-001.md`)
- [x] Library hardening spec implemented (v0.2.0 surface present)
- [x] Test app harness exists (`examples/test-app/` with MinIO Docker)
- [x] Architecture and project-context documentation present
- [ ] Playwright + browsers installed (output of next workflow `bmad-testarch-framework`)
- [ ] CI configured to run a 3-browser matrix

## Exit Criteria

- [ ] **All P0 tests passing** — both R1 (Resume E2E) and R2 (Cross-browser smoke) are green
- [ ] **P1 net-new tests passing** at ≥ 95%
- [ ] **DIST validation green** (ESM/CJS/strict-TS/effect-leak/exports-map)
- [ ] **No open Critical risks** unmitigated
- [ ] **Test-design traceability matrix** (`{trace_output}/`) populated with 1:1 scenario ↔ test ID mapping
- [ ] **Coverage agreed sufficient** to ship v0.2.0

---

## Test Coverage Plan

> **Note on priority vs execution timing.** P0–P3 below indicate **priority/risk classification**, NOT execution cadence. Execution cadence (PR / Nightly / Weekly) is defined separately in the **Execution Strategy** section below.

### P0 (Critical — BLOCKERS)

**Criteria:** Score = 9 risks. Both R1 and R2 must be green to release v0.2.0.

| Requirement (Risk Link) | Test ID | Test Level | Harness | Count | Owner | Notes |
|---|---|---|---|---|---|---|
| R1 Resume safety E2E | 10.3-E2E-001 | E2E | PW-UI + MinIO | 1 | dev | Persist → reload → resume → byte-equal HeadObject |
| R1 Resume after URL expiry | 10.3-E2E-002 | E2E | PW-UI + MinIO | 1 | dev | Re-sign per attempt verified |
| R2 Cross-browser multipart golden | 10.4-E2E-001/002/003 | E2E | PW-UI matrix | 3 | dev | Chromium · Firefox · WebKit (parametrized) |
| R2 bufferMode across browsers | 10.4-E2E-004 | E2E | PW-UI matrix | 1 | dev | All 3 browsers, parameterized |
| R2 `deflate-raw` support per browser | 10.4-E2E-005 | E2E | PW-Lib | 1 | dev | Library-direct (no UI) |

**Total P0:** 7 tests, **~12–20 hours** (including Story 10.2 Playwright framework setup as a dependency)

### P1 (High)

**Criteria:** Score 6 risks + golden paths that need integration coverage. Common workflows; can have workarounds.

#### Net-new (20 tests)

| Requirement (Risk Link) | Test ID | Test Level | Harness | Count | Est | Notes |
|---|---|---|---|---|---|---|
| R4 Resume golden against MinIO | 10.7-E2E-001 | E2E | PW-UI | 1 | 2h | Standard 3/5 reconciled path |
| R6 Abort cancels in-flight fetches | 10.8-E2E-001 | E2E | PW-UI | 1 | 1.5h | Playwright network log shows `aborted` |
| R8 Effect singleton Tag identity | 10.8-INT-002 | Integration | VT | 1 | 1.5h | Forces 2nd `effect` copy via Vite alias |
| R5 Logger throwing doesn't break upload | 10.1-INT-013 | Integration | VT | 1 | 1h | F#66 — locks the "logging never load-bearing" invariant |
| R9 ESM consumer integration | 10.5-X-001 | DIST | DIST | 1 | 2h | Fresh project, tar → install → import |
| R9 CJS consumer integration | 10.5-X-002 | DIST | DIST | 1 | 1h | Same fixture, `require()` path |
| R9 Strict TypeScript downstream | 10.5-X-003 | DIST | DIST | 1 | 1.5h | tsc against `.d.mts` |
| R10 No `effect` internals in dist | 10.5-X-004 | DIST | DIST | 1 | 1h | Grep regression test |
| R14 Every exports sub-path resolves | 10.5-X-005 | DIST | DIST | 1 | 0.5h | Iterate `package.json#exports` |
| R12 README one-shot doctest | 10.6-D-001 | Doctest | DOC | 1 | 2h | Extract → compile → run mocked |
| R12 README multipart doctest | 10.6-D-002 | Doctest | DOC | 1 | 2h | Against MinIO |
| R12 Match.tag exhaustive regression | 10.6-D-003 | Doctest | DOC | 1 | 1.5h | Compile-time variant-completeness check |
| R16 Cross-adapter parity | 10.7-E2E-002 | E2E | PW-UI | 1 | 1.5h | Same content via File vs Node Readable → identical ETags |
| F#52 `getProgress` % from File totalBytes | 10.1-INT-010 | Integration | VT | 1 | 0.5h | Verify Playwright reads correct progress bar width |
| F#27 maxConcurrency > totalParts | 10.1-INT-018 | Integration | VT | 1 | 0.25h | Trace + minor extension |
| F#1 Multipart golden trace | 10.1-INT-001 | Integration | VT | 1 | 0.5h | Annotate existing test with brainstorming ID |
| (4 more trace-with-extension tests at 0.25–0.5h each) | various | Integration | VT | 4 | 1.5h | |

**Total P1 net-new:** 20 tests, **~20–35 hours**

#### Trace-only (22 tests already covered)

22 scenarios are **already covered by the existing 180-test vitest suite** (including the ~26 just added by the hardening implementation). The Story 10.1 effort is to annotate these tests with brainstorming IDs (`F#X`) in test names or doc comments so the traceability matrix is bidirectional.

**Total P1 trace effort:** ~2–4 hours (pure tagging).

### P2 / P3 — Future Epics

| Bucket | Source | Scenarios | Future Epic | Rough Effort |
|---|---|---|---|---|
| **P2 (Nightly)** | Brainstorming Phase 1+2+3 P2 | ~85 | Epic 11 — P2 Nightly Coverage | ~40–60h |
| **P3 (Weekly/On-demand)** | Brainstorming P3 | ~48 | Epic 12 — P3 Weekly Coverage | ~10–20h |
| **Library hardening v1.x** | Brainstorming missing-feature flags 6–18 | 13 | Epic 13 — v1.x Library Hardening (auto-re-init, Web Locks, etc.) | ~30–50h |

---

## Execution Strategy

**Philosophy:** run everything in PRs unless it's genuinely expensive or long-running. Playwright parallelization gets us 100s of tests in 10–15 min. Defer only what doesn't fit that budget.

### Per-PR (target < 5 min)

Runs on every push and PR. The PR budget is the binding constraint — everything that fits goes here.

- **VT suite** (~180 tests, ~3s) — full vitest run, all unit + integration
- **DIST validation** (5 tests, ~30s) — Stories 10.5-X-001..005
- **Doctest extraction** (3 tests, ~30s) — Stories 10.6-D-001..003
- **Chromium-only E2E smoke** (2 tests, ~90s) — 10.3-E2E-001 (R1 Resume) + 10.4-E2E-001 (R2 Multipart golden, Chromium only)

Total: ~3 min. Cached aggressively via Turborepo.

### Nightly

Full cross-browser matrix + remaining P0/P1 tests that don't fit the PR budget.

- **Full P0 cross-browser matrix:** Stories 10.3 + 10.4 on Chromium + Firefox + WebKit (7 P0 tests × 3 browsers = 21 test-runs)
- **All P1 net-new tests** on the full matrix (Stories 10.7, 10.8, plus the rest of 10.4, 10.6)
- **DIST and doctest** re-run against a real MinIO (vs the mocked PR version)

Estimated runtime: ~30–60 min.

### Weekly / On-demand

Future P2 (Epic 11) and P3 (Epic 12) coverage. Not part of Epic 10's scope; this section is included for forward planning.

- **P2 scenarios** (~85, Epic 11) — chaos, advanced retry, persona paths
- **P3 scenarios** (~48, Epic 12) — deep race conditions, exotic edges, doctest infra extensions
- **Flake burn-in** for any test tagged `@flaky` from PR runs — ad-hoc

---

## Resource Estimates

### Test Development Effort

| Story | Net-new tests | Trace-only | Hours/Test | Total Hours | Notes |
|---|---|---|---|---|---|
| **10.1** Vitest traceability | 5 | 22 | 0.5 / 0.1 | 2–4 | Mostly tagging |
| **10.2** Playwright + MinIO framework | — | — | — | 8–12 | First-time setup (CI matrix, docker fixture, base POM) |
| **10.3** Resume safety E2E (R1) | 2 | — | 3.0 | 6–10 | Fixtures, flake hardening |
| **10.4** Cross-browser smoke (R2) | 5 | — | 1.0 | 6–10 | WebKit setup is the slow part |
| **10.5** DIST integrity | 5 | — | 1.5 | 6–10 | First-time DIST infra |
| **10.6** Doctest harness | 3 | — | 2.0 | 5–8 | New extraction tool |
| **10.7** P1 Playwright UI | 2 | — | 2.0 | 4–6 | Builds on 10.2 fixtures |
| **10.8** Effect singleton + cleanup | 3 | — | 1.5 | 3–5 | One advanced VT + one PW-UI |
| **Total** | **25** | **22** | — | **~40–65** | **~1.5–2 sprint-weeks for one dev** |

### Prerequisites

**Test Data:**
- Files of varying sizes: 1 KiB (under chunk), 10 MiB (exactly 2 parts), 25 MiB (5 parts), 50 MiB (resume scenarios)
- A "different content, same name+size" pair to verify content-digest mismatch detection

**Tooling:**
- **Playwright** — browser automation across Chromium / Firefox / WebKit
- **MinIO Docker** — already exists in `examples/test-app/docker-compose.yml`
- **Concurrently** — for the test-app dev stack (already in place)
- **tar / verdaccio (optional)** — for DIST integrity testing (publish-then-install simulation); a fresh tmp project per test works fine without verdaccio

**Environment:**
- Node 22+ (already required)
- Docker available in CI
- 3-browser Playwright install (~500 MB CI cache)

---

## Quality Gate Criteria

### Pass/Fail Thresholds

- **P0 (R1+R2) pass rate:** 100% — release-blocking, no exceptions
- **P1 pass rate:** ≥ 95% — waivers required for failures
- **P2/P3 pass rate:** ≥ 90% (informational; nightly only)
- **High-risk mitigations (R3-R10):** 100% complete or approved waivers
- **Flake threshold:** < 1% on PR runs over 7-day window — failing tests auto-tagged `@flaky` and moved to nightly until stabilized

### Coverage Targets

- **Critical paths (Resume, Cross-browser):** 100% (both BLOCKER scenarios covered)
- **Library DATA paths (resume validation, content-digest, pipeline-identity):** ≥ 90% (already met by vitest)
- **Business logic (retry, abort, concurrency, golden paths):** ≥ 80% (already met by vitest)
- **DIST artifact correctness:** 100% of public entry points validated
- **README example correctness:** 100% (doctest harness covers all code blocks)

### Non-Negotiable Requirements

- [ ] **All P0 tests pass** before tagging v0.2.0
- [ ] **No unmitigated Critical risks** (R1 or R2 RED → FAIL gate)
- [ ] **DIST integrity green** — peer-dep contract not broken
- [ ] **No `try/catch` in Effect code** — enforced by project-context rules, not lint (yet); code review

### Gate Decision Rules

- **FAIL:** Any P0 RED, or any unresolved CRITICAL risk
- **CONCERNS:** P1 < 95% with HIGH risks documented but mitigated, OR DIST/doctest failures
- **PASS:** All P0 GREEN, P1 ≥ 95%, no unmitigated CRITICAL/HIGH risks
- **WAIVED:** Explicit sign-off with reason + expiry date

---

## Mitigation Plans

### R1: Resume safety E2E (Score: 9) — BLOCKER

**Mitigation Strategy:**
1. Story 10.2 (Playwright + MinIO framework setup) lands first — provides fixtures.
2. Story 10.3 implements two E2E tests:
   - **10.3-E2E-001:** Click upload on a 25 MiB file → reload tab mid-upload → confirm `localStorage` has ResumeState → click "Resume" → wait for completion → verify MinIO `HeadObject` returns the original 25 MiB byte-equal.
   - **10.3-E2E-002:** Similar flow but artificially expire the presigned URL between sessions; verify the lib re-signs each PUT (Playwright network log shows the sign endpoint hit per attempt).
3. Both tests run on Chromium (PR gate) AND nightly on full matrix.

**Owner:** dev (assigned at story-creation time)
**Timeline:** Before v0.2.0 release tag
**Status:** Planned
**Verification:** CI green on both tests across 5 consecutive nightly runs (flake check).

### R2: Cross-browser smoke matrix (Score: 9) — BLOCKER

**Mitigation Strategy:**
1. Story 10.2 sets up Playwright config with the three projects (`chromium`, `firefox`, `webkit`).
2. Story 10.4 implements 5 parametrized tests:
   - **10.4-E2E-001/002/003:** Multipart golden path per browser. Same test body, parametrized over browser.
   - **10.4-E2E-004:** bufferMode adapter parametrized over the three browsers (validates the duplex fallback path).
   - **10.4-E2E-005:** Library-direct test (no UI) verifying `CompressionStream` accepts `deflate-raw` on each browser; fail-fast with skip on browsers that don't support it.
3. CI runs Chromium on every PR; Firefox + WebKit run nightly.
4. WebKit-specific issues (`deflate-raw` historically absent on older Safari): test must either pass or skip with `test.skip(...)` and a documented rationale.

**Owner:** dev
**Timeline:** Before v0.2.0 release tag
**Status:** Planned
**Verification:** Three CI projects all green on 3+ consecutive nightly runs.

### R3–R10: High-Priority Risks (Score: 6)

**Pattern across all R3–R10:** Either existing vitest coverage (R3, R4, R5, R7, R11, R15-R21) or a single Story-10.X net-new test (R6, R8, R9, R10, R12).

**Verification:** Per-story acceptance criteria in the story spec, validated by:
- Triptyque green (build + test + typecheck) per existing project rule
- New tests asserted to fail-on-regression by deliberately breaking the relevant code path during code review

---

## Assumptions and Dependencies

### Assumptions

1. **Playwright + MinIO is the right harness.** Brainstorming chose this; this design assumes the test app at `examples/test-app/` is the production-style harness the library should be validated against.
2. **`tea_browser_automation: auto`** will resolve to CLI mode (Playwright installed in the project). If MCP-only is chosen later, some test patterns (`page.route()`, CDP `Network.emulateNetworkConditions`) may need adjustment.
3. **v0.2.0 release timing** allows the 1.5–2 weeks of test-coverage work before tagging. If shorter, P0-only path is ~12–20 hours (R1 + R2 only) and the rest moves to v0.2.1.
4. **CI budget** accommodates a Chromium-only PR smoke (~3 min) and a nightly 3-browser matrix (~30 min). If CI is constrained, drop Firefox+WebKit from PR (already the recommendation here).
5. **The "fresh dev session" recommendation** from `bmad-quick-spec` applies to the implementation workflow that consumes this design. The dev should start with a clean context and read this file + the brainstorming.

### Dependencies

1. **Playwright + MinIO framework setup (Story 10.2)** — must land before R1+R2 stories.
2. **Next workflow `bmad-testarch-framework`** — initializes Playwright in the repo; will consume this design.
3. **Test app stability** — assumes `examples/test-app/` continues to work as the harness. Any harness breakage blocks E2E tests; covered by Story 10.2 smoke setup.

### Risks to Plan

- **Risk:** WebKit `deflate-raw` may genuinely not be available on the version Playwright bundles. Currently scored as part of R2.
  - **Impact:** Test 10.4-E2E-005 might need `test.skip(...)` rather than a true pass.
  - **Contingency:** Document the WebKit constraint in README; recommend `gzip` as the portable algorithm. The skip becomes evidence of a documented limitation, not a coverage gap.

- **Risk:** Doctest harness (Story 10.6) is more work than estimated if `tsc`-as-compiler-API integration is unfamiliar.
  - **Impact:** Adds ~4 hours.
  - **Contingency:** Drop G#28 (`Match.tag` regression test) from this epic; ship just G#23+G#24 (compile-and-run examples). G#28 becomes Epic 13.

- **Risk:** Effect singleton dual-copy test (R8) requires Vite alias tricks to force a second `effect` instance.
  - **Impact:** Adds ~2 hours.
  - **Contingency:** If untestable in vitest, document as a code-review checklist item instead and skip the test.

---

## Follow-on Workflows (Manual)

- **`bmad-testarch-framework`** — initializes Playwright + MinIO config, base POM, fixtures (Story 10.2). Consume this design as input.
- **`bmad-create-epics-and-stories`** — formalize Epic 10 with stories 10.1–10.8 in `sprint-status.yaml`. Consume this design.
- **`bmad-testarch-atdd`** — generate failing P0 tests (R1+R2) before implementing the rest. Not auto-run; recommended after framework setup.
- **`bmad-testarch-automate`** — broader P1/P2 coverage once framework is stable. After P0 green.
- **`bmad-testarch-trace`** — generate traceability matrix once tests exist. Outputs to `{trace_output}/`.

---

## Approval

**Test Design Approved By:**

- [ ] Product Manager: Grochonnou Date: ____
- [ ] Tech Lead: Grochonnou Date: ____
- [ ] QA Lead: Grochonnou Date: ____

**Comments:**

(solo project — single-person sign-off)

---

## Interworking & Regression

| Service/Component | Impact | Regression Scope |
|---|---|---|
| **`packages/tranquilload-core`** | Multipart core / ResumeState validation / Effect Services | All 149 existing vitest tests + new Story 10.1+10.8 tests |
| **`packages/tranquilload-adapters`** | bufferMode, simpleHttpUpload, s3MultipartUpload | All 31 existing vitest tests + new Story 10.4 tests |
| **`examples/test-app/`** | Test harness (Fastify + MinIO + Vite) | Story 10.7+10.8 use it; any harness change must keep Stories 10.3+10.4 working |
| **`README.md` + `MIGRATION.md`** | Docs accuracy | Story 10.6 doctest harness; every README code-block change re-validates |
| **CI (GitHub Actions)** | New matrix run for Playwright; new DIST validation job | Existing `ci.yml` + `release.yml` should not regress |

---

## Appendix

### Knowledge Base References

- `risk-governance.md` — Risk classification framework
- `probability-impact.md` — 1-9 scoring methodology
- `test-levels-framework.md` — Unit / Integration / E2E selection
- `test-priorities-matrix.md` — P0-P3 prioritization

### Related Documents

- **Brainstorming source matrix:** `_bmad-output/brainstorming/brainstorming-session-2026-05-17-001.md` (175 scenarios)
- **Library hardening spec:** `_bmad-output/implementation-artifacts/tech-spec-library-hardening-resume-and-http.md` (v2.1, just-implemented)
- **Architecture:** `_bmad-output/planning-artifacts/architecture.md`
- **Project conventions:** `docs/project-context.md`
- **Sprint status:** `_bmad-output/implementation-artifacts/sprint-status.yaml` (will gain Epic 10)
- **Test design progress (working file):** `_bmad-output/test-artifacts/test-design-progress.md`

### Test ID Convention

`{EPIC}.{STORY}-{LEVEL}-{SEQ}`

- **EPIC:** 10 (this epic), 11 (P2), 12 (P3), 13 (lib hardening)
- **STORY:** 1–8 within Epic 10
- **LEVEL:** UNIT / INT (integration) / E2E / X (DIST validation) / D (doctest)
- **SEQ:** 001, 002, … per story

Example: `10.4-E2E-003` = Epic 10, Story 4 (Cross-browser), E2E level, third test.

### Harness Types Mapping

| Harness Code | Stack | Where |
|---|---|---|
| **VT** | vitest unit / integration | `packages/*/src/*.test.ts` |
| **PW-UI** | Playwright driving `examples/test-app/` UI | `tests/e2e/ui/` (new dir) |
| **PW-Lib** | Playwright library-direct (no UI) | `tests/e2e/lib/` (new dir) |
| **DIST** | DIST artifact validation (fresh consumer project) | `tests/integration/dist/` (new dir) |
| **DOC** | Doctest harness (extract → compile → run README) | `tests/integration/docs/` (new dir) |

---

**Generated by:** BMad TEA Agent — Test Architect Module
**Workflow:** `bmad-testarch-test-design` (Epic-Level Mode, Sequential execution)
**Version:** Test design v1 for Tranquilload Epic 10 — P1 Test Coverage
