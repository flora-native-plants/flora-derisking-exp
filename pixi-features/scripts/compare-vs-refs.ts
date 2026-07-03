// compare-vs-refs.ts — puts our LATEST ribbon renders next to the AI reference pencil marks
// (Gemini pressure ladder) in one labeled frame, so we can honestly judge how close the procedural
// material is to the target. Reads the PNGs, base64-embeds them into a layout page, screenshots.
// Run: npx tsx scripts/compare-vs-refs.ts   (no dev server needed)
import { chromium } from 'playwright'
import { readFileSync, mkdirSync } from 'node:fs'

const OUT = '.naturalize-out'
mkdirSync(OUT, { recursive: true })

const b64 = (p: string) => `data:image/png;base64,${readFileSync(p).toString('base64')}`
const refGrid = b64('public/textures/pencil/stroke-arcs-grid.png')
const stipple = b64(`${OUT}/ribbon-media-graphite-stipple.png`)
const graphite = b64(`${OUT}/ribbon-media-graphite.png`)
const crayon = b64(`${OUT}/ribbon-media-crayon.png`)

const html = `<!doctype html><html><head><style>
  * { margin: 0; box-sizing: border-box; }
  body { background: #d9d5cc; font-family: ui-monospace, monospace; color: #2a2a2a; padding: 28px; width: 1500px; }
  h1 { font-size: 18px; margin-bottom: 4px; }
  .sub { font-size: 12px; color: #666; margin-bottom: 20px; }
  .panel { background: #fff; border: 1px solid #bbb; border-radius: 8px; padding: 14px; margin-bottom: 20px; }
  .label { font-size: 13px; font-weight: bold; margin-bottom: 8px; }
  .note { font-size: 11px; color: #777; font-weight: normal; }
  img { width: 100%; display: block; border-radius: 4px; }
  .row { display: flex; gap: 20px; }
  .row .panel { flex: 1; margin-bottom: 0; }
</style></head><body>
  <h1>Procedural ribbon vs. AI reference marks</h1>
  <div class="sub">headless software-GL — AA is unreliable; judge tooth/tone character, not edge crispness</div>
  <div class="panel">
    <div class="label">AI REFERENCE — Gemini pressure ladder <span class="note">(the graphite target: broad soft marks, granular tooth, tone builds with pressure)</span></div>
    <img src="${refGrid}" />
  </div>
  <div class="panel">
    <div class="label">OURS — Graphite STIPPLE @ ~9px <span class="note">(dot-scatter powder on a believable kinematic path — the Ciallo-airbrush look; see the black border)</span></div>
    <img src="${stipple}" />
  </div>
  <div class="row">
    <div class="panel">
      <div class="label">OURS — Graphite COMBED @ ~6px <span class="note">(directional grain → striations, the earlier version)</span></div>
      <img src="${graphite}" />
    </div>
    <div class="panel">
      <div class="label">OURS — Crayon @ ~3px <span class="note">(waxy pepper-skip, reads thin)</span></div>
      <img src="${crayon}" />
    </div>
  </div>
</body></html>`

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1500, height: 1400 }, deviceScaleFactor: 2 })
await page.setContent(html, { waitUntil: 'networkidle' })
const h = await page.evaluate(() => document.body.scrollHeight)
await page.setViewportSize({ width: 1500, height: h })
await page.screenshot({ path: `${OUT}/compare-vs-refs.png`, fullPage: true })
await browser.close()
console.log(`wrote ${OUT}/compare-vs-refs.png`)
