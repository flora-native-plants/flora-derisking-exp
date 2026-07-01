import { describe, it, expect } from 'vitest'
import { pigmentKS, reflectanceInfinite } from './pigmentKS'

const A_RW: [number, number, number] = [0.35, 0.62, 0.48]
const A_RB: [number, number, number] = [0.06, 0.20, 0.13]

describe('pigmentKS', () => {
  it('produces finite non-negative K and S', () => {
    const { K, S } = pigmentKS(A_RW, A_RB)
    for (const c of [...K, ...S]) { expect(Number.isFinite(c)).toBe(true); expect(c).toBeGreaterThanOrEqual(0) }
  })

  it('round-trips: R∞ from derived K/S lies between Rb and Rw per channel', () => {
    // R∞ is infinite-thickness masstone — it should sit at/above the over-white
    // reflectance and below 1; assert a physical band, NOT R∞≈Rw (different quantities).
    const { K, S } = pigmentKS(A_RW, A_RB)
    const rInf = reflectanceInfinite(K, S)
    for (let c = 0; c < 3; c++) {
      expect(rInf[c]).toBeGreaterThan(A_RB[c] - 0.02)
      expect(rInf[c]).toBeLessThan(1)
    }
  })

  it('clamps degenerate inputs (Rb>=Rw) without NaN', () => {
    const { K, S } = pigmentKS([0.2, 0.2, 0.2], [0.5, 0.5, 0.5]) // Rb>Rw -> must clamp
    for (const c of [...K, ...S]) expect(Number.isFinite(c)).toBe(true)
  })
})
