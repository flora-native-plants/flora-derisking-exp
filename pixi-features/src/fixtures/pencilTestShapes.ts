// pencilTestShapes.ts — shared sample landscape-CAD geometry for pencil-NPR tabs.
// Lifted verbatim from TabSketchStyle so every experiment renders the identical
// shapes. A valid A/B (rough.js vs kinematic) requires identical geometry.
import { polylineToPath } from '../lib/roughStroke'

export interface PencilShape { label: string; d: string; color: number }

// Palette constants (were inline hex in the original tab).
const COLOR_BOUNDARY = 0x2b2b28
const COLOR_BED = 0x4b7a4b
const COLOR_WALK = 0x8a6d3b
const COLOR_LEADER = 0x3b6ea5

export function pencilTestShapes(): PencilShape[] {
  // A property boundary (closed polygon)
  const boundary = polylineToPath(
    [[-260, -150], [260, -150], [260, 150], [40, 150], [-60, 90], [-260, 90]],
    true,
  )
  // A curvy planting-bed outline (beziers)
  const bed =
    'M -180 -40 C -140 -110, -40 -120, 30 -80 ' +
    'C 90 -48, 120 20, 70 70 ' +
    'C 20 118, -110 110, -170 60 ' +
    'C -210 26, -220 10, -180 -40 Z'
  // A straight walkway path (open polyline)
  const walk = polylineToPath([[-240, 20], [-80, 20], [40, -30], [220, -30]])
  // A dimension-leader style zigzag
  const leader = polylineToPath([[-200, 120], [-160, 60], [-120, 120], [-80, 60], [-40, 120]])

  return [
    { label: 'Property boundary (polygon)', d: boundary, color: COLOR_BOUNDARY },
    { label: 'Planting bed (bezier)',        d: bed,      color: COLOR_BED },
    { label: 'Walkway (polyline)',           d: walk,     color: COLOR_WALK },
    { label: 'Leader zigzag',                d: leader,   color: COLOR_LEADER },
  ]
}
