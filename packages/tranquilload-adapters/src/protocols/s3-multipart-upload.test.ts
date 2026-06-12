import { afterEach, describe, expect, it, vi } from "vitest"
import { CompleteUploadError, PresignedUrlError } from "@tranquilload/core/errors"
import { s3MultipartUpload, S3_MIN_PART_SIZE } from "./s3-multipart-upload.js"

const makeMockS3Client = (overrides = {}) => ({
  createMultipartUpload: vi.fn().mockResolvedValue({ UploadId: "upload-123" }),
  completeMultipartUpload: vi.fn().mockResolvedValue({}),
  ...overrides,
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("s3MultipartUpload", () => {
  it("F#45 — throws synchronously when chunkSize < 5 MiB (s3MultipartUpload guard)", () => {
    expect(() =>
      s3MultipartUpload({
        bucket: "b",
        key: "k",
        chunkSize: 1024,
        getPresignedUrl: vi.fn(),
        s3Client: makeMockS3Client(),
      })
    ).toThrow("S3 requires chunkSize >= 5242880 bytes (5 MiB)")
  })

  it("initiate calls createMultipartUpload with bucket and key", async () => {
    const s3Client = makeMockS3Client()
    const adapter = s3MultipartUpload({
      bucket: "my-bucket",
      key: "my-key",
      getPresignedUrl: vi.fn(),
      s3Client,
    })
    const result = await adapter.initiate()
    expect(s3Client.createMultipartUpload).toHaveBeenCalledWith({
      Bucket: "my-bucket",
      Key: "my-key",
    })
    expect(result).toEqual({ uploadId: "upload-123" })
  })

  it("uploadPart calls getPresignedUrl with partNumber and uploadId then PUTs chunk", async () => {
    const getPresignedUrl = vi.fn().mockResolvedValue("https://s3.example.com/presigned")
    const s3Client = makeMockS3Client()
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ ETag: '"etag-abc"' }),
    })
    vi.stubGlobal("fetch", fetchMock)

    const adapter = s3MultipartUpload({ bucket: "b", key: "k", getPresignedUrl, s3Client })
    await adapter.initiate()
    const etag = await adapter.uploadPart(1, new Uint8Array([1, 2, 3]))

    expect(getPresignedUrl).toHaveBeenCalledWith(1, "upload-123")
    expect(fetchMock).toHaveBeenCalledWith("https://s3.example.com/presigned", {
      method: "PUT",
      body: expect.any(Uint8Array),
    })
    expect(etag).toBe("etag-abc")
  })

  // Story 13.2 (DD2) — cross-session resume: `uploadPart` must sign against the
  // caller-supplied `resumeUploadId` when `initiate` is NOT called this session,
  // instead of the empty `storedUploadId` closure. Net-new (no prior lock).
  it("13.2 — resumeUploadId seeds uploadPart signing without calling initiate", async () => {
    const getPresignedUrl = vi.fn().mockResolvedValue("https://s3.example.com/presigned")
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, headers: new Headers({ ETag: '"etag-r"' }) })
    )

    const adapter = s3MultipartUpload({
      bucket: "b",
      key: "k",
      getPresignedUrl,
      s3Client: makeMockS3Client(),
      resumeUploadId: "resumed-upload-id",
    })

    // No initiate() call — straight to uploadPart, as on a cross-session resume.
    const etag = await adapter.uploadPart(2, new Uint8Array([9]))

    expect(getPresignedUrl).toHaveBeenCalledWith(2, "resumed-upload-id")
    expect(etag).toBe("etag-r")
  })

  it("13.2 — default (no resumeUploadId): uploadPart pre-initiate signs against empty uploadId (non-breaking baseline)", async () => {
    const getPresignedUrl = vi.fn().mockResolvedValue("https://s3.example.com/presigned")
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, headers: new Headers({ ETag: '"etag-d"' }) })
    )

    const adapter = s3MultipartUpload({
      bucket: "b",
      key: "k",
      getPresignedUrl,
      s3Client: makeMockS3Client(),
    })

    // Without resumeUploadId and without initiate(), storedUploadId is "".
    await adapter.uploadPart(1, new Uint8Array([1]))

    expect(getPresignedUrl).toHaveBeenCalledWith(1, "")
  })

  it("uploadPart returns ETag stripped of quotes", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        headers: new Headers({ ETag: '"quoted-etag"' }),
      })
    )
    const adapter = s3MultipartUpload({
      bucket: "b",
      key: "k",
      getPresignedUrl: vi.fn().mockResolvedValue("https://s3.example.com/presigned"),
      s3Client: makeMockS3Client(),
    })
    await adapter.initiate()
    const etag = await adapter.uploadPart(1, new Uint8Array())
    expect(etag).toBe("quoted-etag")
  })

  it("uploadPart rejects with PresignedUrlError when getPresignedUrl rejects", async () => {
    const getPresignedUrl = vi.fn().mockRejectedValue(new Error("no URL"))
    const adapter = s3MultipartUpload({
      bucket: "b",
      key: "k",
      getPresignedUrl,
      s3Client: makeMockS3Client(),
    })
    await adapter.initiate()
    await expect(adapter.uploadPart(1, new Uint8Array())).rejects.toBeInstanceOf(PresignedUrlError)
  })

  it("completeUpload calls s3Client.completeMultipartUpload with correct structure", async () => {
    const s3Client = makeMockS3Client()
    const adapter = s3MultipartUpload({
      bucket: "b",
      key: "k",
      getPresignedUrl: vi.fn(),
      s3Client,
    })
    await adapter.completeUpload("upload-123", [{ partNumber: 1, etag: "etag-1" }])
    expect(s3Client.completeMultipartUpload).toHaveBeenCalledWith({
      Bucket: "b",
      Key: "k",
      UploadId: "upload-123",
      MultipartUpload: { Parts: [{ PartNumber: 1, ETag: "etag-1" }] },
    })
  })

  it("completeUpload sorts parts by partNumber before calling completeMultipartUpload (S3 requires ascending order)", async () => {
    const s3Client = makeMockS3Client()
    const adapter = s3MultipartUpload({
      bucket: "b",
      key: "k",
      getPresignedUrl: vi.fn(),
      s3Client,
    })
    // Parts arrive out of order — concurrent uploads complete in arbitrary order.
    await adapter.completeUpload("upload-123", [
      { partNumber: 3, etag: "etag-3" },
      { partNumber: 1, etag: "etag-1" },
      { partNumber: 2, etag: "etag-2" },
    ])
    expect(s3Client.completeMultipartUpload).toHaveBeenCalledWith({
      Bucket: "b",
      Key: "k",
      UploadId: "upload-123",
      MultipartUpload: {
        Parts: [
          { PartNumber: 1, ETag: "etag-1" },
          { PartNumber: 2, ETag: "etag-2" },
          { PartNumber: 3, ETag: "etag-3" },
        ],
      },
    })
  })

  it("completeUpload rejects with CompleteUploadError when s3Client fails", async () => {
    const s3Client = makeMockS3Client({
      completeMultipartUpload: vi.fn().mockRejectedValue(new Error("S3 error")),
    })
    const adapter = s3MultipartUpload({
      bucket: "b",
      key: "k",
      getPresignedUrl: vi.fn(),
      s3Client,
    })
    await expect(
      adapter.completeUpload("upload-123", [{ partNumber: 1, etag: "etag-1" }])
    ).rejects.toBeInstanceOf(CompleteUploadError)
  })
})
