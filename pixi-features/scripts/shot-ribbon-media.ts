// shot-ribbon-media.ts — captures each selectable MEDIUM at its native width, so we can judge
// "graphite vs crayon" as two distinct drawn media in the zoom-stable ribbon (not two failed
// attempts at the same look). Graphite renders wide (~6px, where soft tooth reads); crayon renders
// thin (~3px, where the waxy speckle IS the look). Same clip region as shot-ribbon-thin.
// Run: npx tsx scripts/shot-ribbon-media.ts            (dev server on :5202)
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'

const OUT = '.naturalize-out'
mkdirSync(OUT, { recursive: true })

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1400, height: 820 }, deviceScaleFactor: 2 })
const errs: string[] = []
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()) })
page.on('pageerror', (e) => errs.push(String(e)))
await page.goto('http://localhost:5202/', { waitUntil: 'networkidle' })
await page.getByText('Pencil Ribbon (mesh)').first().click()
await page.waitForTimeout(1000)

const canvas = page.locator('canvas').first()
const box = (await canvas.boundingBox())!
const clip = {
  x: box.x + box.width * 0.33,
  y: box.y + box.height * 0.32,
  width: box.width * 0.45,
  height: box.height * 0.42,
}

const media: [string, string][] = [
  ['Graphite (combed)', 'graphite'],
  ['Graphite (stipple)', 'graphite-stipple'],
  ['Crayon / colored pencil', 'crayon'],
]
for (const [label, tag] of media) {
  await page.getByRole('button', { name: label, exact: true }).click()
  await page.waitForTimeout(600)
  await page.screenshot({ path: `${OUT}/ribbon-media-${tag}.png`, clip })
  console.log(`wrote ${OUT}/ribbon-media-${tag}.png`)
}

await browser.close()
if (errs.length) console.log(`CONSOLE ERRORS:\n${errs.slice(0, 6).join('\n')}`)
