<script setup lang="ts">
/**
 * Selection FX derisking tab — compares five GPU/CPU approaches for selection animation.
 *
 * Modes:
 *  A  CPU Ants      — white+black dashed outline redrawn per frame (our current approach)
 *  B  Outline Pulse — pixi-filters OutlineFilter with cycling hue
 *  C  Glow Aura     — pixi-filters GlowFilter with pulsing outerStrength
 *  D  GPU Shader    — custom GLSL: alpha edge detection + gradient-tangent dash animation
 *  E  Multi-FX      — Outline + Glow stacked to show composability
 */
import { ref, onMounted, onUnmounted, markRaw, watch } from 'vue'
import { Application, Graphics, Container } from 'pixi.js'
import { Filter, GlProgram, defaultFilterVert } from 'pixi.js'
import { OutlineFilter, GlowFilter } from 'pixi-filters'
import { useFps } from '../shared/useFps'

type Mode = 'cpu-ants' | 'outline' | 'glow' | 'gpu-shader' | 'multi'

interface ShapeDef {
  label: string
  draw: (g: Graphics) => void
  outline: [number, number][]  // closed polyline for CPU ants
}

interface Shape {
  wrap: Container
  gfx: Graphics
  def: ShapeDef
  selected: boolean
}

const { fps, frameMs } = useFps()
const canvasEl = ref<HTMLCanvasElement>()

const mode = ref<Mode>('cpu-ants')

// --- CPU ants params ---
const antsSpeed = ref(2.5)
const antsDash = ref(8)
const antsGap = ref(6)

// --- Outline params ---
const outlineThick = ref(2.5)
const outlineAnimate = ref(true)

// --- Glow params ---
const glowOuter = ref(3.5)
const glowDist = ref(18)
const glowPulse = ref(true)

// --- GPU shader params ---
const gpuDash = ref(12)
const gpuGap = ref(8)
const gpuSpeed = ref(1.5)

// --- Pixi objects (markRaw so Vue doesn't proxy them) ---
let app = markRaw({} as Application)
let overlayGfx = markRaw({} as Graphics)
let shapes: Shape[] = []
let outlineF: OutlineFilter | null = null
let glowF: GlowFilter | null = null
let gpuFilter: Filter | null = null

let dashOffset = 0
let gpuTime = 0
let outlineHue = 0

// ---- Shape definitions -----------------------------------------------------------

const SHAPES: ShapeDef[] = [
  {
    label: 'Rectangle',
    draw(g) {
      g.setFillStyle({ color: 0x1a3a5c, alpha: 0.85 })
      g.setStrokeStyle({ width: 1, color: 0x3366aa })
      g.rect(0, 0, 200, 130).fill().stroke()
    },
    outline: [[0,0],[200,0],[200,130],[0,130],[0,0]],
  },
  {
    label: 'Hexagon',
    draw(g) {
      g.setFillStyle({ color: 0x1a4a2a, alpha: 0.85 })
      g.setStrokeStyle({ width: 1, color: 0x33aa55 })
      const pts: [number,number][] = Array.from({length: 6}, (_, i) => {
        const a = (Math.PI / 3) * i - Math.PI / 6
        return [90 + Math.cos(a) * 85, 90 + Math.sin(a) * 85]
      })
      g.moveTo(pts[0][0], pts[0][1])
      for (let i = 1; i < pts.length; i++) g.lineTo(pts[i][0], pts[i][1])
      g.closePath().fill().stroke()
    },
    outline: (() => {
      const pts: [number,number][] = Array.from({length: 6}, (_, i) => {
        const a = (Math.PI / 3) * i - Math.PI / 6
        return [90 + Math.cos(a) * 85, 90 + Math.sin(a) * 85]
      })
      return [...pts, pts[0]] as [number,number][]
    })(),
  },
  {
    label: 'Dimension Line',
    draw(g) {
      g.setStrokeStyle({ width: 8, color: 0xcc8822, cap: 'square' })
      g.moveTo(0, 20).lineTo(300, 20).stroke()
      g.setFillStyle({ color: 0xcc8822 })
      g.rect(0, 0, 8, 40).fill()
      g.rect(292, 0, 8, 40).fill()
    },
    outline: [[-4, -4],[304, -4],[304, 44],[-4, 44],[-4, -4]],
  },
  {
    label: 'Bed Polygon',
    draw(g) {
      g.setFillStyle({ color: 0x3a2810, alpha: 0.85 })
      g.setStrokeStyle({ width: 1, color: 0xaa6622 })
      const pts: [number,number][] = [[20,80],[100,10],[230,30],[260,100],[160,150],[40,140]]
      g.moveTo(pts[0][0], pts[0][1])
      for (let i = 1; i < pts.length; i++) g.lineTo(pts[i][0], pts[i][1])
      g.closePath().fill().stroke()
    },
    outline: [[20,80],[100,10],[230,30],[260,100],[160,150],[40,140],[20,80]],
  },
]

// ---- GPU shader source -----------------------------------------------------------
// Plain global uniforms — NOT UBO blocks — to match how pixi-filters declares them.
// uTexelSize is updated per-apply from the input texture dimensions.

const GPU_FRAG = /* glsl */ `
in vec2 vTextureCoord;
out vec4 finalColor;

uniform sampler2D uTexture;

uniform vec2 uTexelSize;
uniform float uTime;
uniform float uDashLen;
uniform float uGapLen;

void main() {
  vec4 c = texture(uTexture, vTextureCoord);

  // Binarize alpha (0.5 threshold) before edge detection.
  float inside = step(0.5, c.a);

  // Sample at up to uDashLen pixels away to create a thick enough visible band.
  // uDashLen is re-purposed as the detection radius here (in physical pixels).
  float s = max(4.0, uDashLen * 0.5);
  float aL = step(0.5, texture(uTexture, vTextureCoord + vec2(-uTexelSize.x * s, 0.0)).a);
  float aR = step(0.5, texture(uTexture, vTextureCoord + vec2( uTexelSize.x * s, 0.0)).a);
  float aU = step(0.5, texture(uTexture, vTextureCoord + vec2(0.0, -uTexelSize.y * s)).a);
  float aD = step(0.5, texture(uTexture, vTextureCoord + vec2(0.0,  uTexelSize.y * s)).a);

  // Edge: outside but adjacent to inside within s pixels
  float maxN = max(max(aL, aR), max(aU, aD));
  float isEdge = (1.0 - inside) * maxN;

  // Gradient-derived tangent (from binarized neighbors)
  float gx = aR - aL;
  float gy = aD - aU;
  float gLen = length(vec2(gx, gy));
  vec2 tang = gLen > 0.001 ? normalize(vec2(-gy, gx)) : vec2(1.0, 0.0);

  // Project pixel coord onto tangent; animated dash phase (pixel space)
  vec2 px = vTextureCoord / uTexelSize;
  float period = uDashLen + uGapLen;
  float phase = mod(dot(px, tang) - uTime * 80.0, period);
  float inDash = step(phase, uDashLen);

  // Two-tone ants: white on black
  vec3 dashColor = mix(vec3(0.0), vec3(1.0), inDash);
  // Interior: pass through original. Edge band: animated white/black dash.
  finalColor = mix(c, vec4(dashColor, 1.0), isEdge);
}
`

// GpuAntsFilter — subclasses Filter to update uTexelSize from input texture dimensions
class GpuAntsFilter extends Filter {
  constructor() {
    super({
      glProgram: GlProgram.from({ vertex: defaultFilterVert, fragment: GPU_FRAG }),
      resources: {
        gpuAntsUniforms: {
          uTexelSize: { value: new Float32Array([0.005, 0.005]), type: 'vec2<f32>' },
          uTime:      { value: 0.0,  type: 'f32' },
          uDashLen:   { value: 12.0, type: 'f32' },
          uGapLen:    { value: 8.0,  type: 'f32' },
        },
      },
      padding: 8,
    })
  }

  override apply(fm: any, input: any, output: any, clearMode: any): void {
    const u = this.resources.gpuAntsUniforms.uniforms
    u.uTexelSize[0] = 1 / input.source.width
    u.uTexelSize[1] = 1 / input.source.height
    super.apply(fm, input, output, clearMode)
  }
}

// ---- CPU ants helpers ------------------------------------------------------------

function drawDashedPoly(
  g: Graphics, pts: [number,number][],
  offset: number, dash: number, gap: number, color: number,
) {
  const period = dash + gap
  g.beginPath()
  g.setStrokeStyle({ width: 1.5, color } as any)

  for (let i = 1; i < pts.length; i++) {
    const ax = pts[i-1][0], ay = pts[i-1][1]
    const bx = pts[i][0],   by = pts[i][1]
    const segLen = Math.hypot(bx - ax, by - ay)
    const dx = (bx - ax) / segLen, dy = (by - ay) / segLen

    let t = 0
    let dist = -((offset % period) + period) % period

    while (t < segLen) {
      const phase = ((dist + t) % period + period) % period
      const inD = phase < dash
      const remaining = inD ? dash - phase : period - phase
      const step = Math.min(remaining, segLen - t)
      const nextT = t + step
      if (nextT <= t) break

      if (inD) {
        g.moveTo(ax + dx * t,     ay + dy * t)
        g.lineTo(ax + dx * nextT, ay + dy * nextT)
      }
      t = nextT
    }
  }
  g.stroke()
}

// ---- Setup helpers ---------------------------------------------------------------

function makeShapes(stage: Container): void {
  const positions: [number, number][] = [
    [70, 60],
    [360, 50],
    [80, 330],
    [350, 290],
  ]

  for (let i = 0; i < SHAPES.length; i++) {
    const def = SHAPES[i]
    const wrap = markRaw(new Container())
    const gfx  = markRaw(new Graphics())
    wrap.position.set(positions[i][0], positions[i][1])
    def.draw(gfx)

    gfx.eventMode = 'static'
    gfx.cursor = 'pointer'
    gfx.on('pointerdown', () => toggleShape(i))

    wrap.addChild(gfx)
    stage.addChild(wrap)

    shapes.push({ wrap, gfx, def, selected: false })
  }
}

function toggleShape(i: number): void {
  shapes[i].selected = !shapes[i].selected
  _applyMode()
}

// ---- Filter / mode management ----------------------------------------------------

function _clearFilters(): void {
  for (const s of shapes) {
    s.wrap.filters = []
  }
}

function _applyMode(): void {
  _clearFilters()
  overlayGfx.clear()

  const selected = shapes.filter(s => s.selected)

  if (mode.value === 'outline' || mode.value === 'multi') {
    if (!outlineF) return
    for (const s of selected) {
      s.wrap.filters = mode.value === 'multi' && glowF
        ? [outlineF, glowF]
        : [outlineF]
    }
  } else if (mode.value === 'glow') {
    if (!glowF) return
    for (const s of selected) s.wrap.filters = [glowF]
  } else if (mode.value === 'gpu-shader') {
    if (!gpuFilter) return
    for (const s of selected) s.wrap.filters = [gpuFilter]
  }
  // cpu-ants: no filters needed, drawn in onTick
}

// ---- Ticker ----------------------------------------------------------------------

function hslToRgb(h: number, s: number, l: number): number {
  const k = (n: number) => (n + h / 30) % 12
  const a = s * Math.min(l, 1 - l)
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)))
  return (Math.round(f(0) * 255) << 16) | (Math.round(f(8) * 255) << 8) | Math.round(f(4) * 255)
}

function onTick(ticker: { deltaTime: number; deltaMS: number; [k: string]: any }): void {
  const dt = ticker.deltaTime

  if (mode.value === 'cpu-ants') {
    dashOffset += antsSpeed.value * dt
    overlayGfx.clear()
    for (const s of shapes) {
      if (!s.selected) continue
      const pts = s.def.outline.map(
        ([x, y]) => [x + s.wrap.x, y + s.wrap.y] as [number, number],
      )
      drawDashedPoly(overlayGfx, pts, dashOffset, antsDash.value, antsGap.value, 0xffffff)
      drawDashedPoly(overlayGfx, pts, dashOffset + antsDash.value + antsGap.value, antsDash.value, antsGap.value, 0x000000)
    }
  }

  if (mode.value === 'outline' || mode.value === 'multi') {
    if (outlineF && outlineAnimate.value) {
      outlineHue = (outlineHue + dt * 2) % 360
      outlineF.color = hslToRgb(outlineHue, 0.9, 0.55)
    }
  }

  if (mode.value === 'glow' || mode.value === 'multi') {
    if (glowF && glowPulse.value) {
      gpuTime += dt * 0.04
      const strength = glowOuter.value * (0.6 + 0.4 * Math.sin(gpuTime * 3))
      glowF.outerStrength = strength
    }
  }

  if (mode.value === 'gpu-shader') {
    if (gpuFilter) {
      gpuTime += ticker.deltaMS / 1000
      const u = (gpuFilter as GpuAntsFilter).resources.gpuAntsUniforms.uniforms
      u.uTime    = gpuTime * gpuSpeed.value
      u.uDashLen = gpuDash.value
      u.uGapLen  = gpuGap.value
    }
  }
}

// ---- Lifecycle -------------------------------------------------------------------

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

  const shapesLayer = markRaw(new Container())
  overlayGfx = markRaw(new Graphics())
  app.stage.addChild(shapesLayer, overlayGfx)

  makeShapes(shapesLayer)

  // Create filters (needs app context)
  outlineF = markRaw(new OutlineFilter({ thickness: outlineThick.value, color: 0xffffff, quality: 0.25 }))
  glowF = markRaw(new GlowFilter({ distance: glowDist.value, outerStrength: glowOuter.value, innerStrength: 0, color: 0x4499ff, quality: 0.5 }))

  try {
    gpuFilter = markRaw(new GpuAntsFilter())
  } catch (e) {
    console.error('[SelectionFX] GPU shader failed to create:', e)
    gpuFilter = null
  }

  app.ticker.add(onTick)

  // Sync filter params when sliders change
  watch(outlineThick, v => { if (outlineF) outlineF.thickness = v })
  watch(glowOuter,    v => { if (glowF && !glowPulse.value) glowF.outerStrength = v })
  watch(glowDist,     v => { if (glowF) glowF.distance = v })
})

onUnmounted(() => {
  app?.ticker?.remove(onTick)
  app?.destroy(true, { children: true, texture: true, context: true })
})

const MODES: { id: Mode; label: string }[] = [
  { id: 'cpu-ants',   label: 'A · CPU Ants' },
  { id: 'outline',    label: 'B · Outline' },
  { id: 'glow',       label: 'C · Glow' },
  { id: 'gpu-shader', label: 'D · GPU Shader' },
  { id: 'multi',      label: 'E · Multi-FX' },
]

function selectMode(m: Mode) {
  mode.value = m
  _applyMode()
}

const DESCRIPTIONS: Record<Mode, string> = {
  'cpu-ants':   'Classic marching ants — dashed outline redrawn every frame on CPU. Current Flora CAD approach.',
  'outline':    'pixi-filters OutlineFilter — GPU filter generates a solid outline ring, CPU cycles its hue.',
  'glow':       'pixi-filters GlowFilter — GPU soft-glow bloom around the selected shape, pulsing strength.',
  'gpu-shader': 'Custom GLSL filter — alpha edge detection + gradient-tangent dash phase, zero CPU per frame.',
  'multi':      'Outline + Glow stacked — shows filter composability; two filters on one container.',
}
</script>

<template>
  <div class="wrap">
    <canvas ref="canvasEl" />

    <!-- HUD -->
    <div class="hud">
      <div class="fps">{{ fps }} <span>fps</span></div>
      <div>{{ frameMs }} ms</div>
    </div>

    <!-- Mode switcher -->
    <div class="mode-strip">
      <button
        v-for="m in MODES" :key="m.id"
        :class="['mode-btn', { active: mode === m.id }]"
        @click="selectMode(m.id)"
      >{{ m.label }}</button>
    </div>

    <!-- Per-mode controls -->
    <div class="controls">
      <div class="ctrl-title">{{ MODES.find(m => m.id === mode)?.label }}</div>

      <!-- CPU Ants -->
      <template v-if="mode === 'cpu-ants'">
        <label>Speed
          <input type="range" v-model.number="antsSpeed" min="0.5" max="8" step="0.5" />
          {{ antsSpeed.toFixed(1) }}
        </label>
        <label>Dash
          <input type="range" v-model.number="antsDash" min="2" max="20" step="1" />
          {{ antsDash }}px
        </label>
        <label>Gap
          <input type="range" v-model.number="antsGap" min="2" max="20" step="1" />
          {{ antsGap }}px
        </label>
      </template>

      <!-- Outline -->
      <template v-else-if="mode === 'outline'">
        <label>Thickness
          <input type="range" v-model.number="outlineThick" min="1" max="6" step="0.5" />
          {{ outlineThick }}px
        </label>
        <label class="check">
          <input type="checkbox" v-model="outlineAnimate" />
          Animate hue
        </label>
      </template>

      <!-- Glow -->
      <template v-else-if="mode === 'glow'">
        <label>Outer str
          <input type="range" v-model.number="glowOuter" min="0.5" max="8" step="0.5" />
          {{ glowOuter }}
        </label>
        <label>Distance
          <input type="range" v-model.number="glowDist" min="4" max="40" step="2" />
          {{ glowDist }}px
        </label>
        <label class="check">
          <input type="checkbox" v-model="glowPulse" />
          Pulse
        </label>
      </template>

      <!-- GPU Shader -->
      <template v-else-if="mode === 'gpu-shader'">
        <label>Speed
          <input type="range" v-model.number="gpuSpeed" min="0.2" max="5" step="0.2" />
          {{ gpuSpeed.toFixed(1) }}
        </label>
        <label>Dash
          <input type="range" v-model.number="gpuDash" min="2" max="24" step="1" />
          {{ gpuDash }}px
        </label>
        <label>Gap
          <input type="range" v-model.number="gpuGap" min="2" max="24" step="1" />
          {{ gpuGap }}px
        </label>
        <div v-if="!gpuFilter" class="warn">GPU shader failed — check console</div>
      </template>

      <!-- Multi -->
      <template v-else-if="mode === 'multi'">
        <label>Outline thick
          <input type="range" v-model.number="outlineThick" min="1" max="6" step="0.5" />
          {{ outlineThick }}px
        </label>
        <label>Glow str
          <input type="range" v-model.number="glowOuter" min="0.5" max="8" step="0.5" />
          {{ glowOuter }}
        </label>
        <label class="check">
          <input type="checkbox" v-model="outlineAnimate" />
          Cycle color
        </label>
        <label class="check">
          <input type="checkbox" v-model="glowPulse" />
          Pulse glow
        </label>
      </template>

      <div class="hint-small">Click shapes to select/deselect</div>
    </div>

    <!-- Description bar -->
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

.warn { color: #ff6644; font-size: 11px; }
.hint-small { font-size: 10px; color: #555; margin-top: 4px; }

.desc {
  position: absolute; bottom: 10px; left: 50%; transform: translateX(-50%);
  font-family: monospace; font-size: 11px; color: #667;
  background: rgba(0,0,0,0.65); padding: 5px 14px; border-radius: 4px;
  white-space: nowrap; pointer-events: none; max-width: 90%;
  overflow: hidden; text-overflow: ellipsis;
}
</style>
