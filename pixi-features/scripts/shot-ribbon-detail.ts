// shot-ribbon-detail.ts — tight, high-DPI screenshot of a DENSE stroke crossing on the Pencil
// Ribbon tab, for the shader-tweak loop. Two tricks make the grain/tooth actually visible:
//   1. FAT strokes (a 2px line shows no interior; ~12px reveals tooth/tone/edge) — diagnostic,
//      not the final look.
//   2. Zoom into a crossing of several strokes, then clip to that region at deviceScaleFactor 2.
// Run: npx tsx scripts/shot-ribbon-detail.ts            (dev server on :5202)
//      npx tsx scripts/shot-ribbon-detail.ts mytag      (-> ribbon-detail-mytag.png)
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'

const OUT = '.naturalize-out'
const TAG = process.argv[2] ? `-${process.argv[2]}` : ''
const STROKE_WIDTH = 12   // fat, so the interior grain is visible
const ZOOM_STEPS = 11     // ~3.5x, centered on the dense crossing
mkdirSync(OUT, { recursive: true })

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1400, height: 820 }, deviceScaleFactor: 2 })
const errs: string[] = []
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()) })
page.on('pageerror', (e) => errs.push(String(e)))
await page.goto('http://localhost:5202/', { waitUntil: 'networkidle' })
await page.getByText('Pencil Ribbon (mesh)').first().click()
await page.waitForTimeout(1000)

// Fatten the strokes via the Stroke-width slider so grain reads.
await page.evaluate((w) => {
  const lab = Array.from(document.querySelectorAll('label')).find((l) => l.textContent?.includes('Stroke width'))
  const inp = lab?.querySelector('input[type=range]') as HTMLInputElement | undefined
  if (inp) { inp.value = String(w); inp.dispatchEvent(new Event('input', { bubbles: true })) }
}, STROKE_WIDTH)
await page.waitForTimeout(400)

// Zoom into a dense crossing (lower-centre-left: boundary bottom × bed × zigzag all meet there).
const canvas = page.locator('canvas').first()
const box = (await canvas.boundingBox())!
const fx = box.x + box.width * 0.42
const fy = box.y + box.height * 0.60
await page.mouse.move(fx, fy)
for (let i = 0; i < ZOOM_STEPS; i++) { await page.mouse.wheel(0, -120); await page.waitForTimeout(60) }
await page.waitForTimeout(500)

// Clip a tight square around the focus point, staying clear of the right-hand control panel.
const half = 320 // CSS px -> 640 device px per side at DSR 2
const clip = {
  x: Math.max(box.x, fx - half),
  y: Math.max(box.y, fy - half),
  width: half * 2,
  height: half * 2,
}
await page.screenshot({ path: `${OUT}/ribbon-detail${TAG}.png`, clip })
await browser.close()
console.log(`wrote ${OUT}/ribbon-detail${TAG}.png @ ${STROKE_WIDTH}px stroke, ~3.5x zoom` + (errs.length ? `\nCONSOLE ERRORS:\n${errs.slice(0, 6).join('\n')}` : ''))
