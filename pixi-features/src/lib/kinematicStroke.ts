// kinematicStroke.ts — render an SVG path as a hand-drawn stroke using an
// AlMeraj/Flash–Hogan minimum-jerk line model, as a drop-in alternative to
// roughStroke.ts. Same op-list output (move/lineTo/bcurveTo) so it replays 1:1
// into a Pixi Graphics and stays crisp at any zoom.
//
// KEY CONTRACT (identical to roughStroke.ts):
//   - Geometry is generated ONCE in world coordinates with a FIXED seed.
//   - It is cached by (squiggle, cpSpacing, seed, overshoot, cornerAngle) plus the raw `d` string.
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
  /** Turn angle (degrees) above which a vertex is a hard corner (spline restarts there). */
  cornerAngle: number
}

/**
 * Op-list element — shape matches roughStroke's replay input exactly.
 * Kinematic strokes only ever emit `move` and `bcurveTo`; `lineTo` is retained for
 * op-list parity with roughStroke (shared replay code) but is never produced here.
 */
export interface StrokeOp { op: 'move' | 'lineTo' | 'bcurveTo'; data: number[] }

type Pt = [number, number]

// How finely to flatten each SVG cubic before resampling to control points.
const BEZIER_FLATTEN_STEPS = 16
// Catmull-Rom → cubic-bezier tangent scale (the standard 1/6 factor).
const CR_TANGENT = 1 / 6
// Points within this distance (world units) of the subpath start count as the
// closing vertex and are dropped, so a closed path never keeps a coincident seam CP.
const SEAM_EPS = 1e-6

// A run whose max perpendicular deviation from its chord is below this fraction of
// the chord length is treated as straight (one bow instead of full squiggle).
export const STRAIGHT_FRAC = 0.03
// Straight runs keep only this fraction of the squiggle amplitude (confident line).
export const STRAIGHT_SQUIGGLE_SCALE = 0.35
// Bow amplitude for a straight run = chordLength / BOW_DIVISOR, capped at BOW_CAP.
export const BOW_DIVISOR = 200
export const BOW_CAP = 14

const _cache = new Map<string, StrokeOp[]>()

function cacheKey(d: string, o: KinematicStrokeOptions): string {
  return `${o.squiggle}|${o.cpSpacing}|${o.seed}|${o.overshoot}|${o.cornerAngle}|${d}`
}

function cubicAt(p0: Pt, c1: Pt, c2: Pt, p1: Pt, t: number): Pt {
  const u = 1 - t
  const a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, e = t * t * t
  return [
    a * p0[0] + b * c1[0] + c * c2[0] + e * p1[0],
    a * p0[1] + b * c1[1] + c * c2[1] + e * p1[1],
  ]
}

/**
 * Flatten an M/L/C/Z path `d` into one polyline per subpath.
 * NOTE: subset parser — absolute M/L/C/Z only (matches pencilTestShapes). It does
 * NOT handle relative commands or H/V/A/Q; broaden it before porting to flora-studio.
 */
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

/**
 * Densify a polyline so no gap exceeds `spacing`, while PRESERVING every input vertex.
 * Long segments get intermediate points (room for straight runs to wobble/bow), but fine
 * input detail (features closer than `spacing`) is never averaged away — the old fixed
 * arc-length resample discarded any vertex between sample points, smoothing plant-symbol
 * detail. Coincident duplicate vertices are dropped so no zero-length segment reaches the spline.
 */
function resample(pts: Pt[], spacing: number): Pt[] {
  if (pts.length < 2) return pts.slice()
  if (spacing <= 0) return pts.slice()
  const out: Pt[] = [pts[0]]
  for (let i = 1; i < pts.length; i++) {
    const [x0, y0] = pts[i - 1], [x1, y1] = pts[i]
    const segLen = Math.hypot(x1 - x0, y1 - y0)
    if (segLen < 1e-9) continue // drop coincident duplicate
    const inserts = Math.floor(segLen / spacing)
    for (let k = 1; k <= inserts; k++) {
      const t = (k * spacing) / segLen
      if (t < 1 - 1e-9) out.push([x0 + (x1 - x0) * t, y0 + (y1 - y0) * t])
    }
    out.push([x1, y1]) // always keep the real vertex
  }
  return out
}

/**
 * Perturb control points laterally. Endpoints of open paths are pinned (the
 * min-jerk anchors); interior points get max deviation (bell weight), matching
 * AlMeraj's observation that hand-drawn lines deviate most in the middle.
 */
function perturb(cps: Pt[], amp: number, rng: () => number, closed: boolean): Pt[] {
  const n = cps.length
  if (n <= 1) return cps.slice() // avoid NaN from Math.sin(PI * i/(n-1)) when n===1
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

/**
 * Drop every trailing vertex coincident (within SEAM_EPS) with the subpath start,
 * so a closed path built from an authored `d` that repeats its first vertex (and/or
 * a `Z`) does not leave two coincident control points at the seam.
 */
function stripClosingDuplicates(poly: Pt[]): Pt[] {
  const first = poly[0]
  let end = poly.length
  while (
    end > 1 &&
    Math.abs(poly[end - 1][0] - first[0]) < SEAM_EPS &&
    Math.abs(poly[end - 1][1] - first[1]) < SEAM_EPS
  ) end--
  return poly.slice(0, end)
}

/** Turn angle (radians, [0, PI]) between the incoming a->b and outgoing b->c directions. */
export function turnAngle(a: Pt, b: Pt, c: Pt): number {
  const v1x = b[0] - a[0], v1y = b[1] - a[1]
  const v2x = c[0] - b[0], v2y = c[1] - b[1]
  const l1 = Math.hypot(v1x, v1y), l2 = Math.hypot(v2x, v2y)
  if (l1 === 0 || l2 === 0) return 0
  const dot = (v1x * v2x + v1y * v2y) / (l1 * l2)
  return Math.acos(Math.max(-1, Math.min(1, dot)))
}

/**
 * Split a subpath polyline into corner-to-corner runs. A vertex whose turn angle
 * exceeds `cornerRad` is a hard corner: the spline restarts there (crisp C0 corner).
 * Returns { runs, loop }: a closed subpath with NO corners yields one run + loop=true
 * (a smooth loop, e.g. an ellipse); otherwise open runs + loop=false (each corner is
 * drawn as two crossing strokes). Runs share corner endpoints on purpose.
 */
export function splitAtCorners(poly: Pt[], closed: boolean, cornerRad: number): { runs: Pt[][]; loop: boolean } {
  const n = poly.length
  if (n < 3) return { runs: [poly.slice()], loop: false }
  const cornerIdx: number[] = []
  const lo = closed ? 0 : 1
  const hi = closed ? n : n - 1
  for (let i = lo; i < hi; i++) {
    const a = poly[(i - 1 + n) % n], b = poly[i % n], c = poly[(i + 1) % n]
    if (turnAngle(a, b, c) > cornerRad) cornerIdx.push(i % n)
  }
  if (cornerIdx.length === 0) return { runs: [poly.slice()], loop: closed }

  const runs: Pt[][] = []
  if (closed) {
    for (let k = 0; k < cornerIdx.length; k++) {
      const s = cornerIdx[k], e = cornerIdx[(k + 1) % cornerIdx.length]
      const run: Pt[] = [poly[s]]
      let i = s
      do { i = (i + 1) % n; run.push(poly[i]) } while (i !== e)
      runs.push(run)
    }
  } else {
    let prev = 0
    for (const c of cornerIdx) { runs.push(poly.slice(prev, c + 1)); prev = c }
    runs.push(poly.slice(prev))
  }
  return { runs, loop: false }
}

/** Max perpendicular distance from any run point to the run's chord (start->end). */
export function chordDeviation(run: Pt[]): number {
  const a = run[0], b = run[run.length - 1]
  const abx = b[0] - a[0], aby = b[1] - a[1]
  const L = Math.hypot(abx, aby) || 1
  let maxd = 0
  for (const p of run) {
    const d = Math.abs((p[0] - a[0]) * aby - (p[1] - a[1]) * abx) / L
    if (d > maxd) maxd = d
  }
  return maxd
}

/** True if the run is essentially straight (deviates < STRAIGHT_FRAC of its chord length). */
export function isStraightRun(run: Pt[]): boolean {
  if (run.length < 3) return true
  const a = run[0], b = run[run.length - 1]
  const L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1
  return chordDeviation(run) < STRAIGHT_FRAC * L
}

/** Displace control points by a single half-sine bow (0 at ends, `amp` perpendicular at middle). */
export function bowRun(cps: Pt[], amp: number): Pt[] {
  const n = cps.length
  if (n < 2 || amp === 0) return cps
  const a = cps[0], b = cps[n - 1]
  let tx = b[0] - a[0], ty = b[1] - a[1]
  const L = Math.hypot(tx, ty) || 1
  tx /= L; ty /= L
  const nx = -ty, ny = tx // unit normal
  return cps.map((p, i) => {
    // Pin endpoints exactly to 0 to avoid Math.sin(PI)≈1.2e-15 float drift.
    const w = (i === 0 || i === n - 1) ? 0 : Math.sin(Math.PI * (i / (n - 1)))
    return [p[0] + nx * amp * w, p[1] + ny * amp * w] as Pt
  })
}

/** Generate (or fetch cached) min-jerk op-list for an SVG path `d` string. */
export function kinematicOpsForPath(d: string, o: KinematicStrokeOptions): StrokeOp[] {
  const seed = o.seed || 1 // 0 disallowed — mirrors roughStroke's rule
  const key = cacheKey(d, { ...o, seed })
  const hit = _cache.get(key)
  if (hit) return hit

  const subpaths = flattenPath(d)
  const ops: StrokeOp[] = []
  const cornerRad = (o.cornerAngle * Math.PI) / 180
  for (let si = 0; si < subpaths.length; si++) {
    const raw = subpaths[si]
    const isClosedSub =
      raw.length > 2 &&
      raw[0][0] === raw[raw.length - 1][0] &&
      raw[0][1] === raw[raw.length - 1][1]
    const poly = isClosedSub ? stripClosingDuplicates(raw) : raw
    const rng = alea(`${seed}:${si}:${key}`)
    const { runs, loop } = splitAtCorners(poly, isClosedSub, cornerRad)
    for (const run of runs) {
      let cps = resample(run, o.cpSpacing)
      const straight = isStraightRun(run)
      const amp = straight ? o.squiggle * STRAIGHT_SQUIGGLE_SCALE : o.squiggle
      cps = perturb(cps, amp, rng, loop)
      if (straight) {
        const L = Math.hypot(run[run.length - 1][0] - run[0][0], run[run.length - 1][1] - run[0][1])
        const bowSign = rng() < 0.5 ? -1 : 1
        cps = bowRun(cps, bowSign * Math.min(L / BOW_DIVISOR, BOW_CAP))
      }
      if (!loop && o.overshoot > 0 && cps.length >= 2) cps = applyOvershoot(cps, o.overshoot)
      catmullRomOps(cps, ops, loop)
    }
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
