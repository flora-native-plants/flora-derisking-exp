<script setup lang="ts">
/**
 * Wash Material (H–N) — smoke-test harness for the Heitz–Neyret filter.
 *
 * Loads wash-green.png, crops the central 60% to avoid the exemplar's large blooms,
 * runs Task-1 precompute (PCA decorrelation + per-channel histogram Gaussianization),
 * builds packed 256×1 LUT textures, and displays:
 *   Left  — raw TilingSprite (no filter, reference)
 *   Right — H–N filter @ scale 1, seed 0
 *
 * The H–N filter panel generates the field from uWash, not from the filter input,
 * so it is applied to a plain white rectangle.
 */
import { ref, onMounted, onUnmounted, markRaw } from 'vue'
import { Application, Assets, Container, Graphics, Sprite, TilingSprite, Texture, Text } from 'pixi.js'
import { computeColorDecorrelation, buildGaussianLUT } from '../lib/hn/histogramTransform'
import { HeitzNeyretFilter } from '../lib/filters/HeitzNeyretFilter'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const WASH_URL   = '/textures/watercolor/wash-green.png'
const PANEL_W    = 480
const PANEL_H    = 480
const LABEL_H    = 28
const GAP        = 20
const BG         = 0xf2ead4

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const canvasEl = ref<HTMLCanvasElement>()
const status   = ref('Booting…')

let app = markRaw({} as Application)

// ---------------------------------------------------------------------------
// Pixel extraction helpers
// ---------------------------------------------------------------------------

/**
 * Draw a Pixi Texture into an OffscreenCanvas and return the pixels as Float32Array (0..1).
 * Crops the central 60% of the texture to avoid the large pigment blooms near the exemplar edges.
 */
function extractCroppedPixels(tex: Texture): Float32Array {
  const src = tex.source.resource as ImageBitmap | HTMLImageElement | HTMLCanvasElement
  const fullW = (src as { width: number }).width  || tex.source.width
  const fullH = (src as { height: number }).height || tex.source.height

  // Central 60%: start at 20%, end at 80%
  const cx0 = Math.floor(fullW * 0.2)
  const cy0 = Math.floor(fullH * 0.2)
  const cw  = Math.floor(fullW * 0.6)
  const ch  = Math.floor(fullH * 0.6)

  const canvas = new OffscreenCanvas(cw, ch)
  const ctx    = canvas.getContext('2d')!
  ctx.drawImage(src as CanvasImageSource, cx0, cy0, cw, ch, 0, 0, cw, ch)
  const img = ctx.getImageData(0, 0, cw, ch)

  // Convert RGBA Uint8 (0..255) to Float32 (0..1), skip alpha
  const rgb = new Float32Array(cw * ch * 3)
  for (let i = 0; i < cw * ch; i++) {
    rgb[i*3+0] = img.data[i*4+0] / 255
    rgb[i*3+1] = img.data[i*4+1] / 255
    rgb[i*3+2] = img.data[i*4+2] / 255
  }
  return rgb
}

// ---------------------------------------------------------------------------
// LUT texture builder
// ---------------------------------------------------------------------------

/**
 * Pack 3 single-channel Float32 LUTs (each size 256) into a 256×1 RGBA canvas texture.
 * R = ch0, G = ch1, B = ch2, A = 255.
 * Uses Canvas2D (same pattern as sdfTexture.ts) — the most reliable upload path.
 */
function buildLutTexture(ch0: Float32Array, ch1: Float32Array, ch2: Float32Array): Texture {
  const W = 256
  const canvas = document.createElement('canvas')
  canvas.width = W
  canvas.height = 1
  const ctx = canvas.getContext('2d')!
  const img = ctx.createImageData(W, 1)
  for (let i = 0; i < W; i++) {
    img.data[i*4+0] = Math.round(ch0[i] * 255)
    img.data[i*4+1] = Math.round(ch1[i] * 255)
    img.data[i*4+2] = Math.round(ch2[i] * 255)
    img.data[i*4+3] = 255
  }
  ctx.putImageData(img, 0, 0)
  const tex = Texture.from(canvas)
  tex.source.scaleMode = 'nearest'
  return tex
}

// ---------------------------------------------------------------------------
// Scene setup
// ---------------------------------------------------------------------------

async function setupScene(washTex: Texture) {
  const stage = app.stage
  const sw = app.screen.width
  const sh = app.screen.height

  // Background
  const bg = markRaw(new Graphics())
  bg.rect(0, 0, sw, sh).fill({ color: BG })
  stage.addChild(bg)

  // ---------------------------------------------------------------------------
  // Precompute: decorrelation + LUTs
  // ---------------------------------------------------------------------------

  status.value = 'Extracting pixels…'
  const rgb = extractCroppedPixels(washTex)

  status.value = 'Computing PCA decorrelation…'
  const { mean, forward, inverse } = computeColorDecorrelation(rgb)
  const N = rgb.length / 3

  // Build per-channel decorrelated arrays for LUT construction
  const ch0 = new Float32Array(N)
  const ch1 = new Float32Array(N)
  const ch2 = new Float32Array(N)
  const f = forward
  for (let i = 0; i < N; i++) {
    const r = rgb[i*3+0] - mean[0]
    const g = rgb[i*3+1] - mean[1]
    const b = rgb[i*3+2] - mean[2]
    ch0[i] = f[0]*r + f[1]*g + f[2]*b
    ch1[i] = f[3]*r + f[4]*g + f[5]*b
    ch2[i] = f[6]*r + f[7]*g + f[8]*b
  }

  status.value = 'Building Gaussian LUTs…'
  const lut0 = buildGaussianLUT(ch0)
  const lut1 = buildGaussianLUT(ch1)
  const lut2 = buildGaussianLUT(ch2)

  const tTex    = buildLutTexture(lut0.T,    lut1.T,    lut2.T)
  const tinvTex = buildLutTexture(lut0.Tinv, lut1.Tinv, lut2.Tinv)

  // ---------------------------------------------------------------------------
  // Wash texture: set repeat wrap for the H–N sampler
  // ---------------------------------------------------------------------------

  washTex.source.addressMode = 'repeat'

  // ---------------------------------------------------------------------------
  // Layout: two panels side-by-side, centred in the canvas
  // ---------------------------------------------------------------------------

  const totalW  = PANEL_W * 2 + GAP
  const originX = Math.round((sw - totalW) / 2)
  const originY = Math.round((sh - PANEL_H - LABEL_H) / 2)

  const tileScale = PANEL_W / washTex.width

  // --- Left panel: raw TilingSprite (no filter) ---
  const rawWrap = markRaw(new Container())
  rawWrap.position.set(originX, originY)
  stage.addChild(rawWrap)

  const rawSprite = markRaw(new TilingSprite({
    texture:  washTex,
    width:    PANEL_W,
    height:   PANEL_H,
  }))
  rawSprite.tileScale.set(tileScale)
  rawWrap.addChild(rawSprite)

  const rawLabel = markRaw(new Text({ text: 'Raw wash (no filter)', style: { fontFamily: 'monospace', fontSize: 12, fill: 0x4a4030 } }))
  rawLabel.position.set(0, PANEL_H + 6)
  rawWrap.addChild(rawLabel)

  // --- Right panel: H–N filter on a white rectangle ---
  const hnWrap = markRaw(new Container())
  hnWrap.position.set(originX + PANEL_W + GAP, originY)
  stage.addChild(hnWrap)

  // Build the filter
  const hnFilter = new HeitzNeyretFilter({
    T:       tTex,
    Tinv:    tinvTex,
    forward,
    inverse,
    mean:    mean as [number, number, number],
    lutMin:  [lut0.min, lut1.min, lut2.min],
    lutMax:  [lut0.max, lut1.max, lut2.max],
    scale:   1,
    seed:    0,
  })
  hnFilter.setWash(washTex)

  // Apply to a plain white sprite (the filter ignores input colour; generates from uWash)
  const rect = markRaw(new Sprite(Texture.WHITE))
  rect.width  = PANEL_W
  rect.height = PANEL_H
  rect.filters = [hnFilter]
  hnWrap.addChild(rect)

  const hnLabel = markRaw(new Text({ text: 'H–N synthesis (scale 1, seed 0)', style: { fontFamily: 'monospace', fontSize: 12, fill: 0x4a4030 } }))
  hnLabel.position.set(0, PANEL_H + 6)
  hnWrap.addChild(hnLabel)

  status.value = 'Ready — H–N filter applied'
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
      resizeTo:   canvasEl.value!.parentElement!,
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
}
canvas {
  display: block;
  width: 100%;
  height: 100%;
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
