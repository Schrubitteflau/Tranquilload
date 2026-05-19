import Fastify from "fastify"
import cors from "@fastify/cors"
import { randomUUID } from "node:crypto"
import { Readable } from "node:stream"
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  ListPartsCommand,
  PutObjectCommand,
  loadEnv,
  makePresignerClient,
  makeServerClient,
  presignUploadPart,
} from "./s3.js"

const env = loadEnv()
const port = Number(process.env.SERVER_PORT ?? 3000)

const server = makeServerClient(env)
const presigner = makePresignerClient(env)

const app = Fastify({ logger: { transport: { target: "pino-pretty" } } })

await app.register(cors, { origin: true })

// ---------- Chaos toggles (per-session; in-memory; reset on server restart) ----------
//
// Chaos state is keyed by the `x-test-session` header so parallel Playwright
// workers across projects (chromium-ui / firefox-ui / webkit-ui) do not
// trample each other's chaos config. Requests without the header fall back to
// a shared "default" session — preserves manual UI usage and the test-app
// running outside Playwright.
interface Chaos {
  failSignNextN: number
  failCompleteNextN: number
  slowSignMs: number
}
const SESSION_HEADER = "x-test-session"
const DEFAULT_SESSION = "default"
const chaosBySession = new Map<string, Chaos>()

const defaultChaos = (): Chaos => ({
  failSignNextN: 0,
  failCompleteNextN: 0,
  slowSignMs: 0,
})

function getSessionId(headers: Record<string, string | string[] | undefined>): string {
  const raw = headers[SESSION_HEADER]
  if (typeof raw === "string" && raw.length > 0) return raw
  if (Array.isArray(raw) && raw.length > 0 && typeof raw[0] === "string") return raw[0]
  return DEFAULT_SESSION
}

function getChaos(sessionId: string): Chaos {
  let c = chaosBySession.get(sessionId)
  if (!c) {
    c = defaultChaos()
    chaosBySession.set(sessionId, c)
  }
  return c
}

app.get("/api/chaos", async (req) => getChaos(getSessionId(req.headers)))
app.post<{ Body: Partial<Chaos> }>("/api/chaos", async (req) => {
  const chaos = getChaos(getSessionId(req.headers))
  if (typeof req.body.failSignNextN === "number") chaos.failSignNextN = req.body.failSignNextN
  if (typeof req.body.failCompleteNextN === "number") chaos.failCompleteNextN = req.body.failCompleteNextN
  if (typeof req.body.slowSignMs === "number") chaos.slowSignMs = req.body.slowSignMs
  return chaos
})

// ---------- Multipart ----------

app.post<{ Body: { filename: string; contentType?: string } }>(
  "/api/multipart/initiate",
  async (req, reply) => {
    const { filename, contentType } = req.body
    if (!filename) return reply.code(400).send({ error: "filename required" })

    const key = `uploads/${randomUUID()}-${filename}`
    const result = await server.send(
      new CreateMultipartUploadCommand({
        Bucket: env.bucket,
        Key: key,
        ContentType: contentType,
      })
    )
    if (!result.UploadId) return reply.code(500).send({ error: "no UploadId returned" })
    return { uploadId: result.UploadId, key }
  }
)

app.post<{ Body: { key: string; uploadId: string; partNumber: number } }>(
  "/api/multipart/sign",
  async (req, reply) => {
    const { key, uploadId, partNumber } = req.body
    if (!key || !uploadId || typeof partNumber !== "number") {
      return reply.code(400).send({ error: "key, uploadId, partNumber required" })
    }
    const chaos = getChaos(getSessionId(req.headers))
    if (chaos.slowSignMs > 0) {
      await new Promise((r) => setTimeout(r, chaos.slowSignMs))
    }
    if (chaos.failSignNextN > 0) {
      chaos.failSignNextN -= 1
      return reply.code(503).send({ error: "chaos: forced failure" })
    }
    const url = await presignUploadPart(presigner, env.bucket, key, uploadId, partNumber)
    return { url }
  }
)

app.post<{
  Body: { key: string; uploadId: string; parts: ReadonlyArray<{ partNumber: number; etag: string }> }
}>("/api/multipart/complete", async (req, reply) => {
  const { key, uploadId, parts } = req.body
  if (!key || !uploadId || !Array.isArray(parts)) {
    return reply.code(400).send({ error: "key, uploadId, parts required" })
  }
  const chaos = getChaos(getSessionId(req.headers))
  if (chaos.failCompleteNextN > 0) {
    chaos.failCompleteNextN -= 1
    return reply.code(503).send({ error: "chaos: forced complete failure" })
  }
  const sorted = [...parts].sort((a, b) => a.partNumber - b.partNumber)
  const result = await server.send(
    new CompleteMultipartUploadCommand({
      Bucket: env.bucket,
      Key: key,
      UploadId: uploadId,
      MultipartUpload: {
        Parts: sorted.map((p) => ({ PartNumber: p.partNumber, ETag: p.etag })),
      },
    })
  )
  return { ok: true, location: result.Location, key }
})

app.post<{ Body: { key: string; uploadId: string } }>(
  "/api/multipart/abort",
  async (req, reply) => {
    const { key, uploadId } = req.body
    if (!key || !uploadId) return reply.code(400).send({ error: "key, uploadId required" })
    await server.send(
      new AbortMultipartUploadCommand({
        Bucket: env.bucket,
        Key: key,
        UploadId: uploadId,
      })
    )
    return { ok: true }
  }
)

app.get<{ Querystring: { key: string; uploadId: string } }>(
  "/api/multipart/parts",
  async (req, reply) => {
    const { key, uploadId } = req.query
    if (!key || !uploadId) return reply.code(400).send({ error: "key, uploadId required" })
    const result = await server.send(
      new ListPartsCommand({
        Bucket: env.bucket,
        Key: key,
        UploadId: uploadId,
      })
    )
    const parts = (result.Parts ?? []).map((p) => ({
      partNumber: p.PartNumber!,
      etag: (p.ETag ?? "").replace(/"/g, ""),
      size: p.Size ?? 0,
    }))
    return { parts }
  }
)

// ---------- One-shot ----------

// Stream the request body straight to S3. The browser PUTs the file body here;
// we forward it to MinIO via PutObjectCommand. Fastify needs raw stream access:
app.addContentTypeParser("*", (_req, _payload, done) => done(null))

app.put<{ Querystring: { filename: string; contentType?: string } }>(
  "/api/oneshot",
  async (req, reply) => {
    const { filename, contentType } = req.query
    if (!filename) return reply.code(400).send({ error: "filename query param required" })

    const key = `uploads/${randomUUID()}-${filename}`
    const body = req.raw as Readable
    const contentLength = req.headers["content-length"]
      ? Number(req.headers["content-length"])
      : undefined

    await server.send(
      new PutObjectCommand({
        Bucket: env.bucket,
        Key: key,
        Body: body,
        ContentType: contentType ?? req.headers["content-type"],
        ContentLength: contentLength,
      })
    )
    return { ok: true, key }
  }
)

app.get("/api/health", async () => ({
  ok: true,
  bucket: env.bucket,
  endpoint: env.endpoint,
  publicEndpoint: env.publicEndpoint,
}))

app.listen({ port, host: "0.0.0.0" }, (err, addr) => {
  if (err) {
    app.log.error(err)
    process.exit(1)
  }
  app.log.info(`Tranquilload test server listening on ${addr}`)
})
