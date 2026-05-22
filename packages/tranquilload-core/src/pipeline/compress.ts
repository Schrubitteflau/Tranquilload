import { Effect } from "effect"
import { CompressionService } from "../services/compression-service.js"
import type { Transform } from "./middleware.js"

// Wraps `svc.compress(stream, alg)` so a sync throw from the user-injected
// CompressionService becomes a typed `PartUploadError` (via chunkStream's
// `Stream.mapError`) rather than a fiber DEFECT. Mirrors the `safeLog`
// boundary (Story 10.1-INT-013) for the compression service.
export const compress = (
  algorithm: CompressionFormat = "deflate-raw"
): Effect.Effect<Transform, never, CompressionService> =>
  Effect.map(CompressionService, (svc): Transform => (stream) => {
    try {
      return svc.compress(stream, algorithm)
    } catch (cause) {
      return new ReadableStream<Uint8Array>({
        start(ctrl) {
          ctrl.error(cause)
        },
      })
    }
  })
