import { afterEach, describe, expect, it, vi } from "vitest"
import { InitiateUploadError } from "@tranquilload/core/errors"
import { s3MultipartUpload } from "./s3-multipart-upload.js"

/**
 * Story 11.7 — filename edges for `s3MultipartUpload` (VT harness).
 *
 *   - 11.7-INT-001 (G#17): special-character keys — the raw key reaches
 *     `createMultipartUpload` unchanged, and when the presigner URL-encodes the
 *     key into the PUT URL, a round-trip decode resolves the SAME name.
 *   - 11.7-INT-002 (G#19): a >1024-char key (S3's documented key limit).
 *
 * S3 (MinIO) is mocked — these are unit-level assertions about the key path,
 * no real server needed.
 */

const makeMockS3Client = (overrides = {}) => ({
  createMultipartUpload: vi.fn().mockResolvedValue({ UploadId: "upload-123" }),
  completeMultipartUpload: vi.fn().mockResolvedValue({}),
  ...overrides,
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const SPECIAL_CHAR_KEYS = [
  "file#hash.bin",
  "file?query.bin",
  "file%percent.bin",
  "file+plus.bin",
  "file space.bin",
  "café.bin",
  "🚀rocket.bin",
  "نص عربي.bin",
] as const

describe("11.7-INT-001 (G#17) — special-character filenames", () => {
  for (const key of SPECIAL_CHAR_KEYS) {
    it(`11.7-INT-001 (G#17) — "${key}" round-trips through the presigned PUT URL`, async () => {
      const s3Client = makeMockS3Client()

      // Realistic presigner: encodes the key into a path-style URL exactly the
      // way the AWS presigner does (encodeURIComponent per path segment is the
      // S3 object-key encoding rule; "+" and space must both survive).
      const getPresignedUrl = (partNumber: number, uploadId: string): string =>
        `https://s3.example.com/my-bucket/${encodeURIComponent(key)}` +
        `?uploadId=${uploadId}&partNumber=${partNumber}`

      let putUrl = ""
      const fetchMock = vi.fn(async (url: string) => {
        putUrl = url
        return {
          ok: true,
          headers: new Headers({ ETag: '"etag-abc"' }),
        } as unknown as Response
      })
      vi.stubGlobal("fetch", fetchMock)

      const adapter = s3MultipartUpload({
        bucket: "my-bucket",
        key,
        getPresignedUrl,
        s3Client,
      })

      await adapter.initiate()
      // The RAW (unencoded) key must reach S3 CreateMultipartUpload — the SDK
      // encodes on the wire; the adapter must not double-encode.
      expect(s3Client.createMultipartUpload).toHaveBeenCalledWith({
        Bucket: "my-bucket",
        Key: key,
      })

      await adapter.uploadPart(1, new Uint8Array([1, 2, 3]))

      // The PUT went to the ENCODED URL.
      expect(putUrl).toContain(encodeURIComponent(key))

      // Round-trip: decoding the path segment yields the ORIGINAL key exactly.
      const pathname = new URL(putUrl).pathname
      const lastSegment = pathname.slice(pathname.lastIndexOf("/") + 1)
      expect(decodeURIComponent(lastSegment)).toBe(key)
    })
  }

  it("11.7-INT-001 (G#17) — reserved chars are percent-encoded, not passed raw, in the PUT URL", () => {
    // Spot-check the encoding contract the round-trip relies on: characters that
    // are URL-significant must be escaped so they can't break the request line.
    expect(encodeURIComponent("file#hash.bin")).toBe("file%23hash.bin")
    expect(encodeURIComponent("file?query.bin")).toBe("file%3Fquery.bin")
    expect(encodeURIComponent("file%percent.bin")).toBe("file%25percent.bin")
    expect(encodeURIComponent("file space.bin")).toBe("file%20space.bin")
    // "+" must be escaped (raw "+" decodes to space in query context).
    expect(encodeURIComponent("file+plus.bin")).toBe("file%2Bplus.bin")
  })
})

describe("11.7-INT-002 (G#19) — filename exceeding the S3 1024-byte key limit", () => {
  it(
    "11.7-INT-002 (G#19) — >1024-byte key rejected pre-flight with InitiateUploadError, no createMultipartUpload call",
    async () => {
      // Epic 13 (Story 13.1): the adapter pre-validates the S3 key length (S3's
      // documented 1024-byte limit) at construction and throws
      // `InitiateUploadError` BEFORE any request. `createMultipartUpload` is
      // never reached.
      const longKey = "a".repeat(1025)
      const s3Client = makeMockS3Client()

      expect(() =>
        s3MultipartUpload({
          bucket: "my-bucket",
          key: longKey,
          getPresignedUrl: vi.fn(),
          s3Client,
        }),
      ).toThrow(InitiateUploadError)

      // Guard fired pre-flight — the SDK was never called.
      expect(s3Client.createMultipartUpload).not.toHaveBeenCalled()
    },
  )

  it(
    "11.7-INT-002 (G#19) — boundary: a 1024-byte key passes the guard and forwards to createMultipartUpload",
    async () => {
      // Exactly at the limit (1024 bytes) is allowed; only >1024 is rejected.
      const boundaryKey = "a".repeat(1024)
      const s3Client = makeMockS3Client()

      const adapter = s3MultipartUpload({
        bucket: "my-bucket",
        key: boundaryKey,
        getPresignedUrl: vi.fn(),
        s3Client,
      })

      await adapter.initiate()
      expect(s3Client.createMultipartUpload).toHaveBeenCalledWith({
        Bucket: "my-bucket",
        Key: boundaryKey,
      })
    },
  )
})
