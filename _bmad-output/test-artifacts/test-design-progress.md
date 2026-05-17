---
stepsCompleted: ['step-01-detect-mode', 'step-02-load-context', 'step-03-risk-and-testability', 'step-04-coverage-plan', 'step-05-generate-output']
lastStep: 'step-05-generate-output'
lastSaved: '2026-05-17'
workflow_complete: true
output_file: '_bmad-output/test-artifacts/test-design-epic-10.md'
inputDocuments:
  - '_bmad-output/brainstorming/brainstorming-session-2026-05-17-001.md'
  - '_bmad-output/implementation-artifacts/tech-spec-library-hardening-resume-and-http.md'
  - '_bmad-output/planning-artifacts/architecture.md'
  - 'docs/project-context.md'
  - '_bmad/tea/testarch/knowledge/test-priorities-matrix.md'
  - '_bmad/tea/testarch/knowledge/test-levels-framework.md'
  - '_bmad/tea/testarch/knowledge/risk-governance.md'
  - '_bmad/tea/testarch/knowledge/probability-impact.md'
mode: 'epic-level'
epic_target: 'P1 Test Coverage (first test-coverage epic)'
source_matrix: '_bmad-output/brainstorming/brainstorming-session-2026-05-17-001.md'
total_scenarios_in_matrix: 175
target_subset_for_this_design: 'P1 (~42 scenarios)'
related_specs:
  - '_bmad-output/implementation-artifacts/tech-spec-library-hardening-resume-and-http.md'
  - '_bmad-output/planning-artifacts/architecture.md'
---

# Test Design — Tranquilload P1 Test Coverage Epic

## Step 1 — Mode Detection & Prerequisites

**Mode:** Epic-Level

**Rationale:**
- Explicit user intent: produce a test plan that "becomes the first test-coverage epic" — matches the Epic-Level mode definition.
- `_bmad-output/implementation-artifacts/sprint-status.yaml` exists, confirming the project is in epic-driven development.
- Inputs available: brainstorming-session scenario matrix (175 scenarios, P1/P2/P3 prioritized, feature-tagged), architecture document, just-shipped library-hardening tech-spec (v0.2.0 surface).

**Prerequisites confirmed:**
- ✅ Epic/story-equivalent requirements: 175 scenarios with priority + feature tags + acceptance shape ("Trigger / Contract / Assertion")
- ✅ Architecture context: `_bmad-output/planning-artifacts/architecture.md` + `docs/project-context.md`
- ✅ Current library surface: just-implemented hardening spec (ResumeState, bufferMode, ResumeMismatchError, etc.)

**Out of scope for this workflow:** test implementation. We're producing a plan; `bmad-testarch-framework` + story-level dev come next.

## Step 2 — Loaded Context & Knowledge Base

### TEA Configuration

- `tea_use_playwright_utils: true`
- `tea_use_pactjs_utils: true` — **not relevant** for Tranquilload (library, no microservice contract testing). Pact fragments skipped.
- `tea_pact_mcp: mcp` — skipped for the same reason
- `tea_browser_automation: auto` — Playwright CLI / MCP will be configured during the framework step (next workflow)
- `test_stack_type: auto` → detected: **fullstack** (TypeScript library + browser test-app under `examples/test-app/`)
- `risk_threshold: p1` — gate at P1, consistent with our brainstorming priorities
- `test_design_output: _bmad-output/test-artifacts/test-design`
- `trace_output: _bmad-output/test-artifacts/traceability`

### Loaded Knowledge Fragments (Epic-Level Required, Core Tier)

- ✅ `test-priorities-matrix.md` — P0-P3 criteria, coverage targets, risk-based adjustments
- ✅ `test-levels-framework.md` — Unit / Integration / E2E selection rules and anti-patterns
- ✅ `risk-governance.md` — Risk scoring matrix, gate decision engine, traceability
- ✅ `probability-impact.md` — Probability/Impact scale (1-3 × 1-3 = 1-9), action thresholds

**Deliberately skipped (not needed for this design):**
- Playwright Utils fragments — will load during `bmad-testarch-framework` when actually setting up Playwright
- Pact.js Utils — not applicable (no microservices)
- Extended/specialized fragments — defer until they're needed

### Existing Test Coverage Snapshot

- **Vitest unit/integration:** 23 test files across both packages. Last full run: 180 tests, 0 failures (per the just-completed hardening implementation report).
- **Playwright E2E:** **0 tests.** No Playwright installed yet. Framework setup is the next workflow (`bmad-testarch-framework`).
- **Doctest / DIST validation / cross-browser harnesses:** none exist yet.

### Strategic Implications

1. **Vitest-level scenarios are already well-covered for the core features just shipped** (chunkSize validation, ResumeState validation, bufferMode, etc.). The test-design exercise for those scenarios is mostly *traceability* (mapping existing tests to the brainstorming scenario IDs), not net-new test work.

2. **The net-new work concentrates at:** (a) Playwright UI E2E (against `examples/test-app/`), (b) library-direct Playwright (no UI, drives library in a page context), (c) DIST artifact validation (separate harness), (d) doctest infra (separate harness). All four are first-time setup.

3. **Risk scoring against the brainstorming matrix:** the brainstorming already prioritized P1/P2/P3, but did NOT apply formal probability-impact scoring. Step 3 will retroactively score the P1 set to identify any P0 blockers (score=9) that gate v0.2.0.

4. **No microservices, no contract testing:** simplifies scope. We don't need Pact provider/consumer testing.

## Step 3 — Risk Assessment (Epic-Level)

**Method:** retroactively apply Probability × Impact scoring (1–9) to the brainstorming P1 set. Goal: identify true BLOCKERS (score=9) that gate v0.2.0 — distinguishing them from HIGH (6–8, MITIGATE) and MEDIUM (4–5, MONITOR) within the P1 bucket.

### Risk Categories (applied)

| Category | Description | Applies to Tranquilload |
|---|---|---|
| **DATA** | Data integrity, silent corruption | Resume-state mismatches (chunk/pipeline/content), reconcile errors |
| **BUS** | Business-logic errors | Retry, abort, concurrency, golden paths |
| **TECH** | Technical fragility | Effect Tag singleton, cleanup leaks, runtime feature gaps |
| **OPS** | Release / distribution | DIST artifact integrity, doctest drift, cross-browser support |
| **PERF** | Performance regressions | Not in v1 scope (no perf SLA documented) |
| **SEC** | Security / data exposure | Not in v1 scope (no auth or sensitive-data paths) |

### Risk Scoring of P1 Set

Scoring applied to scenario *clusters* (not each scenario individually — many cluster siblings share the same risk profile). Test ID format reserved for Step 4 (coverage plan).

| Cluster | Scenarios | Category | P | I | Score | Action |
|---|---|---|---|---|---|---|
| **Resume safety — 6h gap + URL expiry** | P#C1 | DATA | 3 | 3 | **9** | **BLOCK** |
| **Cross-browser smoke (Chromium/Firefox/WebKit)** | G#1 | OPS | 3 | 3 | **9** | **BLOCK** |
| **Silent-corruption regression (ResumeState validation)** | New: ResumeMismatchError variants (post-hardening) | DATA | 2 | 3 | 6 | MITIGATE |
| **Golden multipart path** | F#1, F#11, F#21-23 | BUS | 2 | 3 | 6 | MITIGATE |
| **Named error paths** | F#3, F#4, F#6, F#8, F#9 | BUS | 2 | 3 | 6 | MITIGATE |
| **One-shot golden path** | F#2 | BUS | 1 | 3 | 3 | DOCUMENT |
| **Compression real (size assertion)** | F#16 | DATA | 2 | 2 | 4 | MONITOR |
| **No pipeline (passthrough)** | F#19 | BUS | 1 | 2 | 2 | DOCUMENT |
| **Cleanup — abort cancels fetches** | F#82 | TECH | 2 | 3 | 6 | MITIGATE |
| **Cleanup — Refs isolation across uploads** | F#89 | TECH | 2 | 3 | 6 | MITIGATE |
| **Cross-adapter smoke (fromFile, fromNodeReadable)** | F#51, F#52, F#56, F#62 | BUS | 1 | 2 | 2 | DOCUMENT |
| **Effect singleton Tag identity** | F#77 | TECH | 2 | 3 | 6 | MITIGATE |
| **Logger default silent + non-load-bearing** | F#64, F#66 | TECH | 1 | 2 | 2 | DOCUMENT |
| **DIST integrity (ESM/CJS/strict-TS)** | G#9, G#10, G#11 | OPS | 2 | 3 | 6 | MITIGATE |
| **No `effect` internals in dist (peer-dep)** | G#12 | OPS | 2 | 3 | 6 | MITIGATE |
| **Exports map resolution** | G#14 | OPS | 1 | 3 | 3 | DOCUMENT |
| **README quick-start runs (doctest)** | G#23, G#24 | OPS | 2 | 2 | 4 | MONITOR |
| **Match.tag exhaustive doc regression guard** | G#28 | OPS | 2 | 2 | 4 | MONITOR |
| **S3 adapter chunkSize guard** | F#45 | BUS | 1 | 2 | 2 | DOCUMENT |
| **Effect-typed callbacks (dual-mode)** | F#29 | BUS | 1 | 2 | 2 | DOCUMENT |
| **Concurrency endpoints** | F#26, F#27 | BUS | 1 | 2 | 2 | DOCUMENT |

### Highest Risks (Step 3 Summary)

**🔴 BLOCKERS (Score=9, automatic FAIL until covered):**

1. **R1 · Resume safety, end-to-end against real S3** (P#C1) — DATA · 9
   - *Risk:* the just-shipped ResumeState/digest/chunkSize/pipelineIdentity machinery is unit-tested at the validation layer, but the *full* "persist state → reload page → resume → MinIO accepts the merged object byte-for-byte" path has zero E2E coverage. A regression in `runResumeSetup` or in how `refUploadId` is wired would not be caught by unit tests.
   - *Probability=3:* resume is the highest-complexity feature; touches many components (validation, reconcile, partial-stream consumption, MinIO Complete).
   - *Impact=3:* silent corruption — the multipart Complete succeeds with wrong bytes; user loses data.
   - *Mitigation owner:* test-coverage epic.
   - *Mitigation:* one Playwright E2E test against `examples/test-app/` exercising: fresh upload → tab close → reload → pick same file → resume → MinIO `HeadObject` byte-for-byte match.

2. **R2 · Cross-browser smoke (Chromium, Firefox, WebKit)** (G#1) — OPS · 9
   - *Risk:* README claims "modern browsers"; lib uses `CompressionStream`, `ReadableStream` piping, `fetch` with `duplex: 'half'` — all of which vary across browsers. WebKit historically lacks `deflate-raw`. The `simpleHttpUpload` streaming path requires HTTP/2 + duplex, which Firefox/WebKit handle differently from Chromium.
   - *Probability=3:* almost certain at least one feature breaks somewhere.
   - *Impact=3:* "modern browsers" claim becomes false; users on WebKit silently get broken uploads.
   - *Mitigation owner:* test-coverage epic.
   - *Mitigation:* Playwright matrix run (chromium, firefox, webkit) on a smoke subset — at minimum the multipart golden path and the bufferMode adapter path.

**🟠 HIGH (Score=6, MITIGATE — concerns at gate):**

8 clusters scored 6 (see table above). All have either existing vitest coverage or planned coverage. Mitigation = ensure planned tests are implemented during the test-coverage epic before v0.2.0 ships.

**🟡 MEDIUM (Score=4–5, MONITOR):**

2 clusters: compression size assertion (F#16) and doc regression guards (G#23/G#24/G#28). Implementable cheaply but not gating.

**🟢 LOW (Score=1–3, DOCUMENT):**

9 clusters. Many are already covered by existing vitest tests; the test design just needs to *trace* them (assign IDs) rather than write new tests.

### Strategic Risk Implications

- **The P1 set is bigger than the BLOCKER set.** Of 42 P1 scenarios, only **2 are score=9 BLOCKERS**. ~8 are HIGH (MITIGATE), ~12 are MEDIUM/LOW. This is normal — the brainstorming used user-perception priority; risk scoring tightens to release-criticality.
- **The two BLOCKERS are both NEW work** — no existing tests cover them. Estimated effort: ~1–2 days for the resume E2E test (depends on Playwright setup), ~0.5 day to wire the cross-browser matrix (Playwright config).
- **Risk threshold P1 (from `tea` config) interpretation:** at this gate, a v0.2.0 release CANNOT ship without R1+R2 being green. HIGH scenarios get tracked as CONCERNS but don't block.
- **No PERF or SEC blockers.** The library has no performance SLA documented (could become one in v1.0) and no auth/data-exposure surface. Risk space is concentrated in DATA + OPS.

## Step 4 — Coverage Plan & Execution Strategy

### Epic & Story Decomposition

This becomes **Epic 10 — P1 Test Coverage** (next after the library development epics 1–9).

| Story | Scope | Owner | BLOCKER? |
|---|---|---|---|
| **10.1** Vitest traceability pass | Map existing ~180 vitest tests to brainstorming scenario IDs (F#1, F#2, ...). Identify true gaps vs already-covered. Pure documentation/tagging work. | dev | — |
| **10.2** Playwright + MinIO framework setup | Initialize Playwright, configure CI matrix (chromium+firefox+webkit), wire docker-compose, fixtures for test app boot. Output of `bmad-testarch-framework`. | infra | — |
| **10.3** Resume safety E2E | The R1 blocker: real-S3 resume golden path against MinIO. | dev | ✅ **R1** |
| **10.4** Cross-browser smoke matrix | The R2 blocker: multipart-golden + bufferMode adapter run on three browsers. | dev | ✅ **R2** |
| **10.5** DIST integrity harness | ESM/CJS consumer integration, strict-TS, no-effect-leak grep, exports-map resolution. New vitest-style harness in `tests/integration/`. | dev | — |
| **10.6** Doctest harness for README examples | Extract code blocks from `README.md`, compile, run. Implements G#28 infrastructure. | dev | — |
| **10.7** P1 Playwright UI happy paths | Multipart-golden + one-shot + abort + compression UI flows. Builds on 10.2. | dev | — |
| **10.8** P1 effect-singleton + cleanup tests | F#77 (Tag identity), F#82 (abort cancels fetches), F#89 (Refs isolation). Mix of vitest-integration + Playwright. | dev | — |

### Coverage Matrix — P1 Scenarios

**Legend:**
- **Level:** U=Unit · I=Integration · E=E2E · D=Doctest · X=DIST validation
- **Harness:** VT=vitest · PW-UI=Playwright against test-app · PW-Lib=Playwright library-direct (no UI) · DOC=doctest harness · DIST=DIST validation harness
- **Cov?:** ✅ already covered by existing tests · 🆕 net-new work · 🔄 trace-only (exists, needs ID assignment)
- **Risk:** score from Step 3
- **Est:** rough estimate including writing + review + CI integration

#### Golden Paths & Named Errors

| Test ID | Scenario | Level | Harness | Story | Cov? | Risk | Est |
|---|---|---|---|---|---|---|---|
| 10.1-INT-001 | F#1 — Multipart happy path, defaults (5 parts, ordered events) | I | VT | 10.1 | 🔄 | 6 | 0.5h |
| 10.1-INT-002 | F#2 — One-shot happy path | I | VT | 10.1 | ✅ | 3 | 0h |
| 10.1-INT-003 | F#3 — PartUploadError → retry → success | I | VT | 10.1 | ✅ | 6 | 0h |
| 10.1-INT-004 | F#4 — MaxRetriesExceededError after retries exhausted | I | VT | 10.1 | ✅ | 6 | 0h |
| 10.1-INT-005 | F#6 — InitiateUploadError (server 500 on initiate) | I | VT | 10.1 | ✅ | 6 | 0h |
| 10.1-INT-006 | F#8 — CompleteUploadError; parts present, multipart not finalized | I | VT | 10.1 | ✅ | 6 | 0h |
| 10.1-INT-007 | F#9 — AbortError via user click | I | VT | 10.1 | ✅ | 6 | 0h |
| 10.1-INT-008 | F#11 — Resume happy path (3/5 reconciled → only PUT 4&5) | I | VT | 10.1 | ✅ | 6 | 0h |
| 10.7-E2E-001 | F#11 — Resume golden path against MinIO (end-to-end) | E | PW-UI | 10.7 | 🆕 | 6 | 2h |

#### Resume Safety (R1 BLOCKER)

| Test ID | Scenario | Level | Harness | Story | Cov? | Risk | Est |
|---|---|---|---|---|---|---|---|
| 10.3-E2E-001 | P#C1 — Fresh upload → reload tab → resume with same file → MinIO HeadObject byte-equal | E | PW-UI | 10.3 | 🆕 | **9** | 3h |
| 10.3-E2E-002 | P#C1+ — Resume after presigned URL expiry (re-sign per attempt) | E | PW-UI | 10.3 | 🆕 | **9** | 2h |
| 10.3-INT-001 | ResumeMismatchError exhaustive: 4 reasons + dropped-digest + empty-uploadId | I | VT | 10.3 | ✅ | 6 | 0h |
| 10.3-INT-002 | runResumeSetup vs runFreshInit branch coverage | I | VT | 10.3 | ✅ | 6 | 0h |

#### Cross-Browser Smoke (R2 BLOCKER)

| Test ID | Scenario | Level | Harness | Story | Cov? | Risk | Est |
|---|---|---|---|---|---|---|---|
| 10.4-E2E-001 | G#1 — Multipart golden on Chromium | E | PW-UI | 10.4 | 🆕 | **9** | 0.5h |
| 10.4-E2E-002 | G#1 — Multipart golden on Firefox | E | PW-UI | 10.4 | 🆕 | **9** | 1h |
| 10.4-E2E-003 | G#1 — Multipart golden on WebKit | E | PW-UI | 10.4 | 🆕 | **9** | 1.5h |
| 10.4-E2E-004 | bufferMode adapter on all three browsers (parametrized) | E | PW-UI | 10.4 | 🆕 | 6 | 1h |
| 10.4-E2E-005 | CompressionStream `deflate-raw` algo support per browser | E | PW-Lib | 10.4 | 🆕 | 6 | 1h |

#### Cleanup & Resource Safety

| Test ID | Scenario | Level | Harness | Story | Cov? | Risk | Est |
|---|---|---|---|---|---|---|---|
| 10.8-E2E-001 | F#82 — Abort cancels in-flight fetches (Playwright network log shows `aborted` status) | E | PW-UI | 10.8 | 🆕 | 6 | 1.5h |
| 10.8-INT-001 | F#89 — Two parallel uploads have independent Refs | I | VT | 10.8 | 🔄 | 6 | 0.5h |
| 10.8-INT-002 | F#77 — Effect singleton Tag identity (two-copy detection) | I | VT | 10.8 | 🆕 | 6 | 1.5h |

#### Cross-Adapter & Layer Contracts

| Test ID | Scenario | Level | Harness | Story | Cov? | Risk | Est |
|---|---|---|---|---|---|---|---|
| 10.1-INT-009 | F#51 — fromFile byte-fidelity | U | VT | 10.1 | ✅ | 2 | 0h |
| 10.1-INT-010 | F#52 — fromFile.totalBytes → ProgressTick % | I | VT | 10.1 | 🔄 | 2 | 0.5h |
| 10.1-INT-011 | F#56 — fromNodeReadable happy path | I | VT | 10.1 | ✅ | 2 | 0h |
| 10.7-E2E-002 | F#62 — Cross-adapter parity (fromFile vs fromNodeReadable produce identical MinIO ETags) | E | PW-UI | 10.7 | 🆕 | 4 | 1.5h |
| 10.1-INT-012 | F#64 — Default logger is silent | I | VT | 10.1 | ✅ | 2 | 0h |
| 10.1-INT-013 | F#66 — Logger throwing doesn't break upload | I | VT | 10.1 | 🆕 | 6 | 1h |

#### DIST Integrity (Build/Packaging)

| Test ID | Scenario | Level | Harness | Story | Cov? | Risk | Est |
|---|---|---|---|---|---|---|---|
| 10.5-X-001 | G#9 — ESM consumer integration (fresh `node index.mjs`) | X | DIST | 10.5 | 🆕 | 6 | 2h |
| 10.5-X-002 | G#10 — CJS consumer integration (`require()`) | X | DIST | 10.5 | 🆕 | 6 | 1h |
| 10.5-X-003 | G#11 — Strict TypeScript downstream (tsc against `.d.mts` types) | X | DIST | 10.5 | 🆕 | 6 | 1.5h |
| 10.5-X-004 | G#12 — No `effect` internals in dist (peer-dep regression test) | X | DIST | 10.5 | 🆕 | 6 | 1h |
| 10.5-X-005 | G#14 — Every `exports` sub-path resolves | X | DIST | 10.5 | 🆕 | 3 | 0.5h |

#### Documentation Regression

| Test ID | Scenario | Level | Harness | Story | Cov? | Risk | Est |
|---|---|---|---|---|---|---|---|
| 10.6-D-001 | G#23 — README one-shot quick-start compiles & runs | D | DOC | 10.6 | 🆕 | 4 | 2h |
| 10.6-D-002 | G#24 — README multipart quick-start compiles & runs against MinIO | D | DOC | 10.6 | 🆕 | 4 | 2h |
| 10.6-D-003 | G#28 — Match.tag exhaustive doctest (regression guard for new error variants) | D | DOC | 10.6 | 🆕 | 4 | 1.5h |

#### Compression & Misc

| Test ID | Scenario | Level | Harness | Story | Cov? | Risk | Est |
|---|---|---|---|---|---|---|---|
| 10.1-INT-014 | F#16 — Compression actually compresses (size assertion) | I | VT | 10.1 | ✅ | 4 | 0h |
| 10.1-INT-015 | F#19 — No pipeline (passthrough control) | I | VT | 10.1 | ✅ | 2 | 0h |
| 10.1-INT-016 | F#21–23 — File &lt; chunkSize / == × N / +1 byte | I | VT | 10.1 | ✅ | 4 | 0h |
| 10.1-INT-017 | F#26 — maxConcurrency=1 (serial) | I | VT | 10.1 | ✅ | 2 | 0h |
| 10.1-INT-018 | F#27 — maxConcurrency=16 vs totalParts=4 (no blocking) | I | VT | 10.1 | 🔄 | 2 | 0.25h |
| 10.1-INT-019 | F#29 — Effect-typed uploadPart works | I | VT | 10.1 | ✅ | 2 | 0h |
| 10.1-INT-020 | F#45 — s3MultipartUpload chunkSize <5MiB guard | U | VT | 10.1 | ✅ | 2 | 0h |

### Coverage Summary by Harness

| Harness | Net-new tests | Already covered (trace) | Total in P1 |
|---|---|---|---|
| **VT** (vitest unit/integration) | 2 net-new | 18 covered + 4 trace | 24 |
| **PW-UI** (Playwright against test app) | 9 net-new | 0 | 9 |
| **PW-Lib** (Playwright library-direct) | 1 net-new | 0 | 1 |
| **DIST** (build/packaging validation) | 5 net-new | 0 | 5 |
| **DOC** (doctest harness) | 3 net-new | 0 | 3 |
| **Total P1** | **20 net-new** | **22 trace-only** | **42** |

### Out-of-P1 Buckets (For Future Epics)

| Bucket | Source | Scenarios | Future Epic |
|---|---|---|---|
| P2 (Nightly) | Brainstorming Phase 1+2+3 P2 | ~85 | Epic 11 — P2 Nightly Coverage |
| P3 (Weekly/On-demand) | Brainstorming P3 | ~48 | Epic 12 — P3 Weekly Coverage |
| Missing-feature backlog | Brainstorming flags 6-18 + reviews | 13 | Epic 13 — v1.x Library Hardening (auto-re-init, Web Locks, etc.) |

### Execution Strategy

Following the **PR / Nightly / Weekly** model from `test-priorities-matrix.md`:

#### Per-PR (must stay <5 minutes total)

- **All VT tests** (180 existing + ~5 new from this epic = ~185 tests, runs in ~3s today, will stay well under budget)
- **DIST validation** (10.5-X-001 to 10.5-X-005, ~30s)
- **Smoke E2E subset** — Chromium only, golden multipart + golden resume (10.4-E2E-001, 10.3-E2E-001), no chaos, no full browser matrix (~90s)
- **Doctest extraction** (10.6-D-001 to 10.6-D-003, ~30s)

Total target: <5 minutes. Cache aggressively via `turbo`.

#### Nightly (can run 30–60 min)

- **Full Playwright matrix** — all P1 E2E across Chromium + Firefox + WebKit (10.4 + 10.7 + 10.8 E2E suite × 3 browsers)
- **P2 coverage** as it lands (Epic 11)
- **Doctest with real MinIO** for the runnable examples

#### Weekly / On-demand

- **P3 scenarios** (deep chaos, persona edges, exotic filenames)
- **Long-running burn-in** to detect flakiness in time-sensitive tests (anything using TestClock for `Schedule.exponential`)

### Resource Estimates

| Bucket | Hours | Notes |
|---|---|---|
| **Story 10.1** Vitest traceability | 2–4h | Mostly tagging; 4 scenarios need new tests (~0.5h each) |
| **Story 10.2** Playwright + MinIO framework | 8–12h | First-time setup: install, config, CI integration, docker fixture, base page object |
| **Story 10.3** Resume safety E2E (R1) | 6–10h | 2 E2E tests + fixtures + flake hardening |
| **Story 10.4** Cross-browser smoke (R2) | 6–10h | WebKit setup is the slow part; CI matrix configuration |
| **Story 10.5** DIST integrity harness | 6–10h | First-time DIST validation infra; tar-then-install fresh project |
| **Story 10.6** Doctest harness | 5–8h | New extraction tool, compile pipeline; reusable for future docs |
| **Story 10.7** P1 Playwright UI happy paths | 4–6h | Builds on 10.2 fixtures |
| **Story 10.8** Effect singleton + cleanup | 3–5h | One advanced VT test + one PW-UI network-log test |

**P0 (BLOCKERS R1+R2) subtotal:** ~12–20h (Stories 10.3 + 10.4 + dependency on 10.2)
**P1 epic total:** ~40–65h (~1.5–2 sprint-weeks for one dev)

**Future epics (estimates only — not commitments):**
- Epic 11 (P2 nightly): ~40–60h
- Epic 12 (P3 weekly): ~10–20h
- Epic 13 (library hardening v1.x): ~30–50h (auto-re-init alone is ~12h based on the v1 spec's complexity)

### Quality Gates

| Gate | Threshold | Enforcement |
|---|---|---|
| **P0 (BLOCKER) pass rate** | **100%** | CI fails on any P0 red. Required for v0.2.0 release. |
| **P1 pass rate** | ≥ 95% | CI logs concerns; release notes flag known-failing tests. |
| **Coverage target** | n/a (existing vitest already high; new layer is E2E) | Trace matrix updated each story merge. |
| **R1 (Resume safety E2E)** | Must be green on Chromium minimum | Before tagging v0.2.0. |
| **R2 (Cross-browser smoke)** | Must be green on Chromium + WebKit + Firefox | Before tagging v0.2.0. |
| **Flake threshold** | < 1% on PR runs over 7-day window | Failing tests get auto-tagged `@flaky` and moved to nightly until stabilized. |

**Gate decision rules:**
- Any **R1 or R2 RED** → FAIL gate, no release.
- All R1+R2 GREEN, P1 ≥ 95% → PASS.
- R1+R2 GREEN, P1 < 95% with documented HIGH risks → CONCERNS (release allowed with sign-off).
- DIST or DOC failures → CONCERNS (release allowed but flag in release notes).
