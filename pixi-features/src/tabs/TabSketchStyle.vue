<script setup lang="ts">
/**
 * Sketch Style (rough.js) derisking fixture.
 *
 * Proves the flora-studio pen-path plan: render vector paths with a hand-drawn look by
 * feeding rough.js's GENERATOR (not its canvas) op-list into a Pixi Graphics. The exact
 * replay loop here (move/lineTo/bcurveTo -> Pixi) is what ports to PixiFeatureLine.drawPath.
 *
 * What to check:
 *  - Roughness / Bowing sliders change the sketch feel live.
 *  - Seed changes the specific wobble but keeps the same "amount".
 *  - Double-stroke on/off = the characteristic hand-drawn double line.
 *  - SCROLL TO ZOOM: the wobble scales with the drawing and NEVER re-randomizes/crawls,
 *    because geometry is generated once (fixed seed, world coords) and cached; only the
 *    parent container is scaled. This is the "randomness shouldn't vary as you zoom" req.
 */
import { ref, reactive, onMounted, onUnmounted, markRaw, watch } from 'vue'
import { Application, Assets, Container, Graphics, Sprite, Texture } from 'pixi.js'
import { drawRoughStroke, type RoughStrokeOptions } from '../lib/roughStroke'
import { drawKinematicStroke, type KinematicStrokeOptions } from '../lib/kinematicStroke'
import { PaperGrainFilter, PAPER_GRAIN_DEFAULTS } from '../lib/filters/PaperGrainFilter'
import { useFps } from '../shared/useFps'
import { pencilTestShapes } from '../fixtures/pencilTestShapes'

const { fps, frameMs } = useFps()
const canvasEl = ref<HTMLCanvasElement>()

const opts = reactive({
  roughness: 1.0,
  bowing: 1.0,
  seed: 42,
  doubleStroke: true,
  strokeWidth: 2,
  showCrisp: true, // overlay the exact geometry in faint gray for comparison
  generator: 'rough' as 'rough' | 'kinematic',
  squiggle: 6,      // world-unit lateral deviation for the kinematic model
  cpSpacing: 40,    // world-unit control-point spacing
  overshoot: 4,     // world-unit endpoint overshoot (open paths)
  cornerAngle: 35, // turn angle (deg) above which a vertex is a crisp corner
})

// Paper-grain (graphite compositing) controls.
// Available real paper/graphite textures shipped in the repo.
const PAPER_TEXTURES = [
  { label: 'Watercolor RPN (seamless)', url: '/textures/paper/watercolor-height.png' },
  { label: 'Height smooth (for normals)', url: '/textures/paper/watercolor-height-smooth.png' },
  { label: 'Watercolor (white)',        url: '/textures/paper/watercolor-white.png' },
  { label: 'Smooth (gray)',             url: '/textures/paper/smooth-gray.png' },
  { label: 'Kraft (tan)',               url: '/textures/paper/kraft-tan.png' },
  { label: 'Graphite (heavy)',          url: '/textures/pencil/grain-heavy.jpg' },
] as const

const grain = reactive({
  enabled: true,
  useTexture: true,  // real texture vs procedural noise (the "static" look)
  textureUrl: PAPER_TEXTURES[0].url,
  grainScale: PAPER_GRAIN_DEFAULTS.grainScale,
  grainContrast: PAPER_GRAIN_DEFAULTS.grainContrast,
  octaves: true,   // fractal octaves on = no zoom pixelation
  screenLock: false, // true = deliberately reproduce the "shower door" failure
  showGrain: false,  // visualize the raw grain field
  inkGrain: true,    // graphite catches on the paper tooth inside the strokes
  inkGrainAmt: 0.55, // how much the tooth breaks up the lines
  surface: false,    // height->normal lighting + directional graphite tooth
  lightAngle: 135,   // raking light angle (deg)
  bump: 3,           // surface normal steepness
})

let app = markRaw({} as Application)
let world = markRaw({} as Container)
let paperSprite = markRaw({} as Sprite)
let paperFilter = markRaw({} as PaperGrainFilter)
let inkFilter = markRaw({} as PaperGrainFilter)
let camX = 0, camY = 0, zoom = 1
let isPanning = false, panStart = { x: 0, y: 0 }

function crispPath(g: Graphics, d: string): void {
  // Minimal SVG-d replay for the faint reference overlay (M/L/C/Z only — matches pencilTestShapes()).
  const toks = d.match(/[MLCZ]|-?\d*\.?\d+/g) ?? []
  let i = 0
  const num = () => parseFloat(toks[i++])
  while (i < toks.length) {
    const cmd = toks[i++]
    if (cmd === 'M') g.moveTo(num(), num())
    else if (cmd === 'L') g.lineTo(num(), num())
    else if (cmd === 'C') g.bezierCurveTo(num(), num(), num(), num(), num(), num())
    else if (cmd === 'Z') g.closePath()
  }
  g.stroke({ color: 0x000000, width: 1 / zoom, alpha: 0.18 })
}

// Phase A layered-graphite build-up: N low-alpha passes, each a differently-seeded searching line.
const PASS_ALPHA = 0.55
const PASS_SEEDS = [0, 7]

function redraw(): void {
  world.removeChildren().forEach((c) => c.destroy())
  const ro: RoughStrokeOptions = {
    roughness: opts.roughness,
    bowing: opts.bowing,
    seed: opts.seed,
    doubleStroke: opts.doubleStroke,
  }
  for (const s of pencilTestShapes()) {
    if (opts.showCrisp) {
      const ref = markRaw(new Graphics())
      crispPath(ref, s.d)
      world.addChild(ref)
    }
    // Phase A "layered graphite": draw each stroke as 2 low-alpha passes with different seeds,
    // multiply-blended, so the offset passes + crossings DARKEN like layered pencil (instead of
    // flat occlusion). The broken full-screen grain filter over `world` is gone (see applyGrain).
    // Bonus: multiply composites strokes against the paper sprite behind → they pick up its tooth.
    for (const seedOffset of PASS_SEEDS) {
      const g = markRaw(new Graphics())
      g.blendMode = 'multiply'
      const style = { color: s.color, width: opts.strokeWidth / zoom, alpha: PASS_ALPHA }
      if (opts.generator === 'kinematic') {
        const ko: KinematicStrokeOptions = {
          squiggle: opts.squiggle,
          cpSpacing: opts.cpSpacing,
          seed: opts.seed + seedOffset,
          overshoot: opts.overshoot,
          cornerAngle: opts.cornerAngle,
        }
        drawKinematicStroke(g, s.d, ko, style)
      } else {
        drawRoughStroke(g, s.d, { ...ro, seed: opts.seed + seedOffset }, style)
      }
      world.addChild(g)
    }
  }
}

// Stroke width is authored in *screen pixels* here (width/zoom) so it stays readable while
// we test zoom. The rough GEOMETRY is world-space + cached, so it is NOT regenerated on
// zoom — only the width and the crisp-overlay are cheaply recomputed.
function onZoomChanged(): void {
  syncCamera()
  redraw()
}

onMounted(async () => {
  const canvas = canvasEl.value!
  app = markRaw(new Application())
  await app.init({
    canvas, width: canvas.clientWidth, height: canvas.clientHeight,
    antialias: true, backgroundAlpha: 0, resolution: devicePixelRatio, autoDensity: true,
  })

  camX = canvas.clientWidth / 2
  camY = canvas.clientHeight / 2
  app.stage.position.set(camX, camY)

  // Full-screen paper layer BEHIND the strokes. It's a child of the panned/zoomed stage, so
  // we counter-offset its position (-cam) and keep scale 1 to pin it to the screen. Its bounds
  // are exactly the canvas, guaranteeing the grain filter covers everything. The grain itself
  // is world-anchored inside the shader via uWorldMatrix (so it pans/zooms with the drawing).
  paperFilter = markRaw(new PaperGrainFilter())          // mode 0: paper background
  inkFilter = markRaw(new PaperGrainFilter({ ...PAPER_GRAIN_DEFAULTS, mode: 1 })) // mode 1: strokes
  paperSprite = markRaw(new Sprite(Texture.WHITE))
  paperSprite.setSize(canvas.clientWidth, canvas.clientHeight)
  app.stage.addChild(paperSprite)

  world = markRaw(new Container())
  app.stage.addChild(world)

  await loadPaperTexture(grain.textureUrl)
  applyGrain()
  redraw()

  canvas.addEventListener('wheel', onWheel, { passive: false })
  canvas.addEventListener('pointerdown', onPD)
  window.addEventListener('pointermove', onPM)
  window.addEventListener('pointerup', onPU)

  if (import.meta.env.DEV) {
    const { registerPixiBridge } = await import('pixi-bridge')
    registerPixiBridge(app, {
      tabName: 'sketch-style',
      getSnapshot: () => ({ ...opts, zoom }),
    })
  }
})

onUnmounted(() => {
  window.__pixiTestBridge = undefined
  window.__pixiTestBridgeReady = false
  canvasEl.value?.removeEventListener('wheel', onWheel)
  canvasEl.value?.removeEventListener('pointerdown', onPD)
  window.removeEventListener('pointermove', onPM)
  window.removeEventListener('pointerup', onPU)
  app?.destroy(true, { children: true, texture: true, context: true })
})

// Redraw when any sketch parameter changes (but NOT on pan — pan only moves the stage).
watch(opts, () => redraw())

// Keep the paper layer pinned to the screen (counter the stage's pan) and the grain shader's
// camera uniforms in sync. Called on every pan/zoom.
function syncCamera(): void {
  if (paperSprite.position) paperSprite.position.set(-camX, -camY)
  paperFilter.setCamera?.(camX, camY, zoom)
  inkFilter.setCamera?.(camX, camY, zoom)
}

async function loadPaperTexture(url: string): Promise<void> {
  const tex = await Assets.load(url)
  // Tiling repeat so the world-anchored UVs wrap seamlessly across the sheet.
  tex.source.style.addressMode = 'repeat'
  tex.source.style.update()
  paperFilter.setPaperTexture(tex.source)
  inkFilter.setPaperTexture(tex.source)
}

function applyGrain(): void {
  const a = (grain.lightAngle * Math.PI) / 180
  const shared = {
    grainScale: grain.grainScale,
    useTexture: grain.useTexture ? 1 : 0,
    octaves: grain.octaves ? 1 : 0,
    anchor: grain.screenLock ? 1 : 0,
    surface: grain.surface ? 1 : 0,
    lightDir: [Math.cos(a), Math.sin(a)] as [number, number],
    bumpStrength: grain.bump,
  }
  paperFilter.setParams({ ...shared, grainContrast: grain.grainContrast, showGrain: grain.showGrain ? 1 : 0 })
  inkFilter.setParams({ ...shared, inkGrain: grain.inkGrainAmt })
  paperSprite.filters = grain.enabled ? [paperFilter] : []
  paperSprite.visible = grain.enabled
  // Phase A: the graphite-in-stroke filter over the scaled `world` container is the cause of the
  // stairstepping (below-screen-res RenderTexture) + the 4fps cliff (bounds grow with zoom). Killed.
  // Graphite tooth now comes from multiply-blending the strokes against the paper sprite; a proper
  // stroke-space shader (Phase B ribbon mesh) replaces it. inkFilter left instantiated but unused.
  world.filters = []
  syncCamera()
}
watch(grain, () => applyGrain())
watch(() => grain.textureUrl, async (url) => { await loadPaperTexture(url); applyGrain() })

function onWheel(e: WheelEvent) {
  e.preventDefault()
  const rect = canvasEl.value!.getBoundingClientRect()
  const sx = e.clientX - rect.left
  const sy = e.clientY - rect.top
  const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12
  const wx = (sx - camX) / zoom
  const wy = (sy - camY) / zoom
  zoom = Math.max(0.1, Math.min(30, zoom * factor))
  camX = sx - wx * zoom
  camY = sy - wy * zoom
  app.stage.position.set(camX, camY)
  world.scale.set(zoom)
  onZoomChanged()
}

function onPD(e: PointerEvent) {
  isPanning = true
  panStart = { x: e.clientX - camX, y: e.clientY - camY }
  ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
}
function onPM(e: PointerEvent) {
  if (!isPanning) return
  camX = e.clientX - panStart.x
  camY = e.clientY - panStart.y
  app.stage.position.set(camX, camY)
  syncCamera()
}
function onPU() { isPanning = false }

function reseed() { opts.seed = Math.floor(Math.random() * 100000) + 1 }
</script>

<template>
  <div class="wrap">
    <canvas ref="canvasEl" />
    <div class="hud">
      <div class="fps">{{ fps }} <span>fps</span></div>
      <div>{{ frameMs }} ms</div>
      <div class="sep" />
      <div>zoom: {{ zoom.toFixed(2) }}×</div>
    </div>

    <div class="panel">
      <div class="title">Sketch Style · rough.js generator → Pixi Graphics</div>

      <label>Generator
        <select v-model="opts.generator">
          <option value="rough">rough.js (wobble)</option>
          <option value="kinematic">kinematic (min-jerk)</option>
        </select>
      </label>

      <label>Roughness <b>{{ opts.roughness.toFixed(2) }}</b>
        <input type="range" min="0" max="4" step="0.05" v-model.number="opts.roughness" />
      </label>
      <label>Bowing <b>{{ opts.bowing.toFixed(2) }}</b>
        <input type="range" min="0" max="6" step="0.1" v-model.number="opts.bowing" />
      </label>
      <label>Stroke width <b>{{ opts.strokeWidth.toFixed(1) }}px</b>
        <input type="range" min="0.5" max="6" step="0.5" v-model.number="opts.strokeWidth" />
      </label>
      <label>Seed <b>{{ opts.seed }}</b>
        <input type="range" min="1" max="200" step="1" v-model.number="opts.seed" />
      </label>

      <template v-if="opts.generator === 'kinematic'">
        <label>Squiggle <b>{{ opts.squiggle.toFixed(1) }}</b>
          <input type="range" min="0" max="30" step="0.5" v-model.number="opts.squiggle" />
        </label>
        <label>CP spacing <b>{{ opts.cpSpacing.toFixed(0) }}</b>
          <input type="range" min="8" max="120" step="2" v-model.number="opts.cpSpacing" />
        </label>
        <label>Overshoot <b>{{ opts.overshoot.toFixed(1) }}</b>
          <input type="range" min="0" max="20" step="0.5" v-model.number="opts.overshoot" />
        </label>
        <label>Corner angle <b>{{ opts.cornerAngle }}°</b>
          <input type="range" min="0" max="90" step="1" v-model.number="opts.cornerAngle" />
        </label>
      </template>

      <div class="toggles">
        <label class="chk"><input type="checkbox" v-model="opts.doubleStroke" /> Double stroke</label>
        <label class="chk"><input type="checkbox" v-model="opts.showCrisp" /> Show exact geometry</label>
      </div>
      <button class="btn" @click="reseed">🎲 Re-seed</button>

      <div class="divider" />
      <div class="subtitle">
        <label class="chk"><input type="checkbox" v-model="grain.enabled" /> <b>Paper grain</b></label>
      </div>
      <template v-if="grain.enabled">
        <label>Texture
          <select v-model="grain.textureUrl" :disabled="!grain.useTexture">
            <option v-for="t in PAPER_TEXTURES" :key="t.url" :value="t.url">{{ t.label }}</option>
          </select>
        </label>
        <label>Grain scale <b>{{ grain.grainScale.toFixed(1) }}</b>
          <input type="range" min="2" max="400" step="1" v-model.number="grain.grainScale" />
        </label>
        <label>Grain contrast <b>{{ grain.grainContrast.toFixed(2) }}</b>
          <input type="range" min="0" max="1" step="0.05" v-model.number="grain.grainContrast" />
        </label>
        <label>Graphite in strokes <b>{{ grain.inkGrainAmt.toFixed(2) }}</b>
          <input type="range" min="0" max="1" step="0.05" v-model.number="grain.inkGrainAmt" :disabled="!grain.inkGrain" />
        </label>
        <div class="toggles">
          <label class="chk"><input type="checkbox" v-model="grain.inkGrain" /> <b>Graphite in strokes</b> (lines catch tooth)</label>
          <label class="chk"><input type="checkbox" v-model="grain.surface" /> <b>Surface lighting</b> (normal map + directional)</label>
        </div>
        <template v-if="grain.surface">
          <label>Light angle <b>{{ grain.lightAngle }}°</b>
            <input type="range" min="0" max="360" step="5" v-model.number="grain.lightAngle" />
          </label>
          <label>Bump strength <b>{{ grain.bump.toFixed(1) }}</b>
            <input type="range" min="1" max="30" step="0.5" v-model.number="grain.bump" />
          </label>
        </template>
        <div class="toggles">
          <label class="chk"><input type="checkbox" v-model="grain.useTexture" /> Real texture (off = procedural static)</label>
          <label class="chk"><input type="checkbox" v-model="grain.octaves" /> Fractal octaves (anti-pixelate)</label>
          <label class="chk warn"><input type="checkbox" v-model="grain.screenLock" /> Screen-lock (shower door!)</label>
          <label class="chk"><input type="checkbox" v-model="grain.showGrain" /> Show raw grain / normals</label>
        </div>
      </template>
    </div>

    <div class="hint">
      <kbd>scroll</kbd> zoom — wobble scales with the drawing & never re-randomizes ·
      <kbd>drag</kbd> pan
    </div>
  </div>
</template>

<style scoped>
.wrap { position: relative; width: 100%; height: 100%; background: #f4f1ea; }
canvas { display: block; width: 100%; height: 100%; cursor: grab; }
canvas:active { cursor: grabbing; }
.hud { position: absolute; top: 10px; left: 10px; font-family: monospace; font-size: 12px; color: #3a3a3a; line-height: 1.7; pointer-events: none; }
.fps { font-size: 18px; font-weight: bold; }
.fps span { font-size: 12px; color: #888; }
.sep { height: 6px; }
.panel {
  position: absolute; top: 10px; right: 10px;
  font-family: monospace; font-size: 11px; color: #333; line-height: 1.5;
  background: rgba(255,255,255,0.9); padding: 12px 14px; border-radius: 6px;
  border: 1px solid #ddd; width: 230px; box-shadow: 0 2px 10px rgba(0,0,0,0.08);
}
.title { font-weight: bold; margin-bottom: 10px; color: #222; }
.panel label { display: block; margin-bottom: 8px; }
.panel label b { color: #4b7a4b; font-weight: bold; }
.panel input[type=range] { width: 100%; margin-top: 2px; }
.panel select { width: 100%; margin-top: 2px; font-family: monospace; font-size: 11px;
  padding: 3px; border: 1px solid #ccc; border-radius: 3px; background: #fff; }
.toggles { margin: 6px 0 8px; }
.chk { display: flex; align-items: center; gap: 6px; margin-bottom: 4px; cursor: pointer; }
.chk input { margin: 0; }
.chk.warn { color: #b04a2f; }
.divider { height: 1px; background: #e2ddd2; margin: 10px 0; }
.subtitle { margin-bottom: 8px; }
.subtitle b { color: #222; }
.btn { width: 100%; padding: 5px; font-family: monospace; font-size: 11px; cursor: pointer;
  background: #4b7a4b; color: #fff; border: none; border-radius: 4px; }
.btn:hover { background: #3d643d; }
.hint {
  position: absolute; bottom: 10px; left: 50%; transform: translateX(-50%);
  font-family: monospace; font-size: 11px; color: #666;
  background: rgba(255,255,255,0.7); padding: 5px 12px; border-radius: 4px;
  white-space: nowrap; pointer-events: none;
}
kbd { background: #eee; border: 1px solid #ccc; border-radius: 3px; padding: 1px 5px; font-size: 10px; color: #555; }
</style>
