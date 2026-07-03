<script setup lang="ts">
/**
 * Wash Material (H–N) — full comparison strip harness.
 *
 * Panels (left→right):
 *   1. raw wash         — TilingSprite, no filter (control)
 *   2. H–N @ 1×        — scale=1, seed=0  (primary; target of window.__hnTune)
 *   3. H–N @ 8× zoom   — scale=0.125 (magnifies material; checks grain under magnification)
 *   4. H–N tiled ~4×   — scale=4 (packs ~4 tile-lengths; checks seams/repeats)
 *   5. 4 seeds          — 2×2 grid, seed=0..3 (checks non-repetition)
 *
 * All panels share a single precompute (LUTs/matrices built once).
 */
import { ref, onMounted, onUnmounted, markRaw } from 'vue'
import {
  Application, Assets, Container, Graphics,
  Sprite, TilingSprite, Texture, Text,
} from 'pixi.js'
import { computeColorDecorrelation, buildGaussianLUT } from '../lib/hn/histogramTransform'
import { HeitzNeyretFilter } from '../lib/filters/HeitzNeyretFilter'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const WASH_URL  = '/textures/watercolor/wash-green.png'
const PANEL_W   = 280
const PANEL_H   = 280
const LABEL_H   = 24
const GAP       = 16
const PADDING   = 24
const SEED_GAP  = 8
const SEED_SIZE = Math.floor((PANEL_W - SEED_GAP) / 2) // ≈136
const BG        = 0xf2ead4

// Canvas is fixed-size — panels in a 3-column grid (2 rows); container scrolls if needed.
const COLS     = 3
const CANVAS_W = COLS * PANEL_W + (COLS - 1) * GAP + 2 * PADDING
const CANVAS_H = 2 * PANEL_H + 2 * LABEL_H + GAP + 2 * PADDING

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const canvasEl = ref<HTMLCanvasElement>()
const status   = ref('Booting…')

let app = markRaw({} as Application)

// Primary H–N filter — exposed to window.__hnTune
let primaryHnFilter: HeitzNeyretFilter | null = null

// ---------------------------------------------------------------------------
// Pixel extraction helpers
// ---------------------------------------------------------------------------

/**
 * Draw a Pixi Texture into an OffscreenCanvas and return pixels as Float32Array (0..1).
 * Crops the central 60% of the texture to avoid the large pigment blooms near the edges.
 */
function extractCroppedPixels(tex: Texture): Float32Array {
  const src   = tex.source.resource as ImageBitmap | HTMLImageElement | HTMLCanvasElement
  const fullW = (src as { width: number }).width  || tex.source.width
  const fullH = (src as { height: number }).height || tex.source.height

  const cx0 = Math.floor(fullW * 0.2)
  const cy0 = Math.floor(fullH * 0.2)
  const cw  = Math.floor(fullW * 0.6)
  const ch  = Math.floor(fullH * 0.6)

  const canvas = new OffscreenCanvas(cw, ch)
  const ctx    = canvas.getContext('2d')!
  ctx.drawImage(src as CanvasImageSource, cx0, cy0, cw, ch, 0, 0, cw, ch)
  const img = ctx.getImageData(0, 0, cw, ch)

  const rgb = new Float32Array(cw * ch * 3)
  for (let i = 0; i < cw * ch; i++) {
    rgb[i * 3 + 0] = img.data[i * 4 + 0] / 255
    rgb[i * 3 + 1] = img.data[i * 4 + 1] / 255
    rgb[i * 3 + 2] = img.data[i * 4 + 2] / 255
  }
  return rgb
}

// ---------------------------------------------------------------------------
// LUT texture builder
// ---------------------------------------------------------------------------

/**
 * Pack 3 single-channel Float32 LUTs (each size 256) into a 256×1 RGBA canvas texture.
 * R = ch0, G = ch1, B = ch2, A = 255.
 */
function buildLutTexture(ch0: Float32Array, ch1: Float32Array, ch2: Float32Array): Texture {
  const W      = 256
  const canvas = document.createElement('canvas')
  canvas.width  = W
  canvas.height = 1
  const ctx = canvas.getContext('2d')!
  const img = ctx.createImageData(W, 1)
  for (let i = 0; i < W; i++) {
    img.data[i * 4 + 0] = Math.round(ch0[i] * 255)
    img.data[i * 4 + 1] = Math.round(ch1[i] * 255)
    img.data[i * 4 + 2] = Math.round(ch2[i] * 255)
    img.data[i * 4 + 3] = 255
  }
  ctx.putImageData(img, 0, 0)
  const tex = Texture.from(canvas)
  tex.source.scaleMode = 'nearest'
  return tex
}

// ---------------------------------------------------------------------------
// Panel helpers
// ---------------------------------------------------------------------------

/** Shared opts type for HeitzNeyretFilter minus scale/seed. */
interface FilterBase {
  T: Texture
  Tinv: Texture
  forward: number[]
  inverse: number[]
  mean: [number, number, number]
  lutMin: [number, number, number]
  lutMax: [number, number, number]
}

function makeHnFilter(base: FilterBase, scale: number, seed: number, washTex: Texture): HeitzNeyretFilter {
  const f = new HeitzNeyretFilter({ ...base, scale, seed })
  f.setWash(washTex)
  return f
}

function addLabel(parent: Container, text: string, y: number): void {
  const lbl = markRaw(new Text({
    text,
    style: { fontFamily: 'monospace', fontSize: 11, fill: 0x4a4030 },
  }))
  lbl.position.set(0, y)
  parent.addChild(lbl)
}

// ---------------------------------------------------------------------------
// Scene setup
// ---------------------------------------------------------------------------

async function setupScene(washTex: Texture) {
  const stage = app.stage

  // Background
  const bg = markRaw(new Graphics())
  bg.rect(0, 0, CANVAS_W, CANVAS_H).fill({ color: BG })
  stage.addChild(bg)

  // -------------------------------------------------------------------------
  // Precompute: decorrelation + LUTs  (once, shared by all filter instances)
  // -------------------------------------------------------------------------

  status.value = 'Extracting pixels…'
  const rgb = extractCroppedPixels(washTex)

  status.value = 'Computing PCA decorrelation…'
  const { mean, forward, inverse } = computeColorDecorrelation(rgb)
  const N  = rgb.length / 3
  const f  = forward

  const ch0 = new Float32Array(N)
  const ch1 = new Float32Array(N)
  const ch2 = new Float32Array(N)
  for (let i = 0; i < N; i++) {
    const r = rgb[i * 3 + 0] - mean[0]
    const g = rgb[i * 3 + 1] - mean[1]
    const b = rgb[i * 3 + 2] - mean[2]
    ch0[i] = f[0] * r + f[1] * g + f[2] * b
    ch1[i] = f[3] * r + f[4] * g + f[5] * b
    ch2[i] = f[6] * r + f[7] * g + f[8] * b
  }

  status.value = 'Building Gaussian LUTs…'
  const lut0 = buildGaussianLUT(ch0)
  const lut1 = buildGaussianLUT(ch1)
  const lut2 = buildGaussianLUT(ch2)

  const tTex    = buildLutTexture(lut0.T,    lut1.T,    lut2.T)
  const tinvTex = buildLutTexture(lut0.Tinv, lut1.Tinv, lut2.Tinv)

  washTex.source.addressMode = 'repeat'

  const filterBase: FilterBase = {
    T:      tTex,
    Tinv:   tinvTex,
    forward,
    inverse,
    mean:   mean as [number, number, number],
    lutMin: [lut0.min, lut1.min, lut2.min],
    lutMax: [lut0.max, lut1.max, lut2.max],
  }

  // -------------------------------------------------------------------------
  // Layout helpers
  // -------------------------------------------------------------------------

  const LABEL_DY = PANEL_H + 6            // label y within a panel container
  const ROW_H    = PANEL_H + LABEL_H + GAP

  // 3-column grid: idx 0..2 on row 0, idx 3..4 on row 1.
  function panelX(idx: number): number {
    return PADDING + (idx % COLS) * (PANEL_W + GAP)
  }
  function panelYFor(idx: number): number {
    return PADDING + Math.floor(idx / COLS) * ROW_H
  }

  function addHnQuad(
    parent: Container,
    w: number,
    h: number,
    filter: HeitzNeyretFilter,
  ): Sprite {
    const rect = markRaw(new Sprite(Texture.WHITE))
    rect.width   = w
    rect.height  = h
    rect.filters = [filter]
    parent.addChild(rect)
    return rect
  }

  // -------------------------------------------------------------------------
  // Panel 1: raw wash — TilingSprite, no filter
  // -------------------------------------------------------------------------

  const p1 = markRaw(new Container())
  p1.position.set(panelX(0), panelYFor(0))
  stage.addChild(p1)

  const tileScale  = PANEL_W / washTex.width
  const rawSprite  = markRaw(new TilingSprite({ texture: washTex, width: PANEL_W, height: PANEL_H }))
  rawSprite.tileScale.set(tileScale)
  p1.addChild(rawSprite)
  addLabel(p1, 'Raw wash (no filter)', LABEL_DY)

  // -------------------------------------------------------------------------
  // Panel 2: H–N @ 1× — primary; target of window.__hnTune
  // -------------------------------------------------------------------------

  const p2 = markRaw(new Container())
  p2.position.set(panelX(1), panelYFor(1))
  stage.addChild(p2)

  primaryHnFilter = makeHnFilter(filterBase, 1, 0, washTex)
  addHnQuad(p2, PANEL_W, PANEL_H, primaryHnFilter)
  addLabel(p2, 'H–N @ 1× (scale 1, seed 0)', LABEL_DY)

  // -------------------------------------------------------------------------
  // Panel 3: H–N @ 8× zoom — scale=0.125 magnifies the material
  // -------------------------------------------------------------------------

  const p3 = markRaw(new Container())
  p3.position.set(panelX(2), panelYFor(2))
  stage.addChild(p3)

  const zoomFilter = makeHnFilter(filterBase, 0.125, 0, washTex)
  addHnQuad(p3, PANEL_W, PANEL_H, zoomFilter)
  addLabel(p3, 'H–N @ 8× zoom (scale 0.125)', LABEL_DY)

  // -------------------------------------------------------------------------
  // Panel 4: H–N tiled — scale=4 packs ~4 wash tile-lengths; checks seams
  // -------------------------------------------------------------------------

  const p4 = markRaw(new Container())
  p4.position.set(panelX(3), panelYFor(3))
  stage.addChild(p4)

  const tiledFilter = makeHnFilter(filterBase, 4, 0, washTex)
  addHnQuad(p4, PANEL_W, PANEL_H, tiledFilter)
  addLabel(p4, 'H–N tiled ~4× (scale 4)', LABEL_DY)

  // -------------------------------------------------------------------------
  // Panel 5: 4 seeds — 2×2 grid of sub-quads, seed 0..3
  // -------------------------------------------------------------------------

  const p5 = markRaw(new Container())
  p5.position.set(panelX(4), panelYFor(4))
  stage.addChild(p5)

  for (let s = 0; s < 4; s++) {
    const col   = s % 2
    const row   = Math.floor(s / 2)
    const sx    = col * (SEED_SIZE + SEED_GAP)
    const sy    = row * (SEED_SIZE + SEED_GAP)
    const wrap  = markRaw(new Container())
    wrap.position.set(sx, sy)
    p5.addChild(wrap)
    const sf = makeHnFilter(filterBase, 1, s, washTex)
    addHnQuad(wrap, SEED_SIZE, SEED_SIZE, sf)
    const seedLbl = markRaw(new Text({
      text: `seed ${s}`,
      style: { fontFamily: 'monospace', fontSize: 9, fill: 0x4a4030 },
    }))
    seedLbl.position.set(2, SEED_SIZE - 14)
    wrap.addChild(seedLbl)
  }
  addLabel(p5, '4 seeds (seed 0–3)', LABEL_DY)

  // -------------------------------------------------------------------------
  // window.__hnTune — update primary H–N filter (panel 2)
  // -------------------------------------------------------------------------

  ;(window as unknown as { __hnTune?: unknown }).__hnTune = (
    params: { scale?: number; seed?: number },
  ) => {
    if (!primaryHnFilter) return
    if (typeof params.scale === 'number') primaryHnFilter.setScale(params.scale)
    if (typeof params.seed  === 'number') primaryHnFilter.setSeed(params.seed)
    app.renderer.render(app.stage)
  }

  status.value = 'Ready — comparison strip rendered'
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

onMounted(async () => {
  try {
    status.value = 'Initialising Pixi…'
    app = markRaw(new Application())
    await app.init({
      canvas:     canvasEl.value!,
      width:      CANVAS_W,
      height:     CANVAS_H,
      antialias:  true,
      background: BG,
    })

    status.value = 'Loading wash texture…'
    const washTex: Texture = await Assets.load(WASH_URL)

    await setupScene(washTex)
  } catch (e) {
    status.value = `Error: ${(e as Error).message}`
    console.error('[TabWashMaterialHN]', e)
  }
})

onUnmounted(() => {
  primaryHnFilter = null
  ;(window as unknown as { __hnTune?: unknown }).__hnTune = undefined
  if (app.destroy) app.destroy(true, { children: true })
})
</script>

<template>
  <div class="wrap">
    <canvas ref="canvasEl" />
    <div class="status">{{ status }}</div>
  </div>
</template>

<style scoped>
.wrap {
  position: relative;
  width: 100%;
  height: 100%;
  background: #f2ead4;
  overflow-x: auto;
}
canvas {
  display: block;
  /* Canvas has a fixed logical size; let it be pixel-exact at 1×. */
}
.status {
  position: absolute;
  bottom: 10px;
  left: 50%;
  transform: translateX(-50%);
  font-family: monospace;
  font-size: 11px;
  color: #8a7f66;
  background: rgba(255, 255, 255, 0.75);
  padding: 4px 12px;
  border-radius: 4px;
  pointer-events: none;
  white-space: nowrap;
}
</style>
