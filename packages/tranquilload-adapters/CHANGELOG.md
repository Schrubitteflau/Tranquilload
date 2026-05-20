# @tranquilload/adapters

## 0.1.1

### Patch Changes

- 6ca9186: `simpleHttpUpload`: add `bufferMode` option + set `duplex: 'half'` on streaming uploads.

  The streaming PUT path now sets `duplex: 'half'`, which modern browsers and
  Node 22+ require to accept a `ReadableStream` as a `fetch` body. **Streaming
  PUT now requires an HTTP/2 endpoint** — HTTP/1.x will reject the request.

  For HTTP/1.x targets (or environments where the `duplex` flag is unavailable),
  opt in to `bufferMode: true`. The adapter drains the entire source stream
  into a `Blob` before issuing the request:

  ```ts
  const adapter = simpleHttpUpload({
    url: "https://legacy-http1.example.com/upload",
    bufferMode: true,
  });
  ```

  **Memory caveat.** `bufferMode: true` buffers the whole source into memory —
  do not enable for files larger than available memory. Use it as the HTTP/1.x
  escape hatch, not as a default.

  The drain loop is signal-aware: aborting via `AbortSignal` between read
  iterations rejects with `AbortError` (not `CompleteUploadError`), preserving
  the abort phase mapping.

- Updated dependencies [6ca9186]
- Updated dependencies [6ca9186]
  - @tranquilload/core@0.1.1
