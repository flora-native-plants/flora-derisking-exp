// Cache-contract check for kinematicStroke — the load-bearing porting risk.
// Run: npx tsx scripts/kinematic-cache-test.ts
// kinematicOpsForPath takes NO zoom arg, so it cannot re-randomize on zoom;
// these assertions pin the generate-once / regenerate-only-on-param-change rules.
import assert from 'node:assert'
import {
  kinematicOpsForPath,
  clearKinematicCache,
  type KinematicStrokeOptions,
} from '../src/lib/kinematicStroke'

const D_CLOSED = 'M -260 -150 L 260 -150 L 260 150 L -260 90 Z'
const D_OPEN = 'M -240 20 L -80 20 L 40 -30 L 220 -30'
const base: KinematicStrokeOptions = { squiggle: 6, cpSpacing: 40, seed: 42, overshoot: 4 }

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

console.log('OK: kinematic cache contract holds (9 assertions)')
