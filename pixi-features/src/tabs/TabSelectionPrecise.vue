<script setup lang="ts">
/**
 * Precise / drafting selection treatments — the architect's & botanical
 * illustrator's vocabulary, NOT glow. Thin hairlines on paper, restraint over
 * bloom, motion that signals an event then SETTLES (never perpetual).
 *
 * Rendered on a vellum background because dark ink hairlines vanish on a dark
 * canvas — this aesthetic lives on paper.
 *
 * Modes:
 *  A  Registration   — an edge-aligned L-bracket at every CONVEX corner (curved
 *                      shapes get four quadrant arc segments instead), breathing in/out.
 *  B  Drafting Dashes — fine slow-marching dashes on the TRUE contour (3px dash),
 *                      construction-blue. The drafter's dashed boundary.
 *  C  Ink Draw-On     — botanical: a single ink hairline traces the silhouette on
 *                      (pen drawing the contour), holds static, retracts on deselect.
 *  D  Double Rule     — two concentric ink hairlines (engraving-plate / botanical
 *                      key-line + offset rule). Static, fades in.
 *  E  Witness Lines   — architect's dimensioning: extension lines + chevrons project
 *                      outward from every polygon vertex (curved shapes get 8 radial
 *                      lines), bouncing in/out while selected.
 *
 * ZOOM: the overlay lives INSIDE the zoomed `world` container and is drawn in
 * world coordinates, so the ornaments scale with the object — arms, gap, dash,
 * and stroke weight all grow with zoom just like the object's own border. The
 * marks read as part of the drawing, not as detached UI chrome.
 */
import { ref, onMounted, onUnmounted, markRaw } from 'vue'
import { Application, Graphics, Container } from 'pixi.js'
import { useFps } from '../shared/useFps'

type Mode = 'registration' | 'dashes' | 'drawon' | 'double' | 'witness'

interface ShapeDef { draw: (g: Graphics) => void; outline: [number, number][] }
interface Shape { gfx: Graphics; def: ShapeDef; pos: [number, number]; selected: boolean; t: number }

const { fps, frameMs } = useFps()
const canvasEl = ref<HTMLCanvasElement>()
const mode = ref<Mode>('registration')

// Drafting palette on vellum
const PAPER = 0xf2efe6
const DRAFT = 0x2b5d8a   // construction / drafting blue
const INK   = 0x2a2723   // warm near-black ink

let app = markRaw({} as Application)
let world = markRaw({} as Container)    // zoomed/panned layer holding the shapes
let bg = markRaw({} as Graphics)        // screen-space background that catches pan drags
let overlay = markRaw({} as Graphics)   // selection chrome — lives inside `world`, scales with zoom
let shapes: Shape[] = []
let march = 0
let clock = 0   // continuous frame clock for perpetual motion (registration bounce)

// camera — shapes AND the chrome overlay both live in `world`, so both scale with zoom
let zoom = 1, panX = 0, panY = 0
const zoomPct = ref(100)

// NMS: suppress corner/witness marks within this many WORLD units of a stronger one (0 = off)
const nmsRadius = ref(45)
const nmsAlongEdge = ref(true)   // measure distance along the perimeter (arc-length) vs straight-line

// bounce (modes A & E): how fast the marks breathe, how far the swing reaches, and its easing curve
const bounceSpeed = ref(0.09)    // clock multiplier
const bounceAmount = ref(8)      // amplitude in world units (distance out from resting)
const bounceEase = ref<'sine'|'linear'|'back'|'bounce'|'elastic'>('sine')

// ---- shapes (muted plan fills that read on paper) --------------------------------

const SHAPES: ShapeDef[] = [
  { draw(g) { fillStroke(g, 0x9fb8cf, 0x5a7790); g.rect(0,0,190,120).fill().stroke() },
    outline: [[0,0],[190,0],[190,120],[0,120]] },
  { draw(g) { fillStroke(g, 0xaecdb2, 0x6f9075); const p = hex(); poly(g, p) },
    outline: hex() },
  { draw(g) { fillStroke(g, 0xd8c3a0, 0x9c8255); const p: [number,number][] = [[20,80],[100,10],[230,30],[260,100],[160,150],[40,140]]; poly(g, p) },
    outline: [[20,80],[100,10],[230,30],[260,100],[160,150],[40,140]] },
  { draw(g) { fillStroke(g, 0xcdb6cf, 0x8a6b8c); g.circle(70,70,65).fill().stroke() },
    outline: (() => Array.from({length:33},(_,i)=>{const a=(Math.PI*2*i)/32;return [70+Math.cos(a)*65,70+Math.sin(a)*65] as [number,number]}))() },
  // home footprint: an L-shaped building plan (main mass + wing) — 5 convex
  // corners + 1 reflex inner corner at the notch.
  { draw(g) { fillStroke(g, 0xc9a99a, 0x8a6555); poly(g, homeFootprint()) },
    outline: homeFootprint() },
]

function fillStroke(g: Graphics, fill: number, stroke: number) {
  g.setFillStyle({ color: fill, alpha: 0.9 }); g.setStrokeStyle({ width: 1, color: stroke })
}
function poly(g: Graphics, p: [number,number][]) {
  g.moveTo(p[0][0],p[0][1]); for (let i=1;i<p.length;i++) g.lineTo(p[i][0],p[i][1]); g.closePath().fill().stroke()
}
function hex(): [number,number][] {
  return Array.from({length:6},(_,i)=>{const a=(Math.PI/3)*i-Math.PI/6;return [85+Math.cos(a)*80,85+Math.sin(a)*80] as [number,number]})
}
// Complex home footprint — a tall plan with several in/out alcoves & steps on
// both sides (like a real roof plan). Rectilinear: alternating convex outer
// corners and reflex inner corners.
function homeFootprint(): [number,number][] {
  return [
    [60,0],[170,0],          // top mass
    [170,70],[220,70],[220,130],[170,130],   // right protrusion
    [170,200],[210,200],[210,250],[170,250], // right step
    [170,440],[40,440],      // down to bottom, across
    [40,300],[10,300],[10,230],[40,230],     // lower-left alcove
    [40,130],[0,130],[0,60],[60,60],         // upper-left wide protrusion
  ]
}

// ---- geometry helpers ------------------------------------------------------------

// THE zoom contract (this aesthetic): the chrome is drawn in WORLD space and the
// overlay lives INSIDE the zoomed `world` container, so ornaments scale with the
// object — arms, gap, dash, and stroke weight all grow with zoom exactly like the
// object's own border. The marks read as part of the drawing, not detached UI.
function worldOutline(s: Shape): [number,number][] {
  return s.def.outline.map(([x,y]) => [ x + s.pos[0], y + s.pos[1] ] as [number,number])
}
function arcLen(pts: [number,number][]) {
  const cum = [0]; let total = 0
  for (let i=1;i<pts.length;i++){ total += Math.hypot(pts[i][0]-pts[i-1][0], pts[i][1]-pts[i-1][1]); cum.push(total) }
  // close back to start
  total += Math.hypot(pts[0][0]-pts[pts.length-1][0], pts[0][1]-pts[pts.length-1][1]); cum.push(total)
  return { cum, total }
}
function edgeNormal(a: [number,number], b: [number,number]): [number,number] {
  const dx=b[0]-a[0], dy=b[1]-a[1]; const l=Math.hypot(dx,dy)||1; return [dy/l, -dx/l]
}
// per-vertex outward unit normal + turn (sharpness) + convex flag + arc-length
// position `s` along the perimeter; `perim` is the full perimeter (for wrap).
interface VMark { x:number; y:number; nx:number; ny:number; turn:number; convex:boolean; s:number; perim:number }
function vertexNormals(pts: [number,number][]): VMark[] {
  let v = pts.slice()
  if (v.length>1 && v[0][0]===v[v.length-1][0] && v[0][1]===v[v.length-1][1]) v = v.slice(0,-1)
  const n = v.length
  let cx=0, cy=0, area2=0
  const cum: number[] = []; let acc = 0
  for (let i=0;i<n;i++){
    cx+=v[i][0]; cy+=v[i][1]; const j=(i+1)%n
    area2 += v[i][0]*v[j][1] - v[j][0]*v[i][1]
    cum[i] = acc; acc += Math.hypot(v[j][0]-v[i][0], v[j][1]-v[i][1])
  }
  cx/=n; cy/=n; const perim = acc
  const res: VMark[] = []
  for (let i=0;i<n;i++){
    const prev=v[(i-1+n)%n], cur=v[i], next=v[(i+1)%n]
    const i1x=cur[0]-prev[0], i1y=cur[1]-prev[1]; const l1=Math.hypot(i1x,i1y)||1
    const i2x=next[0]-cur[0], i2y=next[1]-cur[1]; const l2=Math.hypot(i2x,i2y)||1
    const ix=i1x/l1, iy=i1y/l1, ox=i2x/l2, oy=i2y/l2
    const turn = Math.acos(Math.max(-1, Math.min(1, ix*ox + iy*oy)))   // 0 = straight, π = spike
    const convex = Math.sign(ix*oy - iy*ox) === Math.sign(area2)
    const n1=edgeNormal(prev,cur), n2=edgeNormal(cur,next)
    let nx=n1[0]+n2[0], ny=n1[1]+n2[1]; const l=Math.hypot(nx,ny)||1; nx/=l; ny/=l
    if ((cur[0]-cx)*nx + (cur[1]-cy)*ny < 0){ nx=-nx; ny=-ny }
    res.push({ x: cur[0], y: cur[1], nx, ny, turn, convex, s: cum[i], perim })
  }
  return res
}

// Non-maximum suppression over corner marks: sort by score (sharper, convex
// preferred), greedily keep, suppress any remaining mark within minDist.
// alongEdge=true measures distance ALONG the perimeter (arc-length) instead of
// straight-line — this is what lets one radius keep a wide-edged hexagon's
// corners while still collapsing a footprint's short-edged steps.
function suppressClose<T extends { x:number; y:number; turn:number; convex?:boolean; s?:number; perim?:number }>(
  marks: T[], minDist: number, alongEdge: boolean): T[] {
  if (minDist <= 0 || marks.length < 2) return marks
  const score = (m: T) => m.turn + (m.convex === false ? 0 : 0.4)
  const order = marks.map((_, i) => i).sort((a, b) => score(marks[b]) - score(marks[a]))
  const kept: T[] = []
  const tooClose = (a: T, b: T) => {
    if (alongEdge && a.s !== undefined && b.s !== undefined && a.perim) {
      let d = Math.abs(a.s - b.s); d = Math.min(d, a.perim - d)   // circular arc distance
      return d < minDist
    }
    return (a.x-b.x)**2 + (a.y-b.y)**2 < minDist*minDist           // straight-line distance
  }
  for (const i of order) {
    const m = marks[i]
    if (kept.every(k => !tooClose(k, m))) kept.push(m)
  }
  return kept
}
// constant outward offset polygon (reuses the vertex normals)
function offsetPoly(pts: [number,number][], d: number): [number,number][] {
  const out: [number,number][] = vertexNormals(pts).map(p => [p.x + p.nx*d, p.y + p.ny*d] as [number,number])
  out.push(out[0]); return out
}

// Corners with a meaningful turn, filtered by kind. 'convex' = outward-pointing,
// 'concave' = inward-pointing (reflex). Shallow vertices that merely sample a
// curve are skipped, so a circle yields none of either kind.
interface Corner { x:number; y:number; ix:number; iy:number; ox:number; oy:number; nx:number; ny:number; turn:number; convex:boolean; s:number; perim:number }
function findCorners(pts: [number,number][], kind: 'convex'|'concave', minTurnDeg = 28): Corner[] {
  let v = pts.slice()
  if (v.length>1 && v[0][0]===v[v.length-1][0] && v[0][1]===v[v.length-1][1]) v = v.slice(0,-1)
  const n = v.length
  let cx=0, cy=0, area2=0
  const cum: number[] = []; let acc = 0
  for (let i=0;i<n;i++){
    cx+=v[i][0]; cy+=v[i][1]; const j=(i+1)%n
    area2 += v[i][0]*v[j][1] - v[j][0]*v[i][1]
    cum[i] = acc; acc += Math.hypot(v[j][0]-v[i][0], v[j][1]-v[i][1])
  }
  cx/=n; cy/=n; const perim = acc
  const cosMax = Math.cos(minTurnDeg * Math.PI/180)
  const res: Corner[] = []
  for (let i=0;i<n;i++){
    const prev=v[(i-1+n)%n], cur=v[i], next=v[(i+1)%n]
    const i1x=cur[0]-prev[0], i1y=cur[1]-prev[1]; const l1=Math.hypot(i1x,i1y)||1
    const i2x=next[0]-cur[0], i2y=next[1]-cur[1]; const l2=Math.hypot(i2x,i2y)||1
    const ix=i1x/l1, iy=i1y/l1, ox=i2x/l2, oy=i2y/l2
    const dot = ix*ox + iy*oy
    if (dot > cosMax) continue                           // too straight → not a real corner
    const cross = ix*oy - iy*ox
    const isConvex = Math.sign(cross) === Math.sign(area2)
    if (kind === 'convex' ? !isConvex : isConvex) continue
    // outward bisector normal (averaged edge normals, pushed into the open wedge)
    const n1=edgeNormal(prev,cur), n2=edgeNormal(cur,next)
    let nx=n1[0]+n2[0], ny=n1[1]+n2[1]; const l=Math.hypot(nx,ny)||1; nx/=l; ny/=l
    if ((cur[0]-cx)*nx + (cur[1]-cy)*ny < 0){ nx=-nx; ny=-ny }
    res.push({ x:cur[0], y:cur[1], ix, iy, ox, oy, nx, ny, turn: Math.acos(Math.max(-1,Math.min(1,dot))), convex: isConvex, s: cum[i], perim })
  }
  return res
}

// ---- per-mode drawing (s.t in 0..1 drives the entrance) --------------------------

function centroidRadius(pts: [number,number][]) {
  let v = pts.slice()
  if (v.length>1 && v[0][0]===v[v.length-1][0] && v[0][1]===v[v.length-1][1]) v = v.slice(0,-1)
  const n = v.length; let cx=0, cy=0; for (const p of v){ cx+=p[0]; cy+=p[1] } cx/=n; cy/=n
  let r=0; for (const p of v) r += Math.hypot(p[0]-cx, p[1]-cy); r/=n
  return { cx, cy, r }
}

function drawRegistration(s: Shape) {
  const wo = worldOutline(s); const t = ease(s.t)
  // continuous bounce: marks swing out from a resting gap by the eased oscillation
  const out = 6 + bounceAmount.value * bounceOsc()
  const arm = 14
  const g = overlay
  g.setStrokeStyle({ width: 1, color: DRAFT, alpha: t })

  const convex = findCorners(wo, 'convex')
  const concave = findCorners(wo, 'concave')
  if (convex.length + concave.length === 0) {
    // truly curved shape (no sharp corners of either kind) → four concentric
    // arc segments at the quadrant diagonals: the circle's analog of brackets.
    const { cx, cy, r } = centroidRadius(wo)
    const R = r + out
    // match the corner bracket's total path length (two arms) — convert px → angle
    const half = (arm * 2) / (2 * R)   // radians; arc length 2·half·R = 2·arm
    g.setStrokeStyle({ width: 1, color: DRAFT, alpha: t, cap: 'round' })
    for (const c of [Math.PI*0.25, Math.PI*0.75, Math.PI*1.25, Math.PI*1.75]) {
      g.moveTo(cx + Math.cos(c-half)*R, cy + Math.sin(c-half)*R)
      g.arc(cx, cy, R, c-half, c+half)
    }
    g.stroke()
    return
  }

  // an edge-aligned L-bracket just outside every CONVEX corner (concave notches
  // are left bare), with NMS to thin clusters of close corners
  void concave
  for (const c of suppressClose(convex, nmsRadius.value, nmsAlongEdge.value)) {
    const qx = c.x + c.nx*out, qy = c.y + c.ny*out         // corner offset along its outward bisector (bounces)
    g.moveTo(qx + c.ox*arm, qy + c.oy*arm)                 // arm along the outgoing edge
     .lineTo(qx, qy)
     .lineTo(qx - c.ix*arm, qy - c.iy*arm)                 // arm back along the incoming edge
  }
  g.stroke()
}

function drawDashes(s: Shape) {
  const o = offsetPoly(worldOutline(s), 4); const t = ease(s.t)
  drawDashedClosed(o, march, 3, 4, DRAFT, t, 0.9)
}

function drawDrawOn(s: Shape) {
  const o = offsetPoly(worldOutline(s), 3); const al = arcLen(o)
  const upto = ease(s.t) * al.total
  const g = overlay
  g.setStrokeStyle({ width: 1.1, color: INK, alpha: 1 })
  let acc = 0; let started = false; let headX=o[0][0], headY=o[0][1]
  for (let i=0;i<o.length;i++){
    const a=o[i], bpt=o[(i+1)%o.length]
    const seg = Math.hypot(bpt[0]-a[0], bpt[1]-a[1])
    if (acc + seg <= upto) {
      if (!started){ g.moveTo(a[0],a[1]); started=true }
      g.lineTo(bpt[0],bpt[1]); headX=bpt[0]; headY=bpt[1]
    } else if (acc < upto) {
      const f=(upto-acc)/seg
      if (!started){ g.moveTo(a[0],a[1]); started=true }
      headX=a[0]+(bpt[0]-a[0])*f; headY=a[1]+(bpt[1]-a[1])*f
      g.lineTo(headX, headY); break
    } else break
    acc += seg
  }
  if (started) g.stroke()
  // pen head dot while drawing
  if (s.t < 0.995) { g.setFillStyle({ color: INK, alpha: 1 }); g.circle(headX, headY, 1.6).fill() }
}

function drawDouble(s: Shape) {
  const wo = worldOutline(s); const t = ease(s.t)
  const inner = wo.concat([wo[0]]); const outer = offsetPoly(wo, 3.5)
  const g = overlay
  g.setStrokeStyle({ width: 1.1, color: INK, alpha: t })
  g.moveTo(inner[0][0],inner[0][1]); for (let i=1;i<inner.length;i++) g.lineTo(inner[i][0],inner[i][1]); g.stroke()
  g.setStrokeStyle({ width: 0.6, color: INK, alpha: t * 0.55 })
  g.moveTo(outer[0][0],outer[0][1]); for (let i=1;i<outer.length;i++) g.lineTo(outer[i][0],outer[i][1]); g.stroke()
}

// one witness/extension line + outward chevron, from a base point along normal n
function witnessTick(g: Graphics, bx: number, by: number, nx: number, ny: number, gap: number, ext: number) {
  const sx = bx + nx*gap,        sy = by + ny*gap
  const ex = bx + nx*(gap+ext),  ey = by + ny*(gap+ext)
  g.moveTo(sx, sy).lineTo(ex, ey)
  const px = -ny, py = nx, barb = 4, spread = 2.4   // chevron at the tip
  g.moveTo(ex, ey).lineTo(ex - nx*barb + px*spread, ey - ny*barb + py*spread)
  g.moveTo(ex, ey).lineTo(ex - nx*barb - px*spread, ey - ny*barb - py*spread)
}

function drawWitness(s: Shape) {
  const wo = worldOutline(s); const t = ease(s.t)
  const gap = 5
  const ext = (6 + bounceAmount.value * bounceOsc()) * t   // extension swings out by the eased oscillation
  const g = overlay
  // faint key-line on the actual contour
  g.setStrokeStyle({ width: 0.6, color: DRAFT, alpha: t * 0.5 })
  g.moveTo(wo[0][0], wo[0][1]); for (let i=1;i<wo.length;i++) g.lineTo(wo[i][0], wo[i][1]); g.closePath().stroke()

  g.setStrokeStyle({ width: 1, color: DRAFT, alpha: t })
  const sharp = findCorners(wo, 'convex').length + findCorners(wo, 'concave').length
  if (sharp === 0) {
    // curved shape → 8 radial witness lines (4 cardinal + 4 diagonal), not one per vertex
    const { cx, cy, r } = centroidRadius(wo)
    for (let k=0;k<8;k++) {
      const a = k * Math.PI/4, nx = Math.cos(a), ny = Math.sin(a)
      witnessTick(g, cx + nx*r, cy + ny*r, nx, ny, gap, ext)
    }
  } else {
    for (const { x, y, nx, ny } of suppressClose(vertexNormals(wo), nmsRadius.value, nmsAlongEdge.value))
      witnessTick(g, x, y, nx, ny, gap, ext)
  }
  g.stroke()
}

// ---- dashed closed polyline (fine, restrained) -----------------------------------

function drawDashedClosed(pts: [number,number][], offset: number, dash: number, gap: number, color: number, alpha: number, width: number) {
  const period = dash + gap; const g = overlay
  g.setStrokeStyle({ width, color, alpha })
  const ring = pts[0][0]===pts[pts.length-1][0] && pts[0][1]===pts[pts.length-1][1] ? pts : pts.concat([pts[0]])
  let carry = -(((offset % period) + period) % period)
  for (let i=1;i<ring.length;i++){
    const ax=ring[i-1][0], ay=ring[i-1][1], bx=ring[i][0], by=ring[i][1]
    const segLen=Math.hypot(bx-ax,by-ay); if (segLen<1e-3) continue
    const dx=(bx-ax)/segLen, dy=(by-ay)/segLen
    let dist=carry, t=0
    while (t<segLen){
      const phase=((dist+t)%period+period)%period
      const inDash=phase<dash
      const remain=inDash?dash-phase:period-phase
      const step=Math.min(remain, segLen-t); const nt=t+step
      if (nt<=t) break
      if (inDash){ g.moveTo(ax+dx*t,ay+dy*t).lineTo(ax+dx*nt,ay+dy*nt) }
      t=nt
    }
    carry=((carry+segLen)%period+period)%period
  }
  g.stroke()
}

function ease(t: number) { return t<0?0:t>1?1:t*t*(3-2*t) }   // smoothstep (entrance fade)

// ---- bounce easing ---------------------------------------------------------------
// Each entry maps cycle phase p∈[0,1) → "how far out" ∈ ~[0,1] (0 at the ends).
// Triangle-based ones ease a 0→1→0 ramp; sine is the smooth symmetric default.
const TAU = Math.PI * 2
const tri = (p: number) => 1 - Math.abs(2*p - 1)
const smooth = (t: number) => t*t*(3 - 2*t)
const outBack = (t: number) => { const c1=1.70158, c3=c1+1; return 1 + c3*(t-1)**3 + c1*(t-1)**2 }
const outBounce = (t: number) => {
  const n1=7.5625, d1=2.75
  if (t < 1/d1) return n1*t*t
  if (t < 2/d1) { t-=1.5/d1; return n1*t*t + 0.75 }
  if (t < 2.5/d1) { t-=2.25/d1; return n1*t*t + 0.9375 }
  t-=2.625/d1; return n1*t*t + 0.984375
}
const outElastic = (t: number) => t===0?0 : t===1?1 : Math.pow(2,-10*t)*Math.sin((t*10-0.75)*(TAU/3)) + 1
// Energetic easings only show their character on a full 0→1 sweep, so run them as
// an asymmetric PULSE: pop out (with character) → ease back → rest. That keeps the
// overshoot/bounce/spring at full amplitude instead of cancelling on a symmetric ramp.
function pulse(p: number, easeOut: (t: number) => number): number {
  if (p < 0.45) return easeOut(p / 0.45)          // pop out — easing personality lives here
  if (p < 0.80) return 1 - smooth((p - 0.45) / 0.35)  // ease back in
  return 0                                         // rest (held in) until the next pulse
}
const OSC: Record<string, (p: number) => number> = {
  sine:    p => 0.5 - 0.5*Math.cos(TAU*p),   // calm continuous breathe (slow at ends)
  linear:  p => tri(p),                       // mechanical breathe (constant speed, sharp reversal)
  back:    p => pulse(p, outBack),            // pop + overshoot, then rest
  bounce:  p => pulse(p, outBounce),          // pop + ball-bounce, then rest
  elastic: p => pulse(p, outElastic),         // pop + spring wobble, then rest
}
function bounceOsc(): number {
  const p = (((clock * bounceSpeed.value) % TAU) + TAU) % TAU / TAU
  return (OSC[bounceEase.value] ?? OSC.sine)(p)
}

// ---- interaction + ticker --------------------------------------------------------

function onShapeClick(i: number) { shapes[i].selected = !shapes[i].selected }

// ---- camera ----------------------------------------------------------------------

function clamp(v: number, a: number, b: number) { return v<a?a:v>b?b:v }
function applyCamera() {
  world.scale.set(zoom)
  world.position.set(panX, panY)
  zoomPct.value = Math.round(zoom * 100)
}
function onWheel(e: WheelEvent) {
  e.preventDefault()
  const rect = (e.currentTarget as HTMLCanvasElement).getBoundingClientRect()
  const mx = e.clientX - rect.left, my = e.clientY - rect.top
  const nz = clamp(zoom * Math.exp(-e.deltaY * 0.0015), 0.25, 8)
  // keep the world point under the cursor pinned while zooming
  const wx = (mx - panX) / zoom, wy = (my - panY) / zoom
  panX = mx - wx*nz; panY = my - wy*nz; zoom = nz
  applyCamera()
}
let panning = false, lastPX = 0, lastPY = 0

function onTick(t: { deltaTime: number }) {
  march += 0.5 * t.deltaTime
  clock += t.deltaTime
  for (const s of shapes) {
    const target = s.selected ? 1 : 0
    s.t += (target - s.t) * Math.min(1, 0.18 * t.deltaTime)
  }
  overlay.clear()
  for (const s of shapes) {
    if (s.t < 0.005) continue
    if (mode.value === 'registration') drawRegistration(s)
    else if (mode.value === 'dashes') drawDashes(s)
    else if (mode.value === 'drawon') drawDrawOn(s)
    else if (mode.value === 'double') drawDouble(s)
    else if (mode.value === 'witness') drawWitness(s)
  }
}

onMounted(async () => {
  const canvas = canvasEl.value!
  app = markRaw(new Application())
  await app.init({ canvas, preference: 'webgl', width: canvas.clientWidth, height: canvas.clientHeight,
    antialias: true, background: PAPER, resolution: devicePixelRatio, autoDensity: true })

  // bg (screen-space, catches pan drags on empty paper) → world (zoomed shapes) → overlay (screen-space chrome)
  bg = markRaw(new Graphics())
  bg.eventMode = 'static'; bg.hitArea = app.screen
  world = markRaw(new Container())
  overlay = markRaw(new Graphics())
  overlay.eventMode = 'none'
  app.stage.addChild(bg, world)        // overlay goes INSIDE world (below), so it scales with zoom
  app.stage.eventMode = 'static'

  const positions: [number,number][] = [[80,70],[380,60],[80,330],[400,300],[600,110]]
  for (let i=0;i<SHAPES.length;i++){
    const def=SHAPES[i]; const gfx=markRaw(new Graphics()); def.draw(gfx)
    gfx.position.set(positions[i][0], positions[i][1])
    gfx.eventMode='static'; gfx.cursor='pointer'; const idx=i
    gfx.on('pointerdown', () => onShapeClick(idx))
    world.addChild(gfx)
    shapes.push({ gfx, def, pos: positions[i], selected: i===0, t: i===0?1:0 })
  }
  world.addChild(overlay)              // chrome on top of the shapes, inside the zoomed world

  // pan: drag on empty paper (shapes are above bg, so they win their own clicks)
  bg.on('pointerdown', (e) => { panning = true; lastPX = e.global.x; lastPY = e.global.y })
  app.stage.on('globalpointermove', (e) => {
    if (!panning) return
    panX += e.global.x - lastPX; panY += e.global.y - lastPY
    lastPX = e.global.x; lastPY = e.global.y; applyCamera()
  })
  const endPan = () => { panning = false }
  app.stage.on('pointerup', endPan); app.stage.on('pointerupoutside', endPan)
  canvas.addEventListener('wheel', onWheel, { passive: false })

  applyCamera()
  app.ticker.add(onTick)
})

onUnmounted(() => {
  canvasEl.value?.removeEventListener('wheel', onWheel)
  app?.ticker?.remove(onTick)
  app?.destroy(true,{children:true,texture:true,context:true})
})

const MODES: { id: Mode; label: string }[] = [
  { id: 'registration', label: 'A · Registration' },
  { id: 'dashes',       label: 'B · Drafting Dashes' },
  { id: 'drawon',       label: 'C · Ink Draw-On' },
  { id: 'double',       label: 'D · Double Rule' },
  { id: 'witness',      label: 'E · Witness Lines' },
]
// Switching mode keeps the current selection so you can compare treatments on
// the same shapes. Shape 0 starts selected (set in onMounted).
function selectMode(m: Mode){ mode.value = m }

const DESC: Record<Mode,string> = {
  registration: 'A — crop/registration corner marks + edge ticks just outside the bounds, breathing in/out continuously. The drafter\'s sheet corner.',
  dashes:       'B — fine slow-marching 3px dashes on the true contour, construction-blue. Restrained, not gaudy.',
  drawon:       'C — botanical: a single ink hairline traces the silhouette on, holds, retracts on deselect.',
  double:       'D — two concentric ink hairlines (key-line + offset rule). Engraving-plate / botanical key.',
  witness:      'E — architect dimensioning: extension lines project outward from EVERY polygon vertex with chevron arrow ticks.',
}
</script>

<template>
  <div class="wrap">
    <canvas ref="canvasEl" />
    <div class="hud"><div class="fps">{{ fps }} <span>fps</span></div><div>{{ frameMs }} ms</div><div class="zoom">{{ zoomPct }}%</div></div>
    <div class="mode-strip">
      <button v-for="m in MODES" :key="m.id" :class="['mode-btn',{active: mode===m.id}]" @click="selectMode(m.id)">{{ m.label }}</button>
    </div>
    <div v-if="mode === 'registration' || mode === 'witness'" class="controls">
      <div class="ctrl-title">Bounce</div>
      <label>Speed
        <input type="range" v-model.number="bounceSpeed" min="0" max="0.3" step="0.01" />
        {{ bounceSpeed === 0 ? 'still' : bounceSpeed.toFixed(2) }}
      </label>
      <label>Distance
        <input type="range" v-model.number="bounceAmount" min="0" max="24" step="1" />
        {{ bounceAmount }}u
      </label>
      <label>Easing
        <select v-model="bounceEase">
          <option value="sine">Sine — calm breathe</option>
          <option value="linear">Linear — mechanical</option>
          <option value="back">Back — pop + overshoot</option>
          <option value="bounce">Bounce — pop + bounce</option>
          <option value="elastic">Elastic — pop + spring</option>
        </select>
      </label>
      <div class="ctrl-title" style="margin-top:4px">Corner NMS</div>
      <label>Radius
        <input type="range" v-model.number="nmsRadius" min="0" max="120" step="5" />
        {{ nmsRadius === 0 ? 'off' : nmsRadius + 'u' }}
      </label>
      <label class="check"><input type="checkbox" v-model="nmsAlongEdge" /> along edge (arc-length)</label>
      <div class="hint-small">suppress marks within N units of a sharper one — measured {{ nmsAlongEdge ? 'along the border' : 'straight-line' }}</div>
    </div>
    <div class="desc">{{ DESC[mode] }} <span class="hint">· click shapes to select · scroll to zoom · drag paper to pan</span></div>
  </div>
</template>

<style scoped>
.wrap { position: relative; width: 100%; height: 100%; background: #f2efe6; }
canvas { display: block; width: 100%; height: 100%; }
.hud { position: absolute; top: 10px; left: 10px; font-family: monospace; font-size: 12px; color: #5a7; line-height: 1.7; pointer-events: none; }
.fps { font-size: 18px; font-weight: bold; color: #3a7; }
.fps span { font-size: 12px; color: #6b8; }
.zoom { color: #7a7466; }
.controls {
  position: absolute; top: 96px; right: 14px;
  display: flex; flex-direction: column; gap: 7px;
  font-family: monospace; font-size: 12px; color: #5a5446;
  background: rgba(255,255,255,0.85); padding: 10px 14px; border-radius: 6px;
  border: 1px solid #d8d2c4; min-width: 180px;
}
.ctrl-title { font-size: 11px; color: #8a8474; }
.controls label { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.controls input[type=range] { width: 90px; }
.controls select { font-family: monospace; font-size: 11px; background: #faf8f2; color: #2a2723; border: 1px solid #d0c9ba; border-radius: 3px; padding: 1px 3px; }
.hint-small { font-size: 9px; color: #a09a8a; }
.mode-strip {
  position: absolute; top: 10px; left: 50%; transform: translateX(-50%);
  display: flex; gap: 4px; background: rgba(255,255,255,0.8); padding: 6px 10px;
  border-radius: 6px; border: 1px solid #d8d2c4;
}
.mode-btn {
  padding: 5px 10px; border: 1px solid #d0c9ba; border-radius: 4px;
  background: #faf8f2; color: #5a5446; font-family: monospace; font-size: 11px;
  cursor: pointer; transition: background 0.15s;
}
.mode-btn:hover { background: #f0ece1; color: #2a2723; }
.mode-btn.active { background: #2b5d8a; border-color: #2b5d8a; color: #fff; }
.desc {
  position: absolute; bottom: 10px; left: 50%; transform: translateX(-50%);
  font-family: monospace; font-size: 11px; color: #6a6456;
  background: rgba(255,255,255,0.8); padding: 5px 14px; border-radius: 4px;
  max-width: 90%; text-align: center; pointer-events: none; border: 1px solid #e0dacd;
}
.hint { color: #a09a8a; }
</style>
