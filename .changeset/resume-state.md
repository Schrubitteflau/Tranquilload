---
"@tranquilload/core": patch
---

Resume safety: opaque `ResumeState`, content-digest validation, pipeline-identity check.

The pre-v0.2 resume pattern (re-passing a stored `uploadId` via `initiate`)
had three silent-corruption gaps: chunkSize drift, content swap, and pipeline
drift. This release ships an opaque `ResumeState` that the lib produces, you
persist, and the lib re-validates before any byte is uploaded.

**New surface:**

- `ResumeState` — opaque, JSON-serializable resume metadata carrying `version`,
  `uploadId`, `chunkSize`, optional `pipelineIdentity`, optional `contentDigest`,
  and the `contentDigestCaptured` flag.
- `resumeFrom: ResumeState` option on `uploadMultipart` — validates match
  synchronously (version, chunkSize, pipelineIdentity, captured-but-dropped
  digest) and asynchronously (digest value), then uses `resumeFrom.uploadId`
  directly (skipping `initiate`).
- `getContentDigest: () => string | Promise<string> | Effect<string, UploadError>`
  option — lightweight stable identifier of the source content. Captured on
  fresh init, compared on resume. Stable patterns:
  `` `${name}|${size}|${lastModified}` `` for browser files;
  `` `${path}|${stat.size}|${stat.mtimeMs}` `` for Node fs.
- `pipelineIdentity: string` option — opaque, strict-equality identifier for
  the upstream pipeline composition.
- `resumeState: Promise<ResumeState>` on `uploadMultipart`'s return — resolves
  with the state you should persist.
- `ResumeMismatchError` — new `UploadError` variant with a `reason`
  discriminant: `version_mismatch | chunksize_mismatch | pipeline_mismatch |
  content_mismatch`. Dispatch with `Match.value(err.reason)` inside the
  `Match.tag("ResumeMismatchError", ...)` handler.

**Behaviour change (semver-minor under pre-1.0 SemVer):** `initiate` semantics
are now "always fresh". Users on the v0.1.x legacy pattern (`initiate +
reconcileCompletedParts + no resumeFrom`) get an unconditional `console.warn`
pointing at `MIGRATION.md`. A second warning fires when `pipeline` is set
without `pipelineIdentity` — without an identity, pipeline-mismatch protection
on resume is disabled.

**Resume is now silent.** On the resume branch, the lib does **not** emit a
synthetic `UploadInitiated` event; the first event after setup is whatever
the parts stream emits next (`PartCompleted` or `ProgressTick`). The
`uploadId` Promise resolves synchronously with `resumeFrom.uploadId`. The
existing fresh-init flow is unchanged.

**Bundled fix:** `CircuitOpenError` is now exported from
`@tranquilload/core/errors`. It was defined internally but had never been
re-exported, so callers had no way to `instanceof`-check it.

**NOT in this release** (explicit non-feature note): auto-re-initiate on dead
`uploadId` was considered but deferred to a future version. If your stored
`uploadId` is no longer valid server-side, you'll currently see
`PartUploadError(1, 1, <404>)` on the first part upload — same as before.

See `MIGRATION.md` for the migration guide.
