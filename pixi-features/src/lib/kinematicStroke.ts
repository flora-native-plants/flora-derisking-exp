// kinematicStroke.ts — render an SVG path as a hand-drawn stroke using an
// AlMeraj/Flash–Hogan minimum-jerk line model, as a drop-in alternative to
// roughStroke.ts. Same op-list output (move/lineTo/bcurveTo) so it replays 1:1
// into a Pixi Graphics and stays crisp at any zoom.
//
// KEY CONTRACT (identical to roughStroke.ts):
//   - Geometry is generated ONCE in world coordinates with a FIXED seed.
//   - It is cached by (squiggle, cpSpacing, seed, overshoot, dHash).
//   - There is NO zoom parameter: zooming only scales the parent container, so
//     the wobble scales with the drawing and never re-randomizes or crawls.
import type { Graphics } from 'pixi.js'
import alea from 'alea'

export interface KinematicStrokeOptions {
  /** Lateral squiggle amplitude in world units (AlMeraj "D"). 0 = exact centerline. */
  squiggle: number
  /** Control-point spacing in world units. Larger = fewer control points = straighter. */
  cpSpacing: number
  /** Stable per-element seed. MUST be a nonzero int (0 disallowed, per contract). */
  seed: number
  /** Endpoint overshoot in world units for open paths (min-jerk hallmark). 0 = none. */
  overshoot: number
}

/** Op-list element — shape matches roughStroke's replay input exactly. */
export interface StrokeOp { op: 'move' | 'lineTo' | 'bcurveTo'; data: number[] }

type Pt = [number, number]

// How finely to flatten each SVG cubic before resampling to control points.
const BEZIER_FLATTEN_STEPS = 16
// Catmull-Rom → cubic-bezier tangent scale (the standard 1/6 factor).
const CR_TANGENT = 1 / 6

const _cache = new Map<string, StrokeOp[]>()

function cacheKey(d: string, o: KinematicStrokeOptions): string {
  return `${o.squiggle}|${o.cpSpacing}|${o.seed}|${o.overshoot}|${d}`
}

function cubicAt(p0: Pt, c1: Pt, c2: Pt, p1: Pt, t: number): Pt {
  const u = 1 - t
  const a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, e = t * t * t
  return [
    a * p0[0] + b * c1[0] + c * c2[0] + e * p1[0],
    a * p0[1] + b * c1[1] + c * c2[1] + e * p1[1],
  ]
}

/** Flatten an M/L/C/Z path `d` into one polyline per subpath. */
function flattenPath(d: string): Pt[][] {
  const toks = d.match(/[MLCZ]|-?\d*\.?\d+/g) ?? []
  let i = 0
  const num = () => parseFloat(toks[i++])
  const subpaths: Pt[][] = []
  let cur: Pt[] = []
  let start: Pt = [0, 0]
  let pen: Pt = [0, 0]
  while (i < toks.length) {
    const cmd = toks[i++]
    if (cmd === 'M') {
      if (cur.length) subpaths.push(cur)
      pen = [num(), num()]; start = pen; cur = [pen]
    } else if (cmd === 'L') {
      pen = [num(), num()]; cur.push(pen)
    } else if (cmd === 'C') {
      const c1: Pt = [num(), num()], c2: Pt = [num(), num()], p: Pt = [num(), num()]
      for (let s = 1; s <= BEZIER_FLATTEN_STEPS; s++) cur.push(cubicAt(pen, c1, c2, p, s / BEZIER_FLATTEN_STEPS))
      pen = p
    } else if (cmd === 'Z') {
      cur.push(start); pen = start
    }
  }
  if (cur.length) subpaths.push(cur)
  return subpaths
}

/** Resample a polyline to control points spaced ~`spacing` apart by arc length. */
function resample(pts: Pt[], spacing: number): Pt[] {
  if (pts.length < 2) return pts.slice()
  const out: Pt[] = [pts[0]]
  let acc = 0
  for (let i = 1; i < pts.length; i++) {
    const [x0, y0] = pts[i - 1], [x1, y1] = pts[i]
    const segLen = Math.hypot(x1 - x0, y1 - y0)
    let from = 0
    while (acc + (segLen - from) >= spacing) {
      from += spacing - acc
      const t = from / segLen
      out.push([x0 + (x1 - x0) * t, y0 + (y1 - y0) * t])
      acc = 0
    }
    acc += segLen - from
  }
  const last = pts[pts.length - 1]
  const tail = out[out.length - 1]
  if (tail[0] !== last[0] || tail[1] !== last[1]) out.push(last)
  return out
}

/**
 * Perturb control points laterally. Endpoints of open paths are pinned (the
 * min-jerk anchors); interior points get max deviation (bell weight), matching
 * AlMeraj's observation that hand-drawn lines deviate most in the middle.
 */
function perturb(cps: Pt[], amp: number, rng: () => number, closed: boolean): Pt[] {
  const n = cps.length
  return cps.map((p, i) => {
    const edge = closed ? 1 : Math.sin(Math.PI * (i / (n - 1))) // 0 at ends, 1 mid
    const a = cps[Math.max(0, i - 1)], b = cps[Math.min(n - 1, i + 1)]
    let tx = b[0] - a[0], ty = b[1] - a[1]
    const tl = Math.hypot(tx, ty) || 1
    tx /= tl; ty /= tl
    const nx = -ty, ny = tx // unit normal
    const dev = (rng() * 2 - 1) * amp * edge
    return [p[0] + nx * dev, p[1] + ny * dev] as Pt
  })
}

/** Extend the open-path ends slightly past the endpoints along their tangents. */
function applyOvershoot(cps: Pt[], amt: number): Pt[] {
  const n = cps.length
  const ext = (from: Pt, to: Pt): Pt => {
    const dx = to[0] - from[0], dy = to[1] - from[1]
    const l = Math.hypot(dx, dy) || 1
    return [to[0] + (dx / l) * amt, to[1] + (dy / l) * amt]
  }
  return [ext(cps[1], cps[0]), ...cps, ext(cps[n - 2], cps[n - 1])]
}

/** Emit a Catmull-Rom-through-`cps` spline as move + bcurveTo ops. */
function catmullRomOps(cps: Pt[], out: StrokeOp[], closed: boolean): void {
  if (cps.length < 2) return
  const n = cps.length
  const get = (idx: number): Pt =>
    closed ? cps[(idx + n) % n] : cps[Math.max(0, Math.min(n - 1, idx))]
  out.push({ op: 'move', data: [cps[0][0], cps[0][1]] })
  const last = closed ? n : n - 1
  for (let i = 0; i < last; i++) {
    const p0 = get(i - 1), p1 = get(i), p2 = get(i + 1), p3 = get(i + 2)
    const c1: Pt = [p1[0] + (p2[0] - p0[0]) * CR_TANGENT, p1[1] + (p2[1] - p0[1]) * CR_TANGENT]
    const c2: Pt = [p2[0] - (p3[0] - p1[0]) * CR_TANGENT, p2[1] - (p3[1] - p1[1]) * CR_TANGENT]
    out.push({ op: 'bcurveTo', data: [c1[0], c1[1], c2[0], c2[1], p2[0], p2[1]] })
  }
}

/** Generate (or fetch cached) min-jerk op-list for an SVG path `d` string. */
export function kinematicOpsForPath(d: string, o: KinematicStrokeOptions): StrokeOp[] {
  const key = cacheKey(d, o)
  const hit = _cache.get(key)
  if (hit) return hit

  const seed = o.seed || 1 // 0 disallowed — mirrors roughStroke's rule
  const subpaths = flattenPath(d)
  const ops: StrokeOp[] = []
  for (let si = 0; si < subpaths.length; si++) {
    const poly = subpaths[si]
    const closed =
      poly.length > 2 &&
      poly[0][0] === poly[poly.length - 1][0] &&
      poly[0][1] === poly[poly.length - 1][1]
    const rng = alea(`${seed}:${si}:${key}`)
    let cps = resample(closed ? poly.slice(0, -1) : poly, o.cpSpacing)
    cps = perturb(cps, o.squiggle, rng, closed)
    if (!closed && o.overshoot > 0 && cps.length >= 2) cps = applyOvershoot(cps, o.overshoot)
    catmullRomOps(cps, ops, closed)
  }
  _cache.set(key, ops)
  return ops
}

function replayOps(g: Graphics, ops: StrokeOp[]): void {
  for (const { op, data } of ops) {
    if (op === 'move') g.moveTo(data[0], data[1])
    else if (op === 'lineTo') g.lineTo(data[0], data[1])
    else if (op === 'bcurveTo') g.bezierCurveTo(data[0], data[1], data[2], data[3], data[4], data[5])
  }
}

export interface KinematicStrokeStyle { color: number; width: number; alpha?: number }

/**
 * Stroke an SVG path `d` into `g` with a min-jerk hand-drawn look.
 * Caller owns g.clear() and the transform/zoom (world coords in).
 */
export function drawKinematicStroke(
  g: Graphics,
  d: string,
  o: KinematicStrokeOptions,
  style: KinematicStrokeStyle,
): void {
  replayOps(g, kinematicOpsForPath(d, o))
  g.stroke({ color: style.color, width: style.width, alpha: style.alpha ?? 1, cap: 'round', join: 'round' })
}

/** Clear the memo (used when the playground wants a clean slate). */
export function clearKinematicCache(): void { _cache.clear() }
