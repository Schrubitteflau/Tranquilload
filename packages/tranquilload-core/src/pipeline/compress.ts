import { Effect } from "effect"
import { CompressionService } from "../services/compression-service.js"
import type { Transform } from "./middleware.js"

export const compress = (
  algorithm = "deflate-raw"
): Effect.Effect<Transform, never, CompressionService> =>
  Effect.map(CompressionService, (svc) => (stream) => svc.compress(stream, algorithm))
