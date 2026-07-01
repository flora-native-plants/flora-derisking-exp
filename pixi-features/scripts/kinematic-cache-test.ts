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

console.log('OK: kinematic cache contract holds (6 assertions)')
