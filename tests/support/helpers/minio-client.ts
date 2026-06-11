import {
  HeadObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
  S3Client,
} from "@aws-sdk/client-s3"

export interface MinioEnv {
  endpoint: string
  region: string
  accessKey: string
  secretKey: string
  bucket: string
}

export function loadMinioEnv(): MinioEnv {
  return {
    endpoint: process.env.MINIO_ENDPOINT ?? "http://localhost:9000",
    region: process.env.MINIO_REGION ?? "us-east-1",
    accessKey: process.env.MINIO_ACCESS_KEY ?? "minioadmin",
    secretKey: process.env.MINIO_SECRET_KEY ?? "minioadmin",
    bucket: process.env.MINIO_BUCKET ?? "tranquilload-test",
  }
}

export function makeMinioClient(env: MinioEnv = loadMinioEnv()): S3Client {
  return new S3Client({
    endpoint: env.endpoint,
    region: env.region,
    credentials: { accessKeyId: env.accessKey, secretAccessKey: env.secretKey },
    forcePathStyle: true,
  })
}

/**
 * Verify the object at `key` matches `expected` byte-for-byte.
 * Used by Story 10.3 (R1 Resume safety) and Story 10.7 (R4 multipart golden).
 */
export async function assertObjectBytesEqual(
  client: S3Client,
  bucket: string,
  key: string,
  expected: Uint8Array,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const head = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }))
  if (head.ContentLength !== expected.byteLength) {
    return {
      ok: false,
      reason: `size mismatch: expected ${expected.byteLength} bytes, got ${head.ContentLength}`,
    }
  }

  const got = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }))
  const body = got.Body
  if (!body) return { ok: false, reason: "empty body returned from GetObject" }

  const actual = await body.transformToByteArray()
  if (actual.byteLength !== expected.byteLength) {
    return { ok: false, reason: `body length mismatch after streaming` }
  }
  for (let i = 0; i < expected.byteLength; i++) {
    if (actual[i] !== expected[i]) {
      return { ok: false, reason: `byte mismatch at offset ${i}` }
    }
  }
  return { ok: true }
}

/**
 * HEAD an object and return its byte length, or `null` if it does not exist.
 * Used by Story 11.5 chaos specs to confirm a retried upload landed in full.
 */
export async function headObjectSize(
  client: S3Client,
  bucket: string,
  key: string,
): Promise<number | null> {
  try {
    const head = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }))
    return head.ContentLength ?? null
  } catch {
    return null
  }
}

/**
 * Find the object under `uploads/` whose key ends with `filename`.
 * Both upload paths place the object at `uploads/<uuid>-<filename>`, so the
 * suffix match is unique per timestamped filename. Throws (with the current
 * listing) when nothing matches — turning a missing object into a readable
 * failure rather than a silent `undefined`.
 */
export async function findUploadedKey(
  client: S3Client,
  bucket: string,
  filename: string,
): Promise<string> {
  const list = await client.send(
    new ListObjectsV2Command({ Bucket: bucket, Prefix: "uploads/" }),
  )
  const match = (list.Contents ?? []).find((o) => o.Key?.endsWith(filename))
  if (!match?.Key) {
    throw new Error(
      `MinIO has no object ending with "${filename}" under uploads/ — got: ${(list.Contents ?? [])
        .map((o) => o.Key)
        .join(", ")}`,
    )
  }
  return match.Key
}

/**
 * Best-effort cleanup of `uploads/` prefix between tests.
 * Tests that need a guaranteed-empty bucket should call this in a `beforeEach`.
 */
export async function purgeUploadsPrefix(
  client: S3Client,
  bucket: string,
  prefix = "uploads/",
): Promise<number> {
  let deleted = 0
  let continuationToken: string | undefined
  do {
    const list = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      }),
    )
    const objects = (list.Contents ?? []).flatMap((o) => (o.Key ? [{ Key: o.Key }] : []))
    if (objects.length > 0) {
      await client.send(
        new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: objects } }),
      )
      deleted += objects.length
    }
    continuationToken = list.NextContinuationToken
  } while (continuationToken)
  return deleted
}
