---
stepsCompleted: [1, 2, 3, 4]
inputDocuments:
  - 'docs/project-context.md'
  - '_bmad-output/brainstorming/brainstorming-session-2026-03-08-001.md'
  - 'packages/tranquilload-core/src/errors/upload-error.ts'
  - 'packages/tranquilload-core/src/multipart/upload-stream.ts'
  - 'examples/test-app/'
session_topic: 'E2E test scenarios for Tranquilload — enumerate every scenario worth covering with Playwright against the test-app + MinIO harness, before writing any test code'
session_goals: 'Produce a complete, prioritized scenario matrix (P1/P2/P3) tagged by library feature, ready to feed bmad-testarch-test-design as the next step'
selected_approach: 'ai-recommended'
techniques_used: ['Failure Analysis', 'Chaos Engineering', 'Persona Journey']
ideas_generated: 175
context_file: ''
session_active: false
workflow_completed: true
priority_distribution:
  p1_release_blockers: 42
  p2_nightly: 85
  p3_weekly_or_deferred: 48
missing_feature_flags: 18
next_workflow: 'bmad-testarch-test-design'
---

# Brainstorming Session Results

**Facilitator:** Grochonnou
**Date:** 2026-05-17

## Session Overview

**Topic:** E2E test scenarios for Tranquilload — enumerate every scenario worth covering with Playwright against the test-app + MinIO harness, before writing any test code.

**Goals:** Produce a complete, prioritized scenario matrix (P1/P2/P3) tagged by library feature, ready to feed `bmad-testarch-test-design` as the next step.

### Inputs

- `docs/project-context.md` — library rules, invariants, anti-patterns
- `_bmad-output/brainstorming/brainstorming-session-2026-03-08-001.md` — original library design rationale (45 ideas, v1 scope vs v2)
- Source code: `packages/tranquilload-core/src/errors/upload-error.ts`, `multipart/upload-stream.ts`, `oneshot/upload.ts`
- Target harness: `examples/test-app/` (Fastify + MinIO + vanilla TS frontend driving the library)

### Session Setup

Three orthogonal techniques sequenced to fight LLM clustering bias — each forces a different lens on the same scenario space.

---

## Technique Selection

**Approach:** AI-Recommended Techniques
**Analysis Context:** Tranquilload is a resilience-focused upload library. Test scenarios live at the intersection of (a) named failure modes, (b) network/runtime degradation, (c) real user behaviour. One lens alone leaves gaps in the others.

**Recommended Techniques:**

- **Failure Analysis (deep)** — Walk the `UploadError` union and every `await` in the Effect graph. Each named failure becomes one or more scenarios.
- **Chaos Engineering (wild)** — Cover combinations, intermittency, and degraded-but-not-down states. Leans on Playwright's `setOffline`, `page.route()`, CDP `Network.emulateNetworkConditions`.
- **Persona Journey (theatrical)** — Walk four personas (Mobile-3G, Developer-Tuning, Recovery, Multi-Tab) and surface scenarios that only emerge from a real user's path.

**AI Rationale:** The library's value is correctness under adverse conditions. The matrix needs failure-mode coverage (Phase 1), worst-case-combinations coverage (Phase 2), and user-context coverage (Phase 3). Together they fight semantic clustering — each phase forces a discontinuous shift in viewpoint.

---

## Phase 1 — Failure Analysis

**Frame applied to each scenario:** *Trigger* (how the harness induces it), *Contract* (what the lib promises), *Assertion* (what Playwright checks).

### Golden anchors & UploadError union (F#1–F#10)

| # | Tag | Mnemonic | Key contract |
|---|---|---|---|
| F#1 | Golden | Multipart happy path, defaults | 5 parts, ordered events, correct ETags |
| F#2 | Golden | One-shot happy path | Single PUT, UploadCompleted |
| F#3 | PartUploadError → retry → success | Transient 503, then success | Default `Schedule.exponential ∘ recurs(2)` recovers |
| F#4 | MaxRetriesExceededError | Indefinite 503 | Fail after 3 total attempts; events close cleanly |
| F#5 | PresignedUrlError (corrected) | Adapter throws inside `uploadPart` | Wrapped as `PartUploadError.cause`; **lib does NOT differentiate retry policy** (gap vs original design) |
| F#6 | InitiateUploadError | 500 on `/initiate` | Fail fast; no UploadInitiated; no orphan multipart |
| F#7 | ReconcileError | 500 on `/parts` during resume | Fail before any PUT; parts state unknown → safe refusal |
| F#8 | CompleteUploadError | 500 on `/complete` after all parts | Parts present in MinIO; user must retry-complete or abort manually (**auto-abort not implemented**) |
| F#9 | AbortError via user click | `AbortController.abort()` mid-flight | `Effect.raceFirst` cancels in-flight PUTs; AbortError rejected |
| F#10 | CircuitOpenError | 5 consecutive part failures within 10s (when wired) | CircuitOpen event then rejection |

### Resume / `reconcileCompletedParts` (F#11–F#15)

- F#11 Golden resume: 3/5 already → only PUTs for 4 & 5
- F#12 Resume against deleted uploadId (S3 NoSuchUpload)
- F#13 Resume after presigned URL expiry (re-sign per attempt)
- F#14 Resume with stale reconcile result (part deleted between ListParts and next op)
- F#15 Reconcile returns 0 parts (= fresh start with that uploadId)

### Compression pipeline (F#16–F#20)

- F#16 Compression actually compresses (size assertion on MinIO object)
- F#17 Compression throws → wraps as `PartUploadError`
- F#18 Effect-typed pipeline (resolved with `CompressionServiceLive`)
- F#19 No pipeline (passthrough control)
- F#20 `CompressionStream` unavailable → fails in Effect error channel, not unhandled

### Stream & chunking edge cases (F#21–F#25)

- F#21 File < chunkSize → 1 part
- F#22 File == chunkSize × N exactly
- F#23 File == chunkSize × N + 1 byte
- F#24 Zero-byte file (S3 rejects empty parts list → lib should error before complete)
- F#25 Source stream errors mid-read → wrapped as `PartUploadError(0, 0, cause)`

### Concurrency / semaphore (F#26–F#28)

- F#26 maxConcurrency=1 (serial PUTs)
- F#27 maxConcurrency=16 vs totalParts=4 (no blocking)
- F#28 Concurrency saturation: exactly N PUTs in flight under throttling

### Effect / Promise dual-mode (F#29–F#31)

- F#29 Effect-typed `uploadPart`
- F#30 Synchronous `completeUpload`
- F#31 Effect-typed `initiate` that fails — `cause` is the Effect's typed error

### Events & getProgress (F#32–F#36)

- F#32 Events stream never consumed → no leak
- F#33 Events reader cancelled mid-upload
- F#34 `getProgress()` before initiate → 0
- F#35 `getProgress()` after completion → final value
- F#36 `uploadId` promise resolves even when upload later fails

### One-shot specific (F#37–F#40)

- F#37 One-shot abort mid-stream
- F#38 One-shot server 4xx → `CompleteUploadError`
- F#39 One-shot empty stream
- F#40 `simpleHttpUpload` ReadableStream body in browser (**adapter gap: missing `duplex: 'half'`**)

### Chunk-size & adapter arithmetic (F#41–F#50)

- F#41 **chunkSize=0 = infinite loop bug** in `chunk-stream.ts:18`
- F#42 chunkSize=1 byte (hits S3 10k part limit at tiny files)
- F#43 chunkSize > totalBytes (single part = whole file)
- F#44 Non-integer chunkSize (float math drift)
- F#45 `s3MultipartUpload` synchronous guard on `chunkSize < 5 MiB`
- F#46 `networkMultiplier` with no samples → factor=1.0 (control)
- F#47 `networkMultiplier` saturated slow → factor=0.1 (below S3 floor — user must clamp)
- F#48 Dynamic chunk wired to PartCompleted events (**test-app gap, not lib gap**)
- F#49 10,001 parts (**lib has no pre-validation** — relies on S3 reject)
- F#50 `computeOptimalPartSize` → actual PUT body sizes round-trip

### Source adapters (F#51–F#63)

- F#51 `fromFile` byte-fidelity
- F#52 `fromFile.totalBytes` flows into Progress% (Playwright reads bar width)
- F#53 Empty File (couples with F#24)
- F#54 File blob URL revoked mid-read
- F#55 MIME parity (PNG / UTF-8 / multi-byte chars)
- F#56 `fromNodeReadable` happy path (CLI scenario, MD5 parity)
- F#57 Backpressure under slow consumer (heap stays flat)
- F#58 `createReadStream` of missing file → ENOENT propagates as `PartUploadError`
- F#59 `Readable.destroy(err)` mid-stream
- F#60 Paused Readable → auto-resume by `Readable.toWeb`
- F#61 Buffer source → no re-allocation
- F#62 Cross-adapter parity: same content via `fromFile` vs `fromNodeReadable` → identical MinIO ETags
- F#63 `node:stream` boundary: grep dist for accidental imports outside `from-node-readable.ts` (vitest, not Playwright)

### Logger & Compression injection (F#64–F#73)

- F#64 Default logger is silent (zero console output)
- F#65 User-injected recording logger — locks expected log lines
- F#66 Logger that throws → upload still completes (logging is never load-bearing)
- F#67 Slow logger → upload latency does NOT scale with log-line count
- F#68 Default CompressionService works in browser + Node 22
- F#69 No-op CompressionService → object size = source size (proves injection overrides default)
- F#70 Malformed CompressionService output → upload "succeeds" with corrupt object (codifies the no-checksum trust boundary)
- F#71 CompressionService sync throw
- F#72 CompressionService async rejection
- F#73 Polyfill `globalThis.CompressionStream` to `undefined` → fails in Effect error channel

### Effect Layer composition (F#74–F#81)

- F#74 `.effect` escape hatch typechecks — missing `LoggerService` = compile error (tsd / expectTypeOf)
- F#75 Custom LoggerLive with `[upload:${id}]` prefix
- F#76 `Layer.empty` provided → clear Effect runtime error
- F#77 **Singleton Tag identity** test — forces a second `effect` copy via Vite alias and proves the silent-failure mode
- F#78 TestClock with `@effect/vitest` for `Schedule.exponential`
- F#79 User Layer stacked above `CompressionServiceLive` (last-writer-wins)
- F#80 Layer finalizer runs exactly once at scope close (including on error/abort)
- F#81 Two concurrent `.effect` programs share Layer instance (no double-init)

### Cleanup / resource leaks (F#82–F#90)

- F#82 Abort cancels in-flight fetches (Playwright network log shows `aborted`)
- F#83 Source ReadableStream released on error
- F#84 100 sequential uploads → flat heap (Chromium `performance.memory`)
- F#85 Pipeline error cancels upstream source
- F#86 Server kills TCP mid-PUT → `PartUploadError`, not hang
- F#87 Browser tab closed mid-upload → orphan multipart on MinIO (current behaviour; flips when auto-abort lands)
- F#88 Semaphore permit released on terminal error
- F#89 Two parallel `uploadMultipart` calls → independent Refs (no cross-contamination)
- F#90 Not reading events stream does NOT slow uploads

### Missing-feature flags surfaced by Phase 1

| Flag | Source | Suggested follow-up |
|---|---|---|
| `chunkSize=0` infinite loop | F#41 | Input validation in `chunk-stream.ts` or `uploadMultipart` |
| No pre-validation of S3 10,000 part limit | F#49 | Protocol-aware adapter check |
| No auto-abort on `CompleteUploadError` | F#8 | Implement Cross #5 from original brainstorm |
| Uniform retry across all `PartUploadError` causes | F#5 | Differentiate `PresignedUrlError` (1-2 max) per original design |
| `simpleHttpUpload` missing `duplex: 'half'` | F#40 | Adapter-level fix |

---

## Phase 2 — Chaos Engineering

**Lens shift.** Phase 1 = named failures, one at a time. Phase 2 = intermittent, simultaneous, degraded-but-not-down, and boundary-moment failures. Leans on Playwright network primitives (`setOffline`, `page.route()`, CDP `Network.emulateNetworkConditions`, `context.close()`, `route.abort('namenotresolved')`).

### Cluster 1 — Intermittent failures (C#1–C#6)

- C#1 Flapping uploads — 30% failure on every PUT, expect eventual success
- C#2 Flapping with correlation — failure clusters trip circuit breaker
- C#3 Offline window 8s — exponential backoff insufficient, exposes tuning need
- C#4 Partial response truncation (`Content-Length` lies)
- C#5 Missing ETag header in 200 OK → `PartUploadError` → retry
- C#6 Garbage ETag → MinIO rejects on Complete with `InvalidPart`

### Cluster 2 — Simultaneous failures (C#7–C#11)

- C#7 Two parts fail at once — catches shared-state bugs between retry loops
- C#8 Abort during retry backoff — `Effect.raceFirst` must win immediately
- C#9 Two tabs reconcile + upload same uploadId concurrently — codifies Web Locks need
- C#10 `/sign` and `/parts` both 503 during resume — `ReconcileError` wins
- C#11 Retry-complete after MinIO part expiry → `InvalidPart`

### Cluster 3 — Degraded but not down (C#12–C#17)

- C#12 Slow 3G end-to-end — no hardcoded timeouts must fire
- C#13 High-latency + low-bandwidth — abort must stay responsive
- C#14 Bandwidth crash mid-upload — locks current behaviour, surfaces `networkMultiplier` gap
- C#15 Slow-loris server — reveals need for client-side per-part timeout option
- C#16 Random 10% packet loss (`route.abort('failed')`)
- C#17 DNS failure mid-session (`route.abort('namenotresolved')`)

### Cluster 4 — Boundary-moment failures (C#18–C#25)

- C#18 Abort during `/initiate` — documents orphan-multipart gap
- C#19 Abort between part N and N+1 — partial state in `refParts`, never completed
- C#20 Abort during `/complete` — late-stage abort has no clean recovery
- C#21 TCP RST mid-PUT body
- C#22 Clock skew mid-upload (signed URLs unaffected, but worth verifying)
- C#23 Tab backgrounded → browser throttles
- C#24 `localStorage` quota exceeded — test-app robustness, not lib
- C#25 System sleep approximation (`waitForTimeout(300_000)` under throttle)

### Phase 2 missing-feature flags

| Flag | Source | Suggested follow-up |
|---|---|---|
| No client-side per-part timeout | C#15 | Add `partTimeout?: Duration` option to `UploadMultipartOptions` |
| Default retry policy too aggressive for >1s outages | C#3 | Document `retrySchedule` recipes for "real world" tuning |
| `networkMultiplier` not wired in test app | C#14 | Test-app enhancement (not lib gap) |
| Late-stage abort during `/complete` has no recovery API | C#20 | Document or expose `tryComplete(uploadId, parts)` for manual retry |
| Web Locks not implemented | C#9 | Per original brainstorm (Adapt #3, v1.x) |

---

## Phase 3 — Persona Journey

**Lens shift.** Mechanic-driven (P1+P2) → human-driven. Same library, same harness — scenarios emerge from a real user's path. Sequencing matters: this surfaces *combinations* that mechanic-by-mechanic enumeration misses.

### Persona A — Mobile-3G User (P#A1–P#A6)

*Commuter on a phone uploading a 30 MiB video on flaky cellular.*

- P#A1 Tunnel disconnect (30s silence; default retry too short to survive)
- P#A2 Screen lock mid-upload (browser throttles/suspends JS)
- P#A3 Battery saver caps concurrent connections to 2
- P#A4 Wi-Fi → 5G handoff (TCP connections die)
- P#A5 Oscillating connectivity (5s good / 2s dead, repeat) — `networkMultiplier` oscillation risk
- P#A6 User force-quits app → orphan multipart

### Persona B — Developer-Tuning (P#B1–P#B9)

*Working dev integrating the lib, mixing callback shapes, reading source.*

- P#B1 Forgot to `await result` — unhandled rejection surface
- P#B2 Synchronous `uploadPart` with static ETag (dual-mode smoke)
- P#B3 Promise + Effect callbacks mixed in one upload
- P#B4 chunkSize=7 MiB (non-standard, accepted by core)
- P#B5 Calls `getProgress()` inside `uploadPart` for part 1 → returns 0 (the foot-gun from MEMORY.md)
- P#B6 Custom `retrySchedule: Schedule.recurs(10).pipe(Schedule.fixed("1 second"))`
- P#B7 Custom Logger that pretty-prints UploadEvent
- P#B8 Push (`events`) + pull (`getProgress`) simultaneously, no desync
- P#B9 Multi-step `compose(compress("gzip"), customChecksumTransform)`

### Persona C — Recovery User (P#C1–P#C7)

*Closes laptop mid-upload, opens it 6 hours later. Expects Resume to actually work.*

- P#C1 Resume after 6h — **presigned URLs expired** (re-sign per attempt required)
- P#C2 Resume after MinIO multipart TTL (8 days) — uploadId gone, reconcile empty
- P#C3 Resume with different chunkSize than original — **silent corruption risk**, no validation
- P#C4 Resume with different file (same name + size) — content not hashed, undetectable
- P#C5 Resume but localStorage cleared — test-app behaviour, not lib
- P#C6 Resume, then immediate abort
- P#C7 Two devices, one upload (laptop dies, user opens phone)

### Persona D — Multi-Tab User (P#D1–P#D6)

*Opens app in two tabs, runs same upload, or observes one from the other.*

- P#D1 Same upload, two tabs, two independent uploadIds (no shared state)
- P#D2 Same uploadId, two tabs racing — **silent corruption**, codifies Web Locks need
- P#D3 Observer tab via `storage` events (test-app feature opportunity)
- P#D4 Close tab A mid-upload, tab B sees stale `uploadId`
- P#D5 Tabs race to write `localStorage`
- P#D6 Different effective network speeds per tab — `networkMultiplier` isolation

### Cross-persona collisions

- P#X1 Mobile-3G + Recovery (A + C)
- P#X2 Developer-Tuning + bad reconcile callback (B + C)
- P#X3 Multi-Tab + Mobile-3G (D + A) — doubles the race surface

### Phase 3 missing-feature flags

| Flag | Source | Suggested follow-up |
|---|---|---|
| No `chunkSize` validation on resume vs original session | P#C3 | Persist chunkSize in resume state; refuse mismatched resume |
| No file-content hash for resume identity | P#C4 | Optional `getContentDigest()` hook for resume verification |
| No "resume-when-stale" automatic fallback | P#C2 | When reconcile returns empty AND uploadId 404s, auto re-initiate |
| Unhandled rejection on un-awaited result | P#B1 | Console warning OR opt-in `onUnhandled` callback |

---

## Gap-closing categories (G#1–G#30)

After Phase 3, an honest pass identified four under-covered areas. Mining these brings the matrix to ~175 scenarios.

### (g) Browser matrix (G#1–G#8)

- G#1 Multipart smoke on Chromium / Firefox / WebKit (parameterized)
- G#2 `simpleHttpUpload` streaming body across browsers (will fail without `duplex: 'half'` fix)
- G#3 `CompressionStream` algo support per browser (deflate-raw missing on older WebKit)
- G#4 AbortSignal propagation timing variance
- G#5 Concurrent fetch limit (browser-imposed ~6/host) interacts with `maxConcurrency`
- G#6 `performance.memory` is Chromium-only — heap-stability tests scope-limited
- G#7 `localStorage` quota variance affects resume state
- G#8 Background-tab throttling differs (Chromium intensive, Firefox reduced, Safari aggressive)

### (h) Build / packaging validation (G#9–G#16)

- G#9 ESM consumer integration (fresh `node index.mjs`)
- G#10 CJS consumer integration (`require()`)
- G#11 Strict TypeScript downstream (`strict + noUncheckedIndexedAccess + exactOptionalPropertyTypes`)
- G#12 No `effect` internals in dist (peer-dep contract regression test)
- G#13 Tree-shaking proof (oneshot-only import excludes multipart code)
- G#14 Every `exports` sub-path resolves
- G#15 No `node:*` imports in browser bundle (except behind `fromNodeReadable` boundary)
- G#16 Source maps validity (DevTools-loadable, lines map to `.ts`)

### (i) Filename / S3 key edge cases (G#17–G#22)

- G#17 Special-char filename parameterized over `[# ? % +  café 🚀 RTL]`
- G#18 Path traversal `../../etc/passwd` (test-app sanitization gap)
- G#19 Filename > 1024 chars (S3 key limit → `InitiateUploadError`)
- G#20 Empty / whitespace filename
- G#21 Leading slash → double-slash in key
- G#22 Null byte in filename

### (j) README doctest / documentation accuracy (G#23–G#30)

- G#23 One-shot quick-start example compiles & runs (mocked)
- G#24 Multipart S3 quick-start example compiles & runs against MinIO
- G#25 Resume example compiles & runs end-to-end
- G#26 Adaptive chunk-size example compiles (type-check only)
- G#27 Compression example compiles & runs (size assertion)
- G#28 `Match.tag` exhaustive example compiles — **doubles as 9th-variant regression guard**
- G#29 Test-app README setup reproducibility (CI-runnable script)
- G#30 Package metadata URLs resolve (HTTP 200)

### Final missing-feature flags (from gap pass)

| Flag | Source | Suggested follow-up |
|---|---|---|
| `simpleHttpUpload` browser streaming body | G#2 | Set `duplex: 'half'` in adapter; document HTTP/2 requirement |
| `deflate-raw` not portable to older Safari | G#3 | Document algo support matrix; default to `gzip` |
| No CI step for downstream consumer integration | G#9–G#11 | Add post-build smoke test against fresh ESM/CJS/TSC project |
| No bundle-size regression test | G#12, G#13 | Add `size-limit` config with effect-internal grep guard |

---

## Phase Tally

- Phase 1 (Failure Analysis): **90 scenarios**, 5 missing-feature flags
- Phase 2 (Chaos Engineering): **25 scenarios**, 5 missing-feature flags
- Phase 3 (Persona Journey): **30 scenarios** (incl. 3 cross-persona), 4 missing-feature flags
- Gap-closing categories: **30 scenarios**, 4 missing-feature flags

**Grand total: ~175 scenarios, 18 missing-feature flags surfaced.**

---

## Idea Organization & Prioritization

### Feature → scenario tagging

| Feature | Scope | Scenarios |
|---|---|---|
| **CORE-Multipart** | `uploadMultipart`, `uploadMultipart.effect` | F#1, F#4, F#6, F#8, F#9, F#10, F#21-F#25, F#29-F#36, F#82, F#88-F#90 |
| **CORE-Oneshot** | `uploadOnce`, `uploadOnce.effect` | F#2, F#37-F#39 |
| **CORE-Retry** | `retrySchedule`, `Schedule.exponential` default | F#3, F#4, C#1, C#3, C#8, P#A1, P#B6 |
| **CORE-Abort** | `Effect.raceFirst` + `fromAbortSignal` | F#9, F#82, C#8, C#18-C#20, F#37 |
| **CORE-Events** | `events: ReadableStream<UploadEvent>` | F#32, F#33, F#90, P#B8 |
| **CORE-Progress** | `getProgress`, `uploadId` Promise | F#34-F#36, F#52, P#B5, P#B8 |
| **CORE-Chunking** | `chunkStream` | F#21-F#25, F#41-F#44, F#50 |
| **CORE-Pipeline** | `compose`, `compress` | F#16-F#20, F#71-F#73, P#B9 |
| **CORE-Layers** | `LoggerService`, `CompressionService` | F#64-F#81 |
| **CORE-CircuitBreaker** | `circuitBreaker?` option | F#10, C#2 |
| **CORE-Resume** | `initiate?` + `reconcileCompletedParts?` | F#7, F#11-F#15, P#C1-P#C7, C#10, C#11 |
| **ADP-S3** | `s3MultipartUpload` | F#5, F#45, C#6 |
| **ADP-HTTP** | `simpleHttpUpload` | F#40, G#2 |
| **ADP-File** | `fromFile` | F#51-F#55 |
| **ADP-Node** | `fromNodeReadable` | F#56-F#62, F#63 |
| **ADP-Chunk** | `computeOptimalPartSize`, `networkMultiplier` | F#46-F#50, C#14 |
| **DIST** | published artifact, types, exports | G#9-G#16 |
| **DOC** | README accuracy, examples | G#23-G#30 |
| **CROSS-Browser** | Chromium/Firefox/WebKit parity | G#1-G#8 |
| **APP-Filename** | test-app key sanitization | G#17-G#22 |
| **APP-Lock** | test-app multi-tab handling | C#9, P#D1-P#D6 |

### Priority Buckets

#### P1 — release blockers (~42 scenarios, <5min CI on every PR)

Golden paths & named errors:
F#1, F#2, F#3, F#4, F#6, F#8, F#9, F#11, F#16, F#19, F#21-F#23, F#45

Cleanup & resource safety: F#82, F#89

Cross-adapter smoke: F#51, F#52, F#56, F#62

Critical resume: P#C1 (6h gap + URL expiry — most likely silent breakage)

Layer / service contracts: F#64, F#66, F#77

Browser & dist integrity: G#1, G#9, G#10, G#11, G#12, G#14

Doc regression guards: G#23, G#24, G#28

Per-feature must-haves: F#82, F#29, F#26, F#27

#### P2 — nightly (~85 scenarios)

Phase 1 edges: F#5, F#7, F#10, F#12-F#15, F#17, F#18, F#20, F#24, F#25, F#28, F#30, F#31, F#33-F#36, F#37-F#39, F#40, F#42-F#44, F#46, F#47, F#50, F#53-F#55, F#57-F#61, F#65, F#67-F#73, F#75, F#76, F#78-F#81, F#83-F#88, F#90

Chaos (degraded but realistic): C#1, C#3, C#4-C#8, C#12, C#13, C#15, C#18-C#20

Personas (likely real users): P#A1, P#A2, P#A4, P#B1, P#B5, P#B6, P#C2

Gap-closers: G#2, G#3, G#13, G#15, G#17, G#19, G#25, G#27, G#29

#### P3 — weekly / on-demand / deferred (~48 scenarios)

Niche & exotic: F#41, F#49, F#63, F#74

Deep chaos: C#2, C#9, C#10, C#11, C#14, C#16, C#17, C#21-C#25

Persona edges: P#A3, P#A5, P#A6, P#B2-P#B4, P#B7-P#B9, P#C3-P#C7, P#D1-P#D6, P#X1-P#X3

Sub-features: G#4-G#8, G#16, G#18, G#20-G#22, G#26, G#30

---

## Missing-feature backlog (18 flags)

These are **library/test-app gaps**, not test scenarios. Candidates for v1.x stories.

| Flag | Severity | Source | Suggested follow-up |
|---|---|---|---|
| `chunkSize=0` infinite loop | **Bug** | F#41 | Input validation in chunk-stream |
| `simpleHttpUpload` missing `duplex: 'half'` | **Bug** | F#40, G#2 | Adapter fix; doc HTTP/2 requirement |
| No auto-abort on `CompleteUploadError` | Missing | F#8 | Implement Cross #5 from original brainstorm |
| No pre-validation of S3 10k part limit | Missing | F#49 | Protocol-aware adapter check |
| Uniform retry across all PartUploadError causes | Design gap | F#5 | Differentiate `PresignedUrlError` (1-2 max) |
| No client-side per-part timeout | Missing | C#15 | Add `partTimeout?: Duration` option |
| Default retry too short for >1s outages | Tuning | C#3, P#A1 | Document mobile-friendly recipes |
| No chunkSize validation on resume vs original | **Silent corruption** | P#C3 | Persist + refuse mismatched |
| No content-hash check on resume | **Silent corruption** | P#C4 | Optional `getContentDigest()` hook |
| No auto re-initiate when reconcile empty + uploadId 404s | Missing | P#C2 | Graceful fallback for expired multiparts |
| Unhandled rejection on un-awaited result | Design gap | P#B1 | Console warning or `onUnhandled` callback |
| Web Locks not implemented | Missing | C#9, P#D2 | Per original brainstorm Adapt #3 |
| Late-stage abort during `/complete` has no recovery API | Missing | C#20 | Expose `tryComplete(uploadId, parts)` |
| `networkMultiplier` not wired in test app | Test-app gap | F#48, C#14 | Test-app enhancement |
| `deflate-raw` not portable to older Safari | Doc gap | G#3 | Algo support matrix in README |
| No CI step for downstream consumer integration | Test infra | G#9-G#11 | Post-build smoke test |
| No bundle-size regression test | Test infra | G#12-G#13 | Add `size-limit` config |
| Test-app `uploads/${filename}` not sanitized | Test-app bug | G#18 | Sanitize path traversal sequences |

**Top 5 by severity** (forms candidate v1.1 hardening epic):
1. `chunkSize=0` infinite loop
2. `simpleHttpUpload` `duplex: 'half'` fix
3. ChunkSize mismatch on resume → silent corruption
4. Content-hash verification on resume
5. Auto re-initiate when stored uploadId is dead

---

## Action Plan

**Immediate next step:**
- Run **`bmad-testarch-test-design`** with this matrix as input. Output: structured test plan with traceability matrix (scenario → feature → priority → risk → expected duration).

**Following:**
- **`bmad-testarch-framework`** initializes Playwright + MinIO Docker config.
- **`bmad-create-epics-and-stories`** breaks the P1 set into stories. Suggested epics:
  - *Epic: P1 Test Coverage* — ~10 stories grouped by feature area (Multipart-Golden, Resume, Cross-Browser, Dist, etc.)
  - *Epic: P2 Nightly Coverage* — once P1 green
  - *Epic: v1.1 Library Hardening* — addresses top-5 missing-feature flags

**Parallel track:**
- The top-5 missing-feature flags should be triaged: fixing them BEFORE writing P1 tests means we don't lock in the broken behaviour. The `chunkSize=0` and `duplex: 'half'` bugs especially should be fixed first.

---

## Session Summary & Insights

**Achievements:**
- 175 scenarios across 3 phases + 4 gap-closing categories
- 18 missing-feature flags surfaced as bonus output
- Full feature-tagged matrix ready for `bmad-testarch-test-design`
- 5 top-severity library issues identified for v1.1 backlog

**Breakthrough moments:**
1. **Three orthogonal lenses (failure modes / chaos / personas) generated genuinely different scenarios.** Persona phase surfaced scenarios (P#C1, P#C3, P#C4) that the mechanic-driven phases missed entirely.
2. **Honest gap-pass revealed real category misses** — cross-browser, dist integrity, filename edges, doctest weren't on the original radar. Asking "is this exhaustive?" forced the right additions.
3. **Missing-feature flags are a load-bearing output of brainstorming for testing.** You can't write a meaningful test against a bug; you have to decide to lock or fix. We surfaced 18 such decisions early.

**Methodology notes for future test-brainstorming sessions:**
- AI-recommended technique sequence (3 orthogonal techniques) worked well for the scenario-enumeration use case.
- Asking the meta-question "is this exhaustive enough?" once before organization is high-ROI — caught 4 categories we'd otherwise have missed.
- Tag scenarios by library feature, not by phase, during organization. The phase identifier is provenance; the feature tag is what `bmad-testarch-test-design` and downstream stories will consume.

**Session complete.** Document ready as input to `bmad-testarch-test-design`.

