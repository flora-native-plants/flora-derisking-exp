// roughStroke.ts — render a path as a hand-drawn (rough.js) stroke into a Pixi Graphics.
//
// This is the pattern that ports to flora-studio's PixiFeatureLine.drawPath():
// rough.js is used ONLY as a geometry generator (rough.generator(), NOT the canvas
// renderer). It returns an op-list of move/lineTo/bcurveTo commands that map 1:1 onto
// Pixi's moveTo/lineTo/bezierCurveTo — no canvas texture, no rasterization, stays crisp
// at any zoom.
//
// KEY CONTRACT (why the wobble is stable):
//   - The rough geometry is generated ONCE in world coordinates with a FIXED seed.
//   - It is cached by (dHash, roughness, bowing, seed, doubleStroke).
//   - Zooming just scales the parent container — the geometry is never regenerated, so
//     the wobble scales with the drawing and never re-randomizes or crawls.
// This is what satisfies "the randomness of the wobble shouldn't vary as you zoom".

import type { Graphics } from 'pixi.js'
import rough from 'roughjs'
import type { RoughGenerator } from 'roughjs/bin/generator'
import type { OpSet, Options } from 'roughjs/bin/core'

// One shared generator — it's stateless across calls (seed is per-call).
let _gen: RoughGenerator | null = null
function generator(): RoughGenerator {
  if (!_gen) _gen = rough.generator()
  return _gen
}

export interface RoughStrokeOptions {
  /** rough.js roughness — 0 = crisp, ~1 = pencil, ~3 = very loose. */
  roughness: number
  /** rough.js bowing — how much straight segments bow into arcs. */
  bowing: number
  /** Stable per-element seed. MUST be a fixed nonzero int or rough.js re-randomizes. */
  seed: number
  /** rough.js draws each edge twice by default (the characteristic sketch look). */
  doubleStroke: boolean
}

// A cached op-list: the raw sketch geometry, independent of stroke color/width/zoom.
type CachedSketch = OpSet[]
const _cache = new Map<string, CachedSketch>()

function cacheKey(d: string, o: RoughStrokeOptions): string {
  return `${o.roughness}|${o.bowing}|${o.seed}|${o.doubleStroke ? 1 : 0}|${d}`
}

/** Generate (or fetch cached) rough op-sets for an SVG path `d` string. */
export function roughOpsForPath(d: string, o: RoughStrokeOptions): OpSet[] {
  const key = cacheKey(d, o)
  const hit = _cache.get(key)
  if (hit) return hit

  const opts: Options = {
    roughness: o.roughness,
    bowing: o.bowing,
    seed: o.seed || 1, // 0 means "random each call" in rough.js — never allow it
    disableMultiStroke: !o.doubleStroke,
    // We drive stroke color/width ourselves in Pixi; ask rough.js for stroke-only sets.
    stroke: '#000',
    fill: undefined,
  }
  const drawable = generator().path(d, opts)
  // We only want the stroke sets (type 'path'); fills come from a separate hachure call.
  const sets = drawable.sets.filter((s) => s.type === 'path')
  _cache.set(key, sets)
  return sets
}

/** Replay a rough op-set into a Pixi Graphics as a subpath (no stroke() call). */
function replayOps(g: Graphics, ops: OpSet['ops']): void {
  for (const { op, data } of ops) {
    if (op === 'move') g.moveTo(data[0], data[1])
    else if (op === 'lineTo') g.lineTo(data[0], data[1])
    else if (op === 'bcurveTo') g.bezierCurveTo(data[0], data[1], data[2], data[3], data[4], data[5])
  }
}

export interface RoughStrokeStyle {
  color: number
  /** World-unit stroke width (scales with zoom, like the rest of the drawing). */
  width: number
  alpha?: number
}

/**
 * Stroke an SVG path `d` string into `g` with a hand-drawn look.
 * Caller is responsible for g.clear() and for the transform/zoom (world coords in).
 */
export function drawRoughStroke(
  g: Graphics,
  d: string,
  rough: RoughStrokeOptions,
  style: RoughStrokeStyle,
): void {
  const sets = roughOpsForPath(d, rough)
  for (const set of sets) {
    replayOps(g, set.ops)
    g.stroke({
      color: style.color,
      width: style.width,
      alpha: style.alpha ?? 1,
      cap: 'round',
      join: 'round',
    })
  }
}

/** Clear the memo (used when the playground wants a clean slate). */
export function clearRoughCache(): void {
  _cache.clear()
}

// ---------------------------------------------------------------------------
// Helpers to build an SVG `d` string from primitive shapes, so the playground
// (and later flora-studio's PathData) can feed rough.js.
// ---------------------------------------------------------------------------

/** Polyline / polygon from points. `close` appends 'Z'. */
export function polylineToPath(pts: Array<[number, number]>, close = false): string {
  if (pts.length === 0) return ''
  const head = `M ${pts[0][0]} ${pts[0][1]}`
  const rest = pts.slice(1).map((p) => `L ${p[0]} ${p[1]}`).join(' ')
  return `${head} ${rest}${close ? ' Z' : ''}`
}
