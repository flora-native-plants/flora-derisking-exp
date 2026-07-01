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
  tonalDepth: number       // 0..1 — spread of light-centre → dark-lobe values (volume)
  tempShift: number        // 0..1 — warm-highlight vs cool-shadow colour split
  backruns: number         // 0..1 — cauliflower back-run strength (light core, dark feathered ring)
  driedEdge: number        // 0..1 — dark feathered rim hugging the silhouette (dried hard edge)
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

type RGB = [number, number, number]

function rgbToHsl(rgb: RGB): [number, number, number] {
  const r = rgb[0] / 255, g = rgb[1] / 255, b = rgb[2] / 255
  const max = Math.max(r, g, b), min = Math.min(r, g, b)
  const l = (max + min) / 2
  if (max === min) return [0, 0, l]
  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  let h = 0
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0)
  else if (max === g) h = (b - r) / d + 2
  else h = (r - g) / d + 4
  return [h / 6, s, l]
}

function hslToRgb(h: number, s: number, l: number): RGB {
  if (s === 0) { const v = Math.round(l * 255); return [v, v, v] }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s
  const p = 2 * l - q
  const hue = (t: number) => {
    if (t < 0) t += 1; if (t > 1) t -= 1
    if (t < 1 / 6) return p + (q - p) * 6 * t
    if (t < 1 / 2) return q
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6
    return p
  }
  return [Math.round(hue(h + 1 / 3) * 255), Math.round(hue(h) * 255), Math.round(hue(h - 1 / 3) * 255)]
}

/**
 * Shift a pigment toward warm-highlight (t>0) or cool-shadow (t<0): warm rotates
 * hue toward yellow + lightens + desaturates a touch; cool rotates toward
 * blue-green + darkens + saturates. `amt` scales the whole effect (tempShift).
 */
function tempTint(rgb: RGB, t: number, amt: number): RGB {
  const [h, s, l] = rgbToHsl(rgb)
  const k = t * amt
  const h2 = (h - 0.012 * k + 1) % 1                       // warm→yellow-green, cool→blue-green (subtle)
  const l2 = Math.max(0, Math.min(1, l + 0.14 * k))         // warm lighter, cool darker (the main move)
  const s2 = Math.max(0, Math.min(1, s + 0.07 * Math.max(0, -k))) // cool a touch richer; warm keeps sat (no tan)
  return hslToRgb(h2, s2, l2)
}

function smoothstep(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)))
  return t * t * (3 - 2 * t)
}

interface Pool {
  ax: number; ay: number; radius: number
  rgb: [number, number, number]
  density: number; edge: number; softness: number
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

/** Build the seeded pool list: a pale base wash, alternating highlight/shadow
 *  pigment pools (tonal + temperature structure), and one bloom pool. */
function buildPools(seed: number, box: { cx: number; cy: number; radius: number }, p: WatercolorPoolParams): Pool[] {
  const rng = mulberry32(seed * 2654435761 + 1)
  const foliage = hexToRgb(p.foliage)
  const accent = hexToRgb(p.accent)
  const R = box.radius
  const scatter = p.variationStrength * R
  const depth = p.tonalDepth
  const pools: Pool[] = []

  // Base wash — pale green ground the pools sit on; light centre, soft.
  pools.push({
    ax: box.cx, ay: box.cy, radius: R * 1.12,
    rgb: tempTint(foliage, +1, p.tempShift * 0.3),
    density: p.baseStrength * (0.5 - depth * 0.2), edge: p.edgeDarkening * 0.4,
    softness: p.softness,
  })

  // Pigment pools — alternate warm HIGHLIGHT (pale, soft) and cool SHADOW
  // (dark, hard dried rim) so the canopy has value + temperature structure.
  const n = Math.max(2, Math.min(4, Math.round(p.poolCount)))
  for (let i = 0; i < n; i++) {
    const ang = rng() * Math.PI * 2
    const dist = rng() * scatter
    const shadow = rng() < 0.5
    const jitter = 1 + (rng() - 0.5) * 0.15
    const base = shadow
      ? scaleRgb(tempTint(foliage, -1, p.tempShift), (1 - depth * 0.45) * jitter) // cool + darker
      : scaleRgb(tempTint(foliage, +1, p.tempShift), (1 + depth * 0.25) * jitter) // warm + lighter
    pools.push({
      ax: box.cx + Math.cos(ang) * dist,
      ay: box.cy + Math.sin(ang) * dist,
      radius: R * (0.4 + rng() * 0.4),
      rgb: base,
      density: shadow ? 0.45 + depth * 0.35 : 0.3 + rng() * 0.2,
      edge: shadow ? Math.min(1, p.edgeDarkening + 0.3) : p.edgeDarkening * 0.6,
      softness: shadow ? p.softness * 0.6 : p.softness,   // shadow = harder dried rim
    })
  }

  // Bloom pool — accent colour, off-centre, hard dried rim (back-run character).
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
      softness: p.softness * 0.7,
    })
  }
  return pools
}

interface Backrun {
  ax: number; ay: number; radius: number; dark: RGB
}

/** Seeded back-runs: a light core ringed by a dark feathered fringe (cauliflower
 *  bloom), biased toward the canopy rim where real washes back-flow as they dry. */
function buildBackruns(seed: number, box: { cx: number; cy: number; radius: number }, p: WatercolorPoolParams): Backrun[] {
  if (p.backruns <= 0) return []
  const rng = mulberry32(seed * 40503 + 7)
  const foliage = hexToRgb(p.foliage)
  const dark = scaleRgb(tempTint(foliage, -1, p.tempShift), 0.55)
  const R = box.radius
  const count = 1 + (rng() < 0.6 ? 1 : 0) + (rng() < 0.3 ? 1 : 0) // 1..3
  const runs: Backrun[] = []
  for (let i = 0; i < count; i++) {
    const ang = rng() * Math.PI * 2
    const dist = (0.35 + rng() * 0.45) * R // rim-biased
    runs.push({
      ax: box.cx + Math.cos(ang) * dist,
      ay: box.cy + Math.sin(ang) * dist,
      radius: R * (0.18 + rng() * 0.22),
      dark,
    })
  }
  return runs
}

/** Apply one back-run to an accumulated pixel colour (mutates via return). */
function applyBackrun(
  br: Backrun, px: number, py: number, o: RGB, oA: number, lo: NoiseFn, strength: number,
): RGB {
  if (oA < 0.02) return o
  const dx = (px - br.ax) / br.radius
  const dy = (py - br.ay) / br.radius
  let dn = Math.sqrt(dx * dx + dy * dy)
  if (dn > 1.45) return o
  const bn = (lo((px - br.ax) * LO_FREQ * 1.8, (py - br.ay) * LO_FREQ * 1.8) + 1) * 0.5
  dn *= 1 + 0.55 * (bn - 0.5) * 2 // irregular, feathered boundary
  const ring = Math.exp(-((dn - 1) * (dn - 1)) / (2 * 0.12 * 0.12)) // dark pile-up at the rim
  const inner = smoothstep(0.95, 0.3, dn)                          // lifted, pushed-out core
  const lift = 1 + inner * strength * 0.45
  let r = Math.min(255, o[0] * lift), g = Math.min(255, o[1] * lift), b = Math.min(255, o[2] * lift)
  const add = Math.min(1, ring * strength)
  r = r * (1 - add) + br.dark[0] * add
  g = g * (1 - add) + br.dark[1] * add
  b = b * (1 - add) + br.dark[2] * add
  return [r, g, b]
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
  const cov = 1 - smoothstep(1 - pool.softness, 1 + 0.12, dNorm)
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
  const backruns = buildBackruns(seed, box, params)
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
      // Back-runs — light core + dark feathered ring on already-painted pigment.
      if (backruns.length) {
        for (const br of backruns) {
          [oR, oG, oB] = applyBackrun(br, px, py, [oR, oG, oB], oA, lo, params.backruns)
        }
      }
      // Canopy-level ambient shade: darken toward the outer edge so the whole
      // symbol reads as a rounded volume, not a flat disc (value structure).
      const dc = Math.sqrt((px - box.cx) ** 2 + (py - box.cy) ** 2) / box.radius
      const shade = 1 - params.tonalDepth * 0.3 * smoothstep(0.5, 1.05, dc)
      const idx = (py * size + px) * 4
      d[idx] = oR * shade; d[idx + 1] = oG * shade; d[idx + 2] = oB * shade; d[idx + 3] = Math.round(oA * 255)
    }
  }
  ctx.putImageData(img, 0, 0)

  // Dried hard edge — a feathered dark stroke centred on the silhouette. The clip
  // below keeps only its inner half, giving a soft dark rim where the wash dried.
  if (params.driedEdge > 0) {
    const dark = scaleRgb(hexToRgb(params.foliage), 0.4)
    ctx.save()
    ctx.strokeStyle = `rgb(${dark[0]|0},${dark[1]|0},${dark[2]|0})`
    ctx.globalAlpha = params.driedEdge * 0.55
    ctx.lineWidth = box.radius * 0.14
    ctx.lineJoin = 'round'
    ctx.shadowColor = ctx.strokeStyle as string
    ctx.shadowBlur = box.radius * 0.08
    for (const poly of polys) {
      if (poly.length < 3) continue
      ctx.beginPath()
      ctx.moveTo(poly[0].x * k, poly[0].y * k)
      for (let i = 1; i < poly.length; i++) ctx.lineTo(poly[i].x * k, poly[i].y * k)
      ctx.closePath()
      ctx.stroke()
    }
    ctx.restore()
  }

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
