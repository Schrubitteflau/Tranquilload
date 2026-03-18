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
})
