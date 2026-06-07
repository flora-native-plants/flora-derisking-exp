<script setup lang="ts">
/**
 * SVG rendering test harness.
 *
 * Renders the same SVG input through four strategies side-by-side so
 * differences in Pixi's svg() tessellator vs raster fallback are immediately
 * visible at any zoom level.
 *
 * Strategies:
 *   A  — Graphics.svg() with raw markup (current production path)
 *   B1 — Graphics.svg() with compressed-number re-spacing only
 *   B2 — Graphics.svg() with full abs()+unshort() path normalization
 *   C  — High-res raster (8× natural size) as Sprite — the reliable fallback
 *
 * Exposed on window for Playwright automation:
 *   __renderSvg(markup: string)  — render all strategies from SVG string
 *   __setZoom(factor: number)    — scale all strategy containers
 *   __screenshot(): Promise<string> — base64 PNG of the full canvas
 *   __pixiApp                    — the Application instance
 */
import { onMounted, onUnmounted, ref } from 'vue'
import { Application, Graphics, Sprite, Texture, ImageSource, Container, Text, TextStyle } from 'pixi.js'
import svgpath from 'svgpath'

// ── Layout constants ──────────────────────────────────────────────────────────
const STRATEGIES = [
  { id: 'A',  label: 'A: raw svg()',        desc: 'Graphics.svg() unmodified' },
  { id: 'B1', label: 'B1: re-spaced nums',  desc: 'Insert spaces around compressed signs' },
  { id: 'B2', label: 'B2: abs+unshort',     desc: 'svgpath.abs().unshort()' },
  { id: 'C',  label: 'C: raster 8×',        desc: 'HTMLImage at 8× natural size' },
] as const

const NATURAL_W = 290
const NATURAL_H = 252
const CELL_W    = 310
const CELL_H    = 280
const PADDING   = 20
const LABEL_H   = 40
const CANVAS_W  = STRATEGIES.length * (CELL_W + PADDING) + PADDING
const CANVAS_H  = LABEL_H + CELL_H + PADDING * 2

// ── State ─────────────────────────────────────────────────────────────────────
const canvasEl   = ref<HTMLCanvasElement | null>(null)
const statusMsg  = ref('Ready — call window.__renderSvg(svgMarkup) or paste below')
const svgInput   = ref('')
const currentZoom = ref(1)

let app: Application | null = null
// One Container per strategy; holds the rendered output
const cells: Container[] = []
// Root zoom container
let zoomRoot: Container | null = null

// ── Path normalization helpers ────────────────────────────────────────────────

/** B1: re-space compressed sign-separator number pairs like "0-.6" → "0 -.6" */
function respaceNumbers(svgMarkup: string): string {
  return svgMarkup.replace(/([0-9.])([+-])(?=[0-9.])/g, '$1 $2')
}

/** B2: convert all path commands to absolute, expand shorthand via svgpath */
function normalizePathsAbsolute(svgMarkup: string): string {
  const doc = new DOMParser().parseFromString(svgMarkup, 'image/svg+xml')
  for (const path of Array.from(doc.querySelectorAll('path'))) {
    const d = path.getAttribute('d')
    if (d) {
      path.setAttribute('d', svgpath(d).abs().unshort().round(4).toString())
    }
  }
  return new XMLSerializer().serializeToString(doc.documentElement)
}

// ── Rendering ─────────────────────────────────────────────────────────────────

/** Scale from natural SVG coords (290×252) to fit a cell */
function cellScale(): number {
  return Math.min(CELL_W / NATURAL_W, CELL_H / NATURAL_H)
}

function clearCell(index: number) {
  const cell = cells[index]
  if (!cell) return
  for (const child of [...cell.children]) {
    child.destroy({ children: true })
  }
}

function renderA(markup: string) {
  clearCell(0)
  const g = new Graphics()
  try {
    g.svg(markup)
  } catch (e) {
    statusMsg.value = `Strategy A error: ${e}`
  }
  g.scale.set(cellScale())
  cells[0].addChild(g)
}

function renderB1(markup: string) {
  clearCell(1)
  const g = new Graphics()
  try {
    g.svg(respaceNumbers(markup))
  } catch (e) {
    statusMsg.value = `Strategy B1 error: ${e}`
  }
  g.scale.set(cellScale())
  cells[1].addChild(g)
}

function renderB2(markup: string) {
  clearCell(2)
  const g = new Graphics()
  try {
    g.svg(normalizePathsAbsolute(markup))
  } catch (e) {
    statusMsg.value = `Strategy B2 error: ${e}`
  }
  g.scale.set(cellScale())
  cells[2].addChild(g)
}

async function renderC(markup: string): Promise<void> {
  clearCell(3)
  return new Promise((resolve) => {
    const blob = new Blob([markup], { type: 'image/svg+xml' })
    const url  = URL.createObjectURL(blob)
    const img  = new Image(NATURAL_W * 8, NATURAL_H * 8)
    img.onload = () => {
      URL.revokeObjectURL(url)
      const source  = new ImageSource({ resource: img })
      const texture = new Texture({ source })
      const sprite  = new Sprite(texture)
      const sc = cellScale()
      sprite.width  = NATURAL_W * sc
      sprite.height = NATURAL_H * sc
      cells[3].addChild(sprite)
      resolve()
    }
    img.onerror = () => { URL.revokeObjectURL(url); resolve() }
    img.src = url
  })
}

async function renderAll(markup: string) {
  statusMsg.value = 'Rendering…'
  renderA(markup)
  renderB1(markup)
  renderB2(markup)
  await renderC(markup)
  app?.renderer.render(app.stage)
  statusMsg.value = `Rendered at zoom ${currentZoom.value}×`
}

// ── Zoom ──────────────────────────────────────────────────────────────────────

function applyZoom(factor: number) {
  if (!zoomRoot) return
  currentZoom.value = factor
  zoomRoot.scale.set(factor)
  // re-center each cell within the (now-larger) canvas space
  app?.renderer.render(app.stage)
}

// ── Pixi init ─────────────────────────────────────────────────────────────────

async function initPixi() {
  if (!canvasEl.value) return

  app = new Application()
  await app.init({
    canvas: canvasEl.value,
    width:  CANVAS_W,
    height: CANVAS_H,
    background: '#ffffff',
    antialias: true,
    resolution: window.devicePixelRatio || 1,
    autoDensity: true,
  })

  zoomRoot = new Container()
  app.stage.addChild(zoomRoot)

  const labelStyle = new TextStyle({ fontSize: 13, fill: '#333', fontFamily: 'monospace' })
  const descStyle  = new TextStyle({ fontSize: 10, fill: '#888', fontFamily: 'monospace' })

  STRATEGIES.forEach((s, i) => {
    const x = PADDING + i * (CELL_W + PADDING)
    const y = PADDING + LABEL_H

    // Label row (not inside zoomRoot — stays fixed)
    const lbl = new Text({ text: s.label, style: labelStyle })
    lbl.x = x
    lbl.y = PADDING
    app!.stage.addChild(lbl)

    const desc = new Text({ text: s.desc, style: descStyle })
    desc.x = x
    desc.y = PADDING + 18
    app!.stage.addChild(desc)

    // Cell container (inside zoomRoot — scales with zoom)
    const cell = new Container()
    cell.x = x
    cell.y = y
    zoomRoot!.addChild(cell)
    cells.push(cell)
  })

  // Expose for Playwright
  ;(window as any).__pixiApp    = app
  ;(window as any).__renderSvg  = (markup: string) => { void renderAll(markup) }
  ;(window as any).__setZoom    = (factor: number) => applyZoom(factor)
  ;(window as any).__screenshot = async (): Promise<string> => {
    app!.renderer.render(app!.stage)
    const result = app!.renderer.extract.base64(app!.stage)
    return result instanceof Promise ? await result : result
  }

  statusMsg.value = 'Ready — call window.__renderSvg(svgMarkup) or paste below'
}

onMounted(() => { void initPixi() })
onUnmounted(() => {
  delete (window as any).__pixiApp
  delete (window as any).__renderSvg
  delete (window as any).__setZoom
  delete (window as any).__screenshot
  app?.destroy(true)
  app = null
})
</script>

<template>
  <div style="display:flex; flex-direction:column; gap:12px; padding:16px; font-family:monospace;">
    <div style="display:flex; align-items:center; gap:12px; flex-wrap:wrap;">
      <strong>SVG Render Test Harness</strong>
      <span style="color:#666; font-size:12px;">{{ statusMsg }}</span>
    </div>

    <!-- Manual SVG input for interactive use -->
    <div style="display:flex; gap:8px; align-items:flex-start;">
      <textarea
        v-model="svgInput"
        placeholder="Paste SVG markup here, or use window.__renderSvg(markup) from Playwright"
        style="width:500px; height:80px; font-family:monospace; font-size:11px; resize:vertical;"
      />
      <button @click="() => svgInput && renderAll(svgInput)" style="padding:6px 12px;">
        Render
      </button>
    </div>

    <!-- Zoom controls -->
    <div style="display:flex; gap:8px; align-items:center;">
      <span style="font-size:12px;">Zoom:</span>
      <button v-for="z in [1, 2, 4, 10, 40]" :key="z"
        :style="{ padding:'4px 10px', fontWeight: currentZoom === z ? 'bold' : 'normal' }"
        @click="applyZoom(z)">
        {{ z }}×
      </button>
      <span style="font-size:11px; color:#888; margin-left:8px;">
        (scales zoomRoot container — same as pixi stage scale in flora-studio)
      </span>
    </div>

    <!-- Pixi canvas -->
    <canvas ref="canvasEl" style="border:1px solid #ddd; display:block;" />
  </div>
</template>
