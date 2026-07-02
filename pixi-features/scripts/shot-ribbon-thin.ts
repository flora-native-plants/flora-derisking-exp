// shot-ribbon-thin.ts — the REAL-USE condition for the Pencil Ribbon tab: default stroke width
// (2.5px) at 1x zoom. This is how strokes actually render in the tool, and it's the honest
// acceptance view (the fat 12px detail shot is a diagnostic, per shot-ribbon-detail.ts). Clips a
// region of the canvas over the dense crossings, staying clear of the right-hand control panel.
// Run: npx tsx scripts/shot-ribbon-thin.ts            (dev server on :5202)
//      npx tsx scripts/shot-ribbon-thin.ts mytag      (-> ribbon-thin-mytag.png)
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'

const OUT = '.naturalize-out'
const TAG = process.argv[2] ? `-${process.argv[2]}` : ''
mkdirSync(OUT, { recursive: true })

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1400, height: 820 }, deviceScaleFactor: 2 })
const errs: string[] = []
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()) })
page.on('pageerror', (e) => errs.push(String(e)))
await page.goto('http://localhost:5202/', { waitUntil: 'networkidle' })
await page.getByText('Pencil Ribbon (mesh)').first().click()
await page.waitForTimeout(1000)

// No fatten, no zoom — default 2.5px at 1x. Clip over the crossings, left of the panel (panel x>1160).
const canvas = page.locator('canvas').first()
const box = (await canvas.boundingBox())!
const clip = {
  x: box.x + box.width * 0.33,
  y: box.y + box.height * 0.32,
  width: box.width * 0.45,
  height: box.height * 0.42,
}
await page.screenshot({ path: `${OUT}/ribbon-thin${TAG}.png`, clip })
await browser.close()
console.log(`wrote ${OUT}/ribbon-thin${TAG}.png @ 2.5px stroke, 1x zoom (real-use condition)` + (errs.length ? `\nCONSOLE ERRORS:\n${errs.slice(0, 6).join('\n')}` : ''))
