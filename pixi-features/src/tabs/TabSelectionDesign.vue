<script setup lang="ts">
/**
 * Selection Design derisking tab — four Flora-branded selection treatments.
 *
 *  A  Field Marks    — corner brackets + vertex monuments, GSAP back.out entrance, breathing scale
 *  B  Living Hairline — marching ants on path + soft blur-glow pulse
 *  C  Ink Bloom      — outline draws itself on, leaf ticks bloom, displacement wobble
 *  D  Aura           — pure blur-glow fill behind hairline, pulsing vertex rings
 *  E  Arc Pulse      — C's race-track draw-on + D's pulsing circles, no leaf ticks
 *
 * Glow is core BlurFilter (not pixi-filters GlowFilter) — matches the look the design was tuned against.
 */
import { ref, watch, onMounted, onUnmounted, markRaw, computed } from 'vue'
import { Application, Graphics, Container, Sprite, Texture, BlurFilter, DisplacementFilter } from 'pixi.js'
import gsap from 'gsap'
import { useFps } from '../shared/useFps'

type Mode = 'A' | 'B' | 'C' | 'D' | 'E'
interface ModeHandle { enter(): void; update?(dt: number): void; refresh(): void; destroy(): void }

// ---- palette -------------------------------------------------------------------
const PAL = { sage: 0x3a5836, paper: 0xf6f5ee, ink: 0x1c1c1a, terra: 0xc25739,
              plant: 0xa9b386, grass: 0xd6daba, pad: 0xf4ede0 }

const CHROME_OPTS = [
  { hex: 0x3a5836, css: '#3a5836' },
  { hex: 0xc25739, css: '#c25739' },
  { hex: 0x1c1c1a, css: '#1c1c1a' },
  { hex: 0xc98c2b, css: '#c98c2b' },
]

// ---- geometry — stepped footprint ---------------------------------------------
const PTS: [number, number][] = [
  [120,70],[300,70],[300,148],[348,148],[348,250],[150,250],[150,176],[120,176],
]
const xs = PTS.map(p => p[0]), ys = PTS.map(p => p[1])
const bx0 = Math.min(...xs), bx1 = Math.max(...xs), by0 = Math.min(...ys), by1 = Math.max(...ys)
const bcx = (bx0+bx1)/2, bcy = (by0+by1)/2

// SP: slightly enlarged chrome outline; SPC: closed loop
const SP: [number, number][] = PTS.map(([x,y]) => [bcx+(x-bcx)*1.06, bcy+(y-bcy)*1.06])
const SPC = [...SP, SP[0]]
const cum = [0]; let PER = 0
for (let i = 1; i < SPC.length; i++) {
  PER += Math.hypot(SPC[i][0]-SPC[i-1][0], SPC[i][1]-SPC[i-1][1])
  cum.push(PER)
}
function pointAt(d: number): [number, number] {
  d = ((d % PER) + PER) % PER
  for (let i = 1; i < cum.length; i++) {
    if (d <= cum[i]) {
      const t = (d - cum[i-1]) / (cum[i]-cum[i-1] || 1)
      return [SPC[i-1][0]+(SPC[i][0]-SPC[i-1][0])*t, SPC[i-1][1]+(SPC[i][1]-SPC[i-1][1])*t]
    }
  }
  return SP[0]
}

// ---- reactive state ------------------------------------------------------------
const { fps, frameMs } = useFps()
const canvasEl = ref<HTMLCanvasElement>()
const mode    = ref<Mode>('A')
const dark    = ref(false)
const chromeHex = ref(PAL.sage)

// per-mode params
const aBreath = ref(1.2), aMon = ref(3.4), aGlow = ref(0)
const bSpeed  = ref(40),  bDash = ref(6),  bGlow = ref(1.4)
const cDur    = ref(1.2), cWob  = ref(1.5), cGlow = ref(0.8)
const dDist   = ref(18),  dStr  = ref(2.4), dSpd  = ref(2.0)
const eDur    = ref(1.2), eSpd  = ref(30),  eGlow = ref(1.0)

// ---- Pixi objects (markRaw — never proxied) ------------------------------------
let app          = markRaw({} as Application)
let groundLayer  = markRaw({} as Container)
let glowLayer    = markRaw({} as Container)
let objGroup     = markRaw({} as Container)
let chromeLayer  = markRaw({} as Container)
let cur: ModeHandle | null = null
let curId: Mode = 'A'

// ---- ground + object -----------------------------------------------------------
function drawGround() {
  groundLayer.removeChildren()
  const g = new Graphics()
  if (dark.value) {
    g.rect(bx0-70,by0-46,(bx1-bx0)+140,(by1-by0)+124).fill({ color: 0x2b3326 })
    g.rect(bx0-70,by0-46,(bx1-bx0)+140,(by1-by0)+124).fill({ color: 0x394420, alpha: 0.45 })
  } else {
    g.roundRect(bx0-60,by0-40,(bx1-bx0)+120,(by1-by0)+100,10).fill({ color: PAL.grass, alpha: 0.45 })
  }
  groundLayer.addChild(g)
  const dots: [number,number,number][] = [[176,108,9],[212,108,9],[250,116,7],[300,210,11],[330,224,7],[108,150,8],[372,182,9]]
  const pc = new Graphics()
  dots.forEach(([x,y,r]) => pc.circle(x,y,r).fill({ color: dark.value ? 0x6f7d54 : PAL.plant, alpha: dark.value ? 0.7 : 0.85 }))
  groundLayer.addChild(pc)
}

function drawObject() {
  objGroup.removeChildren()
  const g = new Graphics()
  g.poly(PTS.flat()).fill({ color: dark.value ? 0xe7decb : PAL.pad, alpha: dark.value ? 0.97 : 1 })
   .stroke({ width: 1.4, color: dark.value ? 0x9a8f76 : 0xb9b09a })
  g.moveTo(120,120).lineTo(300,120).stroke({ width: 1, color: 0xcdbfa0, alpha: 0.8 })
  g.moveTo(210,70).lineTo(210,250).stroke({ width: 1, color: 0xcdbfa0, alpha: 0.8 })
  objGroup.addChild(g)
}

// ---- blur glow helper ----------------------------------------------------------
// Uses core BlurFilter on a colored silhouette/stroke — NOT pixi-filters GlowFilter.
function makeGlow(gtype: 'fill' | 'stroke') {
  const g = markRaw(new Graphics())
  const redraw = () => {
    g.clear()
    if (gtype === 'fill') g.poly(PTS.flat()).fill({ color: chromeHex.value })
    else                  g.poly(SPC.flat()).stroke({ width: 3.4, color: chromeHex.value })
  }
  redraw()
  const blur = markRaw(new BlurFilter({ strength: 14, quality: 4 }))
  g.filters = [blur]; g.alpha = 0
  glowLayer.addChild(g)
  return { g, blur, redraw }
}

function clearAll() {
  chromeLayer.removeChildren()
  glowLayer.removeChildren()
  objGroup.filters = []
}

// ---- A · Field Marks -----------------------------------------------------------
function makeA(): ModeHandle {
  const pad = 14, arm = 20
  const X = bx0-pad, Y = by0-pad, X2 = bx1+pad, Y2 = by1+pad
  const corners = [
    { p: [[X,Y+arm],[X,Y],[X+arm,Y]]       as [number,number][], off: [-6,-6] as [number,number] },
    { p: [[X2-arm,Y],[X2,Y],[X2,Y+arm]]    as [number,number][], off: [6,-6]  as [number,number] },
    { p: [[X2,Y2-arm],[X2,Y2],[X2-arm,Y2]] as [number,number][], off: [6,6]   as [number,number] },
    { p: [[X+arm,Y2],[X,Y2],[X,Y2-arm]]    as [number,number][], off: [-6,6]  as [number,number] },
  ]

  const frame = markRaw(new Container())
  frame.pivot.set(bcx,bcy); frame.position.set(bcx,bcy)
  chromeLayer.addChild(frame)

  const drawBracket = (g: Graphics, pts: [number,number][]) => {
    g.clear()
    g.moveTo(pts[0][0],pts[0][1]).lineTo(pts[1][0],pts[1][1]).lineTo(pts[2][0],pts[2][1])
     .stroke({ width: 1.7, color: chromeHex.value, cap: 'square', join: 'miter' })
  }
  const brEls = corners.map(c => {
    const b = markRaw(new Graphics()) as Graphics & { _off: [number,number]; _pts: [number,number][] }
    b._off = c.off; b._pts = c.p
    drawBracket(b, c.p); frame.addChild(b); return b
  })

  const mx = (X+X2)/2, my = (Y+Y2)/2, tk = 5
  const ticks = markRaw(new Graphics())
  const drawTicks = () => { ticks.clear()
    ticks.moveTo(mx-tk,Y).lineTo(mx+tk,Y).moveTo(mx-tk,Y2).lineTo(mx+tk,Y2)
         .moveTo(X,my-tk).lineTo(X,my+tk).moveTo(X2,my-tk).lineTo(X2,my+tk)
         .stroke({ width: 1.4, color: chromeHex.value, alpha: 0.85 }) }
  drawTicks(); frame.addChild(ticks)

  const monEls = PTS.map(([x,y]) => {
    const m = markRaw(new Container()); m.position.set(x,y)
    m.addChild(markRaw(new Graphics())); chromeLayer.addChild(m); return m
  })
  const drawMon = () => { const s = aMon.value
    monEls.forEach(m => { const d = m.children[0] as Graphics; d.clear()
      d.poly([0,-s,s,0,0,s,-s,0]).fill({ color: chromeHex.value }).stroke({ width: 1, color: PAL.paper }) }) }
  drawMon()

  let glow: ReturnType<typeof makeGlow> | null = null
  let breathTw: gsap.core.Tween | null = null

  const setGlow = () => {
    if (glow) { gsap.killTweensOf(glow.g); glow.g.destroy(); glow = null }
    if (aGlow.value > 0) {
      glow = makeGlow('fill'); glow.blur.strength = 8
      gsap.to(glow.g, { alpha: 0.10 + aGlow.value * 0.07, duration: 0.5 })
    }
  }
  const recolor = () => { brEls.forEach(b => drawBracket(b, b._pts)); drawTicks(); drawMon() }

  const enter = () => {
    brEls.forEach((b, i) => {
      gsap.from(b, { alpha: 0, duration: 0.45, delay: i*0.04, ease: 'power2.out', immediateRender: false })
      gsap.from(b.position, { x: b._off[0], y: b._off[1], duration: 0.5, delay: i*0.04, ease: 'back.out(1.7)', immediateRender: false })
    })
    gsap.from(ticks, { alpha: 0, duration: 0.4, delay: 0.3, immediateRender: false })
    monEls.forEach((m, i) => gsap.from(m.scale, { x: 0, y: 0, duration: 0.45, delay: 0.3+i*0.05, ease: 'back.out(2)', immediateRender: false }))
    if (breathTw) breathTw.kill()
    breathTw = gsap.to(frame.scale, { x: 1+aBreath.value*0.01, y: 1+aBreath.value*0.01, duration: 2.1, repeat: -1, yoyo: true, ease: 'sine.inOut', delay: 0.55 })
    setGlow()
  }
  const refresh = () => { recolor(); setGlow()
    if (breathTw) { breathTw.kill()
      breathTw = gsap.to(frame.scale, { x: 1+aBreath.value*0.01, y: 1+aBreath.value*0.01, duration: 2.1, repeat: -1, yoyo: true, ease: 'sine.inOut' }) } }
  const destroy = () => {
    if (breathTw) breathTw.kill()
    brEls.forEach(b => { gsap.killTweensOf(b); gsap.killTweensOf(b.position) })
    monEls.forEach(m => gsap.killTweensOf(m.scale))
    gsap.killTweensOf(ticks)
    if (glow) { gsap.killTweensOf(glow.g); glow = null }
  }
  return { enter, refresh, destroy }
}

// ---- B · Living Hairline -------------------------------------------------------
function makeB(): ModeHandle {
  const glow = makeGlow('stroke'); glow.blur.strength = 5
  const line = markRaw(new Graphics()); chromeLayer.addChild(line)
  const nodes = markRaw(new Graphics()); chromeLayer.addChild(nodes)
  const drawNodes = () => { nodes.clear()
    SP.forEach(([x,y]) => nodes.circle(x,y,3.0).fill({ color: PAL.paper }).stroke({ width: 1.3, color: chromeHex.value })) }
  drawNodes()
  let phase = 0

  const update = (dt: number) => {
    phase += (bSpeed.value / 60) * dt
    const dash = bDash.value, gap = dash * 0.85, period = dash + gap
    line.clear()
    for (let d = -(phase % period); d < PER; d += period) {
      const a = Math.max(0, d), b = Math.min(PER, d + dash); if (b <= a) continue
      const p0 = pointAt(a); line.moveTo(p0[0], p0[1])
      for (let s = a+2; s < b; s += 2) { const p = pointAt(s); line.lineTo(p[0], p[1]) }
      const pe = pointAt(b); line.lineTo(pe[0], pe[1])
    }
    line.stroke({ width: 1.5, color: chromeHex.value, cap: 'butt', join: 'round' })
    glow.g.alpha = 0.16 + bGlow.value * (0.10 + 0.05 * Math.sin(performance.now() / 600))
  }
  const enter = () => { update(1); glow.g.alpha = 0.16 + bGlow.value * 0.10
    gsap.from(line,  { alpha: 0, duration: 0.5,  immediateRender: false })
    gsap.from(nodes, { alpha: 0, duration: 0.45, delay: 0.2, immediateRender: false }) }
  const refresh = () => { glow.redraw(); drawNodes() }
  const destroy = () => { gsap.killTweensOf(line); gsap.killTweensOf(nodes); gsap.killTweensOf(glow.g) }
  return { enter, update, refresh, destroy }
}

// ---- C · Ink Bloom -------------------------------------------------------------
function makeC(): ModeHandle {
  const glow = makeGlow('stroke'); glow.blur.strength = 5
  const line = markRaw(new Graphics()); chromeLayer.addChild(line)

  const leaves = SP.map(([x,y]) => {
    const l = markRaw(new Container()); l.position.set(x,y)
    l.addChild(markRaw(new Graphics())); chromeLayer.addChild(l); return l
  })
  const drawLeaves = () => leaves.forEach(l => { const g = l.children[0] as Graphics; g.clear()
    g.moveTo(0,-4).quadraticCurveTo(3.4,0,0,4).quadraticCurveTo(-3.4,0,0,-4).fill({ color: chromeHex.value }) })
  drawLeaves()

  let dispSprite: Sprite | null = null, dispFilter: InstanceType<typeof DisplacementFilter> | null = null
  try {
    const cv = document.createElement('canvas'); cv.width = cv.height = 256
    const cx2 = cv.getContext('2d')!
    const img = cx2.createImageData(256,256)
    for (let i = 0; i < 256*256; i++) { img.data[i*4]=Math.random()*255; img.data[i*4+1]=Math.random()*255; img.data[i*4+2]=128; img.data[i*4+3]=255 }
    cx2.putImageData(img,0,0); cx2.filter='blur(4px)'; cx2.drawImage(cv,0,0)
    const tex = Texture.from(cv)
    if (tex.source) { (tex.source as any).addressMode='repeat'; (tex.source as any).scaleMode='linear'; tex.source.update?.() }
    dispSprite = markRaw(new Sprite(tex)); dispSprite.alpha=0; dispSprite.position.set(bx0,by0); dispSprite.scale.set(1.4)
    chromeLayer.addChild(dispSprite)
    dispFilter = markRaw(new DisplacementFilter({ sprite: dispSprite, scale: cWob.value }))
    line.filters = [dispFilter]
  } catch(e) { console.warn('[SelectionDesign] displacement unavailable:', (e as Error).message) }

  const drawProgress = (t: number) => { line.clear(); const end = PER * t; if (end <= 0) return
    const p0 = pointAt(0); line.moveTo(p0[0], p0[1])
    for (let s = 2; s < end; s += 2) { const p = pointAt(s); line.lineTo(p[0], p[1]) }
    const pe = pointAt(end); line.lineTo(pe[0], pe[1])
    line.stroke({ width: 1.8, color: chromeHex.value, cap: 'round', join: 'round' }) }

  const st = { t: 0 }; let enterTw: gsap.core.Tween | null = null

  const enter = () => { drawProgress(1); glow.g.alpha = 0.12 + cGlow.value * 0.12
    gsap.from(glow.g, { alpha: 0, duration: 0.8, delay: 0.4, immediateRender: false })
    st.t = 0
    enterTw = gsap.fromTo(st, { t: 0 }, { t: 1, duration: cDur.value, ease: 'power1.inOut', immediateRender: false,
      onUpdate: () => drawProgress(st.t),
      onComplete: () => leaves.forEach((l,i) => gsap.fromTo(l.scale, { x:0,y:0 }, { x:1,y:1, duration:0.45, delay:i*0.06, ease:'back.out(2)' })) }) }

  const update = () => { if (dispSprite) { dispSprite.x=bx0+Math.sin(performance.now()/1400)*8; dispSprite.y=by0+Math.cos(performance.now()/1700)*8 }
    // Pixi v8: scale is an ObservablePoint, set components not the property itself
    if (dispFilter) { const s = (dispFilter as any).scale; if (s && typeof s === 'object') { s.x = cWob.value; s.y = cWob.value } } }

  const refresh = () => { if (st.t >= 1) drawProgress(1); drawLeaves(); glow.redraw() }
  const destroy = () => { enterTw?.kill(); gsap.killTweensOf(st)
    leaves.forEach(l => { gsap.killTweensOf(l.scale); gsap.killTweensOf(l) })
    gsap.killTweensOf(glow.g) }
  return { enter, update, refresh, destroy }
}

// ---- D · Aura ------------------------------------------------------------------
function makeD(): ModeHandle {
  const glow = makeGlow('fill')
  const core = markRaw(new Graphics()); chromeLayer.addChild(core)
  const dots = markRaw(new Graphics())
  const rings = SP.map(([x,y]) => {
    const r = markRaw(new Container()); r.position.set(x,y)
    r.addChild(markRaw(new Graphics())); chromeLayer.addChild(r); return r
  })
  const redraw = () => { core.clear(); core.poly(SP.flat()).stroke({ width: 1.3, color: chromeHex.value })
    dots.clear(); SP.forEach(([x,y]) => dots.circle(x,y,2.3).fill({ color: chromeHex.value }))
    rings.forEach(r => { const g = r.children[0] as Graphics; g.clear(); g.circle(0,0,4.2).stroke({ width: 1.1, color: chromeHex.value }) }) }
  redraw(); chromeLayer.addChild(dots)

  let glowTw: gsap.core.Tween | null = null

  const enter = () => {
    gsap.from(core, { alpha:0, duration:0.55, ease:'power2.out', immediateRender:false })
    gsap.from(dots, { alpha:0, duration:0.5,  delay:0.25, immediateRender:false })
    glow.blur.strength = dDist.value
    const ga = 0.10 + dStr.value * 0.07; glow.g.alpha = ga
    gsap.from(glow.g, { alpha:0, duration:0.6, ease:'back.out(1.4)', immediateRender:false })
    if (glowTw) glowTw.kill()
    glowTw = gsap.to(glow.blur, { strength: dDist.value*1.35, duration: dSpd.value, repeat:-1, yoyo:true, ease:'sine.inOut' })
    gsap.to(glow.g, { alpha: ga*1.6, duration: dSpd.value, repeat:-1, yoyo:true, ease:'sine.inOut', delay:0.6 })
    rings.forEach((r,i) => { r.scale.set(1); r.alpha=0.5
      gsap.to(r.scale, { x:1.45,y:1.45, duration:dSpd.value, repeat:-1, yoyo:true, ease:'sine.inOut', delay:i*0.05 })
      gsap.to(r, { alpha:0.12, duration:dSpd.value, repeat:-1, yoyo:true, ease:'sine.inOut', delay:i*0.05 }) })
  }
  const refresh = () => { redraw(); glow.redraw() }
  const destroy = () => { glowTw?.kill()
    rings.forEach(r => { gsap.killTweensOf(r.scale); gsap.killTweensOf(r) })
    gsap.killTweensOf(glow.g); gsap.killTweensOf(glow.blur)
    gsap.killTweensOf(core); gsap.killTweensOf(dots) }
  return { enter, refresh, destroy }
}

// ---- E · Arc Pulse -------------------------------------------------------------
// C's race-track draw-on entrance + D's pulsing vertex rings. No leaf ticks.
// Sequence: dim ghost path fades in → bright line draws around → sweep arc starts + rings pop in.
function makeE(): ModeHandle {
  // Dim "ghost" full outline — always visible once entrance begins
  const base = markRaw(new Graphics())
  const drawBase = () => { base.clear(); base.poly(SP.flat()).stroke({ width: 1.2, color: chromeHex.value }) }
  drawBase(); base.alpha = 0; chromeLayer.addChild(base)

  // Bright draw-on line (entrance progress)
  const line = markRaw(new Graphics()); chromeLayer.addChild(line)

  // Moving bright sweep arc (post-entrance, loops continuously)
  const sweep = markRaw(new Graphics()); sweep.alpha = 0; chromeLayer.addChild(sweep)

  // Glow behind the path
  const glow = makeGlow('stroke'); glow.blur.strength = 5

  // Pulsing rings at each SP vertex (no leaf ticks)
  const rings = SP.map(([x,y]) => {
    const r = markRaw(new Container()); r.position.set(x,y)
    r.addChild(markRaw(new Graphics())); chromeLayer.addChild(r); return r
  })
  const drawRings = () => rings.forEach(r => { const g = r.children[0] as Graphics; g.clear()
    g.circle(0,0,4.5).stroke({ width: 1.2, color: chromeHex.value }) })
  drawRings()

  const SWEEP_LEN = PER * 0.18
  let sweepPos = 0, sweeping = false

  const drawProgress = (t: number) => { line.clear()
    const end = PER * t; if (end <= 0) return
    const p0 = pointAt(0); line.moveTo(p0[0], p0[1])
    for (let s = 2; s < end; s += 2) { const p = pointAt(s); line.lineTo(p[0], p[1]) }
    const pe = pointAt(end); line.lineTo(pe[0], pe[1])
    line.stroke({ width: 2.0, color: chromeHex.value, cap: 'round', join: 'round' }) }

  const drawSweep = () => { sweep.clear()
    const p0 = pointAt(sweepPos); sweep.moveTo(p0[0], p0[1])
    for (let s = sweepPos + 2; s < sweepPos + SWEEP_LEN; s += 2) { const p = pointAt(s % PER); sweep.lineTo(p[0], p[1]) }
    const pe = pointAt((sweepPos + SWEEP_LEN) % PER); sweep.lineTo(pe[0], pe[1])
    sweep.stroke({ width: 2.2, color: chromeHex.value, cap: 'round' }) }

  const st = { t: 0 }; let enterTw: gsap.core.Tween | null = null

  const enter = () => { sweeping = false; sweep.alpha = 0; glow.g.alpha = 0
    base.alpha = 0; line.clear(); drawBase(); drawRings()
    rings.forEach(r => { r.scale.set(0); r.alpha = 1 })

    // Ghost path fades in during draw-on
    gsap.to(base, { alpha: 0.32, duration: 0.5 })

    st.t = 0
    enterTw = gsap.fromTo(st, { t: 0 }, { t: 1, duration: eDur.value, ease: 'power1.inOut', immediateRender: false,
      onUpdate: () => drawProgress(st.t),
      onComplete: () => {
        line.clear(); sweeping = true
        gsap.to(base, { alpha: 0.40, duration: 0.2 })   // settle to final dim opacity
        gsap.to(sweep, { alpha: 1, duration: 0.35 })
        gsap.to(glow.g, { alpha: 0.10 + eGlow.value * 0.11, duration: 0.5 })
        rings.forEach((r, i) => {
          gsap.to(r.scale, { x: 1, y: 1, duration: 0.45, delay: i*0.05, ease: 'back.out(2)',
            onComplete: () => {
              gsap.to(r.scale, { x: 1.5, y: 1.5, duration: 2.2, repeat: -1, yoyo: true, ease: 'sine.inOut' })
              gsap.to(r, { alpha: 0.12, duration: 2.2, repeat: -1, yoyo: true, ease: 'sine.inOut' })
            }
          })
        })
      }
    })
  }

  const update = (dt: number) => { if (!sweeping) return
    sweepPos = (sweepPos + (eSpd.value / 60) * dt) % PER; drawSweep() }

  const refresh = () => { drawBase(); drawRings(); glow.redraw() }
  const destroy = () => { sweeping = false; enterTw?.kill(); gsap.killTweensOf(st)
    rings.forEach(r => { gsap.killTweensOf(r.scale); gsap.killTweensOf(r) })
    gsap.killTweensOf(base); gsap.killTweensOf(sweep); gsap.killTweensOf(glow.g) }

  return { enter, update, refresh, destroy }
}

// ---- mode management -----------------------------------------------------------
const FACTORY: Record<Mode, () => ModeHandle> = { A: makeA, B: makeB, C: makeC, D: makeD, E: makeE }

function select(id: Mode) {
  cur?.destroy?.(); clearAll()
  curId = id; mode.value = id
  cur = FACTORY[id](); cur.enter()
}
function replay() { select(curId) }

function onTick(ticker: { deltaTime: number }) { cur?.update?.(ticker.deltaTime) }

// ---- watchers — slider → refresh -----------------------------------------------
watch([aBreath, aMon, aGlow], () => { if (mode.value === 'A') cur?.refresh?.() })
watch([bSpeed, bDash, bGlow], () => { if (mode.value === 'B') cur?.refresh?.() })
watch([cDur, cWob, cGlow],    () => { if (mode.value === 'C') cur?.refresh?.() })
watch([dDist, dStr, dSpd],    () => { if (mode.value === 'D') cur?.refresh?.() })
watch([eDur, eSpd, eGlow],    () => { if (mode.value === 'E') cur?.refresh?.() })

// ---- lifecycle -----------------------------------------------------------------
onMounted(async () => {
  const canvas = canvasEl.value!
  app = markRaw(new Application())
  await app.init({ canvas, preference: 'webgl', width: canvas.clientWidth, height: canvas.clientHeight,
    antialias: true, background: '#ebede6', resolution: devicePixelRatio, autoDensity: true })

  const scene = markRaw(new Container())
  groundLayer = markRaw(new Container())
  glowLayer   = markRaw(new Container())
  objGroup    = markRaw(new Container())
  chromeLayer = markRaw(new Container())
  scene.addChild(groundLayer, glowLayer, objGroup, chromeLayer)
  app.stage.addChild(scene)
  scene.pivot.set(bcx, bcy)

  const layout = () => {
    const W = app.screen.width, H = app.screen.height
    const s = Math.min((W * 0.56) / (bx1-bx0), (H * 0.68) / (by1-by0))
    scene.scale.set(s); scene.position.set(W * 0.40, H * 0.52)
  }
  app.renderer.on('resize', layout); layout()

  drawGround(); drawObject()
  app.ticker.add(onTick)
  select('A')
})

onUnmounted(() => {
  app?.ticker?.remove(onTick)
  cur?.destroy?.()
  try { app?.destroy(true, { children: true, texture: true, context: true }) } catch {}
})

// ---- UI helpers ----------------------------------------------------------------
function setGround(d: boolean) {
  dark.value = d
  if (app.renderer) { app.renderer.background.color = d ? 0x222820 : 0xebede6; drawGround(); drawObject(); cur?.refresh?.() }
}
function setChrome(hex: number) { chromeHex.value = hex; cur?.refresh?.() }

const MODES: { id: Mode; name: string; desc: string }[] = [
  { id: 'A', name: 'Field Marks',     desc: 'Corner brackets + monuments. GSAP back.out focus-lock; breathing scale. No filter — crispest & cheapest.' },
  { id: 'B', name: 'Living Hairline', desc: 'Marching ants traced along the path + soft blur-glow pulse. Sage, slow, on-brand.' },
  { id: 'C', name: 'Ink Bloom',       desc: 'Outline draws itself on, then leaf ticks bloom. DisplacementFilter gives hand-inked waver.' },
  { id: 'D', name: 'Aura',            desc: 'Pure blur-glow breathing behind a crisp hairline, with pulsing vertex dot rings.' },
  { id: 'E', name: 'Arc Pulse',       desc: 'Ghost path + race-track draw-on entrance, then a bright arc sweeps the perimeter while vertex rings pulse.' },
]
const currentMode = computed(() => MODES.find(m => m.id === mode.value)!)
</script>

<template>
  <div class="wrap">
    <canvas ref="canvasEl" />

    <!-- FPS -->
    <div class="hud">{{ fps }} <span>fps</span> · {{ frameMs }} ms</div>

    <!-- Right control panel -->
    <div class="panel">
      <!-- Mode tabs -->
      <div class="tabs">
        <button v-for="m in MODES" :key="m.id" :class="['tab', { on: mode === m.id }]" @click="select(m.id)">
          {{ m.id }}
        </button>
      </div>

      <p class="mode-name">{{ currentMode.name }}</p>
      <p class="mode-desc">{{ currentMode.desc }}</p>

      <!-- A sliders -->
      <template v-if="mode === 'A'">
        <div class="row"><label>Breath amount</label><span class="val">{{ aBreath.toFixed(1) }}</span></div>
        <input type="range" v-model.number="aBreath" min="0" max="3" step="0.1" />
        <div class="row"><label>Monument size</label><span class="val">{{ aMon.toFixed(1) }}</span></div>
        <input type="range" v-model.number="aMon" min="2" max="6" step="0.2" />
        <div class="row"><label>Halo glow</label><span class="val">{{ aGlow.toFixed(1) }}</span></div>
        <input type="range" v-model.number="aGlow" min="0" max="3" step="0.1" />
      </template>

      <!-- B sliders -->
      <template v-else-if="mode === 'B'">
        <div class="row"><label>Dash speed</label><span class="val">{{ bSpeed }}</span></div>
        <input type="range" v-model.number="bSpeed" min="0" max="120" step="1" />
        <div class="row"><label>Dash length</label><span class="val">{{ bDash }}</span></div>
        <input type="range" v-model.number="bDash" min="2" max="20" step="0.5" />
        <div class="row"><label>Glow strength</label><span class="val">{{ bGlow.toFixed(1) }}</span></div>
        <input type="range" v-model.number="bGlow" min="0" max="4" step="0.1" />
      </template>

      <!-- C sliders -->
      <template v-else-if="mode === 'C'">
        <div class="row"><label>Draw duration</label><span class="val">{{ cDur.toFixed(1) }}s</span></div>
        <input type="range" v-model.number="cDur" min="0.4" max="2.5" step="0.1" />
        <div class="row"><label>Ink wobble</label><span class="val">{{ cWob.toFixed(1) }}</span></div>
        <input type="range" v-model.number="cWob" min="0" max="5" step="0.1" />
        <div class="row"><label>Glow strength</label><span class="val">{{ cGlow.toFixed(1) }}</span></div>
        <input type="range" v-model.number="cGlow" min="0" max="3" step="0.1" />
      </template>

      <!-- D sliders -->
      <template v-else-if="mode === 'D'">
        <div class="row"><label>Glow distance</label><span class="val">{{ dDist }}</span></div>
        <input type="range" v-model.number="dDist" min="4" max="40" step="1" />
        <div class="row"><label>Outer strength</label><span class="val">{{ dStr.toFixed(1) }}</span></div>
        <input type="range" v-model.number="dStr" min="0.5" max="6" step="0.1" />
        <div class="row"><label>Breath speed</label><span class="val">{{ dSpd.toFixed(1) }}</span></div>
        <input type="range" v-model.number="dSpd" min="0.5" max="4" step="0.1" />
      </template>

      <!-- E sliders -->
      <template v-else-if="mode === 'E'">
        <div class="row"><label>Draw duration</label><span class="val">{{ eDur.toFixed(1) }}s</span></div>
        <input type="range" v-model.number="eDur" min="0.4" max="3.0" step="0.1" />
        <div class="row"><label>Sweep speed</label><span class="val">{{ eSpd }}</span></div>
        <input type="range" v-model.number="eSpd" min="0" max="120" step="1" />
        <div class="row"><label>Glow strength</label><span class="val">{{ eGlow.toFixed(1) }}</span></div>
        <input type="range" v-model.number="eGlow" min="0" max="3" step="0.1" />
      </template>

      <div class="divider" />

      <!-- Chrome color -->
      <p class="glabel">Chrome color</p>
      <div class="swatches">
        <div v-for="opt in CHROME_OPTS" :key="opt.hex"
          :class="['sw', { on: chromeHex === opt.hex }]"
          :style="{ background: opt.css }"
          @click="setChrome(opt.hex)"
        />
      </div>

      <!-- Ground toggle -->
      <p class="glabel">Ground</p>
      <div class="ground-row">
        <button :class="['toggle', { on: !dark }]" @click="setGround(false)">Paper plan</button>
        <button :class="['toggle', { on: dark }]"  @click="setGround(true)">Dark aerial</button>
      </div>

      <!-- Replay -->
      <button class="replay" @click="replay()">↻ Replay entrance</button>
    </div>
  </div>
</template>

<style scoped>
.wrap {
  position: relative;
  width: 100%;
  height: 100%;
  overflow: hidden;
}
canvas {
  display: block;
  width: 100%;
  height: 100%;
}

.hud {
  position: absolute;
  top: 14px;
  left: 18px;
  font-family: monospace;
  font-size: 11px;
  color: #8a9a84;
  pointer-events: none;
}
.hud span { color: #6a7a64; }

/* ---- panel ---- */
.panel {
  position: absolute;
  top: 14px;
  right: 14px;
  bottom: 14px;
  width: 240px;
  background: rgba(24,28,22,0.92);
  backdrop-filter: blur(8px);
  border: 1px solid #2e3628;
  border-radius: 10px;
  padding: 14px 16px 16px;
  display: flex;
  flex-direction: column;
  gap: 0;
  overflow-y: auto;
  scrollbar-width: thin;
}

.tabs { display: grid; grid-template-columns: repeat(5,1fr); gap: 4px; margin-bottom: 12px; }
.tab {
  font-family: monospace; font-size: 11px; font-weight: 600;
  padding: 7px 0; border: 1px solid #2e3628; border-radius: 6px;
  background: transparent; color: #5a6650; cursor: pointer; transition: all .14s;
}
.tab:hover { border-color: #3a5836; color: #8aa07a; }
.tab.on { background: #3a5836; border-color: #3a5836; color: #d6e4cc; }

.mode-name { font-size: 13px; color: #d6e4cc; margin: 0 0 4px; font-weight: 500; }
.mode-desc { font-size: 11px; line-height: 1.5; color: #5a6650; margin: 0 0 14px; }

.row { display: flex; justify-content: space-between; align-items: center; margin-bottom: 3px; margin-top: 6px; }
.row label { font-size: 11px; color: #7a8870; }
.val { font-family: monospace; font-size: 10px; color: #6a9060; background: #1e2a1a; padding: 2px 6px; border-radius: 4px; }
input[type=range] {
  width: 100%; -webkit-appearance: none; appearance: none; height: 3px;
  background: #2e3628; border-radius: 2px; outline: none; margin-bottom: 2px;
}
input[type=range]::-webkit-slider-thumb {
  -webkit-appearance: none; width: 13px; height: 13px; border-radius: 50%;
  background: #3a5836; cursor: pointer; border: 2px solid #1a2018;
}

.divider { height: 1px; background: #2e3628; margin: 10px 0 10px; }

.glabel { font-family: monospace; font-size: 9px; letter-spacing: .14em; text-transform: uppercase; color: #3a4a34; margin: 0 0 8px; }

.swatches { display: flex; gap: 7px; margin-bottom: 12px; }
.sw { width: 26px; height: 26px; border-radius: 7px; cursor: pointer; border: 2px solid transparent; transition: transform .12s; }
.sw:hover { transform: scale(1.1); }
.sw.on { border-color: #d6e4cc; box-shadow: 0 0 0 1px rgba(214,228,204,.3); }

.ground-row { display: flex; gap: 6px; margin-bottom: 10px; }
.toggle { flex: 1; font-family: monospace; font-size: 10px; padding: 7px 0; border: 1px solid #2e3628; border-radius: 6px; background: transparent; color: #5a6650; cursor: pointer; transition: all .14s; }
.toggle.on { background: #1a2018; border-color: #3a5836; color: #8aa07a; }

.replay {
  width: 100%; margin-top: 2px; padding: 9px 0; border: none; border-radius: 7px;
  background: #3a5836; color: #d6e4cc; font-family: monospace; font-size: 10px;
  letter-spacing: .08em; text-transform: uppercase; cursor: pointer; font-weight: 600; transition: filter .14s;
}
.replay:hover { filter: brightness(1.1); }
</style>
