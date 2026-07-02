<script setup lang="ts">
/**
 * Pencil Ribbon (Phase C) — strokes as ribbon MESHES with a stroke-space graphite shader.
 * Geometry is built ONCE from the cached kinematic op-list; the ribbon expansion, width and tip
 * taper now live in the VERTEX shader, so zoom and stroke width are single uniform writes (no
 * per-zoom CPU rebuild). Material (thresholded paper tooth, ragged edge, pressure tone, tip fade)
 * is in the fragment shader; meshes multiply-blend over a screen-fixed paper sprite. Deposition
 * grain uses a dedicated HIGH-frequency tile; the broad watercolor tile drives only the background.
 */
import { ref, reactive, onMounted, onUnmounted, markRaw, watch } from 'vue'
import { Application, Assets, Container, Sprite, Texture, Mesh } from 'pixi.js'
import { kinematicOpsForPath } from '../lib/kinematicStroke'
import { buildStrokeMeshes, STROKE_RIBBON_DEFAULTS } from '../lib/strokeRibbon'
import { PaperGrainFilter } from '../lib/filters/PaperGrainFilter'
import { pencilTestShapes } from '../fixtures/pencilTestShapes'
import { useFps } from '../shared/useFps'

const { fps, frameMs } = useFps()
const canvasEl = ref<HTMLCanvasElement>()

const opts = reactive({
  strokeWidth: 2.5,
  squiggle: 6, cpSpacing: 40, overshoot: 4, cornerAngle: 35, seed: 42,
  taperPx: STROKE_RIBBON_DEFAULTS.taperPx,
  grainFine: STROKE_RIBBON_DEFAULTS.grainFine,
  widthVar: STROKE_RIBBON_DEFAULTS.widthVar,
  toneAmp: STROKE_RIBBON_DEFAULTS.toneAmp,
  tooth: STROKE_RIBBON_DEFAULTS.tooth,
  edgeSoft: STROKE_RIBBON_DEFAULTS.edgeSoft,
  paper: true,
})

let app = markRaw({} as Application)
let world = markRaw({} as Container)
let paperSprite = markRaw({} as Sprite)
let paperFilter = markRaw({} as PaperGrainFilter)
let grainSource = markRaw({} as any)   // high-frequency deposition tile for the ribbon shader
let meshes: Mesh[] = []
let camX = 0, camY = 0, zoom = 1
let isPanning = false, panStart = { x: 0, y: 0 }

function rgb(c: number): [number, number, number] {
  return [((c >> 16) & 255) / 255, ((c >> 8) & 255) / 255, (c & 255) / 255]
}

// Build geometry once per generator/seed change. Width/zoom/material are live uniforms.
function rebuild(): void {
  world.removeChildren().forEach((c) => c.destroy())
  meshes = []
  for (const s of pencilTestShapes()) {
    const ops = kinematicOpsForPath(s.d, {
      squiggle: opts.squiggle, cpSpacing: opts.cpSpacing, seed: opts.seed,
      overshoot: opts.overshoot, cornerAngle: opts.cornerAngle,
    })
    const built = buildStrokeMeshes(ops, grainSource, {
      ...STROKE_RIBBON_DEFAULTS, color: rgb(s.color), seed: opts.seed,
      strokePx: opts.strokeWidth / 2, taperPx: opts.taperPx, grainFine: opts.grainFine,
      widthVar: opts.widthVar, toneAmp: opts.toneAmp, tooth: opts.tooth, edgeSoft: opts.edgeSoft,
    })
    for (const m of built) { world.addChild(m); meshes.push(m) }
  }
  setLiveUniforms()
}

// Push zoom + all material/width values onto every mesh's uniform group (no rebuild).
function setLiveUniforms(): void {
  for (const m of meshes) {
    const u = (m.shader!.resources.strokeUniforms as any).uniforms
    u.uZoom = zoom
    u.uStrokePx = opts.strokeWidth / 2
    u.uTaperPx = opts.taperPx
    u.uWidthVar = opts.widthVar
    u.uGrainFine = opts.grainFine
    u.uToneAmp = opts.toneAmp
    u.uTooth = opts.tooth
    u.uEdgeSoft = opts.edgeSoft
  }
}

function syncCamera(): void {
  if (paperSprite.position) paperSprite.position.set(-camX, -camY)
  paperFilter.setCamera?.(camX, camY, zoom)
  setLiveUniforms()
}

onMounted(async () => {
  const canvas = canvasEl.value!
  app = markRaw(new Application())
  await app.init({ canvas, width: canvas.clientWidth, height: canvas.clientHeight, antialias: true, backgroundAlpha: 0, resolution: devicePixelRatio, autoDensity: true })
  camX = canvas.clientWidth / 2; camY = canvas.clientHeight / 2
  app.stage.position.set(camX, camY)

  paperFilter = markRaw(new PaperGrainFilter())
  paperSprite = markRaw(new Sprite(Texture.WHITE))
  paperSprite.setSize(canvas.clientWidth, canvas.clientHeight)
  app.stage.addChild(paperSprite)
  world = markRaw(new Container())
  app.stage.addChild(world)

  // Background relief tile (broad) for the paper filter; deposition grain tile (fine) for strokes.
  const paperTex = await Assets.load('/textures/paper/watercolor-height.png')
  const grainTex = await Assets.load('/textures/paper/graphite-grain.png')
  // Both tiles MUST repeat — the filter/shader sample them world-anchored across many tiles.
  // (Missing repeat on the paper tile → clamp seam = a banding crosshair + patch at world origin.)
  paperTex.source.style.addressMode = 'repeat'; paperTex.source.style.update()
  grainTex.source.style.addressMode = 'repeat'; grainTex.source.style.update()
  grainSource = markRaw(grainTex.source)
  paperFilter.setPaperTexture(paperTex.source)
  applyPaper()
  rebuild()

  canvas.addEventListener('wheel', onWheel, { passive: false })
  canvas.addEventListener('pointerdown', onPD)
  window.addEventListener('pointermove', onPM)
  window.addEventListener('pointerup', onPU)
})

onUnmounted(() => {
  canvasEl.value?.removeEventListener('wheel', onWheel)
  canvasEl.value?.removeEventListener('pointerdown', onPD)
  window.removeEventListener('pointermove', onPM)
  window.removeEventListener('pointerup', onPU)
  app?.destroy(true, { children: true, texture: true, context: true })
})

// Geometry-changing params rebuild; width/material params are live uniform updates (no rebuild).
watch(() => [opts.squiggle, opts.cpSpacing, opts.overshoot, opts.cornerAngle, opts.seed], () => rebuild())
watch(() => [opts.strokeWidth, opts.taperPx, opts.grainFine, opts.widthVar, opts.toneAmp, opts.tooth, opts.edgeSoft], () => setLiveUniforms())
watch(() => opts.paper, () => applyPaper())

function applyPaper(): void {
  paperSprite.filters = opts.paper ? [paperFilter] : []
  paperSprite.visible = opts.paper
  syncCamera()
}

function onWheel(e: WheelEvent) {
  e.preventDefault()
  const rect = canvasEl.value!.getBoundingClientRect()
  const sx = e.clientX - rect.left, sy = e.clientY - rect.top
  const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12
  const wx = (sx - camX) / zoom, wy = (sy - camY) / zoom
  zoom = Math.max(0.1, Math.min(30, zoom * factor))
  camX = sx - wx * zoom; camY = sy - wy * zoom
  app.stage.position.set(camX, camY)
  world.scale.set(zoom)
  syncCamera() // width is screen-constant via uZoom uniform — no geometry rebuild on zoom
}
function onPD(e: PointerEvent) { isPanning = true; panStart = { x: e.clientX - camX, y: e.clientY - camY }; (e.target as HTMLElement).setPointerCapture(e.pointerId) }
function onPM(e: PointerEvent) { if (!isPanning) return; camX = e.clientX - panStart.x; camY = e.clientY - panStart.y; app.stage.position.set(camX, camY); syncCamera() }
function onPU() { isPanning = false }
function reseed() { opts.seed = Math.floor(Math.random() * 100000) + 1 }
</script>

<template>
  <div class="wrap">
    <canvas ref="canvasEl" />
    <div class="hud">
      <div class="fps">{{ fps }} <span>fps</span></div>
      <div>{{ frameMs }} ms</div>
      <div>zoom: {{ zoom.toFixed(2) }}×</div>
    </div>
    <div class="panel">
      <div class="title">Pencil Ribbon · vertex-expanded mesh (Phase C)</div>
      <label>Stroke width <b>{{ opts.strokeWidth.toFixed(1) }}px</b><input type="range" min="0.5" max="16" step="0.5" v-model.number="opts.strokeWidth" /></label>
      <label>Squiggle <b>{{ opts.squiggle.toFixed(1) }}</b><input type="range" min="0" max="20" step="0.5" v-model.number="opts.squiggle" /></label>
      <label>Taper px <b>{{ opts.taperPx.toFixed(0) }}</b><input type="range" min="0" max="60" step="1" v-model.number="opts.taperPx" /></label>
      <label>Grain scale <b>{{ opts.grainFine.toFixed(0) }}</b><input type="range" min="40" max="800" step="10" v-model.number="opts.grainFine" /></label>
      <label>Width var <b>{{ opts.widthVar.toFixed(2) }}</b><input type="range" min="0" max="0.8" step="0.05" v-model.number="opts.widthVar" /></label>
      <label>Tone amp <b>{{ opts.toneAmp.toFixed(2) }}</b><input type="range" min="0" max="0.9" step="0.05" v-model.number="opts.toneAmp" /></label>
      <label>Tooth <b>{{ opts.tooth.toFixed(2) }}</b><input type="range" min="0" max="1" step="0.05" v-model.number="opts.tooth" /></label>
      <label>Edge softness <b>{{ opts.edgeSoft.toFixed(2) }}</b><input type="range" min="0" max="0.95" step="0.05" v-model.number="opts.edgeSoft" /></label>
      <label class="chk"><input type="checkbox" v-model="opts.paper" /> Paper background</label>
      <button class="btn" @click="reseed">🎲 Re-seed</button>
    </div>
    <div class="hint"><kbd>scroll</kbd> zoom · <kbd>drag</kbd> pan — vertex-expanded ribbon, zoom is a uniform</div>
  </div>
</template>

<style scoped>
.wrap { position: relative; width: 100%; height: 100%; background: #f4f1ea; }
canvas { display: block; width: 100%; height: 100%; cursor: grab; }
canvas:active { cursor: grabbing; }
.hud { position: absolute; top: 10px; left: 10px; font-family: monospace; font-size: 12px; color: #3a3a3a; line-height: 1.7; pointer-events: none; }
.fps { font-size: 18px; font-weight: bold; } .fps span { font-size: 12px; color: #888; }
.panel { position: absolute; top: 10px; right: 10px; font-family: monospace; font-size: 11px; color: #333; line-height: 1.5; background: rgba(255,255,255,0.9); padding: 12px 14px; border-radius: 6px; border: 1px solid #ddd; width: 230px; }
.title { font-weight: bold; margin-bottom: 10px; color: #222; }
.panel label { display: block; margin-bottom: 8px; }
.panel label b { color: #4b7a4b; }
.panel input[type=range] { width: 100%; margin-top: 2px; }
.chk { display: flex; align-items: center; gap: 6px; }
.btn { width: 100%; padding: 5px; font-family: monospace; font-size: 11px; cursor: pointer; background: #4b7a4b; color: #fff; border: none; border-radius: 4px; margin-top: 6px; }
.hint { position: absolute; bottom: 10px; left: 50%; transform: translateX(-50%); font-family: monospace; font-size: 11px; color: #666; background: rgba(255,255,255,0.7); padding: 5px 12px; border-radius: 4px; }
kbd { background: #eee; border: 1px solid #ccc; border-radius: 3px; padding: 1px 5px; font-size: 10px; }
</style>
