/**
 * Baked mini-inkwash — a non-interactive port of the ideas in johnowhitaker/inkwash
 * (GPU fluid sim) run ONCE per variant on the CPU. No real-time loop: seed pigment
 * + wetness fields, run a few wet-gated diffusion/bleed iterations (organic wet-on-
 * wet spread), then display with:
 *   • Beer–Lambert   color = paper · exp(−density · strength)   (layers deepen, no mud)
 *   • edge-darkening  absorption ·= 1 + k·|∇density|            (dried-rim pigment)
 *   • granulation     density mottled by noise where pigment exists
 *   • paper fbm       cream sheet with fibre/tooth
 * Clipped to the (fixed) silhouette; contour is drawn by the caller.
 *
 * Pure: polys + seed + params in, an HTMLCanvasElement out — ports to flora-studio.
 * The same pigment/wetness fields are what a future INTERACTIVE brush would write to.
 */
import { seededNoise2D, fbm2d, type NoiseFn } from './perlinNoise'
import type { Vec2 } from './silhouette'

export interface InkwashParams {
  foliage: string      // hex — foliage pigment
  accent: string       // hex — bloom pigment
  drops: number        // foliage pigment splats (2..14) — arrangement varies per seed
  wetness: number      // 0..1 — initial water (more = more spread/bleed)
  bleed: number        // 0..1 — diffusion rate per iteration
  iterations: number   // sim steps (8..24)
  edgeDarken: number   // 0..2 — gradient-based dried-rim strength
  granulation: number  // 0..1 — pigment settling mottle
  strength: number     // Beer–Lambert ink strength (density → opacity)
  bloomStrength: number// 0..1
  bloomSize: number    // fraction of plant radius
  paperFibre: number   // 0..1 — paper tooth amount
}

const CREAM: [number, number, number] = [0.96, 0.93, 0.84] // paper base

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Optical density per channel for a pigment colour (Beer–Lambert inverse). */
function opticalDensity(hex: string): [number, number, number] {
  const n = parseInt(hex.replace('#', ''), 16)
  const c = [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]
  return [-Math.log(Math.max(c[0], 0.05)), -Math.log(Math.max(c[1], 0.05)), -Math.log(Math.max(c[2], 0.05))]
}

/** Rasterise the silhouette polygons to a 0/1 coverage mask in canvas space. */
function silhouetteMask(polys: Vec2[][], size: number, raster: number): Float32Array {
  const c = document.createElement('canvas')
  c.width = c.height = size
  const ctx = c.getContext('2d')!
  const k = size / raster
  ctx.fillStyle = '#fff'
  ctx.beginPath()
  for (const poly of polys) {
    if (poly.length < 3) continue
    ctx.moveTo(poly[0].x * k, poly[0].y * k)
    for (let i = 1; i < poly.length; i++) ctx.lineTo(poly[i].x * k, poly[i].y * k)
    ctx.closePath()
  }
  ctx.fill()
  const data = ctx.getImageData(0, 0, size, size).data
  const mask = new Float32Array(size * size)
  for (let i = 0; i < mask.length; i++) mask[i] = data[i * 4 + 3] / 255
  return mask
}

/** Separable 3-tap box blur of one field into `out` (wet-gated by W). */
function bleedField(D: Float32Array, W: Float32Array, tmp: Float32Array, size: number, rate: number): void {
  // horizontal
  for (let y = 0; y < size; y++) {
    const row = y * size
    for (let x = 0; x < size; x++) {
      const l = D[row + Math.max(0, x - 1)], c = D[row + x], r = D[row + Math.min(size - 1, x + 1)]
      tmp[row + x] = (l + c + r) / 3
    }
  }
  // vertical + wet-gated mix back into D
  for (let y = 0; y < size; y++) {
    const row = y * size
    for (let x = 0; x < size; x++) {
      const u = tmp[Math.max(0, y - 1) * size + x], c = tmp[row + x], d = tmp[Math.min(size - 1, y + 1) * size + x]
      const blurred = (u + c + d) / 3
      const amt = rate * W[row + x]        // motion only where wet
      D[row + x] = D[row + x] * (1 - amt) + blurred * amt
    }
  }
}

/** Deposit a Gaussian splat of per-channel density into the fields. */
function splat(dR: Float32Array, dG: Float32Array, dB: Float32Array, size: number, cx: number, cy: number, radius: number, amt: number, dens: [number, number, number]): void {
  const r2 = radius * radius
  const x0 = Math.max(0, Math.floor(cx - radius * 2)), x1 = Math.min(size - 1, Math.ceil(cx + radius * 2))
  const y0 = Math.max(0, Math.floor(cy - radius * 2)), y1 = Math.min(size - 1, Math.ceil(cy + radius * 2))
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const g = Math.exp(-((x - cx) ** 2 + (y - cy) ** 2) / r2) * amt
      if (g < 0.002) continue
      const i = y * size + x
      dR[i] += g * dens[0]; dG[i] += g * dens[1]; dB[i] += g * dens[2]
    }
  }
}

function plantBox(polys: Vec2[][], k: number): { cx: number; cy: number; radius: number } {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const poly of polys) for (const p of poly) {
    if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x
    if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y
  }
  return { cx: ((minX + maxX) / 2) * k, cy: ((minY + maxY) / 2) * k, radius: 0.5 * Math.max(maxX - minX, maxY - minY) * k }
}

export function bakeInkwash(polys: Vec2[][], seed: number, size: number, raster: number, p: InkwashParams): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = size
  const ctx = canvas.getContext('2d')!
  const N = size * size
  const mask = silhouetteMask(polys, size, raster)
  const box = plantBox(polys, size / raster)
  const rng = mulberry32(seed * 2654435761 + 17)

  const dR = new Float32Array(N), dG = new Float32Array(N), dB = new Float32Array(N)
  const W = new Float32Array(N), tmp = new Float32Array(N)

  // Wet the whole leaf, softer toward the rim (water sits in the body).
  for (let i = 0; i < N; i++) W[i] = mask[i] * p.wetness

  // Seed foliage pigment drops across the shape + a bloom cluster.
  const foliage = opticalDensity(p.foliage)
  const accent = opticalDensity(p.accent)
  const nDrops = Math.max(2, Math.round(p.drops))
  for (let d = 0; d < nDrops; d++) {
    const ang = rng() * Math.PI * 2, rr = Math.sqrt(rng()) * box.radius * 0.95
    splat(dR, dG, dB, size, box.cx + Math.cos(ang) * rr, box.cy + Math.sin(ang) * rr, box.radius * (0.28 + rng() * 0.25), 0.6 + rng() * 0.5, foliage)
  }
  if (p.bloomStrength > 0) {
    const ang = rng() * Math.PI * 2, rr = (0.15 + rng() * 0.25) * box.radius
    const bx = box.cx + Math.cos(ang) * rr, by = box.cy + Math.sin(ang) * rr
    for (let b = 0; b < 3; b++) {
      splat(dR, dG, dB, size, bx + (rng() - 0.5) * box.radius * 0.3, by + (rng() - 0.5) * box.radius * 0.3, box.radius * p.bloomSize * 0.6, p.bloomStrength * (0.6 + rng() * 0.5), accent)
    }
  }

  // Wet-gated diffusion/bleed + wetness decay (the organic spread).
  const iters = Math.max(1, Math.round(p.iterations))
  for (let it = 0; it < iters; it++) {
    bleedField(dR, W, tmp, size, p.bleed * 1.0)
    bleedField(dG, W, tmp, size, p.bleed * 0.7)  // channel-rate split → mild chromatography
    bleedField(dB, W, tmp, size, p.bleed * 1.15)
    // wetness spreads a little and dries
    for (let y = 0; y < size; y++) {
      const row = y * size
      for (let x = 0; x < size; x++) {
        const l = W[row + Math.max(0, x - 1)], c = W[row + x], r = W[row + Math.min(size - 1, x + 1)]
        tmp[row + x] = (l + c + r) / 3
      }
    }
    for (let i = 0; i < N; i++) W[i] = tmp[i] * 0.94
  }

  // Display: Beer–Lambert + gradient edge-darkening + granulation + paper fbm.
  const gran: NoiseFn = seededNoise2D(seed * 13 + 5)
  const fibre: NoiseFn = seededNoise2D(seed * 29 + 7)
  const img = ctx.createImageData(size, size)
  const out = img.data
  const dtot = (i: number) => dR[i] + dG[i] + dB[i]
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x
      const m = mask[i]
      if (m <= 0) { out[i * 4 + 3] = 0; continue }
      const has = dtot(i) > 0.03 ? 1 : 0
      // density gradient → dried-rim darkening (grad is small on a diffused field, so amplify)
      const gx = dtot(y * size + Math.min(size - 1, x + 1)) - dtot(y * size + Math.max(0, x - 1))
      const gy = dtot(Math.min(size - 1, y + 1) * size + x) - dtot(Math.max(0, y - 1) * size + x)
      const grad = Math.sqrt(gx * gx + gy * gy)
      const edge = 1 + p.edgeDarken * grad * 7
      // Paper tooth (multi-octave) + fine pigment grain — the two together break up
      // the smooth field so it reads painted-on, not airbrushed.
      const tooth = fbm2d(fibre, x, y, 3, 0.05)              // 0..1
      const fine = (gran(x * 0.22, y * 0.22) + 1) * 0.5      // high-freq
      const g = 1 - p.granulation * (0.55 * (1 - fine) + 0.45 * (1 - tooth)) * has
      const paperN = 1 - p.paperFibre * 0.18 * (1 - tooth)
      const kk = p.strength * edge * g
      const tr = Math.exp(-dR[i] * kk), tg = Math.exp(-dG[i] * kk), tb = Math.exp(-dB[i] * kk)
      const o = i * 4
      out[o] = Math.min(255, CREAM[0] * paperN * tr * 255)
      out[o + 1] = Math.min(255, CREAM[1] * paperN * tg * 255)
      out[o + 2] = Math.min(255, CREAM[2] * paperN * tb * 255)
      // opacity from total pigment (thin edges stay translucent → soft wash)
      const a = 1 - Math.exp(-dtot(i) * p.strength * 0.5)
      out[o + 3] = Math.round(Math.min(1, a) * m * 255)
    }
  }
  ctx.putImageData(img, 0, 0)
  return canvas
}
