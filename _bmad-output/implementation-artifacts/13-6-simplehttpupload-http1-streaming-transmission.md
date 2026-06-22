# Story 13.6: simpleHttpUpload HTTP/1.1 Streaming Transmission

**Epic:** 13 (Library Hardening)
**Status:** done (dev + independent Opus review Approve-with-nits 0H/0M/3L) — pending release
**Risk cluster:** R-P2-4 / Decision D1 (spike-gated)

## Story

As a library maintainer,
I want `simpleHttpUpload` to transmit across all three engines without forcing the
caller to manually toggle `bufferMode` per environment,
So that the documented cross-browser HTTP/1.1 transmission gap stops being a
footgun for sources whose size is known.

## Design pass + fork (the spike gate)

Design pass run 2026-06-20, fork DECIDED 2026-06-22 (Project Lead via AskUserQuestion).
Full findings in `epics.md § Story 13.6`. Summary:

- **(a) In-browser HTTP/2 detection is undeliverable** — the Fetch API exposes no
  negotiated-protocol signal. The named lock `11.7-E2E-002` *empirically probes*
  (buffered vs streamed), it does not detect.
- **(b) catch-fail→retry-buffered is blocked by single-use streams** — `upload(stream)`
  hands the source straight to `fetch`; a consumed `ReadableStream` can be neither
  re-streamed nor buffered. Safe retry needs `tee()`+unbounded memory (violates AC#2)
  or a re-openable source (contract change, not "transparent").
- **(c) ~90% already shipped** — `bufferMode:true` already gives an HTTP/1.1-safe path.
- **AC#2 crux** — any auto-buffer needs a SIZE BOUND, but a bare stream has no known
  size, so the size must come from the caller.

**Decision — fork (1): opt-in size-bounded auto-buffer.** *Proactive buffer-if-small*
(decide before consuming) is cleaner than catch-and-retry and sidesteps the
single-use-stream trap entirely.

## Acceptance Criteria

- **AC#1 (reconciled).** A small bounded source transmits in all engines with no manual
  `bufferMode`. The literal brainstorming wording ("transmits via *streaming* in all
  engines") is undeliverable — the engine genuinely rejects an HTTP/1.1 request stream
  and the protocol can't be detected — so it is delivered in its achievable form via the
  auto-buffer path. `11.7-E2E-002` is RE-TAGGED (its raw-engine negative assertion stays
  green); the new behaviour is locked at the unit tier (`13.6-INT-001..007`).
- **AC#2 (memory safety).** Auto-buffer is only chosen when `contentLength <= maxAutoBufferBytes`;
  oversize sources stream (never held in memory); and `maxAutoBufferBytes` set without
  `contentLength` throws a `TypeError` rather than measure-then-buffer an unsized stream.

## New surface (additive, opt-in — default byte-for-byte unchanged)

```ts
interface SimpleHttpUploadOptions {
  // ...existing: url, method, headers, signal, bufferMode...
  contentLength?: number       // known source size; decision-only, not a header
  maxAutoBufferBytes?: number  // opt-in trigger; threshold in bytes
}
```

Decision (computed once, before the single-use stream is touched):

1. `bufferMode: true` → buffer (explicit wins, unchanged).
2. else `maxAutoBufferBytes === undefined` → stream (default, unchanged).
3. else `maxAutoBufferBytes` invalid (negative/non-finite) → `TypeError`.
4. else `contentLength === undefined` → `TypeError` (refuse to size an unsized stream).
5. else `contentLength` invalid → `TypeError`.
6. else `contentLength <= maxAutoBufferBytes` → buffer; otherwise stream.

## Design decisions (called out — do not silently re-pick)

- **DD1 — `contentLength` not a re-openable source.** The fork mentioned Blob/File OR
  `contentLength`. Chose `contentLength` because it keeps the `upload(stream)` contract
  intact (purely additive options) — a `Blob | ReadableStream` overload would be a wider
  public-type change for no extra safety.
- **DD2 — misconfig is a `TypeError`, thrown synchronously from the factory.** A
  programmer error, not an upload-phase error → no new core `UploadError` variant
  (keeps the change adapter-only, per the handoff scope). Fail-fast at construction.
- **DD3 — oversize streams (does not error).** AC#2 allows "honours an explicit policy";
  streaming is memory-safe and preserves the current default. A hard-error policy could
  be added later behind a flag if a caller wants HTTP/1.1-strictness.
- **DD4 — flip-the-lock by re-tag, not flip (wrong tier/shape).** `11.7-E2E-002` probes
  raw browser `fetch` capability the adapter cannot change; net-new unit locks at the
  deterministic tier + re-tag the E2E probe (same call as 13.4 DD2 / 13.5 DD1).
- **DD5 — HTTP/2 detection not attempted** (finding (a) — undeliverable in-browser).

## Files touched

- `packages/tranquilload-adapters/src/protocols/simple-http-upload.ts` — `contentLength`
  + `maxAutoBufferBytes` options; up-front `useBuffer` decision + guards.
- `packages/tranquilload-adapters/src/protocols/simple-http-upload.test.ts` — net-new
  `13.6-INT-001..007`.
- `tests/e2e/lib/simple-http-upload-cross-browser.spec.ts` — re-tagged comments only
  (assertions unchanged; raw-engine gap stays a true negative lock).
- `README.md` — "streaming vs buffered" §: size-bounded auto-buffer subsection.
- `.changeset/13-6-size-bounded-auto-buffer.md` — `@tranquilload/adapters` patch.

## Out of scope

- HTTP/2 capability detection (undeliverable in-browser).
- Transparent catch-retry-buffered (single-use-stream trap / unbounded memory).
- A `Blob | ReadableStream` overload of `upload()` (contract change).
- Node/undici-specific protocol negotiation (revisit if the Node path becomes priority).

## Dev Agent Record

### Agent Model Used

Opus 4.8 (dev). Independent fresh-context Opus `code-reviewer` for review (Codex unavailable).

### Completion Notes

- Triptyque (adapters): tests 68/68 (simple-http-upload 9→16), typecheck clean, build clean.
- Full-repo triptyque: see Change Log / session summary.

### Change Log

- 2026-06-22 — implemented fork (1); +7 unit locks; re-tagged E2E probe; README + changeset.

## Senior Developer Review (AI)

**Reviewer:** independent fresh-context Opus 4.8 `code-reviewer` agent (Codex unavailable).
**Verdict:** Approve-with-nits — **0 HIGH / 0 MED / 3 LOW**.

The reviewer traced every buffering path (memory-safe by construction), confirmed
the decision is made up-front before the single-use stream is touched, precedence
(`bufferMode` wins) and byte-for-byte backward-compat are correct and locked, docs
match code (option names, `TypeError` contract, `<=` inclusivity), the changeset is
correctly scoped (`@tranquilload/adapters` patch, no core leak), and judged the
`11.7-E2E-002` re-tag (not flip) HONEST (raw-engine HTTP/1.1 streaming is a platform
fact the adapter routes around but cannot remove).

### Findings & dispositions

- **F1 (LOW) — no integer check on `contentLength`/`maxAutoBufferBytes`. DECLINED.**
  Fractional values are harmless: `<=` is total over reals and the choice is
  decision-only (no memory-safety impact). `Number.isInteger` would reject
  legitimately-computed sizes for zero safety gain.
- **F2 (LOW) — `bufferMode:true` short-circuits the threshold guards (a typo'd
  `maxAutoBufferBytes` is silently ignored under `bufferMode`). DECLINED.** The TSDoc
  contracts "Ignored when `bufferMode` is set"; throwing on a field documented as
  ignored would contradict the contract.
- **F3 (LOW) — the memory bound is only as honest as the supplied `contentLength`.
  APPLIED.** Added a one-line README caveat (the buffer/stream choice trusts the
  caller's size; uploaded data is always correct since the `Blob` is built from real
  drained bytes, but the ceiling is only as accurate as the number).

### Verify-items raised by the reviewer (it cannot run tests) — checked by the author

1. Adapters tests 16/16 (9 + 7) — GREEN (run pre- and post-review).
2. README doctest harness compiles the new block — **moot**: `doctest.test.ts`
   `findBlock` targets only the "One-shot upload" / "Multipart upload to S3" /
   "Errors are data" headings; the new "streaming vs buffered" block is never
   compiled (reviewer misread the harness).
3. Workspace typecheck — GREEN (4/4; test-app is outside the gate).
