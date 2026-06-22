---
baseline_commit: 49db3f6
---

# Story 13.7: Reconciled-part Integrity & Re-upload (SPIKE)

Status: done — spike resolved (decline/document-only)

<!-- Deferred from Story 13.2 (DD3) on 2026-06-12; authored 2026-06-22. Spike-gated: design pass + AskUserQuestion fork-surfacing precede any dev (proven Epic 13 flow, 13.3/13.5/13.5b/13.6). -->

## Story

As a library maintainer,
I want a resume whose reconcile reports a part as complete that the backend has since garbage-collected to recover instead of dead-ending at `completeUpload`,
so that a cross-session resume against drifted server-side part state completes instead of failing with `CompleteUploadError`.

> **⚠️ Spike-gated (memory-safety + protocol-agnostic-detection fork).** Deferred from Story 13.2 (DD3) because "detect/re-upload a GC'd reconciled part" is NOT a quick-win flip — it carries a genuine memory-safety tension (reconciled chunks are discarded after the skip; the source is drained by the complete phase) and a protocol-agnostic-detection problem (the core can't identify which part S3's `InvalidPart` refers to). The design pass + `AskUserQuestion` fork-surfacing were run **before** any dev.

## Design pass (2026-06-22)

**The lock (`11.3-INT-005` / F#14), confirmed in code.** `reconcileCompletedParts` reports part 3 as already uploaded → `makeUploadOne` (`upload-stream.ts:443-455`) skips its PUT, forwards the reconciled etag to `completeUpload`, and **does not retain the chunk**. The server GC'd part 3 between `ListParts` and `/complete` → `completeUpload` rejects `InvalidPart` → surfaces as `CompleteUploadError` at the complete phase. Tier is **unit** (`it.effect`, stubbed callbacks, no MinIO) — so heuristic (i) is satisfied: this is the right tier to flip *if* the feature were built.

**Epic-level AC (`epics.md:1010`):** "detect the missing part and re-upload it instead of dead-ending."

**Heuristic (v) — is the literal AC honestly deliverable?** No. Two independent walls, both confirmed against the real code:

1. **Granular detection is not in-band.** S3's `InvalidPart` at `/complete` is a single error that does not structurally name which part is stale. The protocol-agnostic core cannot parse it (architecture rule — same rule that kept 13.1's S3 guards in the adapter and `reinitOnStale`/`failFast` predicate-based), and a caller predicate on the raw cause cannot reliably extract a part number either. To learn *which* part is gone you must **re-probe** (`ListParts`) — which the caller's own `reconcileCompletedParts` already does.

2. **Memory-safe single-pass re-upload is impossible for an arbitrary GC'd part.** The skipped chunk is dropped; by `finalEffect` the source `ReadableStream` is fully drained (`Stream.concat(partsStream, finalEffect)`, `upload-stream.ts:614-617`). The lib already re-reads the whole source on every resume (a `ReadableStream` cannot seek) — resume saves re-**upload** bandwidth, not re-**read**. To re-upload after a complete-failure you would need to retain *every* reconciled chunk (you don't know in advance which one GC'd) → unbounded; on a 4.9 GB-reconciled / 5 GB resume that holds 4.9 GB to the end, defeating the point of resume. **Bounded retention only covers a GC'd part in the retained tail — it does not deliver the general AC** (and re-introduces exactly the memory tension that spike-gated 13.6).

**Heuristic (ii) — does the recovery capability already exist?** Yes. The honest, memory-safe recovery is caller-side: (a) **verify-before-skip** — only report parts you have confirmed still exist in `reconcileCompletedParts` (closes the window at the proper home, where the caller knows the protocol); or (b) **catch `CompleteUploadError` → re-probe `reconcileCompletedParts` → re-invoke `uploadMultipart` with a fresh source** (~5 lines; the lib is already idempotent across invocations and re-reads the source start-to-finish anyway). The cross-session GC window is realistically day-scale (S3 lifecycle expiry of incomplete-multipart parts), so verify-before-skip closes nearly all of it.

**Conclusion:** the literal in-band "detect & re-upload the GC'd part" is not honestly or memory-safely deliverable as a clean core feature. The genuinely deliverable options are (1) document the trust boundary + caller recovery recipe, or (2) a heavier `recreateStream`-factory re-drive that largely duplicates a 5-line caller re-invocation. Shipping the literal AC would be a dishonest lock (heuristic (v)).

### Fork (surfaced via AskUserQuestion)

1. **Decline → document-only (RECOMMENDED, chosen).** No new core API. Document the trust boundary + verify-before-skip + the catch→re-probe→re-invoke recovery recipe. Re-tag `11.3-INT-005` (stays green, NOT flipped). 1 doc-only patch changeset. Honest per heuristics (ii)+(v).
2. **Build `recreateStream` re-drive.** Opt-in `recreateStream?: () => ReadableStream` + caller predicate; on a stale-classified `CompleteUploadError`, re-probe reconcile, recreate the source, re-drive only the now-missing parts (one bounded re-attempt), then complete. Honest + memory-safe, but costs a second full read pass + real core surface, and largely duplicates a 5-line caller re-invoke. Would flip `11.3-INT-005`.
3. **Bounded-retention re-upload.** Retain the last N bytes of reconciled chunks; re-upload from the buffer on stale complete. NOT recommended — only covers a GC'd part inside the retained window, can't deliver the general AC, and re-introduces the resume memory tension.

## Decision (Project Lead, 2026-06-22, via AskUserQuestion → Option 1)

**Decline / document-only. Ship NO new library API.** Document the honest trust boundary + the two caller-side remedies instead.

## Acceptance Criteria

1. **Given** a reader hits the stale-reconcile trust boundary (a GC'd reconciled part → `CompleteUploadError` at complete), **When** they consult the docs, **Then** they find (a) an explicit statement that reconcile is trusted and why the core does not auto-detect/re-upload a GC'd reconciled part (no in-band part identity; bytes discarded + source drained), and (b) the two honest caller-side remedies — verify-before-skip in `reconcileCompletedParts`, and the catch-`CompleteUploadError` → re-probe → re-invoke-with-fresh-source recipe. Delivered by the README "Reconciled-part integrity (the stale-reconcile trust boundary)" subsection (`#reconciledpartintegrity`) + a TSDoc note on `reconcileCompletedParts`.
2. **No behaviour change, no new surface.** Default upload path is byte-for-byte unchanged.
3. `11.3-INT-005` (F#14) **stays a green lock** — 13.7 does **not** flip it; its comment is updated to record the resolution (was: "DEFERRED from Story 13.2 (DD3) ... Story 13.7 or fold into 13.5").

## Tasks / Subtasks

- [x] README: add "Reconciled-part integrity (the stale-reconcile trust boundary)" subsection under Concepts (after "Resume Safety", before "Ingest integrity"), with the trust-boundary statement + the why-not-auto-detect rationale + the two remedies (verify-before-skip snippet + catch→re-probe→re-invoke snippet) + the `reinitOnStale` cross-reference.
- [x] TSDoc: add a stale-reconcile-trust-boundary note on `reconcileCompletedParts` in `UploadMultipartOptions` (`packages/tranquilload-core/src/multipart/upload-stream.ts`).
- [x] Re-tag the F#14 lock comment in `resume-error-edges.test.ts` to record the resolution (stays green, not flipped).
- [x] Update `epics.md § Story 13.2` deferral note + the epic status summary + `sprint-status.yaml`.
- [x] 1 pre-1.0 patch changeset (core, docs-only).
- [x] Triptyque (build + test + typecheck) green — no logic touched.

## Dev Notes

- This closes the last Epic 13 candidate (the 13.2 DD3 deferral) as a documented trust boundary + caller remedies (not a code feature) — second decline/document-only resolution after 13.5b, both for honesty/cost reasons, not feasibility.
- **The doctest harness does NOT gate the new snippet.** `tests/integration/docs/*.test.ts` compile only specific headings via `findBlock` (`One-shot upload`, `Multipart upload to S3`, `Errors are data`, `Client-side compression`, `Resuming an upload`) + a bash-only scan. A new "Reconciled-part integrity" heading is not matched — same as the 13.5b "Ingest integrity" block. The snippet is still written to compile (free vars like `listParts`/`uploadId`/`uploadPart`/`completeUpload` are illustrative, matching the house style of the Ingest-integrity block).
- `CompleteUploadError` is exported from `@tranquilload/core/errors`; `uploadMultipart` from `@tranquilload/core/multipart`; the returned `result` is the awaited Promise (matches the existing README resume example).
- If a future need for the heavier `recreateStream` re-drive (Option 2) emerges, re-open with this design pass as the baseline — it remains opt-in, non-breaking, and was declined on cost/duplication grounds, not feasibility.

## References

- [Source: _bmad-output/implementation-artifacts/13-2-resume-and-reconcile-robustness.md § DD3 — Deferred]
- [Source: _bmad-output/planning-artifacts/epics.md § Story 13.2 (deferral note, L1010)]
- [Source: _bmad-output/brainstorming/brainstorming-session-2026-05-17-001.md] — F#14
- [Locking test: resume-error-edges.test.ts 11.3-INT-005 (F#14) — re-tagged, NOT flipped]
- [Precedent: _bmad-output/implementation-artifacts/13-5b-ingest-integrity-checksum.md — decline/document-only spike resolution]

## Dev Agent Record

### Agent Model Used

claude-opus-4-8 (Opus 4.8) — per the permanent Epics 6–9 rule.

### Completion Notes List

- **Spike resolved decline/document-only** (PL via design pass + AskUserQuestion). No library code; README + TSDoc only. Default behaviour byte-for-byte unchanged.
- README "Reconciled-part integrity" subsection added (`#reconciledpartintegrity`) between Resume Safety and Ingest integrity; `reconcileCompletedParts` TSDoc note added; `11.3-INT-005` (F#14) comment re-tagged (stays green).
- 1 pre-1.0 patch changeset (core, docs-only). Triptyque green (no logic touched).
- A doc-only story may skip the formal independent review (PL's call) — like 13.5b.

### File List

- **Modified (docs):** `README.md` (Reconciled-part integrity subsection)
- **Modified (TSDoc):** `packages/tranquilload-core/src/multipart/upload-stream.ts` (`reconcileCompletedParts` note)
- **Modified (test comment):** `packages/tranquilload-core/src/multipart/resume-error-edges.test.ts` (11.3-INT-005 re-tag, no assertion change)
- **Added:** `.changeset/epic13-core-reconciled-part-integrity-docs.md`
- **Modified:** `_bmad-output/implementation-artifacts/13-7-reconciled-part-integrity-and-re-upload.md` (this file)
- **Modified:** `_bmad-output/implementation-artifacts/sprint-status.yaml`
- **Modified:** `_bmad-output/planning-artifacts/epics.md` (§ Story 13.2 deferral note → resolved)
