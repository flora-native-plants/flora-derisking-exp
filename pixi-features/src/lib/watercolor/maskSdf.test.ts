import { describe, it, expect } from 'vitest'
import { computeMaskSdf } from './maskSdf'

/** Build a size×size mask with a centered filled square of side `sq`. */
function squareMask(size: number, sq: number): Float32Array {
  const m = new Float32Array(size * size)
  const lo = (size - sq) / 2, hi = lo + sq
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++)
      if (x >= lo && x < hi && y >= lo && y < hi) m[y * size + x] = 1
  return m
}

describe('computeMaskSdf', () => {
  it('is negative at the center and positive far outside', () => {
    const size = 64, sdf = computeMaskSdf(squareMask(size, 20), size)
    const center = sdf[(size / 2) * size + size / 2]
    const corner = sdf[0]
    expect(center).toBeLessThan(0)
    expect(corner).toBeGreaterThan(0)
  })

  it('center distance approximates half the square side', () => {
    const size = 64, sq = 20, sdf = computeMaskSdf(squareMask(size, sq), size)
    const center = sdf[(size / 2) * size + size / 2]
    // center is ~sq/2 from the nearest edge; chamfer approx within 1.5px
    expect(Math.abs(Math.abs(center) - sq / 2)).toBeLessThan(1.5)
  })

  it('is ~0 within a pixel of the boundary', () => {
    const size = 64, sq = 20, sdf = computeMaskSdf(squareMask(size, sq), size)
    const lo = (size - sq) / 2
    const onEdge = sdf[(size / 2) * size + lo] // just inside left edge
    expect(Math.abs(onEdge)).toBeLessThan(1.5)
  })
})
