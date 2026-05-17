import {
  S3Client,
  CreateMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
  ListPartsCommand,
  UploadPartCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3"
import { getSignedUrl } from "@aws-sdk/s3-request-presigner"

export interface S3Env {
  endpoint: string
  publicEndpoint: string
  region: string
  accessKey: string
  secretKey: string
  bucket: string
}

export function loadEnv(): S3Env {
  return {
    endpoint: process.env.S3_ENDPOINT ?? "http://localhost:9000",
    publicEndpoint: process.env.S3_PUBLIC_ENDPOINT ?? "http://localhost:9000",
    region: process.env.S3_REGION ?? "us-east-1",
    accessKey: process.env.S3_ACCESS_KEY ?? "minioadmin",
    secretKey: process.env.S3_SECRET_KEY ?? "minioadmin",
    bucket: process.env.S3_BUCKET ?? "tranquilload-test",
  }
}

// Server-side client: talks to S3_ENDPOINT (e.g. host->container reachable)
export function makeServerClient(env: S3Env): S3Client {
  return new S3Client({
    endpoint: env.endpoint,
    region: env.region,
    credentials: { accessKeyId: env.accessKey, secretAccessKey: env.secretKey },
    forcePathStyle: true, // MinIO requirement
  })
}

// Presigner client: signs URLs with S3_PUBLIC_ENDPOINT so the browser can reach them
export function makePresignerClient(env: S3Env): S3Client {
  return new S3Client({
    endpoint: env.publicEndpoint,
    region: env.region,
    credentials: { accessKeyId: env.accessKey, secretAccessKey: env.secretKey },
    forcePathStyle: true,
  })
}

export async function presignUploadPart(
  client: S3Client,
  bucket: string,
  key: string,
  uploadId: string,
  partNumber: number,
  ttlSeconds = 3600
): Promise<string> {
  const command = new UploadPartCommand({
    Bucket: bucket,
    Key: key,
    UploadId: uploadId,
    PartNumber: partNumber,
  })
  return getSignedUrl(client, command, { expiresIn: ttlSeconds })
}

export {
  CreateMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
  ListPartsCommand,
  PutObjectCommand,
}
