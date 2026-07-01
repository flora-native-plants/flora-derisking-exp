// Unit tests for the Phase-1.5 pure geometry helpers.
// Run: npx tsx scripts/kinematic-geometry-test.ts
import assert from 'node:assert'
import {
  turnAngle,
  splitAtCorners,
  chordDeviation,
  isStraightRun,
  bowRun,
} from '../src/lib/kinematicStroke'

type Pt = [number, number]
const CORNER_35 = (35 * Math.PI) / 180

// turnAngle: a straight run has ~0 turn; a right angle has ~PI/2.
assert.ok(turnAngle([0, 0], [10, 0], [20, 0]) < 1e-6, 'collinear points have zero turn angle')
assert.ok(Math.abs(turnAngle([0, 0], [10, 0], [10, 10]) - Math.PI / 2) < 1e-6, 'right angle is PI/2')

// splitAtCorners: open zigzag -> one run per corner-to-corner span.
const zig: Pt[] = [[-200, 120], [-160, 60], [-120, 120], [-80, 60], [-40, 120]]
const zigOut = splitAtCorners(zig, false, CORNER_35)
assert.strictEqual(zigOut.runs.length, 4, 'zigzag splits into 4 runs')
assert.strictEqual(zigOut.loop, false, 'zigzag is not a loop')

// splitAtCorners: closed square -> 4 corner-to-corner runs, not a loop.
const square: Pt[] = [[0, 0], [100, 0], [100, 100], [0, 100]]
const sqOut = splitAtCorners(square, true, CORNER_35)
assert.strictEqual(sqOut.runs.length, 4, 'square splits into 4 runs')
assert.strictEqual(sqOut.loop, false, 'square with corners is not a smooth loop')

// splitAtCorners: smooth closed 24-gon (15deg turns) -> single smooth loop.
const circle: Pt[] = []
for (let k = 0; k < 24; k++) {
  const a = (k / 24) * Math.PI * 2
  circle.push([Math.cos(a) * 100, Math.sin(a) * 100])
}
const circOut = splitAtCorners(circle, true, CORNER_35)
assert.strictEqual(circOut.runs.length, 1, 'smooth polygon stays a single run')
assert.strictEqual(circOut.loop, true, 'smooth closed polygon is a loop')

// splitAtCorners: 2-point open segment -> one run.
assert.strictEqual(splitAtCorners([[0, 0], [400, 0]], false, CORNER_35).runs.length, 1, 'segment is one run')

// chordDeviation / isStraightRun.
assert.ok(chordDeviation([[0, 0], [50, 0], [100, 0]]) < 1e-9, 'straight run has zero chord deviation')
assert.ok(isStraightRun([[0, 0], [100, 0], [200, 0], [400, 0]]), 'collinear run is straight')
const arc: Pt[] = [[100, 0], [70, 70], [0, 100], [-70, 70], [-100, 0]]
assert.ok(!isStraightRun(arc), 'semicircle run is not straight')

// bowRun: endpoints fixed, middle displaced perpendicular by amp.
const bowed = bowRun([[0, 0], [100, 0], [200, 0]], 10)
assert.deepStrictEqual(bowed[0], [0, 0], 'bow leaves the start fixed')
assert.deepStrictEqual(bowed[2], [200, 0], 'bow leaves the end fixed')
assert.ok(Math.abs(bowed[1][0] - 100) < 1e-9 && Math.abs(bowed[1][1] - 10) < 1e-9, 'bow displaces the midpoint by amp')

console.log('OK: kinematic geometry helpers (15 assertions)')
