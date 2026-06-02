import { readFileSync } from "node:fs"
import { beforeAll, describe, expect, it } from "vitest"

import {
  buildWrappedSource,
  compileBlock,
  ensureBucket,
  isMinioReachable,
  README_PATH,
  requireEnv,
  type WrapSpec,
} from "./doctest-harness.js"
import {
  extractReadmeBlocks,
  findBlock,
  type ReadmeBlock,
} from "./extract-readme-blocks.js"
import { uploadMultipart, type ResumeState } from "@tranquilload/core/multipart"

/**
 * Story 11.7 — 11.7-D-001 (G#25) — README resume example.
 *
 * Two legs, two distinct guarantees:
 *   1. COMPILE — the "Resuming an upload after a refresh" README block type-checks
 *      against the published `.d.mts` (always runs — needs only tsc).
 *   2. END-TO-END resume against MinIO (skipped when MinIO is unreachable —
 *      start it with `pnpm minio:up`).
 *
 * Honest scope (Pattern 3): the README block CANNOT be run literally — its
 * session 1 does `await result; localStorage.removeItem(...)`, which finalizes
 * the multipart upload, so its session 2 "resume" would target a completed
 * upload (ListParts fails, nothing to resume). The block is illustrative. To
 * prove G#25 ("the lib completes a resume against MinIO") we therefore drive a
 * PROGRAMMATIC two-session crash-resume with a real S3 presigner (reusing the
 * 10.6-D-002 wiring): session 1 uploads part 1 then stops BEFORE complete
 * (simulating a refresh/crash); session 2 calls `uploadMultipart` with
 * `resumeFrom` + `reconcileCompletedParts` returning part 1, so the lib uploads
 * ONLY part 2 and completes. We then HEAD/GET the object to prove full assembly.
 *
 * MinIO is OPTIONAL in CI: when the health check fails the test logs a clear
 * skip reason and passes the compile-only portion, UNLESS `MINIO_REQUIRED=1`.
 */

const minioClientConfig = () =>
  ({
    endpoint: process.env.MINIO_ENDPOINT ?? "http://localhost:9000",
    region: process.env.MINIO_REGION ?? "us-east-1",
    credentials: {
      accessKeyId: process.env.MINIO_ACCESS_KEY ?? "minioadmin",
      secretAccessKey: process.env.MINIO_SECRET_KEY ?? "minioadmin",
    },
    forcePathStyle: true,
  }) as const

let fixtureDir: string
let blocks: ReadonlyArray<ReadmeBlock>

const RESUME_SPEC: WrapSpec = {
  id: "d001-resume",
  // The README block assumes `uploadMultipart` (and the `s3` adapter object) are
  // already in scope from the earlier multipart example. Inject the imports the
  // block relies on so it type-checks standalone.
  prelude: [
    `import { uploadMultipart } from "@tranquilload/core/multipart"`,
    `import { s3MultipartUpload } from "@tranquilload/adapters/s3MultipartUpload"`,
    ``,
  ].join("\n"),
  // The block uses free vars: stream, totalBytes, s3 (spread), file, localStorage.
  // `...s3` injects chunkSize + initiate + uploadPart + completeUpload (the
  // s3MultipartUpload adapter return type).
  paramSignature:
    "{ stream, totalBytes, s3, file, localStorage }: { " +
    "stream: ReadableStream<Uint8Array>; " +
    "totalBytes: number; " +
    "s3: ReturnType<typeof s3MultipartUpload>; " +
    "file: { name: string; size: number; lastModified: number }; " +
    "localStorage: { setItem(k: string, v: string): void; getItem(k: string): string | null; removeItem(k: string): void } " +
    "}",
  executable: true,
}

describe("Story 11.7 — README resume doctest (G#25)", () => {
  beforeAll(() => {
    fixtureDir = requireEnv("DIST_FIXTURE_DIR")
    blocks = extractReadmeBlocks(readFileSync(README_PATH, "utf8"))
  })

  it("11.7-D-001 (G#25) — resume example compiles against published .d.mts", () => {
    const block = findBlock(
      blocks,
      (b) => b.lang === "ts" && b.heading.startsWith("Resuming an upload"),
      "Resuming an upload after a refresh",
    )
    const source = buildWrappedSource(block, RESUME_SPEC)
    // Compile-only proof: emit not required to validate types.
    compileBlock(fixtureDir, RESUME_SPEC, source, { emit: false }, block)
  })

  it(
    "11.7-D-001 (G#25) — programmatic two-session crash-resume completes against MinIO",
    async () => {
      const reachable = await isMinioReachable()
      if (!reachable) {
        if (process.env.MINIO_REQUIRED === "1") {
          throw new Error(
            `MINIO_REQUIRED=1 but MinIO at ${process.env.MINIO_ENDPOINT ?? "http://localhost:9000"} is unreachable.`,
          )
        }
        console.warn(
          "[11.7-D-001] MinIO not reachable — SKIPPING end-to-end resume run. " +
            "Start it with `pnpm minio:up` (sudo on this host) to enable.",
        )
        return
      }

      const aws = await import("@aws-sdk/client-s3")
      const { getSignedUrl } = await import("@aws-sdk/s3-request-presigner")
      const client = new aws.S3Client(minioClientConfig())
      const bucket = "my-bucket"
      await ensureBucket(client, bucket)

      const key = `resume/doctest-d001-${Date.now()}.bin`
      const PART = 5 * 1024 * 1024 // S3 multipart minimum for a non-final part
      const tail = 1 * 1024 * 1024
      const payload = new Uint8Array(PART + tail)
      for (let i = 0; i < payload.length; i++) payload[i] = i & 0xff

      const sign = (uploadId: string, partNumber: number): Promise<string> =>
        getSignedUrl(
          client,
          new aws.UploadPartCommand({
            Bucket: bucket,
            Key: key,
            UploadId: uploadId,
            PartNumber: partNumber,
          }),
          { expiresIn: 600 },
        )

      const putPart = async (
        uploadId: string,
        partNumber: number,
        chunk: Uint8Array,
      ): Promise<string> => {
        const url = await sign(uploadId, partNumber)
        const res = await fetch(url, {
          method: "PUT",
          body: chunk as unknown as BodyInit,
        })
        if (!res.ok) throw new Error(`PUT part ${partNumber} failed: HTTP ${res.status}`)
        return res.headers.get("ETag")!.replace(/"/g, "")
      }

      // --- Session 1: init + upload ONLY part 1, then "crash" (no complete) ---
      const created = await client.send(
        new aws.CreateMultipartUploadCommand({ Bucket: bucket, Key: key }),
      )
      const uploadId = created.UploadId!
      const etag1 = await putPart(uploadId, 1, payload.slice(0, PART))
      const persisted: ResumeState = {
        version: 1,
        uploadId,
        chunkSize: PART,
        contentDigestCaptured: false,
      }

      // --- Session 2: resume — reconcile returns part 1, lib uploads ONLY part 2 ---
      const uploadedThisSession: number[] = []
      const source = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(payload)
          c.close()
        },
      })
      const { result, uploadId: resumedId } = uploadMultipart({
        stream: source,
        chunkSize: PART,
        uploadPart: (partNumber, chunk) => {
          uploadedThisSession.push(partNumber)
          return putPart(uploadId, partNumber, chunk)
        },
        completeUpload: async (uid, parts) => {
          const sorted = [...parts].sort((a, b) => a.partNumber - b.partNumber)
          await client.send(
            new aws.CompleteMultipartUploadCommand({
              Bucket: bucket,
              Key: key,
              UploadId: uid,
              MultipartUpload: {
                Parts: sorted.map((p) => ({ PartNumber: p.partNumber, ETag: p.etag })),
              },
            }),
          )
        },
        reconcileCompletedParts: () => [{ partNumber: 1, etag: etag1 }],
        resumeFrom: persisted,
      })

      // uploadId is resolved synchronously from resumeFrom on the resume branch.
      expect(await resumedId).toBe(uploadId)
      await result

      // Resume contract: part 1 was NOT re-uploaded; only part 2 was PUT here.
      expect(uploadedThisSession).toEqual([2])

      // Object fully assembled: full size + correct boundary bytes.
      const head = await client.send(
        new aws.HeadObjectCommand({ Bucket: bucket, Key: key }),
      )
      expect(head.ContentLength).toBe(payload.length)
      const got = await client.send(
        new aws.GetObjectCommand({ Bucket: bucket, Key: key }),
      )
      const bytes = await got.Body!.transformToByteArray()
      expect(bytes.length).toBe(payload.length)
      expect(bytes[0]).toBe(payload[0])
      expect(bytes[PART]).toBe(payload[PART]) // first byte of the resumed part 2
      expect(bytes[bytes.length - 1]).toBe(payload[payload.length - 1])

      await client
        .send(new aws.DeleteObjectCommand({ Bucket: bucket, Key: key }))
        .catch(() => undefined)
    },
    120_000,
  )
})
