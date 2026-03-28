import { describe, it, expect } from 'vitest'
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
})
