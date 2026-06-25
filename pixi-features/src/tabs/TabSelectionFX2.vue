<script setup lang="ts">
/**
 * Selection FX 2 — three selection treatments not covered by TabSelectionFX.
 *
 * Modes (from the selection-animation research synthesis, docs/):
 *  A  Isolation     — T8 "detective mode": AdjustmentFilter desaturates+dims every shape
 *                     except the active one, which sits on a clean top layer (optional glow pop).
 *  B  Comet         — T10 trail-along-path: a bright head with a fading tail travels the
 *                     selected outline. CPU arc-length sampling, no shader.
 *  C  Conic Border  — T9 rotating conic-gradient border: a Canvas2D conic gradient texture
 *                     masked to the outline stroke, rotated each frame. Seam-free.
 *
 * Click shapes to select (B/C) or set active (A — single).
 */
import { ref, onMounted, onUnmounted, markRaw, watch } from 'vue'
import { Application, Graphics, Container, Sprite, Texture } from 'pixi.js'
import { AdjustmentFilter, GlowFilter } from 'pixi-filters'
import { useFps } from '../shared/useFps'

type Mode = 'isolation' | 'comet' | 'conic'

interface ShapeDef {
  label: string
  draw: (g: Graphics) => void
  outline: [number, number][]   // closed polyline (last point == first)
}

interface Shape {
  wrap: Container
  gfx: Graphics
  def: ShapeDef
  selected: boolean
}

const { fps, frameMs } = useFps()
const canvasEl = ref<HTMLCanvasElement>()
const mode = ref<Mode>('isolation')

// --- params ---
const dimAmount   = ref(0.25)   // isolation: how dark the background gets
const dimSat      = ref(0.0)    // isolation: background saturation
const activeGlow  = ref(true)   // isolation: glow the active shape
const cometSpeed  = ref(1.6)    // comet: head travel speed (px/frame-ish)
const cometTail   = ref(60)     // comet: tail falloff length (px)
const cometWidth  = ref(3)      // comet: stroke width
const conicSpeed  = ref(0.03)   // conic: rad/frame
const conicWidth  = ref(6)      // conic: border thickness

// --- Pixi objects ---
let app = markRaw({} as Application)
let dimLayer = markRaw({} as Container)    // shapes live here; filtered in isolation mode
let topLayer = markRaw({} as Container)    // the active shape during isolation
let overlay  = markRaw({} as Container)    // conic sprites/masks
let cometGfx = markRaw({} as Graphics)     // comet trail
let shapes: Shape[] = []
let adjustF: AdjustmentFilter | null = null
let glowF: GlowFilter | null = null
let conicTex: Texture | null = null
let conicNodes: { sprite: Sprite; mask: Graphics; cx: number; cy: number }[] = []

let cometHead = 0   // arc-length position of the comet head

// ---- shapes ----------------------------------------------------------------------

const SHAPES: ShapeDef[] = [
  {
    label: 'Rectangle',
    draw(g) {
      g.setFillStyle({ color: 0x2a4a6c, alpha: 0.9 })
      g.setStrokeStyle({ width: 1.5, color: 0x4488cc })
      g.rect(0, 0, 200, 130).fill().stroke()
    },
    outline: [[0,0],[200,0],[200,130],[0,130],[0,0]],
  },
  {
    label: 'Hexagon',
    draw(g) {
      g.setFillStyle({ color: 0x1a4a2a, alpha: 0.9 })
      g.setStrokeStyle({ width: 1.5, color: 0x44aa66 })
      const pts = hexPts()
      g.moveTo(pts[0][0], pts[0][1])
      for (let i = 1; i < pts.length; i++) g.lineTo(pts[i][0], pts[i][1])
      g.closePath().fill().stroke()
    },
    outline: (() => { const p = hexPts(); return [...p, p[0]] as [number,number][] })(),
  },
  {
    label: 'Bed Polygon',
    draw(g) {
      g.setFillStyle({ color: 0x3a2810, alpha: 0.9 })
      g.setStrokeStyle({ width: 1.5, color: 0xbb7733 })
      const pts: [number,number][] = [[20,80],[100,10],[230,30],[260,100],[160,150],[40,140]]
      g.moveTo(pts[0][0], pts[0][1])
      for (let i = 1; i < pts.length; i++) g.lineTo(pts[i][0], pts[i][1])
      g.closePath().fill().stroke()
    },
    outline: [[20,80],[100,10],[230,30],[260,100],[160,150],[40,140],[20,80]],
  },
  {
    label: 'Circle',
    draw(g) {
      g.setFillStyle({ color: 0x4a2a4a, alpha: 0.9 })
      g.setStrokeStyle({ width: 1.5, color: 0xaa66bb })
      g.circle(80, 80, 75).fill().stroke()
    },
    outline: (() => {
      const p: [number,number][] = Array.from({ length: 49 }, (_, i) => {
        const a = (Math.PI * 2 * i) / 48
        return [80 + Math.cos(a) * 75, 80 + Math.sin(a) * 75]
      })
      return p
    })(),
  },
]

function hexPts(): [number, number][] {
  return Array.from({ length: 6 }, (_, i) => {
    const a = (Math.PI / 3) * i - Math.PI / 6
    return [90 + Math.cos(a) * 85, 90 + Math.sin(a) * 85] as [number, number]
  })
}

// ---- arc-length sampling (shared by comet + conic sizing) ------------------------

interface ArcLen { cum: number[]; total: number; pts: [number, number][] }

function buildArcLen(pts: [number, number][]): ArcLen {
  const cum = [0]
  let total = 0
  for (let i = 1; i < pts.length; i++) {
    total += Math.hypot(pts[i][0] - pts[i-1][0], pts[i][1] - pts[i-1][1])
    cum.push(total)
  }
  return { cum, total, pts }
}

function pointAt(al: ArcLen, d: number): [number, number] {
  const { cum, total, pts } = al
  d = ((d % total) + total) % total
  for (let i = 1; i < cum.length; i++) {
    if (d <= cum[i]) {
      const seg = cum[i] - cum[i-1] || 1
      const t = (d - cum[i-1]) / seg
      return [pts[i-1][0] + (pts[i][0]-pts[i-1][0]) * t, pts[i-1][1] + (pts[i][1]-pts[i-1][1]) * t]
    }
  }
  return pts[0]
}

function bbox(pts: [number, number][]) {
  const xs = pts.map(p => p[0]), ys = pts.map(p => p[1])
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys)
  return { cx: (x0+x1)/2, cy: (y0+y1)/2, r: Math.hypot(x1-x0, y1-y0) / 2 }
}

// ---- setup -----------------------------------------------------------------------

function makeShapes(): void {
  const positions: [number, number][] = [[70, 60], [380, 50], [70, 320], [400, 300]]
  for (let i = 0; i < SHAPES.length; i++) {
    const def = SHAPES[i]
    const wrap = markRaw(new Container())
    const gfx = markRaw(new Graphics())
    wrap.position.set(positions[i][0], positions[i][1])
    def.draw(gfx)
    gfx.eventMode = 'static'
    gfx.cursor = 'pointer'
    const idx = i
    gfx.on('pointerdown', () => onShapeClick(idx))
    wrap.addChild(gfx)
    dimLayer.addChild(wrap)
    shapes.push({ wrap, gfx, def, selected: false })
  }
}

function onShapeClick(i: number): void {
  if (mode.value === 'isolation') {
    // single active: clicking the active one clears it
    const wasActive = shapes[i].selected
    shapes.forEach(s => (s.selected = false))
    shapes[i].selected = !wasActive
  } else {
    shapes[i].selected = !shapes[i].selected
  }
  applyMode()
}

// Build the conic-gradient texture once (Canvas2D — seam-free, no shader).
function buildConicTexture(): Texture {
  const size = 256
  const c = document.createElement('canvas')
  c.width = c.height = size
  const ctx = c.getContext('2d')!
  // createConicGradient is widely supported in modern browsers.
  const grad = (ctx as any).createConicGradient(0, size / 2, size / 2)
  const stops = ['#ff5252', '#ffb142', '#fff352', '#52ff7a', '#52d8ff', '#7a52ff', '#ff52d8', '#ff5252']
  for (let i = 0; i < stops.length; i++) grad.addColorStop(i / (stops.length - 1), stops[i])
  ctx.fillStyle = grad
  ctx.fillRect(0, 0, size, size)
  return Texture.from(c)
}

// ---- mode application ------------------------------------------------------------

function teardownTransient(): void {
  // move all shapes back to dimLayer, drop filters, clear overlays
  for (const s of shapes) {
    if (s.wrap.parent !== dimLayer) dimLayer.addChild(s.wrap)
    s.wrap.filters = []
  }
  dimLayer.filters = []
  cometGfx.clear()
  for (const n of conicNodes) { n.sprite.destroy(); n.mask.destroy() }
  conicNodes = []
}

function applyMode(): void {
  teardownTransient()

  if (mode.value === 'isolation') {
    const active = shapes.find(s => s.selected)
    if (active) {
      dimLayer.filters = adjustF ? [adjustF] : []
      topLayer.addChild(active.wrap)   // reparent active above the dimmed layer
      if (activeGlow.value && glowF) active.wrap.filters = [glowF]
    }
  } else if (mode.value === 'conic') {
    for (const s of shapes) {
      if (!s.selected) continue
      const { cx, cy, r } = bbox(s.def.outline)
      // mask = the outline stroked at border width (shape-local coords)
      const mask = markRaw(new Graphics())
      mask.setStrokeStyle({ width: conicWidth.value, color: 0xffffff, alignment: 0.5 })
      const o = s.def.outline
      mask.moveTo(o[0][0], o[0][1])
      for (let i = 1; i < o.length; i++) mask.lineTo(o[i][0], o[i][1])
      mask.stroke()
      mask.position.copyFrom(s.wrap.position)
      // sprite = conic gradient, centered on shape bbox center, sized to cover it
      const sprite = markRaw(new Sprite(conicTex!))
      sprite.anchor.set(0.5)
      sprite.width = sprite.height = r * 2.4
      sprite.position.set(s.wrap.x + cx, s.wrap.y + cy)
      sprite.mask = mask
      overlay.addChild(mask, sprite)
      conicNodes.push({ sprite, mask, cx, cy })
    }
  }
  // comet: drawn per-frame in onTick, nothing to set up here
}

// ---- ticker ----------------------------------------------------------------------

function onTick(t: { deltaTime: number; deltaMS: number }): void {
  if (mode.value === 'comet') {
    cometHead += cometSpeed.value * t.deltaTime
    cometGfx.clear()
    for (const s of shapes) {
      if (!s.selected) continue
      drawComet(s)
    }
  } else if (mode.value === 'conic') {
    for (const n of conicNodes) n.sprite.rotation += conicSpeed.value * t.deltaTime
  } else if (mode.value === 'isolation') {
    if (glowF && activeGlow.value) {
      const k = 0.6 + 0.4 * Math.sin(Date.now() * 0.004)
      glowF.outerStrength = 2.5 * k
    }
  }
}

function drawComet(s: Shape): void {
  const al = buildArcLen(s.def.outline)
  const STEP = 4                       // sample spacing along perimeter (px)
  const n = Math.max(8, Math.floor(al.total / STEP))
  const ds = al.total / n
  const tail = cometTail.value
  const head = ((cometHead % al.total) + al.total) % al.total
  const [ox, oy] = [s.wrap.x, s.wrap.y]

  for (let i = 0; i < n; i++) {
    const d0 = i * ds
    const d1 = (i + 1) * ds
    // distance *behind* the head (wrapping), measured to segment midpoint
    const mid = (d0 + d1) / 2
    let behind = head - mid
    behind = ((behind % al.total) + al.total) % al.total
    const alpha = Math.exp(-behind / tail)
    if (alpha < 0.03) continue
    const a = pointAt(al, d0), b = pointAt(al, d1)
    cometGfx.setStrokeStyle({ width: cometWidth.value, color: 0xffffff, cap: 'round', alpha })
    cometGfx.moveTo(ox + a[0], oy + a[1])
    cometGfx.lineTo(ox + b[0], oy + b[1])
    cometGfx.stroke()
  }
}

// ---- lifecycle -------------------------------------------------------------------

onMounted(async () => {
  const canvas = canvasEl.value!
  app = markRaw(new Application())
  await app.init({
    canvas,
    preference: 'webgl',
    width: canvas.clientWidth,
    height: canvas.clientHeight,
    antialias: true,
    background: '#0d1117',
    resolution: devicePixelRatio,
    autoDensity: true,
  })

  dimLayer = markRaw(new Container())
  topLayer = markRaw(new Container())
  overlay = markRaw(new Container())
  cometGfx = markRaw(new Graphics())
  app.stage.addChild(dimLayer, topLayer, overlay, cometGfx)

  makeShapes()
  conicTex = markRaw(buildConicTexture())

  adjustF = markRaw(new AdjustmentFilter({ brightness: dimAmount.value, saturation: dimSat.value }))
  glowF = markRaw(new GlowFilter({ distance: 16, outerStrength: 2.5, innerStrength: 0, color: 0xffd24a, quality: 0.4 }))

  app.ticker.add(onTick)

  watch([dimAmount, dimSat], () => {
    if (adjustF) { adjustF.brightness = dimAmount.value; adjustF.saturation = dimSat.value }
  })
  watch([conicWidth, activeGlow], () => applyMode())

  // start with shape 0 active so isolation shows immediately
  shapes[0].selected = true
  applyMode()
})

onUnmounted(() => {
  app?.ticker?.remove(onTick)
  conicTex?.destroy(true)
  app?.destroy(true, { children: true, texture: true, context: true })
})

const MODES: { id: Mode; label: string }[] = [
  { id: 'isolation', label: 'A · Isolation' },
  { id: 'comet',     label: 'B · Comet' },
  { id: 'conic',     label: 'C · Conic Border' },
]

function selectMode(m: Mode): void {
  mode.value = m
  // sensible default selection per mode
  if (m === 'isolation') { shapes.forEach((s, i) => (s.selected = i === 0)) }
  else { shapes.forEach(s => (s.selected = true)) }
  applyMode()
}

const DESCRIPTIONS: Record<Mode, string> = {
  isolation: 'T8 — AdjustmentFilter desaturates + dims every shape but the active one (on a clean top layer). Maps to editing a group/symbol. Click a shape to make it active.',
  comet:     'T10 — bright head + fading tail travels the outline (CPU arc-length, no shader). A striking single-active-item accent. Click shapes to toggle.',
  conic:     'T9 — Canvas2D conic-gradient texture masked to the outline stroke, rotated each frame. Seam-free. Great "generating/active" indicator. Click shapes to toggle.',
}
</script>

<template>
  <div class="wrap">
    <canvas ref="canvasEl" />

    <div class="hud">
      <div class="fps">{{ fps }} <span>fps</span></div>
      <div>{{ frameMs }} ms</div>
    </div>

    <div class="mode-strip">
      <button
        v-for="m in MODES" :key="m.id"
        :class="['mode-btn', { active: mode === m.id }]"
        @click="selectMode(m.id)"
      >{{ m.label }}</button>
    </div>

    <div class="controls">
      <div class="ctrl-title">{{ MODES.find(m => m.id === mode)?.label }}</div>

      <template v-if="mode === 'isolation'">
        <label>Dim
          <input type="range" v-model.number="dimAmount" min="0.05" max="0.8" step="0.05" />
          {{ dimAmount.toFixed(2) }}
        </label>
        <label>Bg sat
          <input type="range" v-model.number="dimSat" min="0" max="1" step="0.05" />
          {{ dimSat.toFixed(2) }}
        </label>
        <label class="check">
          <input type="checkbox" v-model="activeGlow" /> Glow active
        </label>
      </template>

      <template v-else-if="mode === 'comet'">
        <label>Speed
          <input type="range" v-model.number="cometSpeed" min="0.3" max="6" step="0.1" />
          {{ cometSpeed.toFixed(1) }}
        </label>
        <label>Tail
          <input type="range" v-model.number="cometTail" min="15" max="200" step="5" />
          {{ cometTail }}px
        </label>
        <label>Width
          <input type="range" v-model.number="cometWidth" min="1" max="8" step="0.5" />
          {{ cometWidth }}px
        </label>
      </template>

      <template v-else-if="mode === 'conic'">
        <label>Speed
          <input type="range" v-model.number="conicSpeed" min="0.005" max="0.12" step="0.005" />
          {{ conicSpeed.toFixed(3) }}
        </label>
        <label>Width
          <input type="range" v-model.number="conicWidth" min="2" max="16" step="1" />
          {{ conicWidth }}px
        </label>
      </template>

      <div class="hint-small">Click shapes to {{ mode === 'isolation' ? 'set active' : 'select' }}</div>
    </div>

    <div class="desc">{{ DESCRIPTIONS[mode] }}</div>
  </div>
</template>

<style scoped>
.wrap { position: relative; width: 100%; height: 100%; background: #0d1117; }
canvas { display: block; width: 100%; height: 100%; }

.hud {
  position: absolute; top: 10px; left: 10px;
  font-family: monospace; font-size: 12px; color: #0f0; line-height: 1.7;
  pointer-events: none;
}
.fps { font-size: 18px; font-weight: bold; }
.fps span { font-size: 12px; color: #0a0; }

.mode-strip {
  position: absolute; top: 10px; left: 50%; transform: translateX(-50%);
  display: flex; gap: 4px; background: rgba(0,0,0,0.75); padding: 6px 10px;
  border-radius: 6px; border: 1px solid #333;
}
.mode-btn {
  padding: 5px 10px; border: 1px solid #444; border-radius: 4px;
  background: #1a1a1a; color: #aaa; font-family: monospace; font-size: 11px;
  cursor: pointer; transition: background 0.15s;
}
.mode-btn:hover { background: #2a2a2a; color: #ddd; }
.mode-btn.active { background: #1a3a6a; border-color: #4488ff; color: #88ccff; }

.controls {
  position: absolute; top: 60px; right: 10px;
  display: flex; flex-direction: column; gap: 9px;
  font-family: monospace; font-size: 12px; color: #bbb;
  background: rgba(0,0,0,0.75); padding: 12px 16px; border-radius: 6px;
  border: 1px solid #333; min-width: 200px;
}
.ctrl-title { font-size: 11px; color: #666; margin-bottom: 2px; }

label { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
label.check { gap: 8px; }
input[type=range] { width: 80px; flex-shrink: 0; }

.hint-small { font-size: 10px; color: #555; margin-top: 4px; }

.desc {
  position: absolute; bottom: 10px; left: 50%; transform: translateX(-50%);
  font-family: monospace; font-size: 11px; color: #667;
  background: rgba(0,0,0,0.65); padding: 5px 14px; border-radius: 4px;
  max-width: 90%; text-align: center; pointer-events: none;
}
</style>
