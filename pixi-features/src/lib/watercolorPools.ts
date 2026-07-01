/**
 * Layered pigment-pool watercolour interior generator (canvas2d).
 *
 * Instead of translating one uniform wash texture (which reads as "reshuffled"),
 * each variant of a plant is painted from a few SEEDED pigment POOLS composited
 * wet-on-wet inside the fixed silhouette. The realism comes from:
 *
 *   • edge-darkening — pigment migrates to the drying rim, so each pool is DENSER
 *     near its edge and lighter in the centre (the #1 "hand-painted" tell);
 *   • granulation    — high-freq noise mottles pigment into the paper tooth;
 *   • irregular pool boundaries — low-freq noise warps each pool off-circular;
 *   • per-seed scatter of pool anchor / scale / tint → genuinely different paintings.
 *
 * Pure w.r.t. inputs (polys + seed + params in, an HTMLCanvasElement out), so the
 * tuned algorithm ports verbatim into flora-studio's buildBotanicalComposite.
 */
import { seededNoise2D, fbm2d, type NoiseFn } from './perlinNoise'
import type { Vec2 } from './silhouette'

export interface WatercolorPoolParams {
  foliage: string          // hex — primary/foliage pigment
  accent: string           // hex — bloom pigment
  baseStrength: number     // 0..1 — flat base wash opacity under the pools
  poolCount: number        // 2..4 — foliage pigment pools per variant
  variationStrength: number// 0..1 — how far anchors/scale/tint scatter per seed
  edgeDarkening: number    // 0..1 — rim density boost (the realism lever)
  granulation: number      // 0..1 — high-freq pigment mottle
  boundaryWobble: number   // 0..1 — how irregular each pool's edge is
  bloomStrength: number    // 0..1 — bloom pool opacity (0 = no bloom)
  bloomSize: number        // fraction of plant radius
  softness: number         // 0..1 — pool edge falloff width
}

const LO_FREQ = 0.012      // pool-boundary warp frequency (large patches)
const HI_FREQ = 0.035      // granulation frequency — clumpy pigment settling, not dust
const RIM_START = 0.35     // where edge-darkening begins (fraction of pool radius)

/** Mulberry32 — deterministic per-seed scatter. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.replace('#', ''), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

/** Scale a colour's lightness by `f` (clamped to a byte). */
function scaleRgb(rgb: [number, number, number], f: number): [number, number, number] {
  return [
    Math.max(0, Math.min(255, rgb[0] * f)),
    Math.max(0, Math.min(255, rgb[1] * f)),
    Math.max(0, Math.min(255, rgb[2] * f)),
  ]
}

function smoothstep(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)))
  return t * t * (3 - 2 * t)
}

interface Pool {
  ax: number; ay: number; radius: number
  rgb: [number, number, number]
  density: number; edge: number
}

/** Plant bounding box (in canvas px) from RASTER-space polygons. */
function plantBox(polys: Vec2[][], k: number): { cx: number; cy: number; radius: number } {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const poly of polys) for (const p of poly) {
    if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x
    if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y
  }
  const cx = ((minX + maxX) / 2) * k
  const cy = ((minY + maxY) / 2) * k
  const radius = 0.5 * Math.max(maxX - minX, maxY - minY) * k
  return { cx, cy, radius }
}

/** Build the seeded pool list: a base wash, N foliage pools, and one bloom pool. */
function buildPools(seed: number, box: { cx: number; cy: number; radius: number }, p: WatercolorPoolParams): Pool[] {
  const rng = mulberry32(seed * 2654435761 + 1)
  const foliage = hexToRgb(p.foliage)
  const accent = hexToRgb(p.accent)
  const R = box.radius
  const scatter = p.variationStrength * R
  const pools: Pool[] = []

  // Base wash — covers the whole shape, faint, gentle rim.
  pools.push({ ax: box.cx, ay: box.cy, radius: R * 1.15, rgb: foliage, density: p.baseStrength * 0.6, edge: p.edgeDarkening * 0.5 })

  // Foliage pigment pools — scattered, darker, strong rim.
  const n = Math.max(2, Math.min(4, Math.round(p.poolCount)))
  for (let i = 0; i < n; i++) {
    const ang = rng() * Math.PI * 2
    const dist = rng() * scatter
    const light = 0.7 + rng() * 0.4 // 0.7..1.1 lightness jitter
    pools.push({
      ax: box.cx + Math.cos(ang) * dist,
      ay: box.cy + Math.sin(ang) * dist,
      radius: R * (0.45 + rng() * 0.4),
      rgb: scaleRgb(foliage, light),
      density: 0.4 + rng() * 0.3,
      edge: p.edgeDarkening,
    })
  }

  // Bloom pool — accent colour, off-centre, hardest rim (back-run character).
  if (p.bloomStrength > 0) {
    const ang = rng() * Math.PI * 2
    const dist = (0.15 + rng() * 0.25) * R + rng() * scatter * 0.5
    pools.push({
      ax: box.cx + Math.cos(ang) * dist,
      ay: box.cy + Math.sin(ang) * dist,
      radius: R * p.bloomSize,
      rgb: accent,
      density: p.bloomStrength,
      edge: Math.min(1, p.edgeDarkening + 0.25),
    })
  }
  return pools
}

/** Alpha of one pool at a pixel, with boundary warp, edge-darkening, and granulation. */
function poolAlpha(pool: Pool, px: number, py: number, lo: NoiseFn, hi: NoiseFn, p: WatercolorPoolParams): number {
  const dx = px - pool.ax
  const dy = py - pool.ay
  let dNorm = Math.sqrt(dx * dx + dy * dy) / pool.radius
  if (dNorm > 1.7) return 0
  // Warp the boundary with low-freq noise (offset by anchor so each pool differs).
  const bn = (lo((px + pool.ax) * LO_FREQ, (py + pool.ay) * LO_FREQ) + 1) * 0.5 // [0,1]
  dNorm *= 1 + p.boundaryWobble * (bn - 0.5) * 1.4
  const cov = 1 - smoothstep(1 - p.softness, 1 + 0.12, dNorm)
  if (cov <= 0) return 0
  // Edge-darkening: density rises toward the rim.
  const rim = 1 + pool.edge * smoothstep(RIM_START, 1.0, Math.min(dNorm, 1))
  // Granulation: clumpy fbm mottle, gated by coverage so the soft fading edge
  // stays clean (ungated it punches dusty holes in the halo).
  const hn = fbm2d(hi, px, py, 2, HI_FREQ) // [0,1], clustered
  const solidity = smoothstep(0.25, 0.75, cov)
  const gran = 1 - p.granulation * (1 - hn) * solidity
  return Math.min(1, pool.density * cov * rim * gran)
}

/**
 * Paint one variant's interior into a `size`×`size` canvas and clip it to the
 * silhouette. `polys` are RASTER-space polygons; `raster` is that space's extent.
 */
export function renderVariantInterior(
  polys: Vec2[][],
  seed: number,
  size: number,
  raster: number,
  params: WatercolorPoolParams,
): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = size
  const ctx = canvas.getContext('2d')!
  const k = size / raster
  const box = plantBox(polys, k)
  const pools = buildPools(seed, box, params)
  const lo = seededNoise2D(seed * 7 + 11)
  const hi = seededNoise2D(seed * 13 + 29)

  const img = ctx.createImageData(size, size)
  const d = img.data
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let oR = 0, oG = 0, oB = 0, oA = 0
      for (const pool of pools) {
        const a = poolAlpha(pool, px, py, lo, hi, params)
        if (a <= 0) continue
        // Straight alpha-over: later (darker/accent) pigment layers over earlier.
        oR = oR * (1 - a) + pool.rgb[0] * a
        oG = oG * (1 - a) + pool.rgb[1] * a
        oB = oB * (1 - a) + pool.rgb[2] * a
        oA = oA * (1 - a) + a
      }
      const idx = (py * size + px) * 4
      d[idx] = oR; d[idx + 1] = oG; d[idx + 2] = oB; d[idx + 3] = Math.round(oA * 255)
    }
  }
  ctx.putImageData(img, 0, 0)

  // Clip to the silhouette (RASTER → canvas space).
  ctx.globalCompositeOperation = 'destination-in'
  ctx.beginPath()
  for (const poly of polys) {
    if (poly.length < 3) continue
    ctx.moveTo(poly[0].x * k, poly[0].y * k)
    for (let i = 1; i < poly.length; i++) ctx.lineTo(poly[i].x * k, poly[i].y * k)
    ctx.closePath()
  }
  ctx.fill()
  ctx.globalCompositeOperation = 'source-over'
  return canvas
}
