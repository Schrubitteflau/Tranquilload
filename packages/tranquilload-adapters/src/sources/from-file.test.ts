import { describe, it, expect } from 'vitest'
import { fromFile } from './from-file.js'

describe('fromFile', () => {
  it('returns totalBytes equal to file.size', () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5])
    const file = new File([bytes], 'test.bin', { type: 'application/octet-stream' })

    const result = fromFile(file)

    expect(result.totalBytes).toBe(5)
  })

  it('stream yields all file bytes', async () => {
    const bytes = new Uint8Array([10, 20, 30, 40])
    const file = new File([bytes], 'test.bin')

    const { stream } = fromFile(file)

    const reader = stream.getReader()
    const chunks: Uint8Array[] = []
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
    }

    const all = new Uint8Array(chunks.reduce((acc, c) => acc + c.length, 0))
    let offset = 0
    for (const chunk of chunks) {
      all.set(chunk, offset)
      offset += chunk.length
    }

    expect(Array.from(all)).toEqual([10, 20, 30, 40])
  })
})
