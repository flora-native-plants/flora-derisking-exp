// shot-ribbon-panel.ts — full-page capture in a given medium, to verify the control panel (e.g. that
// combed-grain sliders gray out in stipple mode). Run: npx tsx scripts/shot-ribbon-panel.ts
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'

const OUT = '.naturalize-out'
mkdirSync(OUT, { recursive: true })

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1400, height: 820 }, deviceScaleFactor: 2 })
await page.goto('http://localhost:5202/', { waitUntil: 'networkidle' })
await page.getByText('Pencil Ribbon (mesh)').first().click()
await page.waitForTimeout(800)
await page.getByRole('button', { name: 'Graphite (stipple)', exact: true }).click()
await page.waitForTimeout(600)
// clip just the control panel (right side)
await page.screenshot({ path: `${OUT}/ribbon-panel-stipple.png`, clip: { x: 1150, y: 8, width: 250, height: 560 } })
await browser.close()
console.log(`wrote ${OUT}/ribbon-panel-stipple.png`)
