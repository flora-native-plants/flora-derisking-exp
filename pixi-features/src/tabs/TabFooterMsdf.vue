<script setup lang="ts">
/**
 * Footer MSDF derisking experiment.
 *
 * Proves that Pixi BitmapText (MSDF atlases) can render the site-plan title
 * block crisply at any zoom level. Loads the real footer-classic.svg / footer-
 * engineer.svg produced by the Rust pipeline, extracts g#title-block via DOM
 * walk, and renders rects + lines + text in world coordinates via pixi-viewport.
 *
 * Key unknowns being resolved here:
 *  1. Baseline alignment  – SVG y is baseline; BitmapText y is top of glyph box
 *  2. World-coordinate font sizing – worldScale × SVG font-size → legible?
 *  3. CSS class-based text styles – Rust SVG uses .footer-title etc, not attrs
 *
 * Plan: derisking-experiments/pixi-features/docs/plan-footer-msdf.md
 */
import { onMounted, onUnmounted, ref, watch } from 'vue'
import { Application, Assets, BitmapFont, BitmapText, Container, Graphics } from 'pixi.js'
import { Viewport } from 'pixi-viewport'

// ─── World setup ────────────────────────────────────────────────────────────
// The footer SVGs are 792×612 (US Letter). worldScale maps SVG px → world units.
const SVG_W = 792
const SVG_H = 612
const WORLD_SCALE = 100 / SVG_W  // ≈ 0.1263
const WORLD_W = 100
const WORLD_H = SVG_H * WORLD_SCALE  // ≈ 77.3

// ─── Types ──────────────────────────────────────────────────────────────────
interface FText {
  x: number; y: number
  content: string
  fontSize: number
  fill: string
  fontFamily: string
  bold: boolean
  textAnchor: 'start' | 'middle' | 'end'
}
interface FRect { x: number; y: number; w: number; h: number; stroke: string; strokeWidth: number; fill: string }
interface FLine { x1: number; y1: number; x2: number; y2: number; stroke: string; strokeWidth: number }
interface FooterData { texts: FText[]; rects: FRect[]; lines: FLine[] }

// ─── Refs ────────────────────────────────────────────────────────────────────
const canvasEl = ref<HTMLCanvasElement>()
const containerEl = ref<HTMLDivElement>()
const statusMsg = ref('Loading fonts…')
const zoomLevel = ref(1)
const baselineFactor = ref(1.0)   // tune: bt.y = svgY - bt.height * factor
const fontScale = ref(1.0)        // tune: multiplier on top of worldScale sizing
const showBaselines = ref(false)  // red guide lines at SVG text y values
const footerVariant = ref<'classic' | 'engineer'>('classic')
const elementCounts = ref({ texts: 0, rects: 0, lines: 0 })
const fontsLoaded = ref(false)

// ─── App state ───────────────────────────────────────────────────────────────
let app: Application | null = null
let viewport: Viewport | null = null
let footerContainer: Container | null = null
let guideContainer: Container | null = null

// ─── CSS class parser ────────────────────────────────────────────────────────
// The Rust SVG uses CSS classes (.footer-title, .footer-text, etc.) for font
// properties — not inline attributes. Parse the <style> block so we can
// cascade correctly: class → presentation attr → style attr.
function parseCssClasses(svgText: string): Map<string, Record<string, string>> {
  const map = new Map<string, Record<string, string>>()
  const styleMatch = /<style[^>]*>([\s\S]*?)<\/style>/i.exec(svgText)
  if (!styleMatch) return map
  const css = styleMatch[1]
  const ruleRx = /\.([a-zA-Z0-9_-]+)\s*\{([^}]+)\}/g
  let m: RegExpExecArray | null
  while ((m = ruleRx.exec(css)) !== null) {
    const cls = m[1]
    const props: Record<string, string> = {}
    for (const decl of m[2].split(';')) {
      const parts = decl.split(':')
      if (parts.length >= 2) {
        const k = parts[0].trim()
        const v = parts.slice(1).join(':').trim()
        if (k && v) props[k] = v
      }
    }
    map.set(cls, props)
  }
  return map
}

// ─── Extraction ───────────────────────────────────────────────────────────────
function extract(root: Element, cssClasses: Map<string, Record<string, string>>, ws: number): FooterData {
  const data: FooterData = { texts: [], rects: [], lines: [] }
  const num = (el: Element, attr: string, fb = 0) => parseFloat(el.getAttribute(attr) ?? String(fb))
  const col = (el: Element, attr: string, fb: string) => el.getAttribute(attr) ?? fb

  // Resolve text styling from CSS class + presentation attr + style attr cascade
  function resolveText(el: Element): Omit<FText, 'x' | 'y' | 'content'> {
    let fontSize = 8
    let fontFamily = 'brandon-grotesque'
    let fill = '#333'
    let bold = false
    let textAnchor: FText['textAnchor'] = 'start'

    // 1. Apply CSS class properties (lowest priority)
    const cls = el.getAttribute('class') ?? ''
    for (const c of cls.split(/\s+/).filter(Boolean)) {
      const cp = cssClasses.get(c)
      if (!cp) continue
      if (cp['font-size']) fontSize = parseFloat(cp['font-size'])
      if (cp['font-family']) fontFamily = cp['font-family']
      if (cp['fill']) fill = cp['fill']
      if (cp['font-weight']) bold = cp['font-weight'] === 'bold' || cp['font-weight'] === '700'
      if (cp['text-anchor']) textAnchor = cp['text-anchor'] as FText['textAnchor']
    }

    // 2. Presentation attributes override class
    const fillAttr = el.getAttribute('fill')
    if (fillAttr) fill = fillAttr
    const taAttr = el.getAttribute('text-anchor')
    if (taAttr) textAnchor = taAttr as FText['textAnchor']

    // 3. style attr overrides everything
    const styleAttr = el.getAttribute('style') ?? ''
    if (styleAttr) {
      for (const decl of styleAttr.split(';')) {
        const parts = decl.split(':')
        if (parts.length < 2) continue
        const k = parts[0].trim()
        const v = parts.slice(1).join(':').trim()
        if (k === 'font-size') fontSize = parseFloat(v)
        if (k === 'font-weight') bold = v === 'bold' || v === '700'
        if (k === 'fill') fill = v
        if (k === 'font-family') fontFamily = v
        if (k === 'text-anchor') textAnchor = v as FText['textAnchor']
      }
    }

    // 4. Inline font attributes (legacy fallback)
    const fsa = el.getAttribute('font-size')
    if (fsa && !styleAttr.includes('font-size')) fontSize = parseFloat(fsa)
    const ffa = el.getAttribute('font-family')
    if (ffa && !styleAttr.includes('font-family')) fontFamily = ffa

    return { fontSize: fontSize * ws, fill, fontFamily, bold, textAnchor }
  }

  function walk(el: Element, tx = 0, ty = 0, sx = 1, sy = 1) {
    for (const child of Array.from(el.children)) {
      const tag = child.tagName.toLowerCase()
      if (tag === 'defs' || tag === 'style') continue

      if (tag === 'g') {
        let nx = tx, ny = ty, nsx = sx, nsy = sy
        const tfm = child.getAttribute('transform') ?? ''
        const t = /translate\(\s*([\d.eE+-]+)\s*,\s*([\d.eE+-]+)\s*\)/.exec(tfm)
        const s = /scale\(\s*([\d.eE+-]+)(?:\s*,\s*([\d.eE+-]+))?\s*\)/.exec(tfm)
        if (t) { nx = tx + parseFloat(t[1]) * sx; ny = ty + parseFloat(t[2]) * sy }
        if (s) { nsx = sx * parseFloat(s[1]); nsy = sy * (s[2] ? parseFloat(s[2]) : parseFloat(s[1])) }
        walk(child, nx, ny, nsx, nsy)
        continue
      }

      if (tag === 'text') {
        const raw = child.textContent?.trim() ?? ''
        if (!raw) continue
        data.texts.push({
          x: (num(child, 'x') * sx + tx) * ws,
          y: (num(child, 'y') * sy + ty) * ws,
          content: raw,
          ...resolveText(child),
        })
        continue
      }

      if (tag === 'rect') {
        const fillAttr = child.getAttribute('fill') ?? 'none'
        const strokeAttr = child.getAttribute('stroke') ?? 'none'
        data.rects.push({
          x: (num(child, 'x') * sx + tx) * ws,
          y: (num(child, 'y') * sy + ty) * ws,
          w: num(child, 'width') * sx * ws,
          h: num(child, 'height') * sy * ws,
          stroke: strokeAttr,
          strokeWidth: num(child, 'stroke-width', 0.5) * ws,
          fill: fillAttr,
        })
        continue
      }

      if (tag === 'line') {
        data.lines.push({
          x1: (num(child, 'x1') * sx + tx) * ws,
          y1: (num(child, 'y1') * sy + ty) * ws,
          x2: (num(child, 'x2') * sx + tx) * ws,
          y2: (num(child, 'y2') * sy + ty) * ws,
          stroke: child.getAttribute('stroke') ?? '#000',
          strokeWidth: num(child, 'stroke-width', 0.5) * ws,
        })
        continue
      }

      // path, image, etc. — skip for this experiment
    }
  }

  walk(root)
  return data
}

// ─── Font family resolution ───────────────────────────────────────────────────
// Map SVG font-family strings to the MSDF atlas face names we have loaded.
function resolveFontFamily(fontFamily: string, bold: boolean): string {
  const f = fontFamily.toLowerCase()
  if (f.includes('balmat')) return 'BALMAT'
  if (f.includes('courier')) return bold ? 'Courier New Bold' : 'Courier New'
  // brandon-grotesque and other sans → use Courier New as stand-in for this experiment
  return bold ? 'Courier New Bold' : 'Courier New'
}

// ─── Rendering ────────────────────────────────────────────────────────────────
function render(data: FooterData, container: Container, bf: number, fs: number) {
  container.removeChildren()

  const gfx = new Graphics()
  container.addChild(gfx)

  // Rects
  for (const r of data.rects) {
    if (r.fill !== 'none') {
      gfx.rect(r.x, r.y, r.w, r.h).fill({ color: r.fill })
    }
    if (r.stroke !== 'none' && r.strokeWidth > 0) {
      gfx.rect(r.x, r.y, r.w, r.h).stroke({ color: r.stroke, width: r.strokeWidth })
    }
  }

  // Lines
  for (const ln of data.lines) {
    gfx.moveTo(ln.x1, ln.y1).lineTo(ln.x2, ln.y2).stroke({ color: ln.stroke, width: ln.strokeWidth })
  }

  // Text
  for (const t of data.texts) {
    const face = resolveFontFamily(t.fontFamily, t.bold)
    const bt = new BitmapText({
      text: t.content,
      style: { fontFamily: face, fontSize: t.fontSize * fs },
    })

    // Tint: BitmapText uses vertex colour, not CSS fill
    if (t.fill.startsWith('#')) {
      bt.tint = parseInt(t.fill.replace('#', ''), 16)
    }

    // Horizontal alignment (text-anchor)
    bt.x = t.textAnchor === 'middle' ? t.x - bt.width / 2
          : t.textAnchor === 'end'   ? t.x - bt.width
          : t.x

    // SVG y = baseline; BitmapText y = top of glyph box
    bt.y = t.y - bt.height * bf

    container.addChild(bt)
  }
}

function renderGuides(data: FooterData, container: Container) {
  container.removeChildren()
  if (!showBaselines.value) return
  const gfx = new Graphics()
  container.addChild(gfx)
  for (const t of data.texts) {
    gfx.moveTo(0, t.y).lineTo(WORLD_W, t.y).stroke({ color: 0xff0000, width: 0.02 })
  }
}

// ─── Lifecycle ────────────────────────────────────────────────────────────────
let currentData: FooterData | null = null

async function loadAndRender() {
  if (!fontsLoaded.value) return
  const url = footerVariant.value === 'classic'
    ? '/fixtures/footer-classic.svg'
    : '/fixtures/footer-engineer.svg'

  statusMsg.value = `Fetching ${footerVariant.value}…`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`fetch ${url}: ${res.status}`)
  const svgText = await res.text()

  const doc = new DOMParser().parseFromString(svgText, 'image/svg+xml')
  const titleBlock = doc.getElementById('title-block')
  if (!titleBlock) {
    statusMsg.value = 'ERROR: g#title-block not found in SVG'
    return
  }

  // Read actual SVG dimensions from root
  const svgRoot = doc.documentElement
  const svgW = parseFloat(svgRoot.getAttribute('width') ?? String(SVG_W))
  const ws = 100 / svgW

  const cssClasses = parseCssClasses(svgText)
  const data = extract(titleBlock, cssClasses, ws)
  currentData = data

  elementCounts.value = { texts: data.texts.length, rects: data.rects.length, lines: data.lines.length }
  statusMsg.value = `${data.rects.length} rects · ${data.lines.length} lines · ${data.texts.length} texts`

  if (footerContainer) render(data, footerContainer, baselineFactor.value, fontScale.value)
  if (guideContainer) renderGuides(data, guideContainer)
}

onMounted(async () => {
  app = new Application()
  await app.init({
    canvas: canvasEl.value!,
    width: containerEl.value!.clientWidth,
    height: containerEl.value!.clientHeight,
    antialias: true,
    background: '#f5f5f0',
    resolution: devicePixelRatio,
    autoDensity: true,
  })

  const W = containerEl.value!.clientWidth
  const H = containerEl.value!.clientHeight

  viewport = new Viewport({
    screenWidth: W,
    screenHeight: H,
    worldWidth: WORLD_W,
    worldHeight: WORLD_H,
    events: app.renderer.events,
  })
  viewport
    .drag()
    .wheel({ smooth: 8 })
    .decelerate({ friction: 0.93 })
    .clampZoom({ minScale: 0.5, maxScale: 40 })
    .pinch()
  viewport.on('zoomed', () => { zoomLevel.value = viewport!.scale.x })
  app.stage.addChild(viewport)

  // Fit footer in view initially
  viewport.fit(true, WORLD_W, WORLD_H)
  viewport.moveCenter(WORLD_W / 2, WORLD_H / 2)

  footerContainer = new Container()
  guideContainer = new Container()
  viewport.addChild(footerContainer)
  viewport.addChild(guideContainer)

  // Load all three MSDF atlases
  statusMsg.value = 'Loading MSDF fonts…'
  try {
    await Promise.all([
      Assets.load('/fonts/balmat.fnt'),
      Assets.load('/fonts/courier-new.fnt'),
      Assets.load('/fonts/courier-new-bold.fnt'),
    ])
    fontsLoaded.value = true
    // Log available face names so we can confirm registration
    console.log('[FooterMsdf] BitmapFont.available:', Object.keys((BitmapFont as any).available ?? {}))
  } catch (e) {
    statusMsg.value = `Font load error: ${e}`
    return
  }

  await loadAndRender()
})

onUnmounted(async () => {
  await Assets.unload(['/fonts/balmat.fnt', '/fonts/courier-new.fnt', '/fonts/courier-new-bold.fnt'])
  app?.destroy(true)
  app = null
  viewport = null
  footerContainer = null
  guideContainer = null
})

// Re-render when tuning controls change
watch([baselineFactor, fontScale], () => {
  if (currentData && footerContainer) {
    render(currentData, footerContainer, baselineFactor.value, fontScale.value)
  }
})
watch(showBaselines, () => {
  if (currentData && guideContainer) renderGuides(currentData, guideContainer)
})
watch(footerVariant, () => { loadAndRender() })
</script>

<template>
  <div ref="containerEl" class="wrap">
    <canvas ref="canvasEl" class="canvas" />

    <div class="hud">
      <div class="title">Footer MSDF Derisking</div>
      <div class="status">{{ statusMsg }}</div>
      <div class="stat">zoom: {{ zoomLevel.toFixed(3) }}×</div>

      <div class="section">
        <label class="toggle">
          <input type="radio" v-model="footerVariant" value="classic" /> Classic
        </label>
        <label class="toggle">
          <input type="radio" v-model="footerVariant" value="engineer" /> Engineer
        </label>
      </div>

      <div class="section">
        <label class="toggle">
          <input type="checkbox" v-model="showBaselines" /> Baseline guides
        </label>
      </div>

      <div class="section">
        <div class="slider-row">
          <span>Baseline factor</span>
          <input type="range" min="0.5" max="1.5" step="0.01" v-model.number="baselineFactor" />
          <span class="val">{{ baselineFactor.toFixed(2) }}</span>
        </div>
        <div class="slider-row">
          <span>Font scale</span>
          <input type="range" min="0.5" max="3.0" step="0.05" v-model.number="fontScale" />
          <span class="val">{{ fontScale.toFixed(2) }}</span>
        </div>
      </div>

      <div class="counts">
        {{ elementCounts.rects }}r · {{ elementCounts.lines }}l · {{ elementCounts.texts }}t
      </div>

      <div class="instructions">
        Zoom to 8× to verify crispness.<br>
        Adjust baseline factor until text<br>
        sits on cell borders (guides = red).<br>
        Record final values in plan doc.
      </div>
    </div>
  </div>
</template>

<style scoped>
.wrap { position: relative; width: 100%; height: 100%; }
.canvas { width: 100%; height: 100%; display: block; }
.hud {
  position: absolute; top: 10px; left: 10px;
  font-family: monospace; font-size: 11px; color: #0f0;
  background: rgba(0,0,0,0.85); padding: 10px 14px; border-radius: 4px;
  pointer-events: auto; line-height: 1.8; width: 220px;
}
.title { font-size: 13px; font-weight: bold; margin-bottom: 2px; }
.status { color: #aaa; font-size: 10px; line-height: 1.4; margin-bottom: 4px; word-break: break-all; }
.stat { color: #0f0; }
.section { margin-top: 6px; border-top: 1px solid #333; padding-top: 6px; }
.toggle { display: block; cursor: pointer; }
.toggle input { margin-right: 4px; }
.slider-row { display: flex; align-items: center; gap: 4px; margin-top: 2px; font-size: 10px; color: #aaa; }
.slider-row input[type=range] { flex: 1; height: 12px; }
.val { color: #ff0; width: 32px; text-align: right; }
.counts { margin-top: 6px; color: #888; font-size: 10px; }
.instructions { margin-top: 6px; color: #666; font-size: 10px; line-height: 1.5; }
</style>
