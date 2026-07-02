<script setup lang="ts">
/**
 * Botanical Variants spike — tune per-instance VARIATION on the REAL watercolour
 * texture (same look as the Botanical Illustration tab), not procedural fills.
 *
 * Each variant is a mini Botanical-Illustration render: a real wash-texture
 * TilingSprite → WashTextureTintFilter (the texture's own density pools pigment)
 * → masked to a softened silhouette, plus a second layered wash, a bloom, grain,
 * and a hand-drawn contour. Variation per seed comes from sampling a DIFFERENT
 * patch / rotation of the (large, varied) wash texture + bloom placement — so the
 * variants look like genuinely different hand-painted washes, all real pigment.
 * The silhouette (plant identity) is identical across variants by design.
 */
import { ref, watch, onMounted, onUnmounted, markRaw, nextTick } from 'vue'
import { Application, Assets, Container, Graphics, Sprite, TilingSprite, Text, Texture } from 'pixi.js'
import { fetchPlantSvg, fetchPlantList, type PlantSummary } from '../lib/plantApi'
import { extractSilhouette, type Vec2 } from '../lib/silhouette'
import { WashTextureTintFilter } from '../lib/filters/WashTextureTintFilter'
import { bakeInkwash, silhouetteMask, type InkwashParams } from '../lib/inkwashBake'
import { computeMaskSdf } from '../lib/watercolor/maskSdf'
import { sdfToTexture } from '../lib/watercolor/sdfTexture'
import { ProceduralWatercolorFilter } from '../lib/filters/ProceduralWatercolorFilter'
import { pigmentKS } from '../lib/watercolor/pigmentKS'
import { useFps } from '../shared/useFps'

const { fps, frameMs } = useFps()
const canvasEl = ref<HTMLCanvasElement>()
const status = ref('Booting…')

const plants = ref<PlantSummary[]>([])
const DEFAULT_PLANT_ID = 2
const FALLBACK_COLOR = '#4CAF50'
const WASH_TEXTURE = '/textures/watercolor/wash-green.png'
const GRAIN_TEXTURE = '/textures/pencil/grain-heavy.jpg'

const RASTER = 512
const DISPLAY = 300         // local render space per variant cell
const GRID_COLS = 3
const VARIANT_COUNT = ref(9)
const CONTOUR_COLOR = 0x4a3b2a

// ── controls ─────────────────────────────────────────────────────────────────
const mode          = ref<'texture' | 'sim' | 'procedural'>('texture')  // real-texture vs baked mini-inkwash vs algorithmic
const plantId       = ref<number>(DEFAULT_PLANT_ID)
const dilation      = ref(4)
const variation     = ref(1.0)   // how far each variant samples across the texture

// mini-inkwash (baked fluid sim) controls
const SIM_SIZE      = 240
const simDrops      = ref(8)
const simWetness    = ref(0.8)
const simBleed      = ref(0.5)
const simIterations = ref(14)
const simEdge       = ref(0.6)
const simGranule    = ref(0.35)
const simStrength   = ref(1.1)
const simPaper      = ref(0.5)
const wetness       = ref(0.85)
const paperCut      = ref(0.04)
const washScale     = ref(1.4)
const bleed         = ref(7)
const tonal         = ref(0.5)   // strength of the 2nd (darker) layered wash → depth
const bloomColor    = ref('#a07560')
const bloomStrength = ref(0.6)
const bloomSize     = ref(0.5)
const bloomSoftness = ref(0.55)
const grainOn       = ref(true)
const grainStrength = ref(0.3)
const contourOn     = ref(true)
const contourWidth  = ref(2.5)
const contourWobble = ref(2.5)
const contourAlpha  = ref(0.9)

// ── procedural watercolor controls (Task 7) ──────────────────────────────────
const pwOffsetBase    = ref(8)      // puddle offset base (display units); default 8
const pwWarpAmp       = ref(0.03)   // UV warp amplitude [0, 0.08]
const pwFbmB          = ref(0.4)    // T-field fBm weight [0, 0.6]
const pwPaperC        = ref(0.08)   // T-field paper weight [0, 0.2]
const pwBandCount     = ref(6)      // iso-band count [3, 7]
const pwEdgeWidth     = ref(1.2)    // band edge width multiplier [0.4, 3]
const pwBandGain      = ref(0.6)    // band density gain [0, 1.5]
const pwPlateauLo     = ref(0.12)   // plateau low threshold [0, 0.5]
const pwPlateauHi     = ref(0.5)    // plateau high threshold [0.2, 0.9]
const pwMixT0         = ref(0.2)    // pigment A→B mix start [0, 1]
const pwMixT1         = ref(0.85)   // pigment A→B mix end [0.2, 1.2]
const pwBaseDensity   = ref(0.5)    // base wash density [0.1, 1]
const pwCoverKnee     = ref(0.35)   // coverage opacity knee [0.1, 1]
const pwShadowDX      = ref(0.6)    // shadow direction X (normalized in JS) [-1, 1]
const pwShadowDY      = ref(-0.4)   // shadow direction Y (normalized in JS) [-1, 1]
const pwShadowAmp     = ref(0.05)   // shadow amplitude [0, 0.2]
const pwDebugStage    = ref(0)      // 0 = final; 1..8 = dump a pipeline stage (debug)

// ── SDF cache: keyed by plantId:dilation, rebuilt only on silhouette changes ──
type SdfEntry = { sdfTex: ReturnType<typeof sdfToTexture>; texelWorld: number; interiorScale: number }
let sdfCacheMap = new Map<string, SdfEntry>()
// Baked RenderTextures from the previous rebuild — freed at the start of the next.
let bakedTexturesToDestroy: ReturnType<typeof sdfToTexture>[] = []

let app = markRaw({} as Application)
let grid = markRaw({} as Container)
let washTex = markRaw({} as Texture)
let grainTex = markRaw({} as Texture)
let silhouettePolys: Vec2[][] = []
let cachedKey = ''

function currentPlant(): PlantSummary | undefined {
  return plants.value.find(p => p.id === plantId.value)
}
function currentColor(): string {
  const c = currentPlant()?.planColor
  return c && /^#[0-9a-fA-F]{6}$/.test(c) ? c : FALLBACK_COLOR
}
function hexToLinear(hex: string): [number, number, number] {
  const n = parseInt(hex.replace('#', ''), 16)
  return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255]
}
function hexToRgb255(hex: string): [number, number, number] {
  const n = parseInt(hex.replace('#', ''), 16)
  return [n >> 16 & 255, n >> 8 & 255, n & 255]
}
/** Deterministic per-seed RNG (mulberry32). */
function rngFor(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

async function ensurePlantData() {
  const key = `${plantId.value}:${dilation.value}`
  if (key === cachedKey && silhouettePolys.length) return
  // Silhouette changed — clear the SDF cache so we don't reuse stale textures.
  for (const e of sdfCacheMap.values()) e.sdfTex.destroy(true)
  sdfCacheMap.clear()
  status.value = `Fetching plant ${plantId.value}…`
  const svg = await fetchPlantSvg(plantId.value)
  status.value = 'Extracting silhouette…'
  const sil = await extractSilhouette(svg, { rasterSize: RASTER, dilationPx: dilation.value }, plantId.value)
  silhouettePolys = sil.polygons
  cachedKey = key
}

/** Scale a 512-space polygon to the DISPLAY box, centred at origin. */
function scalePoly(poly: Vec2[]): Vec2[] {
  const s = DISPLAY / RASTER, off = DISPLAY / 2
  return poly.map(p => ({ x: p.x * s - off, y: p.y * s - off }))
}
function inflatePoly(poly: Vec2[], factor: number): Vec2[] {
  if (factor === 1) return poly
  let cx = 0, cy = 0
  for (const p of poly) { cx += p.x; cy += p.y }
  cx /= poly.length; cy /= poly.length
  return poly.map(p => ({ x: cx + (p.x - cx) * factor, y: cy + (p.y - cy) * factor }))
}
function wobblePoly(poly: Vec2[], amp: number, phase: number): Vec2[] {
  return poly.map((p, i) => ({
    x: p.x + Math.sin(i * 0.7 + phase) * amp + Math.sin(i * 2.3 + 1.0 + phase) * amp * 0.4,
    y: p.y + Math.cos(i * 0.9 + phase) * amp + Math.cos(i * 1.7 + 2.0 + phase) * amp * 0.4,
  }))
}
function buildMaskGraphics(inflate = 1): Graphics {
  const g = markRaw(new Graphics())
  for (const poly of silhouettePolys) {
    if (poly.length < 3) continue
    g.poly(inflatePoly(scalePoly(poly), inflate)).fill({ color: 0xffffff })
  }
  return g
}

/** A real wash-texture layer, tinted + masked, sampling a seeded texture patch. */
function buildWashLayer(seed: number, tint: [number, number, number], strength: number, scaleMul: number): Container {
  const layer = markRaw(new Container())
  const m = DISPLAY * 0.6
  const wash = markRaw(new TilingSprite({ texture: washTex, width: DISPLAY + m, height: DISPLAY + m }))
  wash.position.set(-(DISPLAY + m) / 2, -(DISPLAY + m) / 2)
  wash.tileScale.set((washScale.value * scaleMul * DISPLAY) / washTex.width)
  // Seeded patch — a large, varied texture, so different offsets/rotations are
  // genuinely different REAL pigment (this is the per-variant variation).
  const r = rngFor(seed)
  const spread = variation.value
  wash.tilePosition.set(r() * washTex.width * spread, r() * washTex.height * spread)
  wash.tileRotation = r() * Math.PI * 2 * spread
  wash.filters = [new WashTextureTintFilter(tint, strength, paperCut.value)]
  layer.addChild(wash)
  const mask = buildMaskGraphics(1 + bleed.value / 100)
  layer.addChild(mask)
  layer.mask = mask
  return layer
}

function smoothstep(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)))
  return t * t * (3 - 2 * t)
}

/** Bloom — a warm accent pooled at a seeded off-centre anchor, clipped to the shape. */
function buildBloomSprite(seed: number): Sprite | null {
  if (bloomStrength.value <= 0 || !silhouettePolys.length) return null
  const size = DISPLAY
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = size
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  const r = rngFor(seed * 31 + 3)
  const ang = r() * Math.PI * 2
  const rad = 0.15 + r() * 0.2
  const ax = (0.5 + Math.cos(ang) * rad) * size
  const ay = (0.5 + Math.sin(ang) * rad) * size
  const radiusPx = Math.max(1, bloomSize.value * size * 0.5)
  const soft = bloomSoftness.value
  const [cr, cg, cb] = hexToRgb255(bloomColor.value)
  const img = ctx.createImageData(size, size)
  const d = img.data
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      const dx = (px - ax) / radiusPx, dy = (py - ay) / radiusPx
      const wob = Math.sin(Math.atan2(dy, dx) * 3 + seed) * 0.12
      const dist = Math.sqrt(dx * dx + dy * dy) + wob
      const a = 1 - smoothstep(1 - soft, 1.2, dist)
      const i = (py * size + px) * 4
      d[i] = cr; d[i + 1] = cg; d[i + 2] = cb; d[i + 3] = Math.round(a * 255 * bloomStrength.value)
    }
  }
  ctx.putImageData(img, 0, 0)
  const k = size / RASTER
  ctx.globalCompositeOperation = 'destination-in'
  ctx.beginPath()
  for (const poly of silhouettePolys) {
    if (poly.length < 3) continue
    ctx.moveTo(poly[0].x * k, poly[0].y * k)
    for (let i = 1; i < poly.length; i++) ctx.lineTo(poly[i].x * k, poly[i].y * k)
    ctx.closePath()
  }
  ctx.fill()
  ctx.globalCompositeOperation = 'source-over'
  const sprite = markRaw(new Sprite(Texture.from(canvas)))
  sprite.anchor.set(0.5)
  return sprite
}

/** Graphite grain tooth, multiplied over the wash, clipped to the silhouette. */
function buildGrainLayer(): Container {
  const layer = markRaw(new Container())
  const m = DISPLAY * 0.6
  const grain = markRaw(new TilingSprite({ texture: grainTex, width: DISPLAY + m, height: DISPLAY + m }))
  grain.position.set(-(DISPLAY + m) / 2, -(DISPLAY + m) / 2)
  grain.tileScale.set((DISPLAY * 1.1) / grainTex.width)
  grain.alpha = grainStrength.value
  grain.blendMode = 'multiply'
  layer.addChild(grain)
  const mask = buildMaskGraphics(1)
  layer.addChild(mask)
  layer.mask = mask
  return layer
}

/** Hand-drawn contour with a seeded wobble phase. */
function buildContour(seed: number): Graphics {
  const g = markRaw(new Graphics())
  const phase = (seed * 1.618) % (Math.PI * 2)
  const r = rngFor(seed * 97 + 13)
  // Seeded low-freq "pressure" along the path -> pencil-pressure width/alpha variation
  // + occasional lifts (gaps). Breaks the uniform "worm" contour tell (Fable).
  const a1 = r() * 6.283, a2 = r() * 6.283
  for (const poly of silhouettePolys) {
    if (poly.length < 3) continue
    const pts = wobblePoly(scalePoly(poly), contourWobble.value, phase)
    for (let i = 0; i < pts.length; i++) {
      const p0 = pts[i], p1 = pts[(i + 1) % pts.length]
      const t = i / pts.length
      const pressure = Math.max(0, Math.min(1,
        0.55 + 0.35 * Math.sin(t * 6.283 * 3 + a1) + 0.2 * Math.sin(t * 6.283 * 8 + a2)))
      if (pressure < 0.14) continue // lift the pencil — a gap
      const width = contourWidth.value * (0.3 + 1.0 * pressure)
      const alpha = contourAlpha.value * (0.35 + 0.65 * pressure)
      g.moveTo(p0.x, p0.y).lineTo(p1.x, p1.y)
        .stroke({ color: CONTOUR_COLOR, width, alpha, join: 'round', cap: 'round' })
    }
  }
  return g
}

function inkwashParams(): InkwashParams {
  return {
    foliage: currentColor(),
    accent: bloomColor.value,
    drops: simDrops.value,
    wetness: simWetness.value,
    bleed: simBleed.value,
    iterations: simIterations.value,
    edgeDarken: simEdge.value,
    granulation: simGranule.value,
    strength: simStrength.value,
    bloomStrength: bloomStrength.value,
    bloomSize: bloomSize.value,
    paperFibre: simPaper.value,
  }
}

function layoutCell(index: number, cell: number): { x: number; y: number } {
  const col = index % GRID_COLS
  const row = Math.floor(index / GRID_COLS)
  return { x: col * cell + cell / 2, y: row * cell + cell / 2 }
}

/** Get or build the per-plant SDF entry (cached by plantId:dilation). */
function getOrBuildSdf(): SdfEntry {
  const key = `${plantId.value}:${dilation.value}`
  let entry = sdfCacheMap.get(key)
  if (!entry) {
    const mask = silhouetteMask(silhouettePolys, RASTER, RASTER)
    const sdf = computeMaskSdf(mask, RASTER)
    // Deepest interior distance drives the pre-normalized sdfN packed into the texture.
    let maxDepth = 0
    for (let i = 0; i < sdf.length; i++) if (-sdf[i] > maxDepth) maxDepth = -sdf[i]
    const sdfTex = sdfToTexture(sdf, RASTER, maxDepth)
    entry = { sdfTex, texelWorld: DISPLAY / RASTER, interiorScale: Math.max(maxDepth * (DISPLAY / RASTER), 1e-3) }
    sdfCacheMap.set(key, entry)
  }
  return entry
}

function rebuild() {
  if (!app.stage || !silhouettePolys.length || !washTex.source) return

  // Free baked RenderTextures from the previous procedural rebuild.
  for (const t of bakedTexturesToDestroy) t.destroy(true)
  bakedTexturesToDestroy = []

  grid.removeChildren().forEach(c => c.destroy({ children: true }))

  const n = VARIANT_COUNT.value
  const rows = Math.ceil(n / GRID_COLS)
  const cell = Math.min(app.screen.width / GRID_COLS, app.screen.height / rows)
  const inner = cell * 0.86
  const foliage = hexToLinear(currentColor())
  const cool: [number, number, number] = [foliage[0] * 0.7, foliage[1] * 0.72, foliage[2] * 0.66]
  const t0 = performance.now()

  // Pre-build pigment K/S pairs once (same for all seeds in one rebuild).
  const pigA = pigmentKS([0.35, 0.62, 0.48], [0.06, 0.20, 0.13])
  const pigB = pigmentKS([0.80, 0.56, 0.24], [0.26, 0.13, 0.05])

  // Normalize shadow direction in JS before passing to the shader (must be unit-length).
  const sdx = pwShadowDX.value, sdy = pwShadowDY.value
  const sdLen = Math.hypot(sdx, sdy) || 1
  const shadowDir: [number, number] = [sdx / sdLen, sdy / sdLen]

  const ink = mode.value === 'sim' ? inkwashParams() : null
  for (let seed = 0; seed < n; seed++) {
    const cellRoot = markRaw(new Container())

    if (mode.value === 'procedural') {
      // Per-plant SDF: built once per plantId:dilation, reused across all seeds.
      const { sdfTex, texelWorld, interiorScale } = getOrBuildSdf()

      // One filter per seed (different seed → different drying-field phase).
      // Do NOT destroy the filter after baking — it shares sdfTex.source via
      // the UniformGroup resource, so destroying it would kill the shared SDF.
      const filter = new ProceduralWatercolorFilter({
        sdf: sdfTex,
        sdfTexelWorldSize: texelWorld,
        interiorScale,
        seed,
        offsetBase: pwOffsetBase.value,
        offsetNoiseAmp: pwOffsetBase.value * 0.35,  // 35% of offset base
        warpAmp: pwWarpAmp.value,
        shadowDir,
        shadowAmp: pwShadowAmp.value,
        fbmB: pwFbmB.value,
        paperC: pwPaperC.value,
        pigA,
        pigB,
        bandCount: pwBandCount.value,
        edgeWidth: pwEdgeWidth.value,
        bandGain: pwBandGain.value,
        plateauLo: pwPlateauLo.value,
        plateauHi: pwPlateauHi.value,
        mixT0: pwMixT0.value,
        mixT1: pwMixT1.value,
        baseDensity: pwBaseDensity.value,
        coverKnee: pwCoverKnee.value,
        debugStage: pwDebugStage.value,
      })

      // 2× bake: the filter runs on a Sprite OF THE SDF TEXTURE (so the shader reads it
      // via the auto-provided uTexture input with correct vTextureCoord mapping), sized
      // DISPLAY*2, baked to a 2× texture then shown at DISPLAY = clean supersampled bake.
      const src = new Sprite(sdfTex)
      src.anchor.set(0.5)
      src.width = DISPLAY * 2
      src.height = DISPLAY * 2
      src.filters = [filter]

      const bakedTex = app.renderer.generateTexture({
        target: src,
        resolution: 2,
        textureSourceOptions: { scaleMode: 'linear' },
      })
      // Track for destruction at the top of the next rebuild.
      bakedTexturesToDestroy.push(bakedTex)

      // Destroy the wrapper Sprite only — NOT the shared cached SDF texture.
      src.destroy({ texture: false })

      const bakedSprite = markRaw(new Sprite(bakedTex))
      bakedSprite.anchor.set(0.5)
      bakedSprite.width = DISPLAY
      bakedSprite.height = DISPLAY

      const clipMask = buildMaskGraphics(1)
      cellRoot.addChild(clipMask)
      cellRoot.addChild(bakedSprite)
      bakedSprite.mask = clipMask

    } else if (ink) {
      // Baked mini-inkwash: one Sprite from the fluid-sim canvas + contour.
      const simCanvas = bakeInkwash(silhouettePolys, seed, SIM_SIZE, RASTER, ink)
      const s = markRaw(new Sprite(Texture.from(simCanvas)))
      s.anchor.set(0.5)
      s.width = s.height = DISPLAY
      cellRoot.addChild(s)
    } else {
      cellRoot.addChild(buildWashLayer(seed * 7 + 1, foliage, wetness.value, 1.0))
      if (tonal.value > 0) cellRoot.addChild(buildWashLayer(seed * 13 + 5, cool, wetness.value * tonal.value, 1.35))
      const bloom = buildBloomSprite(seed)
      if (bloom) cellRoot.addChild(bloom)
      if (grainOn.value) cellRoot.addChild(buildGrainLayer())
    }

    if (contourOn.value) cellRoot.addChild(buildContour(seed))
    cellRoot.scale.set(inner / DISPLAY)

    const container = markRaw(new Container())
    const { x, y } = layoutCell(seed, cell)
    container.position.set(x, y)
    container.addChild(cellRoot)

    const label = markRaw(new Text({ text: `seed ${seed}`, style: { fontFamily: 'monospace', fontSize: 12, fill: 0x6a5f45 } }))
    label.anchor.set(0.5, 0)
    label.position.set(0, inner / 2 - 2)
    container.addChild(label)
    grid.addChild(container)
  }
  status.value = `${currentPlant()?.commonName ?? plantId.value} · ${n} variants · ${Math.round(performance.now() - t0)}ms`
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

let rebuildTimer: ReturnType<typeof setTimeout> | null = null
function scheduleRebuild() {
  if (rebuildTimer) clearTimeout(rebuildTimer)
  rebuildTimer = setTimeout(rebuild, 90)
}

// ── drag-to-pan ──────────────────────────────────────────────────────────────
const PANEL_CLEAR = 400
let dragging = false, lastX = 0, lastY = 0
function onPanStart(e: PointerEvent) { dragging = true; lastX = e.clientX; lastY = e.clientY }
function onPanMove(e: PointerEvent) {
  if (!dragging || !grid.position) return
  grid.position.x += e.clientX - lastX; grid.position.y += e.clientY - lastY
  lastX = e.clientX; lastY = e.clientY
}
function onPanEnd() { dragging = false }
function resetView() { if (grid.position) grid.position.set(PANEL_CLEAR, 12) }

onMounted(async () => {
  app = markRaw(new Application())
  await app.init({ canvas: canvasEl.value!, resizeTo: canvasEl.value!.parentElement!, antialias: true, background: 0xf2ead4 })

  let loaded: PlantSummary[] = []
  ;[washTex, grainTex, loaded] = await Promise.all([
    Assets.load(WASH_TEXTURE),
    Assets.load(GRAIN_TEXTURE),
    fetchPlantList().catch(() => [] as PlantSummary[]),
  ])
  plants.value = loaded.sort((a, b) => a.commonName.localeCompare(b.commonName))

  grid = markRaw(new Container())
  app.stage.addChild(grid)
  app.renderer.on('resize', rebuild)

  await reloadAll()
  resetView()

  // Dev-only programmatic tuning hook for scripts/watercolor-render.ts — set the
  // procedural knobs from a JSON object and re-render deterministically (no slider
  // poking, survives HMR). Resolves once the grid has rebuilt.
  if (import.meta.env.DEV) {
    const knobMap: Record<string, { value: number }> = {
      offsetBase: pwOffsetBase, warpAmp: pwWarpAmp, fbmB: pwFbmB, paperC: pwPaperC,
      bandCount: pwBandCount, edgeWidth: pwEdgeWidth, bandGain: pwBandGain,
      plateauLo: pwPlateauLo, plateauHi: pwPlateauHi, mixT0: pwMixT0, mixT1: pwMixT1,
      baseDensity: pwBaseDensity, coverKnee: pwCoverKnee,
      shadowDX: pwShadowDX, shadowDY: pwShadowDY, shadowAmp: pwShadowAmp,
      variants: VARIANT_COUNT, dilation, debugStage: pwDebugStage,
    }
    ;(window as unknown as { __procTune?: unknown }).__procTune = async (params: Record<string, number>) => {
      mode.value = 'procedural'
      if (typeof params.plantId === 'number') plantId.value = params.plantId
      for (const [k, v] of Object.entries(params)) {
        if (k === 'plantId') continue
        if (knobMap[k]) knobMap[k].value = v
      }
      await nextTick()
      await reloadAll()
      await nextTick()
    }
  }
})

onUnmounted(() => {
  // Destroy cached SDF textures.
  for (const e of sdfCacheMap.values()) e.sdfTex.destroy(true)
  sdfCacheMap.clear()
  for (const t of bakedTexturesToDestroy) t.destroy(true)
  bakedTexturesToDestroy = []
  if (app.destroy) app.destroy(true, { children: true })
})

watch([plantId, dilation], reloadAll)
watch([
  mode, variation, wetness, paperCut, washScale, bleed, tonal,
  bloomColor, bloomStrength, bloomSize, bloomSoftness,
  grainOn, grainStrength, contourOn, contourWidth, contourWobble, contourAlpha, VARIANT_COUNT,
  simDrops, simWetness, simBleed, simIterations, simEdge, simGranule, simStrength, simPaper,
  // procedural controls
  pwOffsetBase, pwWarpAmp, pwFbmB, pwPaperC,
  pwBandCount, pwEdgeWidth, pwBandGain,
  pwPlateauLo, pwPlateauHi,
  pwMixT0, pwMixT1,
  pwBaseDensity, pwCoverKnee,
  pwShadowDX, pwShadowDY, pwShadowAmp,
], scheduleRebuild)
</script>

<template>
  <div class="wrap">
    <canvas
      ref="canvasEl" class="pan" :class="{ dragging }"
      @pointerdown="onPanStart" @pointermove="onPanMove" @pointerup="onPanEnd"
      @pointerleave="onPanEnd" @dblclick="resetView"
    />
    <div class="hud"><div class="fps">{{ fps }} <span>fps</span></div><div>{{ frameMs }} ms</div></div>

    <div class="panel">
      <div class="title">Botanical Variants</div>
      <label>plant
        <select v-model.number="plantId">
          <option v-for="p in plants" :key="p.id" :value="p.id">{{ p.commonName }}</option>
        </select>
      </label>
      <div class="meta">{{ plants.length }} plants · {{ currentPlant()?.scientificName ?? '—' }}</div>
      <label>mode
        <select v-model="mode">
          <option value="texture">real texture</option>
          <option value="sim">mini-inkwash (sim)</option>
          <option value="procedural">procedural (algorithmic)</option>
        </select>
      </label>
      <label>variants <input type="range" min="1" max="16" step="1" v-model.number="VARIANT_COUNT" /> {{ VARIANT_COUNT }}</label>

      <template v-if="mode === 'texture'">
        <label>variation <input type="range" min="0" max="1" step="0.05" v-model.number="variation" /> {{ variation.toFixed(2) }}</label>
        <div class="group">watercolour (real texture)</div>
        <label>wetness <input type="range" min="0" max="1" step="0.05" v-model.number="wetness" /> {{ wetness.toFixed(2) }}</label>
        <label>paper cut <input type="range" min="0" max="0.4" step="0.01" v-model.number="paperCut" /> {{ paperCut.toFixed(2) }}</label>
        <label>wash zoom <input type="range" min="0.5" max="3" step="0.1" v-model.number="washScale" /> {{ washScale.toFixed(1) }}</label>
        <label>bleed <input type="range" min="0" max="20" step="1" v-model.number="bleed" /> {{ bleed }}</label>
        <label>tonal depth <input type="range" min="0" max="1" step="0.05" v-model.number="tonal" /> {{ tonal.toFixed(2) }}</label>
      </template>

      <template v-else-if="mode === 'procedural'">
        <div class="group">procedural watercolor — puddle / warp</div>
        <label>offset base <input type="range" min="2" max="24" step="1" v-model.number="pwOffsetBase" /> {{ pwOffsetBase }}</label>
        <label>warp amp <input type="range" min="0" max="0.08" step="0.005" v-model.number="pwWarpAmp" /> {{ pwWarpAmp.toFixed(3) }}</label>
        <label>fBm weight <input type="range" min="0" max="0.6" step="0.02" v-model.number="pwFbmB" /> {{ pwFbmB.toFixed(2) }}</label>
        <label>paper weight <input type="range" min="0" max="0.2" step="0.01" v-model.number="pwPaperC" /> {{ pwPaperC.toFixed(2) }}</label>
        <div class="group">bands</div>
        <label>band count <input type="range" min="3" max="7" step="1" v-model.number="pwBandCount" /> {{ pwBandCount }}</label>
        <label>edge width <input type="range" min="0.4" max="3" step="0.1" v-model.number="pwEdgeWidth" /> {{ pwEdgeWidth.toFixed(1) }}</label>
        <label>band gain <input type="range" min="0" max="1.5" step="0.05" v-model.number="pwBandGain" /> {{ pwBandGain.toFixed(2) }}</label>
        <div class="group">density / plateau</div>
        <label>base density <input type="range" min="0.1" max="1" step="0.05" v-model.number="pwBaseDensity" /> {{ pwBaseDensity.toFixed(2) }}</label>
        <label>plateau lo <input type="range" min="0" max="0.5" step="0.02" v-model.number="pwPlateauLo" /> {{ pwPlateauLo.toFixed(2) }}</label>
        <label>plateau hi <input type="range" min="0.2" max="0.9" step="0.02" v-model.number="pwPlateauHi" /> {{ pwPlateauHi.toFixed(2) }}</label>
        <label>cover knee <input type="range" min="0.1" max="1" step="0.05" v-model.number="pwCoverKnee" /> {{ pwCoverKnee.toFixed(2) }}</label>
        <div class="group">pigment mix</div>
        <label>mix T0 <input type="range" min="0" max="1" step="0.02" v-model.number="pwMixT0" /> {{ pwMixT0.toFixed(2) }}</label>
        <label>mix T1 <input type="range" min="0.2" max="1.2" step="0.02" v-model.number="pwMixT1" /> {{ pwMixT1.toFixed(2) }}</label>
        <div class="group">shadow</div>
        <label>shadow DX <input type="range" min="-1" max="1" step="0.05" v-model.number="pwShadowDX" /> {{ pwShadowDX.toFixed(2) }}</label>
        <label>shadow DY <input type="range" min="-1" max="1" step="0.05" v-model.number="pwShadowDY" /> {{ pwShadowDY.toFixed(2) }}</label>
        <label>shadow amp <input type="range" min="0" max="0.2" step="0.01" v-model.number="pwShadowAmp" /> {{ pwShadowAmp.toFixed(2) }}</label>
      </template>

      <template v-else>
        <div class="group">mini-inkwash (fluid sim)</div>
        <label>drops <input type="range" min="2" max="14" step="1" v-model.number="simDrops" /> {{ simDrops }}</label>
        <label>wetness <input type="range" min="0.1" max="1" step="0.05" v-model.number="simWetness" /> {{ simWetness.toFixed(2) }}</label>
        <label>bleed <input type="range" min="0" max="1" step="0.05" v-model.number="simBleed" /> {{ simBleed.toFixed(2) }}</label>
        <label>iterations <input type="range" min="4" max="28" step="1" v-model.number="simIterations" /> {{ simIterations }}</label>
        <label>edge dark <input type="range" min="0" max="2" step="0.1" v-model.number="simEdge" /> {{ simEdge.toFixed(1) }}</label>
        <label>granulation <input type="range" min="0" max="1" step="0.05" v-model.number="simGranule" /> {{ simGranule.toFixed(2) }}</label>
        <label>ink strength <input type="range" min="0.4" max="2.5" step="0.1" v-model.number="simStrength" /> {{ simStrength.toFixed(1) }}</label>
        <label>paper <input type="range" min="0" max="1" step="0.05" v-model.number="simPaper" /> {{ simPaper.toFixed(2) }}</label>
      </template>

      <div class="group">bloom</div>
      <label>bloom <input type="color" v-model="bloomColor" /> <code>{{ bloomColor }}</code></label>
      <label>bloom amt <input type="range" min="0" max="1" step="0.05" v-model.number="bloomStrength" /> {{ bloomStrength.toFixed(2) }}</label>
      <label>bloom size <input type="range" min="0.2" max="0.95" step="0.05" v-model.number="bloomSize" /> {{ bloomSize.toFixed(2) }}</label>
      <label>bloom soft <input type="range" min="0.1" max="1" step="0.05" v-model.number="bloomSoftness" /> {{ bloomSoftness.toFixed(2) }}</label>

      <div class="group">grain / contour</div>
      <label><input type="checkbox" v-model="grainOn" /> graphite grain</label>
      <label>grain <input type="range" min="0" max="0.8" step="0.05" v-model.number="grainStrength" /> {{ grainStrength.toFixed(2) }}</label>
      <label><input type="checkbox" v-model="contourOn" /> contour on</label>
      <label>width <input type="range" min="0.5" max="6" step="0.1" v-model.number="contourWidth" /> {{ contourWidth.toFixed(1) }}</label>
      <label>wobble <input type="range" min="0" max="8" step="0.5" v-model.number="contourWobble" /> {{ contourWobble.toFixed(1) }}</label>
      <label>alpha <input type="range" min="0" max="1" step="0.05" v-model.number="contourAlpha" /> {{ contourAlpha.toFixed(2) }}</label>
      <label>dilation <input type="range" min="0" max="14" step="1" v-model.number="dilation" /> {{ dilation }}</label>
    </div>

    <div class="status">{{ status }} · drag to pan · double-click to reset</div>
  </div>
</template>

<style scoped>
.wrap { position: relative; width: 100%; height: 100%; background: #f2ead4; }
canvas { display: block; width: 100%; height: 100%; }
canvas.pan { cursor: grab; }
canvas.pan.dragging { cursor: grabbing; }
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
