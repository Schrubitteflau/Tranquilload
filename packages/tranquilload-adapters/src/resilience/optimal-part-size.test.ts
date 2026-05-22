import { describe, it, expect } from 'vitest'
import { uploadMultipart } from '@tranquilload/core/multipart'
import { computeOptimalPartSize } from './optimal-part-size.js'

const MB = 1024 * 1024

describe('computeOptimalPartSize', () => {
  it('returns minPartSize when totalBytes is undefined', () => {
    expect(
      computeOptimalPartSize({
        totalBytes: undefined,
        targetPartCount: 10,
        minPartSize: 5 * MB,
      })
    ).toBe(5 * MB)
  })

  it('returns optimal size when raw > minPartSize (AC1: 100MB / 10 = 10MB > 5MB)', () => {
    expect(
      computeOptimalPartSize({
        totalBytes: 100 * MB,
        targetPartCount: 10,
        minPartSize: 5 * MB,
      })
    ).toBe(10 * MB)
  })

  it('returns minPartSize when file is too small (AC2: totalBytes/targetPartCount < minPartSize)', () => {
    expect(
      computeOptimalPartSize({
        totalBytes: 8 * MB,
        targetPartCount: 10,
        minPartSize: 5 * MB,
      })
    ).toBe(5 * MB)
  })

  it('clamps to maxPartSize when raw part size exceeds max', () => {
    expect(
      computeOptimalPartSize({
        totalBytes: 100 * MB,
        targetPartCount: 2,
        minPartSize: 5 * MB,
        maxPartSize: 20 * MB,
      })
    ).toBe(20 * MB)
  })

  it('returns exact value when totalBytes / targetPartCount === minPartSize', () => {
    expect(
      computeOptimalPartSize({
        totalBytes: 50 * MB,
        targetPartCount: 10,
        minPartSize: 5 * MB,
      })
    ).toBe(5 * MB)
  })

  // --- 11.6-INT-018 (F#50) — round-trip through uploadMultipart --------------
  // Locks the *integration* contract: the chunkSize computed by
  // computeOptimalPartSize, when threaded into uploadMultipart, produces PUT
  // bodies of exactly that size for all but the last (which may be smaller
  // when totalBytes is not a multiple of the computed chunkSize).
  //
  // Scale-down rationale: the brainstorming variant uses 100MB/10 = 10MB. Unit
  // tests use scaled-equivalent values (1000/10 = 100 bytes; ratios preserved)
  // to avoid CI-noisy buffer allocations while keeping the math identical.
  it('11.6-INT-018 (F#50) — computeOptimalPartSize chunkSize round-trips into actual PUT body sizes', async () => {
    const totalBytes = 1000 // scaled equivalent of 100MB
    const minPartSize = 50 // scaled equivalent of 5MB
    const targetPartCount = 10

    const chunkSize = computeOptimalPartSize({
      totalBytes,
      targetPartCount,
      minPartSize,
    })
    expect(chunkSize).toBe(100) // 1000 / 10 = 100 (above min)

    // Feed the computed chunkSize into uploadMultipart and capture PUT bodies.
    const seenBodies: number[] = []
    const sourceBytes = new Uint8Array(totalBytes).map((_, i) => i % 251)

    const { result } = uploadMultipart({
      stream: new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(sourceBytes)
          c.close()
        },
      }),
      chunkSize,
      uploadPart: (_partNumber, chunk) => {
        seenBodies.push(chunk.length)
        return `etag-${seenBodies.length}`
      },
      completeUpload: () => {},
    })

    const res = await result
    expect(res._tag).toBe('UploadCompleted')

    // Exactly targetPartCount PUTs, each of size === computed chunkSize. Since
    // totalBytes is a clean multiple of chunkSize, no last-part remainder.
    expect(seenBodies).toHaveLength(targetPartCount)
    for (const sz of seenBodies) expect(sz).toBe(chunkSize)
  })

  // Companion lock for the "last part may be smaller" branch — when totalBytes
  // is NOT a clean multiple of chunkSize, the last PUT body carries only the
  // remainder. Same round-trip contract; different remainder shape.
  it('11.6-INT-018 (F#50, remainder) — last PUT body is the remainder when totalBytes % chunkSize !== 0', async () => {
    const totalBytes = 1037 // 1000 + 37 remainder
    const chunkSize = computeOptimalPartSize({
      totalBytes,
      targetPartCount: 10,
      minPartSize: 50,
    })
    expect(chunkSize).toBe(104) // ceil(1037 / 10)

    const seenBodies: number[] = []
    const sourceBytes = new Uint8Array(totalBytes).map((_, i) => i % 251)

    const { result } = uploadMultipart({
      stream: new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(sourceBytes)
          c.close()
        },
      }),
      chunkSize,
      uploadPart: (_partNumber, chunk) => {
        seenBodies.push(chunk.length)
        return `etag-${seenBodies.length}`
      },
      completeUpload: () => {},
    })

    await result

    // First N-1 PUTs at chunkSize, last PUT is the remainder.
    const sumAll = seenBodies.reduce((s, x) => s + x, 0)
    expect(sumAll).toBe(totalBytes)
    for (let i = 0; i < seenBodies.length - 1; i++) {
      expect(seenBodies[i]).toBe(chunkSize)
    }
    expect(seenBodies[seenBodies.length - 1]).toBeLessThanOrEqual(chunkSize)
  })
})
