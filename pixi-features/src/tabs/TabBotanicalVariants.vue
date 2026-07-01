<script setup lang="ts">
/**
 * Botanical Variants spike — tune the per-instance VARIATION algorithm.
 *
 * Shows ONE species painted N different ways (one grid cell per seed) so we can
 * dial in natural, hand-painted variability before re-porting to flora-studio.
 * The interior of each variant is built from seeded pigment POOLS (edge-darkening
 * + granulation) — see lib/watercolorPools.ts — with a hand-drawn contour on top.
 * The silhouette (plant identity) is IDENTICAL across variants by design.
 */
import { ref, watch, onMounted, onUnmounted, markRaw } from 'vue'
import { Application, Container, Sprite, Text, Texture } from 'pixi.js'
import { fetchPlantSvg, fetchPlantList, type PlantSummary } from '../lib/plantApi'
import { extractSilhouette, type Vec2 } from '../lib/silhouette'
import { renderVariantInterior, type WatercolorPoolParams } from '../lib/watercolorPools'
import { useFps } from '../shared/useFps'

const { fps, frameMs } = useFps()
const canvasEl = ref<HTMLCanvasElement>()
const status = ref('Booting…')

const plants = ref<PlantSummary[]>([])
const DEFAULT_PLANT_ID = 2
const FALLBACK_COLOR = '#4CAF50'

const RASTER = 512          // silhouette extraction space
const CELL_RENDER = 260     // px each variant is painted at
const GRID_COLS = 3
const VARIANT_COUNT = ref(9)
const CONTOUR_COLOR = '#4a3b2a'

// ── controls ─────────────────────────────────────────────────────────────────
const plantId          = ref<number>(DEFAULT_PLANT_ID)
const dilation         = ref(4)
const variationStrength= ref(0.45)
const poolCount        = ref(3)
const edgeDarkening    = ref(0.6)
const granulation      = ref(0.4)
const boundaryWobble   = ref(0.5)
const baseStrength     = ref(0.7)
const softness         = ref(0.5)
const bloomColor       = ref('#a07560')
const bloomStrength    = ref(0.6)
const bloomSize        = ref(0.5)
const contourOn        = ref(true)
const contourWidth     = ref(2.0)
const contourWobble    = ref(2.5)
const contourAlpha     = ref(0.9)

let app = markRaw({} as Application)
let grid = markRaw({} as Container)
let silhouettePolys: Vec2[][] = []
let cachedKey = ''

function currentPlant(): PlantSummary | undefined {
  return plants.value.find(p => p.id === plantId.value)
}
function currentColor(): string {
  const c = currentPlant()?.planColor
  return c && /^#[0-9a-fA-F]{6}$/.test(c) ? c : FALLBACK_COLOR
}
function poolParams(): WatercolorPoolParams {
  return {
    foliage: currentColor(),
    accent: bloomColor.value,
    baseStrength: baseStrength.value,
    poolCount: poolCount.value,
    variationStrength: variationStrength.value,
    edgeDarkening: edgeDarkening.value,
    granulation: granulation.value,
    boundaryWobble: boundaryWobble.value,
    bloomStrength: bloomStrength.value,
    bloomSize: bloomSize.value,
    softness: softness.value,
  }
}

async function ensurePlantData() {
  const key = `${plantId.value}:${dilation.value}`
  if (key === cachedKey && silhouettePolys.length) return
  status.value = `Fetching plant ${plantId.value}…`
  const svg = await fetchPlantSvg(plantId.value)
  status.value = 'Extracting silhouette…'
  const sil = await extractSilhouette(svg, { rasterSize: RASTER, dilationPx: dilation.value }, plantId.value)
  silhouettePolys = sil.polygons
  cachedKey = key
}

/** Smooth per-point jitter, seeded phase so each variant's edge differs. */
function wobbleContour(poly: Vec2[], amp: number, phase: number, k: number): Vec2[] {
  return poly.map((p, i) => ({
    x: p.x * k + Math.sin(i * 0.7 + phase) * amp + Math.sin(i * 2.3 + 1.0 + phase) * amp * 0.4,
    y: p.y * k + Math.cos(i * 0.9 + phase) * amp + Math.cos(i * 1.7 + 2.0 + phase) * amp * 0.4,
  }))
}

/** Stroke the hand-drawn contour onto the (already pigment-painted) variant canvas. */
function drawContour(canvas: HTMLCanvasElement, seed: number) {
  if (!contourOn.value) return
  const ctx = canvas.getContext('2d')!
  const k = canvas.width / RASTER
  const phase = (seed * 1.618) % (Math.PI * 2)
  ctx.save()
  ctx.strokeStyle = CONTOUR_COLOR
  ctx.globalAlpha = contourAlpha.value
  ctx.lineWidth = contourWidth.value
  ctx.lineJoin = 'round'
  ctx.lineCap = 'round'
  for (const poly of silhouettePolys) {
    if (poly.length < 3) continue
    const pts = wobbleContour(poly, contourWobble.value, phase, k)
    ctx.beginPath()
    ctx.moveTo(pts[0].x, pts[0].y)
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y)
    ctx.closePath()
    ctx.stroke()
  }
  ctx.restore()
}

function layoutCell(index: number, cell: number): { x: number; y: number } {
  const col = index % GRID_COLS
  const row = Math.floor(index / GRID_COLS)
  return { x: col * cell + cell / 2, y: row * cell + cell / 2 }
}

function rebuild() {
  if (!app.stage || !silhouettePolys.length) return
  grid.removeChildren().forEach(c => c.destroy({ children: true }))

  const n = VARIANT_COUNT.value
  const rows = Math.ceil(n / GRID_COLS)
  const cell = Math.min(app.screen.width / GRID_COLS, app.screen.height / rows)
  const inner = cell * 0.84
  const params = poolParams()
  const t0 = performance.now()

  for (let seed = 0; seed < n; seed++) {
    const cellCanvas = renderVariantInterior(silhouettePolys, seed, CELL_RENDER, RASTER, params)
    drawContour(cellCanvas, seed)

    const container = markRaw(new Container())
    const { x, y } = layoutCell(seed, cell)
    container.position.set(x, y)

    const sprite = markRaw(new Sprite(Texture.from(cellCanvas)))
    sprite.anchor.set(0.5)
    sprite.width = inner
    sprite.height = inner
    container.addChild(sprite)

    const label = markRaw(new Text({
      text: `seed ${seed}`,
      style: { fontFamily: 'monospace', fontSize: 12, fill: 0x6a5f45 },
    }))
    label.anchor.set(0.5, 0)
    label.position.set(0, inner / 2 - 2)
    container.addChild(label)

    grid.addChild(container)
  }
  const dt = Math.round(performance.now() - t0)
  status.value = `${currentPlant()?.commonName ?? plantId.value} · ${n} variants · ${dt}ms`
}

async function reloadAll() {
  try {
    await ensurePlantData()
    rebuild()
  } catch (e) {
    status.value = `Error: ${(e as Error).message}`
    console.error(e)
  }
}

// Debounce heavy rebuilds so slider drags don't thrash the canvas2d passes.
let rebuildTimer: ReturnType<typeof setTimeout> | null = null
function scheduleRebuild() {
  if (rebuildTimer) clearTimeout(rebuildTimer)
  rebuildTimer = setTimeout(rebuild, 90)
}

onMounted(async () => {
  app = markRaw(new Application())
  await app.init({ canvas: canvasEl.value!, resizeTo: canvasEl.value!.parentElement!, antialias: true, background: 0xf2ead4 })

  plants.value = (await fetchPlantList().catch(() => [] as PlantSummary[]))
    .sort((a, b) => a.commonName.localeCompare(b.commonName))

  grid = markRaw(new Container())
  app.stage.addChild(grid)
  app.renderer.on('resize', rebuild)

  await reloadAll()
})

onUnmounted(() => { if (app.destroy) app.destroy(true, { children: true }) })

watch([plantId, dilation], reloadAll)
watch([
  variationStrength, poolCount, edgeDarkening, granulation, boundaryWobble,
  baseStrength, softness, bloomColor, bloomStrength, bloomSize,
  contourOn, contourWidth, contourWobble, contourAlpha, VARIANT_COUNT,
], scheduleRebuild)
</script>

<template>
  <div class="wrap">
    <canvas ref="canvasEl" />
    <div class="hud"><div class="fps">{{ fps }} <span>fps</span></div><div>{{ frameMs }} ms</div></div>

    <div class="panel">
      <div class="title">Botanical Variants</div>
      <label>plant
        <select v-model.number="plantId">
          <option v-for="p in plants" :key="p.id" :value="p.id">{{ p.commonName }}</option>
        </select>
      </label>
      <div class="meta">{{ plants.length }} plants · {{ currentPlant()?.scientificName ?? '—' }}</div>
      <label>variants <input type="range" min="1" max="16" step="1" v-model.number="VARIANT_COUNT" /> {{ VARIANT_COUNT }}</label>

      <div class="group">variation</div>
      <label>strength <input type="range" min="0" max="1" step="0.05" v-model.number="variationStrength" /> {{ variationStrength.toFixed(2) }}</label>
      <label>pools <input type="range" min="2" max="4" step="1" v-model.number="poolCount" /> {{ poolCount }}</label>
      <label>edge dark <input type="range" min="0" max="1" step="0.05" v-model.number="edgeDarkening" /> {{ edgeDarkening.toFixed(2) }}</label>
      <label>granulation <input type="range" min="0" max="1" step="0.05" v-model.number="granulation" /> {{ granulation.toFixed(2) }}</label>
      <label>boundary <input type="range" min="0" max="1" step="0.05" v-model.number="boundaryWobble" /> {{ boundaryWobble.toFixed(2) }}</label>

      <div class="group">wash / bloom</div>
      <label>base wash <input type="range" min="0" max="1" step="0.05" v-model.number="baseStrength" /> {{ baseStrength.toFixed(2) }}</label>
      <label>softness <input type="range" min="0.1" max="1" step="0.05" v-model.number="softness" /> {{ softness.toFixed(2) }}</label>
      <label>bloom <input type="color" v-model="bloomColor" /> <code>{{ bloomColor }}</code></label>
      <label>bloom amt <input type="range" min="0" max="1" step="0.05" v-model.number="bloomStrength" /> {{ bloomStrength.toFixed(2) }}</label>
      <label>bloom size <input type="range" min="0.2" max="0.95" step="0.05" v-model.number="bloomSize" /> {{ bloomSize.toFixed(2) }}</label>

      <div class="group">contour</div>
      <label><input type="checkbox" v-model="contourOn" /> contour on</label>
      <label>width <input type="range" min="0.5" max="6" step="0.1" v-model.number="contourWidth" /> {{ contourWidth.toFixed(1) }}</label>
      <label>wobble <input type="range" min="0" max="8" step="0.5" v-model.number="contourWobble" /> {{ contourWobble.toFixed(1) }}</label>
      <label>alpha <input type="range" min="0" max="1" step="0.05" v-model.number="contourAlpha" /> {{ contourAlpha.toFixed(2) }}</label>
      <label>dilation <input type="range" min="0" max="14" step="1" v-model.number="dilation" /> {{ dilation }}</label>
    </div>

    <div class="status">{{ status }}</div>
  </div>
</template>

<style scoped>
.wrap { position: relative; width: 100%; height: 100%; background: #f2ead4; }
canvas { display: block; width: 100%; height: 100%; }
.hud { position: absolute; top: 10px; right: 12px; font-family: monospace; font-size: 12px; color: #8a7f66; text-align: right; line-height: 1.5; pointer-events: none; }
.fps { font-size: 16px; font-weight: bold; } .fps span { font-size: 11px; }
.panel { position: absolute; top: 10px; left: 10px; display: flex; flex-direction: column; gap: 5px; font-family: monospace; font-size: 11px; color: #4a4030; background: rgba(255,255,255,0.85); padding: 10px 12px; border-radius: 6px; border: 1px solid #d8cdb4; max-height: calc(100% - 40px); overflow-y: auto; }
.panel .title { font-weight: bold; font-size: 12px; margin-bottom: 2px; }
.panel .group { font-weight: bold; color: #8a7f66; margin-top: 6px; border-top: 1px solid #e3d9c0; padding-top: 4px; }
.panel label { display: flex; align-items: center; gap: 6px; }
.panel .meta { font-size: 10px; color: #9a8f76; margin: -2px 0 2px; font-style: italic; }
.panel input[type=range] { flex: 1; }
.status { position: absolute; bottom: 10px; left: 50%; transform: translateX(-50%); font-family: monospace; font-size: 11px; color: #8a7f66; background: rgba(255,255,255,0.7); padding: 5px 12px; border-radius: 4px; pointer-events: none; }
</style>
