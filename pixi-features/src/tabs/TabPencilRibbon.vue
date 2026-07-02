<script setup lang="ts">
/**
 * Pencil Ribbon (Phase B) — strokes as ribbon MESHES with a stroke-space graphite shader,
 * instead of the full-screen PaperGrainFilter (which stairstepped + tanked fps at zoom).
 * Geometry from the cached kinematic op-list, CPU-expanded to a ribbon, rebuilt on zoom for
 * screen-constant width (wobble stays stable — it's cached). Material (tone/taper/ragged/tooth)
 * is in the fragment shader; meshes multiply-blend over a screen-fixed paper sprite.
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
  taperLen: STROKE_RIBBON_DEFAULTS.taperLen,
  toneAmp: STROKE_RIBBON_DEFAULTS.toneAmp,
  tooth: STROKE_RIBBON_DEFAULTS.tooth,
  edgeSoft: STROKE_RIBBON_DEFAULTS.edgeSoft,
  paper: true,
})

let app = markRaw({} as Application)
let world = markRaw({} as Container)
let paperSprite = markRaw({} as Sprite)
let paperFilter = markRaw({} as PaperGrainFilter)
let paperSource = markRaw({} as any)
let meshes: Mesh[] = []
let camX = 0, camY = 0, zoom = 1
let isPanning = false, panStart = { x: 0, y: 0 }

function rgb(c: number): [number, number, number] {
  return [((c >> 16) & 255) / 255, ((c >> 8) & 255) / 255, (c & 255) / 255]
}

function rebuild(): void {
  world.removeChildren().forEach((c) => c.destroy())
  meshes = []
  const halfWidth = (opts.strokeWidth / zoom) / 2
  for (const s of pencilTestShapes()) {
    const ops = kinematicOpsForPath(s.d, {
      squiggle: opts.squiggle, cpSpacing: opts.cpSpacing, seed: opts.seed,
      overshoot: opts.overshoot, cornerAngle: opts.cornerAngle,
    })
    const built = buildStrokeMeshes(ops, halfWidth, paperSource, {
      ...STROKE_RIBBON_DEFAULTS, color: rgb(s.color),
      taperLen: opts.taperLen, toneAmp: opts.toneAmp, tooth: opts.tooth, edgeSoft: opts.edgeSoft,
    })
    for (const m of built) { world.addChild(m); meshes.push(m) }
  }
  setMeshZoom()
}

function setMeshZoom(): void {
  for (const m of meshes) {
    const u = (m.shader!.resources.strokeUniforms as any).uniforms
    u.uZoom = zoom
  }
}

function syncCamera(): void {
  if (paperSprite.position) paperSprite.position.set(-camX, -camY)
  paperFilter.setCamera?.(camX, camY, zoom)
  setMeshZoom()
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

  const tex = await Assets.load('/textures/paper/watercolor-height.png')
  tex.source.style.addressMode = 'repeat'; tex.source.style.update()
  paperSource = markRaw(tex.source)
  paperFilter.setPaperTexture(tex.source)
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

// Rebuild on any generator/material change; paper toggle is cheap.
watch(() => [opts.strokeWidth, opts.squiggle, opts.cpSpacing, opts.overshoot, opts.cornerAngle, opts.seed, opts.taperLen, opts.toneAmp, opts.tooth, opts.edgeSoft], () => rebuild())
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
  syncCamera()
  rebuild() // half-width is world-space; rebuild from the cached op-list (wobble stays stable)
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
      <div class="title">Pencil Ribbon · mesh + stroke shader (Phase B)</div>
      <label>Stroke width <b>{{ opts.strokeWidth.toFixed(1) }}px</b><input type="range" min="0.5" max="8" step="0.5" v-model.number="opts.strokeWidth" /></label>
      <label>Squiggle <b>{{ opts.squiggle.toFixed(1) }}</b><input type="range" min="0" max="20" step="0.5" v-model.number="opts.squiggle" /></label>
      <label>Taper len <b>{{ opts.taperLen.toFixed(0) }}</b><input type="range" min="0" max="60" step="1" v-model.number="opts.taperLen" /></label>
      <label>Tone amp <b>{{ opts.toneAmp.toFixed(2) }}</b><input type="range" min="0" max="0.9" step="0.05" v-model.number="opts.toneAmp" /></label>
      <label>Tooth <b>{{ opts.tooth.toFixed(2) }}</b><input type="range" min="0" max="1" step="0.05" v-model.number="opts.tooth" /></label>
      <label>Edge softness <b>{{ opts.edgeSoft.toFixed(2) }}</b><input type="range" min="0" max="0.95" step="0.05" v-model.number="opts.edgeSoft" /></label>
      <label class="chk"><input type="checkbox" v-model="opts.paper" /> Paper background</label>
      <button class="btn" @click="reseed">🎲 Re-seed</button>
    </div>
    <div class="hint"><kbd>scroll</kbd> zoom · <kbd>drag</kbd> pan — ribbon meshes, no full-screen filter</div>
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
