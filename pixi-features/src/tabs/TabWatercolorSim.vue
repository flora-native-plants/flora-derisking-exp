<script setup lang="ts">
/**
 * Watercolor Sim spike — PHYSICALLY-BASED baked GPU watercolor (parallel to the effects
 * path in Botanical Variants). Marks EMERGE from a lean Curtis-1997 shallow-water sim:
 * gradient-driven outward flow + edge-biased evaporation (coffee-ring), curl-noise swirl,
 * paper-coupled deposition, then a Kubelka-Munk composite — all baked once per seed.
 * See src/lib/watersim/WatercolorSim.ts for the engine and the .glsl passes for the physics.
 */
import { ref, watch, onMounted, onUnmounted, markRaw, nextTick } from 'vue'
import { Application, Assets, Container, Graphics, Sprite, Text, Texture } from 'pixi.js'
import { fetchPlantSvg, fetchPlantList, type PlantSummary } from '../lib/plantApi'
import { extractSilhouette, type Vec2 } from '../lib/silhouette'
import { computeMaskSdf } from '../lib/watercolor/maskSdf'
import { sdfToTexture } from '../lib/watercolor/sdfTexture'
import { pigmentKS } from '../lib/watercolor/pigmentKS'
import { WatercolorSim, type SimParams } from '../lib/watersim/WatercolorSim'
import { ErosionSim, type ErosionParams } from '../lib/watersim/ErosionSim'
import { useFps } from '../shared/useFps'

const { fps, frameMs } = useFps()
const canvasEl = ref<HTMLCanvasElement>()
const status = ref('Booting…')

const plants = ref<PlantSummary[]>([])
const DEFAULT_PLANT_ID = 2
const RASTER = 512
const SIM_SIZE = 256
const ERO_SIZE = 160
const DISPLAY = 300
const GRID_COLS = 3
const CONTOUR_COLOR = 0x4a3b2a

const plantId = ref(DEFAULT_PLANT_ID)
const dilation = ref(4)
const variants = ref(9)
const contourOn = ref(true)

// which engine: 'shallow' = Curtis shallow-water; 'erosion' = receding wet-mask erosion.
const simMode = ref<'shallow' | 'erosion'>('shallow')
const debugRaw = ref(false)   // erosion only: show the raw deposited tide-line buffer

// erosion-variant knobs (defaults tuned for a handful of nested, low-curvature tide-lines)
const eroErode       = ref(1.0)
const eroEvapBase    = ref(0.012)
const eroPin         = ref(0.5)
const eroPaperScale  = ref(4)
const eroLowScale    = ref(3)
const eroLowAmp      = ref(0.25)
const eroAdvect      = ref(0.9)
const eroDiffuse     = ref(0.12)
const eroDryLevel    = ref(0.12)
const eroFrontGain   = ref(4)
const eroDepRate     = ref(0.6)
const eroDryDump     = ref(0.25)
const eroReleaseSoft = ref(0.09)
const eroDepthBias   = ref(0.55)
const eroBackruns    = ref(2)
const eroBackrunRad  = ref(0.14)
const eroBackrunBurst= ref(0.5)

// sim knobs — defaults are the tuned "sim-v3b" preset (best result of the spike sweep):
// luminous washes, emergent edge tide-lines, warm pooled blooms, per-seed variation.
const iterations  = ref(45)
const water       = ref(0.9)
const pigment     = ref(0.6)
const bloomAmt    = ref(0.7)
const pressure    = ref(0.32)
const damp        = ref(0.9)
const curlAmp     = ref(0.0025)
const curlScale   = ref(4)
const evap        = ref(0.02)
const edgeEvap    = ref(1.3)
const capillary   = ref(0.14)
const advect      = ref(1.0)
const depositG    = ref(0.08)
const depositW    = ref(0.055)
const granule     = ref(0.28)
const paperScale  = ref(18)
const edgeDeposit = ref(4.5)
const dryWet      = ref(0.1)
const density     = ref(1.05)
const coverKnee   = ref(1.05)
const residual    = ref(0.6)
const grainScale  = ref(45)

let app = markRaw({} as Application)
let grid = markRaw({} as Container)
let sim: WatercolorSim | null = null
let eroSim: ErosionSim | null = null
let silhouettePolys: Vec2[][] = []
let cachedKey = ''
let sdfTex: ReturnType<typeof sdfToTexture> | null = null
let bakedToDestroy: Texture[] = []

// green + warm pigment K/S (same pairs as the effects path)
const pigGreen = pigmentKS([0.28, 0.42, 0.26], [0.06, 0.14, 0.07])
const pigWarm = pigmentKS([0.72, 0.55, 0.40], [0.26, 0.13, 0.05])

function currentPlant() { return plants.value.find(p => p.id === plantId.value) }

function scalePoly(poly: Vec2[]): Vec2[] {
  const s = DISPLAY / RASTER, off = DISPLAY / 2
  return poly.map(p => ({ x: p.x * s - off, y: p.y * s - off }))
}
function wobblePoly(poly: Vec2[], amp: number, phase: number): Vec2[] {
  return poly.map((p, i) => ({
    x: p.x + Math.sin(i * 0.7 + phase) * amp + Math.sin(i * 2.3 + 1.0 + phase) * amp * 0.4,
    y: p.y + Math.cos(i * 0.9 + phase) * amp + Math.cos(i * 1.7 + 2.0 + phase) * amp * 0.4,
  }))
}
function rngFor(seed: number): () => number {
  let a = seed >>> 0
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
}
function buildMaskGraphics(): Graphics {
  const g = markRaw(new Graphics())
  for (const poly of silhouettePolys) { if (poly.length < 3) continue; g.poly(scalePoly(poly)).fill({ color: 0xffffff }) }
  return g
}
function buildContour(seed: number): Graphics {
  const g = markRaw(new Graphics())
  const phase = (seed * 1.618) % (Math.PI * 2)
  const r = rngFor(seed * 97 + 13)
  const a1 = r() * 6.283, a2 = r() * 6.283
  for (const poly of silhouettePolys) {
    if (poly.length < 3) continue
    const pts = wobblePoly(scalePoly(poly), 1.5, phase)
    for (let i = 0; i < pts.length; i++) {
      const p0 = pts[i], p1 = pts[(i + 1) % pts.length]
      const t = i / pts.length
      const pr = Math.max(0, Math.min(1, 0.55 + 0.35 * Math.sin(t * 6.283 * 3 + a1) + 0.2 * Math.sin(t * 6.283 * 8 + a2)))
      if (pr < 0.14) continue
      g.moveTo(p0.x, p0.y).lineTo(p1.x, p1.y).stroke({ color: CONTOUR_COLOR, width: 2.5 * (0.3 + pr), alpha: 0.9 * (0.35 + 0.65 * pr), join: 'round', cap: 'round' })
    }
  }
  return g
}

async function ensurePlantData() {
  const key = `${plantId.value}:${dilation.value}`
  if (key === cachedKey && silhouettePolys.length) return
  status.value = `Fetching plant ${plantId.value}…`
  const svg = await fetchPlantSvg(plantId.value)
  const sil = await extractSilhouette(svg, { rasterSize: RASTER, dilationPx: dilation.value }, plantId.value)
  silhouettePolys = sil.polygons
  if (sdfTex) { sdfTex.destroy(true); sdfTex = null }
  cachedKey = key
}

function silhouetteMask(size: number): Float32Array {
  const c = document.createElement('canvas'); c.width = c.height = size
  const ctx = c.getContext('2d')!; const k = size / RASTER
  ctx.fillStyle = '#fff'; ctx.beginPath()
  for (const poly of silhouettePolys) {
    if (poly.length < 3) continue
    ctx.moveTo(poly[0].x * k, poly[0].y * k)
    for (let i = 1; i < poly.length; i++) ctx.lineTo(poly[i].x * k, poly[i].y * k)
    ctx.closePath()
  }
  ctx.fill()
  const data = ctx.getImageData(0, 0, size, size).data
  const mask = new Float32Array(size * size)
  for (let i = 0; i < mask.length; i++) mask[i] = data[i * 4 + 3] / 255
  return mask
}
function ensureSdf(): Texture {
  if (sdfTex) return sdfTex
  const mask = silhouetteMask(SIM_SIZE)
  const sdf = computeMaskSdf(mask, SIM_SIZE)
  let maxDepth = 0
  for (let i = 0; i < sdf.length; i++) if (-sdf[i] > maxDepth) maxDepth = -sdf[i]
  sdfTex = sdfToTexture(sdf, SIM_SIZE, maxDepth)
  return sdfTex
}

function params(): SimParams {
  return {
    iterations: iterations.value, water: water.value, pigment: pigment.value, bloomAmt: bloomAmt.value,
    pressure: pressure.value, damp: damp.value, curlAmp: curlAmp.value, curlScale: curlScale.value,
    evap: evap.value, edgeEvap: edgeEvap.value, capillary: capillary.value,
    advect: advect.value, depositG: depositG.value, depositW: depositW.value, granule: granule.value,
    paperScale: paperScale.value, edgeDeposit: edgeDeposit.value, dryWet: dryWet.value,
    KA: pigGreen.K, SA: pigGreen.S, KB: pigWarm.K, SB: pigWarm.S,
    paperColor: [0.96, 0.93, 0.84], density: density.value, coverKnee: coverKnee.value,
    residual: residual.value, grainScale: grainScale.value,
  }
}
function eroParams(): ErosionParams {
  return {
    iterations: iterations.value, waterEdge: 0.6, pigment: pigment.value, bloomAmt: bloomAmt.value,
    erode: eroErode.value, evapBase: eroEvapBase.value, pin: eroPin.value,
    paperScale: eroPaperScale.value, lowScale: eroLowScale.value, lowAmp: eroLowAmp.value,
    advect: eroAdvect.value, diffuse: eroDiffuse.value, dryLevel: eroDryLevel.value,
    frontGain: eroFrontGain.value, depRate: eroDepRate.value, dryDump: eroDryDump.value,
    releaseSoft: eroReleaseSoft.value, depthBias: eroDepthBias.value,
    backruns: eroBackruns.value, backrunRad: eroBackrunRad.value, backrunBurst: eroBackrunBurst.value,
    KA: pigGreen.K, SA: pigGreen.S, KB: pigWarm.K, SB: pigWarm.S,
    paperColor: [0.96, 0.93, 0.84], density: density.value, coverKnee: coverKnee.value,
    residual: residual.value, grainScale: grainScale.value,
    debug: debugRaw.value, debugScale: 0.5,
  }
}
function layoutCell(index: number, cell: number) {
  return { x: (index % GRID_COLS) * cell + cell / 2, y: Math.floor(index / GRID_COLS) * cell + cell / 2 }
}

function rebuild() {
  if (!app.stage || !silhouettePolys.length || !sim || !eroSim) return
  for (const t of bakedToDestroy) t.destroy(true)
  bakedToDestroy = []
  grid.removeChildren().forEach(c => c.destroy({ children: true }))

  const n = variants.value
  const rows = Math.ceil(n / GRID_COLS)
  const cell = Math.min(app.screen.width / GRID_COLS, app.screen.height / rows)
  const inner = cell * 0.86
  const sdf = ensureSdf()
  const erosion = simMode.value === 'erosion'
  const p = params()
  const ep = eroParams()
  const t0 = performance.now()

  for (let seed = 0; seed < n; seed++) {
    const outRT = erosion ? eroSim.bake(sdf, seed, ep) : sim.bake(sdf, seed, p)
    // Copy the reused `out` RT into an independent texture for this cell.
    const tmp = markRaw(new Sprite(outRT))
    const baked = app.renderer.generateTexture({ target: tmp, resolution: 1 })
    tmp.destroy({ texture: false })
    bakedToDestroy.push(baked)

    const cellRoot = markRaw(new Container())
    const spr = markRaw(new Sprite(baked))
    spr.anchor.set(0.5); spr.width = DISPLAY; spr.height = DISPLAY
    const clip = buildMaskGraphics()
    cellRoot.addChild(clip); cellRoot.addChild(spr); spr.mask = clip
    if (contourOn.value) cellRoot.addChild(buildContour(seed))
    cellRoot.scale.set(inner / DISPLAY)

    const container = markRaw(new Container())
    const { x, y } = layoutCell(seed, cell)
    container.position.set(x, y); container.addChild(cellRoot)
    const label = markRaw(new Text({ text: `seed ${seed}`, style: { fontFamily: 'monospace', fontSize: 12, fill: 0x6a5f45 } }))
    label.anchor.set(0.5, 0); label.position.set(0, inner / 2 - 2); container.addChild(label)
    grid.addChild(container)
  }
  const modeLbl = erosion ? `erosion${debugRaw.value ? ' (raw)' : ''}` : 'shallow-water'
  status.value = `${currentPlant()?.commonName ?? plantId.value} · ${modeLbl} · ${n} sims · ${Math.round(performance.now() - t0)}ms`
}

async function reloadAll() {
  try { await ensurePlantData(); rebuild() }
  catch (e) { status.value = `Error: ${(e as Error).message}`; console.error(e) }
}
let rebuildTimer: ReturnType<typeof setTimeout> | null = null
function scheduleRebuild() { if (rebuildTimer) clearTimeout(rebuildTimer); rebuildTimer = setTimeout(rebuild, 90) }

// pan
const PANEL_CLEAR = 400
let dragging = false, lastX = 0, lastY = 0
function onPanStart(e: PointerEvent) { dragging = true; lastX = e.clientX; lastY = e.clientY }
function onPanMove(e: PointerEvent) { if (!dragging || !grid.position) return; grid.position.x += e.clientX - lastX; grid.position.y += e.clientY - lastY; lastX = e.clientX; lastY = e.clientY }
function onPanEnd() { dragging = false }
function resetView() { if (grid.position) grid.position.set(PANEL_CLEAR, 12) }

onMounted(async () => {
  app = markRaw(new Application())
  await app.init({ canvas: canvasEl.value!, resizeTo: canvasEl.value!.parentElement!, antialias: true, background: 0xf2ead4 })
  sim = markRaw(new WatercolorSim(app.renderer, SIM_SIZE))
  eroSim = markRaw(new ErosionSim(app.renderer, ERO_SIZE))
  const loaded = await fetchPlantList().catch(() => [] as PlantSummary[])
  plants.value = loaded.sort((a, b) => a.commonName.localeCompare(b.commonName))
  grid = markRaw(new Container()); app.stage.addChild(grid)
  app.renderer.on('resize', rebuild)
  await reloadAll(); resetView()

  if (import.meta.env.DEV) {
    const knobMap: Record<string, { value: number }> = {
      iterations, water, pigment, bloomAmt, pressure, damp, curlAmp, curlScale, evap, edgeEvap, capillary,
      advect, depositG, depositW, granule, paperScale, edgeDeposit, dryWet, density, coverKnee, residual,
      grainScale, variants, dilation,
      // erosion-variant knobs (eroX so they never collide with the shallow-water names)
      eroErode, eroEvapBase, eroPin, eroPaperScale, eroLowScale, eroLowAmp, eroAdvect, eroDiffuse,
      eroDryLevel, eroFrontGain, eroDepRate, eroDryDump, eroReleaseSoft, eroDepthBias,
      eroBackruns, eroBackrunRad, eroBackrunBurst,
    }
    ;(window as unknown as { __waterSimTune?: unknown }).__waterSimTune = async (p: Record<string, number | string>) => {
      if (typeof p.plantId === 'number') plantId.value = p.plantId
      if (p.simMode === 'erosion' || p.simMode === 'shallow') simMode.value = p.simMode
      if (typeof p.debug === 'number') debugRaw.value = p.debug > 0.5
      for (const [k, v] of Object.entries(p)) {
        if (k === 'plantId' || k === 'simMode' || k === 'debug') continue
        if (typeof v === 'number' && knobMap[k]) knobMap[k].value = v
      }
      await nextTick(); await reloadAll(); await nextTick()
    }
  }
})
onUnmounted(() => {
  for (const t of bakedToDestroy) t.destroy(true); bakedToDestroy = []
  if (sdfTex) sdfTex.destroy(true)
  if (sim) sim.destroy()
  if (eroSim) eroSim.destroy()
  if (app.destroy) app.destroy(true, { children: true })
})

watch([plantId, dilation], reloadAll)
watch([variants, contourOn, iterations, water, pigment, bloomAmt, pressure, damp, curlAmp, curlScale,
  evap, edgeEvap, capillary, advect, depositG, depositW, granule, paperScale, edgeDeposit, dryWet,
  density, coverKnee, residual, grainScale,
  simMode, debugRaw, eroErode, eroEvapBase, eroPin, eroPaperScale, eroLowScale, eroLowAmp, eroAdvect,
  eroDiffuse, eroDryLevel, eroFrontGain, eroDepRate, eroDryDump, eroReleaseSoft, eroDepthBias,
  eroBackruns, eroBackrunRad, eroBackrunBurst], scheduleRebuild)
</script>

<template>
  <div class="wrap">
    <canvas ref="canvasEl" class="pan" :class="{ dragging }"
      @pointerdown="onPanStart" @pointermove="onPanMove" @pointerup="onPanEnd" @pointerleave="onPanEnd" @dblclick="resetView" />
    <div class="hud"><div class="fps">{{ fps }} <span>fps</span></div><div>{{ frameMs }} ms</div></div>
    <div class="panel">
      <div class="title">Watercolor Sim (baked GPU)</div>
      <label>plant <select v-model.number="plantId"><option v-for="p in plants" :key="p.id" :value="p.id">{{ p.commonName }}</option></select></label>
      <label>mode <select v-model="simMode"><option value="shallow">shallow-water</option><option value="erosion">erosion (fronts)</option></select></label>
      <label>variants <input type="range" min="1" max="12" step="1" v-model.number="variants" /> {{ variants }}</label>
      <label><input type="checkbox" v-model="contourOn" /> contour</label>
      <label v-if="simMode === 'erosion'"><input type="checkbox" v-model="debugRaw" /> raw tide-line buffer</label>
      <template v-if="simMode === 'erosion'">
        <div class="group">erosion / fronts</div>
        <label>iterations <input type="range" min="16" max="90" step="1" v-model.number="iterations" /> {{ iterations }}</label>
        <label>pigment <input type="range" min="0.2" max="1" step="0.05" v-model.number="pigment" /> {{ pigment.toFixed(2) }}</label>
        <label>erode <input type="range" min="0.01" max="0.16" step="0.005" v-model.number="eroErode" /> {{ eroErode.toFixed(3) }}</label>
        <label>evap base <input type="range" min="0" max="0.04" step="0.002" v-model.number="eroEvapBase" /> {{ eroEvapBase.toFixed(3) }}</label>
        <label>pin <input type="range" min="0" max="1" step="0.05" v-model.number="eroPin" /> {{ eroPin.toFixed(2) }}</label>
        <label>paper scale <input type="range" min="3" max="18" step="0.5" v-model.number="eroPaperScale" /> {{ eroPaperScale.toFixed(1) }}</label>
        <label>low scale <input type="range" min="1.5" max="8" step="0.5" v-model.number="eroLowScale" /> {{ eroLowScale.toFixed(1) }}</label>
        <label>low amp <input type="range" min="0" max="0.7" step="0.05" v-model.number="eroLowAmp" /> {{ eroLowAmp.toFixed(2) }}</label>
        <label>advect <input type="range" min="0" max="2.5" step="0.1" v-model.number="eroAdvect" /> {{ eroAdvect.toFixed(1) }}</label>
        <label>diffuse <input type="range" min="0" max="0.4" step="0.02" v-model.number="eroDiffuse" /> {{ eroDiffuse.toFixed(2) }}</label>
        <label>dry level <input type="range" min="0.02" max="0.3" step="0.02" v-model.number="eroDryLevel" /> {{ eroDryLevel.toFixed(2) }}</label>
        <label>release soft <input type="range" min="0.01" max="0.2" step="0.01" v-model.number="eroReleaseSoft" /> {{ eroReleaseSoft.toFixed(2) }}</label>
        <label>depth bias <input type="range" min="0" max="1" step="0.05" v-model.number="eroDepthBias" /> {{ eroDepthBias.toFixed(2) }}</label>
        <label>front gain <input type="range" min="1" max="12" step="0.5" v-model.number="eroFrontGain" /> {{ eroFrontGain.toFixed(1) }}</label>
        <label>dep rate <input type="range" min="0.1" max="1.5" step="0.05" v-model.number="eroDepRate" /> {{ eroDepRate.toFixed(2) }}</label>
        <label>dry dump <input type="range" min="0" max="0.8" step="0.05" v-model.number="eroDryDump" /> {{ eroDryDump.toFixed(2) }}</label>
        <label>backruns <input type="range" min="0" max="5" step="1" v-model.number="eroBackruns" /> {{ eroBackruns }}</label>
        <label>backrun rad <input type="range" min="0.05" max="0.3" step="0.01" v-model.number="eroBackrunRad" /> {{ eroBackrunRad.toFixed(2) }}</label>
        <label>backrun burst <input type="range" min="0" max="1.5" step="0.1" v-model.number="eroBackrunBurst" /> {{ eroBackrunBurst.toFixed(1) }}</label>
        <div class="group">composite</div>
        <label>bloom amt <input type="range" min="0" max="1.2" step="0.05" v-model.number="bloomAmt" /> {{ bloomAmt.toFixed(2) }}</label>
        <label>density <input type="range" min="1" max="6" step="0.1" v-model.number="density" /> {{ density.toFixed(1) }}</label>
        <label>cover knee <input type="range" min="0.2" max="1.2" step="0.05" v-model.number="coverKnee" /> {{ coverKnee.toFixed(2) }}</label>
        <label>residual <input type="range" min="0" max="1" step="0.05" v-model.number="residual" /> {{ residual.toFixed(2) }}</label>
        <label>grain scale <input type="range" min="30" max="140" step="5" v-model.number="grainScale" /> {{ grainScale }}</label>
        <label>dilation <input type="range" min="0" max="14" step="1" v-model.number="dilation" /> {{ dilation }}</label>
      </template>
      <template v-if="simMode === 'shallow'">
      <div class="group">sim / flow</div>
      <label>iterations <input type="range" min="8" max="90" step="1" v-model.number="iterations" /> {{ iterations }}</label>
      <label>water <input type="range" min="0.3" max="1.2" step="0.05" v-model.number="water" /> {{ water.toFixed(2) }}</label>
      <label>pigment <input type="range" min="0.2" max="1" step="0.05" v-model.number="pigment" /> {{ pigment.toFixed(2) }}</label>
      <label>pressure <input type="range" min="0.1" max="1.5" step="0.05" v-model.number="pressure" /> {{ pressure.toFixed(2) }}</label>
      <label>damp <input type="range" min="0.7" max="0.99" step="0.01" v-model.number="damp" /> {{ damp.toFixed(2) }}</label>
      <label>curl amp <input type="range" min="0" max="0.006" step="0.0002" v-model.number="curlAmp" /> {{ curlAmp.toFixed(4) }}</label>
      <label>curl scale <input type="range" min="1" max="10" step="0.5" v-model.number="curlScale" /> {{ curlScale.toFixed(1) }}</label>
      <label>evap <input type="range" min="0.005" max="0.05" step="0.002" v-model.number="evap" /> {{ evap.toFixed(3) }}</label>
      <label>edge evap <input type="range" min="0" max="4" step="0.1" v-model.number="edgeEvap" /> {{ edgeEvap.toFixed(1) }}</label>
      <label>capillary <input type="range" min="0" max="0.4" step="0.02" v-model.number="capillary" /> {{ capillary.toFixed(2) }}</label>
      <div class="group">pigment / deposit</div>
      <label>advect <input type="range" min="0.2" max="2" step="0.1" v-model.number="advect" /> {{ advect.toFixed(1) }}</label>
      <label>deposit G <input type="range" min="0.01" max="0.2" step="0.005" v-model.number="depositG" /> {{ depositG.toFixed(3) }}</label>
      <label>deposit W <input type="range" min="0.01" max="0.2" step="0.005" v-model.number="depositW" /> {{ depositW.toFixed(3) }}</label>
      <label>granule <input type="range" min="0" max="0.8" step="0.05" v-model.number="granule" /> {{ granule.toFixed(2) }}</label>
      <label>paper scale <input type="range" min="10" max="80" step="2" v-model.number="paperScale" /> {{ paperScale }}</label>
      <label>edge deposit <input type="range" min="0" max="6" step="0.2" v-model.number="edgeDeposit" /> {{ edgeDeposit.toFixed(1) }}</label>
      <label>dry-wet <input type="range" min="0.02" max="0.4" step="0.02" v-model.number="dryWet" /> {{ dryWet.toFixed(2) }}</label>
      <div class="group">composite</div>
      <label>density <input type="range" min="1" max="6" step="0.1" v-model.number="density" /> {{ density.toFixed(1) }}</label>
      <label>cover knee <input type="range" min="0.2" max="1.2" step="0.05" v-model.number="coverKnee" /> {{ coverKnee.toFixed(2) }}</label>
      <label>residual <input type="range" min="0" max="1" step="0.05" v-model.number="residual" /> {{ residual.toFixed(2) }}</label>
      <label>grain scale <input type="range" min="30" max="140" step="5" v-model.number="grainScale" /> {{ grainScale }}</label>
      <label>dilation <input type="range" min="0" max="14" step="1" v-model.number="dilation" /> {{ dilation }}</label>
      </template>
    </div>
    <div class="status">{{ status }} · drag to pan · double-click to reset</div>
  </div>
</template>

<style scoped>
.wrap { position: relative; width: 100%; height: 100%; background: #f2ead4; }
canvas { display: block; width: 100%; height: 100%; }
canvas.pan { cursor: grab; } canvas.pan.dragging { cursor: grabbing; }
.hud { position: absolute; top: 10px; right: 12px; font-family: monospace; font-size: 12px; color: #8a7f66; text-align: right; line-height: 1.5; pointer-events: none; }
.fps { font-size: 16px; font-weight: bold; } .fps span { font-size: 11px; }
.panel { position: absolute; top: 10px; left: 10px; display: flex; flex-direction: column; gap: 4px; font-family: monospace; font-size: 11px; color: #4a4030; background: rgba(255,255,255,0.85); padding: 10px 12px; border-radius: 6px; border: 1px solid #d8cdb4; max-height: calc(100% - 40px); overflow-y: auto; }
.panel .title { font-weight: bold; font-size: 12px; margin-bottom: 2px; }
.panel .group { font-weight: bold; color: #8a7f66; margin-top: 6px; border-top: 1px solid #e3d9c0; padding-top: 4px; }
.panel label { display: flex; align-items: center; gap: 6px; }
.panel input[type=range] { flex: 1; }
.status { position: absolute; bottom: 10px; left: 50%; transform: translateX(-50%); font-family: monospace; font-size: 11px; color: #8a7f66; background: rgba(255,255,255,0.7); padding: 5px 12px; border-radius: 4px; pointer-events: none; }
</style>
