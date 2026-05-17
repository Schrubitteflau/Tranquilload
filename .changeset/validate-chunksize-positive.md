---
"@tranquilload/core": patch
---

Validate `chunkSize > 0` in `uploadMultipart` / `uploadMultipartEffect`.

Previously, passing `chunkSize: 0` (or `NaN`, `Infinity`, negative values) caused an infinite loop on the first byte of the source stream — the chunking loop `while (buffer.length >= chunkSize)` never terminated.

Now: `uploadMultipart` (and the `.effect` escape hatch) throws `TypeError` synchronously at construction time when `chunkSize` is not a positive finite number. Behaviour for all valid `chunkSize` values is unchanged.

This is a behaviour change for users who were passing invalid `chunkSize` — but those uploads never worked (they hung forever), so this is semver-patch.
