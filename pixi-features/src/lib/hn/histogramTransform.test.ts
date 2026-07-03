import { describe, it, expect } from 'vitest'
import { computeColorDecorrelation, buildGaussianLUT } from './histogramTransform'

function apply3(m: number[], v: [number,number,number]): [number,number,number] {
  return [
    m[0]*v[0]+m[1]*v[1]+m[2]*v[2],
    m[3]*v[0]+m[4]*v[1]+m[5]*v[2],
    m[6]*v[0]+m[7]*v[1]+m[8]*v[2],
  ]
}

describe('color decorrelation', () => {
  it('forward then inverse round-trips a centered pixel', () => {
    // Correlated data: G and R move together.
    const rgb = new Float32Array([0.2,0.3,0.1, 0.6,0.7,0.5, 0.4,0.5,0.3, 0.8,0.9,0.7])
    const { mean, forward, inverse } = computeColorDecorrelation(rgb)
    const p: [number,number,number] = [0.6,0.7,0.5]
    const centered: [number,number,number] = [p[0]-mean[0], p[1]-mean[1], p[2]-mean[2]]
    const dec = apply3(forward, centered)
    const back = apply3(inverse, dec)
    expect(back[0]).toBeCloseTo(centered[0], 5)
    expect(back[1]).toBeCloseTo(centered[1], 5)
    expect(back[2]).toBeCloseTo(centered[2], 5)
  })
})

describe('gaussian LUT', () => {
  it('T then Tinv restores the input histogram (round-trip within a bucket)', () => {
    const n = 4096
    const ch = new Float32Array(n)
    for (let i = 0; i < n; i++) ch[i] = Math.pow(Math.random(), 2) // skewed, heavy-tailed
    const { T, Tinv } = buildGaussianLUT(ch, 256)
    // Sample a mid value, gaussianize, invert -> should land near original.
    const x = 0.36
    const g = T[Math.round(x * 255)]                       // forward to gaussian 0..1
    const restored = Tinv[Math.max(0, Math.min(255, Math.round(g * 255)))]
    expect(restored).toBeGreaterThan(0.0)
    expect(restored).toBeLessThan(1.0)
    expect(Math.abs(restored - x)).toBeLessThan(0.06)      // within ~1 bucket of round-trip
  })

  it('T output is centered near 0.5 (gaussian target mean)', () => {
    const n = 4096
    const ch = new Float32Array(n)
    for (let i = 0; i < n; i++) ch[i] = Math.random()
    const { T } = buildGaussianLUT(ch, 256)
    const mid = T[128]
    expect(mid).toBeGreaterThan(0.4)
    expect(mid).toBeLessThan(0.6)
  })
})
