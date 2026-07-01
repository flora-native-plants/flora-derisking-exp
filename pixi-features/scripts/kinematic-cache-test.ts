// Cache-contract check for kinematicStroke — the load-bearing porting risk.
// Run: npx tsx scripts/kinematic-cache-test.ts
// kinematicOpsForPath takes NO zoom arg, so it cannot re-randomize on zoom;
// these assertions pin the generate-once / regenerate-only-on-param-change rules.
import assert from 'node:assert'
import {
  kinematicOpsForPath,
  clearKinematicCache,
  STRAIGHT_SQUIGGLE_SCALE,
  BOW_DIVISOR,
  type KinematicStrokeOptions,
} from '../src/lib/kinematicStroke'

const D_CLOSED = 'M -260 -150 L 260 -150 L 260 150 L -260 90 Z'
const D_OPEN = 'M -240 20 L -80 20 L 40 -30 L 220 -30'
const base: KinematicStrokeOptions = { squiggle: 6, cpSpacing: 40, seed: 42, overshoot: 4, cornerAngle: 35 }

clearKinematicCache()

// 1. Same (d, opts) returns the IDENTICAL cached array reference (generate-once).
const a = kinematicOpsForPath(D_CLOSED, base)
const a2 = kinematicOpsForPath(D_CLOSED, { ...base })
assert.strictEqual(a, a2, 'same (d, opts) must return the identical cached op-list reference')

// 2. Determinism: clear cache + same seed => byte-identical geometry.
clearKinematicCache()
const a3 = kinematicOpsForPath(D_CLOSED, base)
assert.deepStrictEqual(a3, a, 'same seed must regenerate identical geometry')

// 3. Changing a param (seed) produces a DIFFERENT op-list (new cache entry).
const diffSeed = kinematicOpsForPath(D_CLOSED, { ...base, seed: 43 })
assert.notDeepStrictEqual(diffSeed, a, 'changing seed must change the geometry')

// 4. squiggle:0 differs from squiggle:6 (the perturbation actually does something).
const crisp = kinematicOpsForPath(D_CLOSED, { ...base, squiggle: 0 })
assert.notDeepStrictEqual(crisp, a, 'squiggle 0 must differ from squiggle 6')

// 5. Output shape is a valid replayable op-list: first op is a move, all ops known.
const KNOWN = new Set(['move', 'lineTo', 'bcurveTo'])
assert.strictEqual(a[0].op, 'move', 'first op must be a move')
assert.ok(a.every((o) => KNOWN.has(o.op)), 'every op must be move/lineTo/bcurveTo')

// 6. Open paths also generate and cache (no closed-path assumption crash).
const open = kinematicOpsForPath(D_OPEN, base)
assert.ok(open.length > 0 && open[0].op === 'move', 'open path must produce ops')

// 7. Changing cpSpacing changes the geometry (closed path).
const diffSpacing = kinematicOpsForPath(D_CLOSED, { ...base, cpSpacing: 80 })
assert.notDeepStrictEqual(diffSpacing, a, 'different cpSpacing must change geometry')

// 8. Changing overshoot changes OPEN-path geometry (overshoot only applies to open paths).
const diffOvershoot = kinematicOpsForPath(D_OPEN, { ...base, overshoot: 12 })
assert.notDeepStrictEqual(diffOvershoot, open, 'different overshoot must change open-path geometry')

// 9. A closed bezier path whose authored `d` repeats its start vertex must NOT leave a
//    coincident seam control point (regression guard for the planting-bed kink).
const BED = 'M -180 -40 C -140 -110, -40 -120, 30 -80 C 90 -48, 120 20, 70 70 C 20 118, -110 110, -170 60 C -210 26, -220 10, -180 -40 Z'
const bedOps = kinematicOpsForPath(BED, base)
const bedAnchors: Array<[number, number]> = []
for (const o of bedOps) {
  if (o.op === 'move') bedAnchors.push([o.data[0], o.data[1]])
  else if (o.op === 'bcurveTo') bedAnchors.push([o.data[4], o.data[5]])
}
let minSeg = Infinity
for (let i = 1; i < bedAnchors.length; i++) {
  minSeg = Math.min(minSeg, Math.hypot(bedAnchors[i][0] - bedAnchors[i - 1][0], bedAnchors[i][1] - bedAnchors[i - 1][1]))
}
assert.ok(minSeg > 1e-3, `closed bezier must not produce a coincident seam CP (min segment ${minSeg})`)

// 10. cornerAngle changes geometry: a 45deg bend is a corner at threshold 30 but not at 60.
const D_BEND = 'M 0 0 L 100 0 L 160 60'
const bend30 = kinematicOpsForPath(D_BEND, { ...base, cornerAngle: 30 })
const bend60 = kinematicOpsForPath(D_BEND, { ...base, cornerAngle: 60 })
assert.notDeepStrictEqual(bend30, bend60, 'cornerAngle must change how a 45deg bend is drawn')

// Helpers for the metric assertions.
const anchorsOf = (ops: typeof bend30): Array<[number, number]> => {
  const a: Array<[number, number]> = []
  for (const o of ops) {
    if (o.op === 'move') a.push([o.data[0], o.data[1]])
    else if (o.op === 'bcurveTo') a.push([o.data[4], o.data[5]])
  }
  return a
}
const sampleOf = (ops: typeof bend30, per = 8): Array<[number, number]> => {
  const pts: Array<[number, number]> = []
  let cur: [number, number] = [0, 0]
  for (const o of ops) {
    if (o.op === 'move') { cur = [o.data[0], o.data[1]]; pts.push(cur) }
    else if (o.op === 'bcurveTo') {
      const p0 = cur, c1 = [o.data[0], o.data[1]], c2 = [o.data[2], o.data[3]], p1 = [o.data[4], o.data[5]]
      for (let s = 1; s <= per; s++) {
        const t = s / per, u = 1 - t
        pts.push([
          u * u * u * p0[0] + 3 * u * u * t * c1[0] + 3 * u * t * t * c2[0] + t * t * t * p1[0],
          u * u * u * p0[1] + 3 * u * u * t * c1[1] + 3 * u * t * t * c2[1] + t * t * t * p1[1],
        ])
      }
      cur = [p1[0], p1[1]]
    }
  }
  return pts
}

// 11. Corner fidelity: every sharp corner of the leader zigzag has a generated anchor near it
//     (proves corners are preserved, not smoothed away). Tolerance = overshoot + small margin.
const D_LEADER = 'M -200 120 L -160 60 L -120 120 L -80 60 L -40 120'
const leaderAnchors = anchorsOf(kinematicOpsForPath(D_LEADER, base))
const CORNERS: Array<[number, number]> = [[-160, 60], [-120, 120], [-80, 60]]
for (const cn of CORNERS) {
  let best = Infinity
  for (const an of leaderAnchors) best = Math.min(best, Math.hypot(an[0] - cn[0], an[1] - cn[1]))
  assert.ok(best <= base.overshoot + 3, `corner ${cn} must have an anchor within ${base.overshoot + 3}px (got ${best.toFixed(2)})`)
}

// 12. Straightness: a dead-straight source segment must not wander. Bound = bow cap + scaled
//     squiggle + margin (encodes the "no drunk straights" fix).
const straightSamples = sampleOf(kinematicOpsForPath('M 0 0 L 400 0', base))
let maxDev = 0
for (const p of straightSamples) maxDev = Math.max(maxDev, Math.abs(p[1]))
// Coarse regression guard (the visual gate is the real straightness judge): a straight run's
// deviation should stay near scaled-squiggle + bow, not full squiggle. '400' is the segment length.
const STRAIGHT_BOUND = base.squiggle * STRAIGHT_SQUIGGLE_SCALE + 400 / BOW_DIVISOR + 4
assert.ok(maxDev <= STRAIGHT_BOUND, `straight segment deviation ${maxDev.toFixed(2)} must be <= ${STRAIGHT_BOUND.toFixed(2)}`)

console.log('OK: kinematic cache contract holds (12 assertions)')
