<script setup lang="ts">
/**
 * Botanical Illustration spike — texture-driven watercolour + pencil look.
 *
 * Goal (v1): nail ONE convincing hand-illustrated look on a fixed plant, no
 * per-placement variation. Three layers over the plant silhouette:
 *   1. cream paper
 *   2. watercolour wash — AI texture (white-bg) -> luminance->alpha + tint,
 *      masked to a SOFTENED silhouette so it bleeds past the crisp SVG edge
 *      (a hard clip is the #1 "computed" tell).
 *   3. pencil contour — silhouette outline stroked with a wobble, optional
 *      graphite-grain multiply for tooth.
 *
 * The plant SVG art is never altered (see feedback-dont-vary-plant-svgs); we only
 * derive a silhouette from it and render effects around/inside that shape.
 *
 * Plant SVGs come from the public Railway backend (no login needed).
 */
import { ref, watch, onMounted, onUnmounted, markRaw } from 'vue'
import {
  Application, Assets, Container, Graphics, Sprite, TilingSprite, Texture, RenderTexture, BlurFilter,
} from 'pixi.js'
import { fetchPlantSvg } from '../lib/plantApi'
import { extractSilhouette, type Vec2 } from '../lib/silhouette'
import { WashTextureTintFilter } from '../lib/filters/WashTextureTintFilter'
import { useFps } from '../shared/useFps'

const { fps, frameMs } = useFps()
const canvasEl = ref<HTMLCanvasElement>()
const status = ref('Booting…')

// ---- test subjects (public Railway plants, green-ish) -------------------------
const PLANTS = [
  { id: 2, name: 'Red Maple',          color: '#4CAF50' },
  { id: 4, name: 'Everglades Palm',    color: '#4CAF50' },
  { id: 5, name: 'Giant Leather Fern', color: '#6E8B5A' },
] as const

const WASH_TEXTURES = {
  'wash-green':     '/textures/watercolor/wash-green.png',
  'blooms-rose':    '/textures/watercolor/blooms-rose.png',
  'splatter-brown': '/textures/watercolor/splatter-brown.png',
} as const
type WashKey = keyof typeof WASH_TEXTURES
const GRAIN_TEXTURE = '/textures/pencil/grain-heavy.jpg'

// ---- live controls ------------------------------------------------------------
const plantId      = ref<number>(PLANTS[0].id)
const washKey      = ref<WashKey>('wash-green')
const washStrength = ref(0.85)   // wetness / overall pigment opacity
const paperCut     = ref(0.04)   // luminance threshold for "paper"
const washScale    = ref(1.4)    // wash texture zoom inside the shape
const bleed        = ref(7)      // mask blur px -> soft bleeding edge
const dilation     = ref(4)      // silhouette fuse radius (re-extracts)

const contourOn    = ref(true)
const contourWidth = ref(2.0)
const contourWobble= ref(2.5)
const contourAlpha = ref(0.85)

const grainOn      = ref(true)
const grainStrength= ref(0.35)
const showArt      = ref(false)  // faint original SVG overlay to keep plant identity

const DISPLAY = 460              // px the plant is rendered at
const RASTER = 512               // silhouette extraction space
const CONTOUR_COLOR = 0x4a3b2a   // sepia graphite

let app = markRaw({} as Application)
let plantRoot = markRaw({} as Container)
let washTex = markRaw({} as Texture)
let grainTex = markRaw({} as Texture)
let artTex: Texture | null = null

// cached per (plantId, dilation)
let svgString = ''
let silhouettePolys: Vec2[][] = []
let cachedKey = ''

function hexToLinear(hex: string): [number, number, number] {
  const n = parseInt(hex.replace('#', ''), 16)
  return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255]
}

/** Scale a 512-space polygon to the DISPLAY box, centred at origin. */
function scalePoly(poly: Vec2[]): Vec2[] {
  const s = DISPLAY / RASTER
  const off = DISPLAY / 2
  return poly.map(p => ({ x: p.x * s - off, y: p.y * s - off }))
}

/** Smooth per-point jitter so the outline reads hand-drawn, not vector. */
function wobblePoly(poly: Vec2[], amp: number): Vec2[] {
  return poly.map((p, i) => ({
    x: p.x + Math.sin(i * 0.7) * amp + Math.sin(i * 2.3 + 1.0) * amp * 0.4,
    y: p.y + Math.cos(i * 0.9) * amp + Math.cos(i * 1.7 + 2.0) * amp * 0.4,
  }))
}

async function loadSvgTexture(svg: string): Promise<Texture> {
  const blob = new Blob([svg], { type: 'image/svg+xml' })
  const url = URL.createObjectURL(blob)
  try {
    const img = new Image()
    await new Promise<void>((res, rej) => { img.onload = () => res(); img.onerror = rej; img.src = url })
    return Texture.from(img)
  } finally { URL.revokeObjectURL(url) }
}

async function ensurePlantData() {
  const key = `${plantId.value}:${dilation.value}`
  if (key === cachedKey && silhouettePolys.length) return
  status.value = `Fetching plant ${plantId.value}…`
  svgString = await fetchPlantSvg(plantId.value)
  artTex = await loadSvgTexture(svgString)
  status.value = 'Extracting silhouette…'
  const sil = await extractSilhouette(svgString, { rasterSize: RASTER, dilationPx: dilation.value }, plantId.value)
  silhouettePolys = sil.polygons
  cachedKey = key
}

const MASK_PAD = 90               // px around DISPLAY so blurred bleed isn't clipped
let disposables: { destroy: (opts?: unknown) => void }[] = []

/**
 * Soft alpha mask = silhouette rendered to a RenderTexture, optionally blurred.
 * A BlurFilter applied directly to a Graphics-as-mask is ignored by Pixi's mask
 * system; baking to a texture and masking with the resulting Sprite gives true
 * soft (alpha) edges, so the wash bleeds past the crisp SVG outline.
 */
function buildSoftMaskSprite(blurPx: number): Sprite {
  const size = DISPLAY + MASK_PAD * 2
  const g = new Graphics()
  for (const poly of silhouettePolys) {
    if (poly.length < 3) continue
    g.poly(scalePoly(poly)).fill({ color: 0xffffff })
  }
  const holder = new Container()
  holder.addChild(g)
  holder.position.set(size / 2, size / 2)          // origin-centred shape -> RT centre
  if (blurPx > 0) holder.filters = [new BlurFilter({ strength: blurPx })]

  const rt = RenderTexture.create({ width: size, height: size, antialias: true })
  app.renderer.render({ container: holder, target: rt })
  holder.destroy({ children: true })
  disposables.push(rt)

  const sprite = markRaw(new Sprite(rt))
  sprite.position.set(-size / 2, -size / 2)
  return sprite
}

function buildWashLayer(): Container {
  const layer = markRaw(new Container())

  // TilingSprite of the wash, covering the plant box (+margin for bleed).
  const m = DISPLAY * 0.6
  const wash = markRaw(new TilingSprite({
    texture: washTex,
    width: DISPLAY + m, height: DISPLAY + m,
  }))
  wash.position.set(-(DISPLAY + m) / 2, -(DISPLAY + m) / 2)
  wash.tileScale.set((washScale.value * DISPLAY) / washTex.width)
  const tint = new WashTextureTintFilter(hexToLinear(currentColor()), washStrength.value, paperCut.value)
  wash.filters = [tint]
  layer.addChild(wash)

  // Soft mask -> wash fades out past the crisp edge (bleed).
  const mask = buildSoftMaskSprite(bleed.value)
  layer.addChild(mask)
  layer.mask = mask
  return layer
}

function buildGrainLayer(): Container {
  const layer = markRaw(new Container())
  const m = DISPLAY * 0.6
  const grain = markRaw(new TilingSprite({ texture: grainTex, width: DISPLAY + m, height: DISPLAY + m }))
  grain.position.set(-(DISPLAY + m) / 2, -(DISPLAY + m) / 2)
  grain.tileScale.set((DISPLAY * 1.1) / grainTex.width)
  grain.alpha = grainStrength.value
  grain.blendMode = 'multiply'
  layer.addChild(grain)
  const mask = buildSoftMaskSprite(Math.min(bleed.value, 4))   // tooth stays mostly inside
  layer.addChild(mask)
  layer.mask = mask
  return layer
}

function buildContour(): Graphics {
  const g = markRaw(new Graphics())
  for (const poly of silhouettePolys) {
    if (poly.length < 3) continue
    const pts = wobblePoly(scalePoly(poly), contourWobble.value)
    g.poly(pts, true).stroke({
      color: CONTOUR_COLOR, width: contourWidth.value, alpha: contourAlpha.value,
      join: 'round', cap: 'round',
    })
  }
  return g
}

function currentColor(): string {
  return PLANTS.find(p => p.id === plantId.value)?.color ?? '#4CAF50'
}

function rebuildPlant() {
  if (!app.stage || !silhouettePolys.length) return
  plantRoot.removeChildren().forEach(c => c.destroy({ children: true }))
  disposables.forEach(d => d.destroy(true))
  disposables = []

  // faint original art, under everything, to keep plant identity if wanted
  if (showArt.value && artTex) {
    const art = markRaw(new Sprite(artTex))
    art.anchor.set(0.5)
    const s = DISPLAY / Math.max(artTex.width, artTex.height)
    art.scale.set(s)
    art.alpha = 0.18
    plantRoot.addChild(art)
  }

  plantRoot.addChild(buildWashLayer())
  if (grainOn.value) plantRoot.addChild(buildGrainLayer())
  if (contourOn.value) plantRoot.addChild(buildContour())
  status.value = `${PLANTS.find(p => p.id === plantId.value)?.name} · ${silhouettePolys.length} blob(s)`
}

async function reloadAll() {
  try {
    await ensurePlantData()
    rebuildPlant()
  } catch (e) {
    status.value = `Error: ${(e as Error).message}`
    console.error(e)
  }
}

onMounted(async () => {
  app = markRaw(new Application())
  await app.init({ canvas: canvasEl.value!, resizeTo: canvasEl.value!.parentElement!, antialias: true, background: 0xf2ead4 })

  ;[washTex, grainTex] = await Promise.all([
    Assets.load(WASH_TEXTURES[washKey.value]),
    Assets.load(GRAIN_TEXTURE),
  ])

  plantRoot = markRaw(new Container())
  plantRoot.position.set(app.screen.width / 2, app.screen.height / 2)
  app.stage.addChild(plantRoot)
  app.renderer.on('resize', () => plantRoot.position.set(app.screen.width / 2, app.screen.height / 2))

  await reloadAll()
})

onUnmounted(() => { if (app.destroy) app.destroy(true, { children: true }) })

// re-fetch + re-extract when plant or dilation changes
watch([plantId, dilation], reloadAll)
// swap wash texture
watch(washKey, async () => { washTex = markRaw(await Assets.load(WASH_TEXTURES[washKey.value])); rebuildPlant() })
// cheap rebuilds
watch([washStrength, paperCut, washScale, bleed, contourOn, contourWidth, contourWobble, contourAlpha, grainOn, grainStrength, showArt], rebuildPlant)
</script>

<template>
  <div class="wrap">
    <canvas ref="canvasEl" />
    <div class="hud"><div class="fps">{{ fps }} <span>fps</span></div><div>{{ frameMs }} ms</div></div>

    <div class="panel">
      <div class="title">Botanical Illustration</div>
      <label>plant
        <select v-model.number="plantId">
          <option v-for="p in PLANTS" :key="p.id" :value="p.id">{{ p.name }}</option>
        </select>
      </label>
      <label>wash tex
        <select v-model="washKey">
          <option v-for="k in Object.keys(WASH_TEXTURES)" :key="k" :value="k">{{ k }}</option>
        </select>
      </label>

      <div class="group">watercolour</div>
      <label>wetness <input type="range" min="0" max="1" step="0.05" v-model.number="washStrength" /> {{ washStrength.toFixed(2) }}</label>
      <label>paper cut <input type="range" min="0" max="0.4" step="0.01" v-model.number="paperCut" /> {{ paperCut.toFixed(2) }}</label>
      <label>wash zoom <input type="range" min="0.5" max="3" step="0.1" v-model.number="washScale" /> {{ washScale.toFixed(1) }}</label>
      <label>bleed <input type="range" min="0" max="20" step="1" v-model.number="bleed" /> {{ bleed }}</label>
      <label>dilation <input type="range" min="0" max="14" step="1" v-model.number="dilation" /> {{ dilation }}</label>

      <div class="group">pencil contour</div>
      <label><input type="checkbox" v-model="contourOn" /> contour on</label>
      <label>width <input type="range" min="0.5" max="5" step="0.1" v-model.number="contourWidth" /> {{ contourWidth.toFixed(1) }}</label>
      <label>wobble <input type="range" min="0" max="8" step="0.5" v-model.number="contourWobble" /> {{ contourWobble.toFixed(1) }}</label>
      <label>alpha <input type="range" min="0" max="1" step="0.05" v-model.number="contourAlpha" /> {{ contourAlpha.toFixed(2) }}</label>

      <div class="group">tooth / art</div>
      <label><input type="checkbox" v-model="grainOn" /> graphite grain</label>
      <label>grain <input type="range" min="0" max="0.8" step="0.05" v-model.number="grainStrength" /> {{ grainStrength.toFixed(2) }}</label>
      <label><input type="checkbox" v-model="showArt" /> show original art (faint)</label>
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
.panel input[type=range] { flex: 1; }
.status { position: absolute; bottom: 10px; left: 50%; transform: translateX(-50%); font-family: monospace; font-size: 11px; color: #8a7f66; background: rgba(255,255,255,0.7); padding: 5px 12px; border-radius: 4px; pointer-events: none; }
</style>
