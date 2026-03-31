import { CompleteUploadError, PartUploadError, PresignedUrlError } from "@tranquilload/core/errors"
import type { CompletedPart } from "@tranquilload/core/multipart"

export const S3_MIN_PART_SIZE = 5 * 1024 * 1024 // 5 MiB

export interface S3Client {
  createMultipartUpload(params: {
    Bucket: string
    Key: string
  }): Promise<{ UploadId?: string }>

  completeMultipartUpload(params: {
    Bucket: string
    Key: string
    UploadId: string
    MultipartUpload: { Parts: ReadonlyArray<{ PartNumber: number; ETag: string }> }
  }): Promise<unknown>
}

export interface S3MultipartUploadOptions {
  bucket: string
  key: string
  chunkSize?: number
  getPresignedUrl: (partNumber: number, uploadId: string) => string | Promise<string>
  s3Client: S3Client
}

export function s3MultipartUpload(options: S3MultipartUploadOptions): {
  chunkSize: number
  initiate: () => Promise<{ uploadId: string }>
  uploadPart: (partNumber: number, chunk: Uint8Array) => Promise<string>
  completeUpload: (uploadId: string, parts: ReadonlyArray<CompletedPart>) => Promise<void>
} {
  const { bucket, key, chunkSize = S3_MIN_PART_SIZE, getPresignedUrl, s3Client } = options

  if (chunkSize < S3_MIN_PART_SIZE) {
    throw new Error(
      `S3 requires chunkSize >= ${S3_MIN_PART_SIZE} bytes (5 MiB), received ${chunkSize} bytes`
    )
  }

  let storedUploadId = ""

  const initiate = async (): Promise<{ uploadId: string }> => {
    const result = await s3Client.createMultipartUpload({ Bucket: bucket, Key: key })
    if (!result.UploadId) throw new Error("S3 CreateMultipartUpload did not return an UploadId")
    storedUploadId = result.UploadId
    return { uploadId: storedUploadId }
  }

  const uploadPart = async (partNumber: number, chunk: Uint8Array): Promise<string> => {
    let url: string
    try {
      url = await Promise.resolve(getPresignedUrl(partNumber, storedUploadId))
    } catch (cause) {
      throw new PresignedUrlError(cause)
    }
    const response = await fetch(url, { method: "PUT", body: chunk as unknown as BodyInit })
    if (!response.ok) {
      throw new PartUploadError(
        partNumber,
        0,
        new Error(`S3 PUT failed: HTTP ${response.status} ${response.statusText}`)
      )
    }
    const rawEtag = response.headers.get("ETag") ?? response.headers.get("etag")
    if (!rawEtag) {
      throw new PartUploadError(partNumber, 0, new Error("S3 response missing ETag header"))
    }
    return rawEtag.replace(/"/g, "")
  }

  const completeUpload = async (
    uploadId: string,
    parts: ReadonlyArray<CompletedPart>
  ): Promise<void> => {
    try {
      await s3Client.completeMultipartUpload({
        Bucket: bucket,
        Key: key,
        UploadId: uploadId,
        MultipartUpload: {
          Parts: parts.map((p) => ({ PartNumber: p.partNumber, ETag: p.etag })),
        },
      })
    } catch (cause) {
      throw new CompleteUploadError(cause)
    }
  }

  return { chunkSize, initiate, uploadPart, completeUpload }
}
