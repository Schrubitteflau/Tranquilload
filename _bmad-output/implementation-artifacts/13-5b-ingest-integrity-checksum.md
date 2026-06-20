---
baseline_commit: 2f49dca
---

# Story 13.5b: Ingest Integrity Checksum (SPIKE)

Status: done — spike resolved (decline/document-only)

<!-- Carved out of Story 13.5 on 2026-06-20. Spike-gated: design pass + AskUserQuestion fork-surfacing precede any dev. -->

## Story

As a library maintainer,
I want an optional ingest checksum to surface a corrupting upload pipeline before `completeUpload`,
so that a buggy `CompressionService` (or wire corruption) is caught instead of silently producing a corrupt object.

> **⚠️ Spike-gated (semantics fork).** Carved out of Story 13.5 because the checksum half is a genuine semantics fork, not a quick-win flip. The design pass + `AskUserQuestion` fork-surfacing were run **before** any dev (proven Epic 13 flow).

## Design pass (2026-06-20)

**F#70's literal promise is not honestly deliverable by any generic checksum.** F#70 / `11.2-INT-005` locks "a malformed `CompressionService` output → upload completes with corrupt bytes". A digest *of the uploaded bytes* faithfully matches whatever (corrupt) bytes the pipeline emitted — it cannot tell the compressor mangled its input. The three candidate semantics were evaluated against the real API:

- **(a) per-part transport-integrity checksum** — the only real-world win is the *server* rejecting **wire** corruption (client → storage) via a trailing checksum header (e.g. S3 `x-amz-checksum-sha256`). But this is **already achievable caller-side with no library API**: `uploadPart(partNumber, chunk)` (see `upload-stream.ts:48`) hands the caller the **exact post-pipeline bytes**, so they can `crypto.subtle.digest("SHA-256", chunk)` and set the header themselves. The lib could only offer thin sugar (compute it + surface on `PartCompleted`). Does **not** detect a buggy compressor. → *Heuristic (ii): the capability already exists → don't add a knob.*
- **(b) caller-supplied expected post-pipeline digest** — the lib would fail with a typed error before `completeUpload` if a rolling digest of the uploaded bytes differs from a caller-supplied expected value. But the "expected post-pipeline digest" **is the output of the pipeline** — the caller has **no oracle for it on a first upload** (the compressor produces it during the run). So (b) cannot catch a buggy compressor on a first upload; it only detects divergence between a recorded prior run and a re-run (niche regression check). Plus cross-platform friction: Web Crypto `subtle.digest` is one-shot (no incremental/streaming hash) and has no MD5, and the core carries **zero crypto dependency** by design.
- **`getContentDigest` is orthogonal** — a caller-supplied resume-**identity** key called *before* any byte flows, documented "MUST NOT consume bytes" and "lightweight/stable" (`name|size|lastModified`). Not a content hash; not reusable for integrity.

**Conclusion:** neither (a) nor (b) honestly delivers F#70's promise. Shipping a checksum knob would give a false sense of safety (heuristic (v): don't ship a dishonest lock for an undeliverable AC).

## Decision (Project Lead, 2026-06-20, via AskUserQuestion → Option 1)

**Decline / document-only. Ship NO new library API.** Document the honest trust boundary + the DIY remedy instead.

## Acceptance Criteria

1. **Given** a reader hits the no-checksum trust boundary, **When** they consult the docs, **Then** they find (a) an explicit statement that the core does not checksum post-pipeline bytes and why a digest of uploaded bytes can't detect a buggy compressor, and (b) the DIY path to server-verified **wire** integrity using the `chunk` already handed to `uploadPart` + a trailing checksum header. Delivered by the README "Ingest integrity (the no-checksum trust boundary)" subsection (`#ingestintegrity`) + a TSDoc note on `uploadPart`.
2. **No behaviour change, no new surface, no crypto dependency.** Default upload path is byte-for-byte unchanged.
3. `11.2-INT-005` (F#70) **stays a green trust-boundary lock** — 13.5b does **not** flip it; its comment is updated to record the resolution and the `13.5b will flip it` re-tag is removed.

## Tasks / Subtasks

- [x] README: add "Ingest integrity (the no-checksum trust boundary)" subsection under Concepts (`README.md`), with the trust-boundary statement + a per-part SHA-256 → `x-amz-checksum-sha256` DIY snippet + the "guards the wire, not a buggy pipeline" caveat.
- [x] TSDoc: add a no-checksum-trust-boundary note on `uploadPart` in `UploadMultipartOptions` (`packages/tranquilload-core/src/multipart/upload-stream.ts`).
- [x] Update the F#70 lock comment in `compression-service-edges.test.ts` to record the resolution (stays green, not flipped).
- [x] Update `epics.md § Story 13.5b` + the epic status summary + `sprint-status.yaml`.
- [x] 1 pre-1.0 patch changeset (core, docs-only).
- [x] Triptyque (build + test + typecheck) green — no logic touched.

## Dev Notes

- This closes risk cluster R-P2-5 as a documented trust boundary + DIY remedy (not a code feature).
- If a future need for *transport-checksum sugar* (Option 2) or *re-upload regression verification* (Option 3) emerges, re-open with the design pass above as the baseline — both remain opt-in, non-breaking, and were declined on cost/honesty grounds, not feasibility.
