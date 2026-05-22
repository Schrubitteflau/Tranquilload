import { describe, it, expect } from 'vitest'
import { networkMultiplier } from './network-multiplier.js'

describe('networkMultiplier', () => {
  it('returns 1.0 when no samples have been recorded', () => {
    const m = networkMultiplier()
    expect(m.factor()).toBe(1.0)
  })

  it('returns 1.0 when throughput >= target', () => {
    const target = 10_000 // bytes/ms
    const m = networkMultiplier({ targetBytesPerMs: target })
    // Record sample at exactly target speed
    m.record(10_000, 1)
    expect(m.factor()).toBe(1.0)
    // Record sample faster than target
    m.record(20_000, 1)
    expect(m.factor()).toBe(1.0)
  })

  it('returns 0.1 when throughput is 10% of target', () => {
    const target = 10_000
    const m = networkMultiplier({ targetBytesPerMs: target })
    m.record(1_000, 1) // 1000 bytes/ms = 10% of target
    expect(m.factor()).toBeCloseTo(0.1, 5)
  })

  it('clamps below 0.1 when throughput is very low', () => {
    const target = 10_000
    const m = networkMultiplier({ targetBytesPerMs: target })
    m.record(100, 1) // 1% of target
    expect(m.factor()).toBe(0.1)
  })

  it('rolling window evicts oldest sample', () => {
    const target = 10_000
    const m = networkMultiplier({ windowSize: 3, targetBytesPerMs: target })
    // Fill window with slow samples (1000 bytes/ms = 0.1 factor)
    m.record(1_000, 1)
    m.record(1_000, 1)
    m.record(1_000, 1)
    expect(m.factor()).toBeCloseTo(0.1, 5)
    // Now push 3 fast samples to evict all slow ones
    m.record(10_000, 1)
    m.record(10_000, 1)
    m.record(10_000, 1)
    expect(m.factor()).toBe(1.0)
  })

  it('skips sample when durationMs <= 0', () => {
    const m = networkMultiplier()
    m.record(1_000, 0)
    m.record(1_000, -5)
    // No valid samples → factor stays 1.0
    expect(m.factor()).toBe(1.0)
  })

  // --- 11.6-INT-016 (F#46) — brand-new instance, zero samples ----------------
  // Control-side lock for the no-samples path: a freshly-constructed multiplier
  // returns the documented `1.0` factor (no penalty), independently of any
  // option overrides. Locks the documented contract that the no-samples branch
  // is *deterministic* and not subject to drift from option changes.
  it('11.6-INT-016 (F#46) — brand-new networkMultiplier with no samples returns factor 1.0 (control)', () => {
    const defaultInstance = networkMultiplier()
    expect(defaultInstance.factor()).toBe(1.0)

    // Option override does not change the no-samples branch.
    const customInstance = networkMultiplier({
      windowSize: 10,
      targetBytesPerMs: 1,
    })
    expect(customInstance.factor()).toBe(1.0)
  })

  // --- 11.6-INT-017 (F#47) — saturated-slow samples clamp at 0.1 floor -------
  // 10 consecutive ultra-slow samples (1% of target) — well past the window
  // size (default 5) — must clamp to the documented floor of 0.1. The window
  // never lets the factor drop below the floor regardless of how slow samples
  // get, and the floor remains stable as more samples saturate it. Note the
  // documented caveat: 0.1 is BELOW S3's 5MiB minimum, so the *caller* must
  // clamp the chunkSize result; the multiplier itself only enforces 0.1.
  it('11.6-INT-017 (F#47) — 10 saturated-slow samples clamp at 0.1 floor', () => {
    const target = 10_000
    const m = networkMultiplier({ targetBytesPerMs: target })

    // 10 ultra-slow samples (1% of target) — far past the window size.
    for (let i = 0; i < 10; i++) {
      m.record(100, 1) // 100 bytes/ms = 1% of target
    }

    expect(m.factor()).toBe(0.1)
  })
})
