// naturalize-lib.ts — pure helpers shared by the naturalize renderer and its audit rig.
// No top-level side effects: safe to import from any script.
import svgpath from 'svgpath'
import { roughOpsForPath } from '../src/lib/roughStroke'
import { kinematicOpsForPath, type KinematicStrokeOptions } from '../src/lib/kinematicStroke'

const TWO_THIRDS = 2 / 3

/**
 * Normalize any SVG path `d` to absolute M/L/C/Z only, so the harness can ingest real
 * plant/landscape SVGs (relative commands, H/V, arcs, quadratics, shorthand) — not just the
 * M/L/C/Z-absolute subset the generators' own flatten understands. The real app feeds
 * structured segments, so this lives in the harness, not in kinematicStroke.
 */
export function normalizePath(d: string): string {
  // Build the output EXPLICITLY, one command per segment. svgpath's toString collapses
  // consecutive same-commands into SVG polyline shorthand (`L x1 y1 x2 y2 ...`), which the
  // generators' one-pair-per-command parsers silently truncate. Emitting each segment on its
  // own avoids that entirely and lets us convert H/V->L and Q->C in the same pass.
  const parts: string[] = []
  svgpath(d)
    .unshort() // S/T -> C/Q
    .unarc()   // A -> C
    .abs()     // relative -> absolute
    .iterate((seg, _i, x, y) => {
      const c = seg[0]
      if (c === 'M') parts.push(`M ${seg[1]} ${seg[2]}`)
      else if (c === 'L') parts.push(`L ${seg[1]} ${seg[2]}`)
      else if (c === 'H') parts.push(`L ${seg[1]} ${y}`)
      else if (c === 'V') parts.push(`L ${x} ${seg[1]}`)
      else if (c === 'C') parts.push(`C ${seg[1]} ${seg[2]} ${seg[3]} ${seg[4]} ${seg[5]} ${seg[6]}`)
      else if (c === 'Q') {
        const qx = seg[1] as number, qy = seg[2] as number, ex = seg[3] as number, ey = seg[4] as number
        parts.push(`C ${x + TWO_THIRDS * (qx - x)} ${y + TWO_THIRDS * (qy - y)} ${ex + TWO_THIRDS * (qx - ex)} ${ey + TWO_THIRDS * (qy - ey)} ${ex} ${ey}`)
      } else if (c === 'Z' || c === 'z') parts.push('Z')
      return undefined
    })
  return parts.join(' ')
}

export type Op = { op: string; data: number[] }
export interface Knobs {
  engine?: 'rough' | 'kinematic' | 'crisp'
  color?: string; width?: number
  // rough.js
  roughness?: number; bowing?: number; doubleStroke?: boolean
  // kinematic
  squiggle?: number; cpSpacing?: number; overshoot?: number; cornerAngle?: number
  // both
  seed?: number
}

/** Extract { id, d } for every <path> in an SVG string. */
export function readShapes(svg: string): Array<{ id: string; d: string }> {
  const out: Array<{ id: string; d: string }> = []
  const re = /<path\b[^>]*?>/g
  let m: RegExpExecArray | null
  let n = 0
  while ((m = re.exec(svg))) {
    const tag = m[0]
    const d = /\bd\s*=\s*"([^"]*)"/.exec(tag)?.[1]
    if (!d) continue
    const id = /\bid\s*=\s*"([^"]*)"/.exec(tag)?.[1] ?? `path${n}`
    out.push({ id, d })
    n++
  }
  return out
}

/** Dispatch a shape `d` + knobs to the chosen naturalism generator -> op-list. */
export function opsFor(d: string, k: Knobs): Op[] {
  const nd = normalizePath(d) // accept real-world SVG paths, not just M/L/C/Z-absolute
  const seed = k.seed ?? 42
  if (k.engine === 'rough') {
    const sets = roughOpsForPath(nd, {
      roughness: k.roughness ?? 1, bowing: k.bowing ?? 1, seed, doubleStroke: k.doubleStroke ?? true,
    })
    return sets.flatMap((s) => s.ops as Op[])
  }
  if (k.engine === 'crisp') return crispOps(nd)
  const ko: KinematicStrokeOptions = {
    squiggle: k.squiggle ?? 6, cpSpacing: k.cpSpacing ?? 40,
    overshoot: k.overshoot ?? 4, cornerAngle: k.cornerAngle ?? 35, seed,
  }
  return kinematicOpsForPath(nd, ko) as Op[]
}

/** The exact geometry as an op-list (faithful reference render). M/L/C/Z absolute only. */
export function crispOps(d: string): Op[] {
  const toks = d.match(/[MLCZ]|-?\d*\.?\d+/g) ?? []
  let i = 0
  const num = () => parseFloat(toks[i++])
  const ops: Op[] = []
  let start = [0, 0]
  while (i < toks.length) {
    const c = toks[i++]
    if (c === 'M') { const p = [num(), num()]; start = p; ops.push({ op: 'move', data: p }) }
    else if (c === 'L') ops.push({ op: 'lineTo', data: [num(), num()] })
    else if (c === 'C') ops.push({ op: 'bcurveTo', data: [num(), num(), num(), num(), num(), num()] })
    else if (c === 'Z') ops.push({ op: 'lineTo', data: start })
  }
  return ops
}

/** op-list -> SVG path `d`. */
export function opsToD(ops: Op[]): string {
  const parts: string[] = []
  for (const { op, data } of ops) {
    if (op === 'move') parts.push(`M ${data[0]} ${data[1]}`)
    else if (op === 'lineTo') parts.push(`L ${data[0]} ${data[1]}`)
    else if (op === 'bcurveTo') parts.push(`C ${data[0]} ${data[1]}, ${data[2]} ${data[3]}, ${data[4]} ${data[5]}`)
  }
  return parts.join(' ')
}

/** Bounding box over one or more path `d` strings (numbers in M/L/C alternate x,y). */
export function bbox(ds: string[]): { x: number; y: number; w: number; h: number } {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const d of ds) {
    const nums = (d.match(/-?\d*\.?\d+/g) ?? []).map(Number)
    for (let i = 0; i < nums.length; i += 2) {
      const x = nums[i], y = nums[i + 1]
      if (x < minX) minX = x; if (x > maxX) maxX = x
      if (y < minY) minY = y; if (y > maxY) maxY = y
    }
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY }
}
