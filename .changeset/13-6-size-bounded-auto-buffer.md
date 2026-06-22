---
"@tranquilload/adapters": patch
---

Add an opt-in **size-bounded auto-buffer** to `simpleHttpUpload` (Epic 13, Story 13.6). For sources of a known size, set `maxAutoBufferBytes` (and `contentLength`) and the adapter chooses the transport up front — before the single-use stream is consumed — instead of forcing a manual per-environment `bufferMode` toggle:

- `contentLength <= maxAutoBufferBytes` → buffered PUT/POST (HTTP/1.1-safe, works in every engine, no `duplex: 'half'`).
- `contentLength > maxAutoBufferBytes` → streamed PUT/POST (`duplex: 'half'`, requires HTTP/2) — the large source is never held in memory.

The decision is memory-safe by construction: `maxAutoBufferBytes` requires `contentLength` (the factory throws a `TypeError` rather than measure-then-buffer an unsized stream), and oversized sources stream rather than buffer. `bufferMode: true` still takes precedence (explicit mode wins). HTTP/2 capability detection is intentionally not attempted — the Fetch API exposes no negotiated-protocol signal in the browser, so a caller-supplied size threshold is the honest, deliverable knob.

Default behaviour is byte-for-byte unchanged: with neither `bufferMode` nor `maxAutoBufferBytes` set, `simpleHttpUpload` streams with `duplex: 'half'` exactly as before.
