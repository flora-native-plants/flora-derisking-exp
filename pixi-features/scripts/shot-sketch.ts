// Screenshot the Sketch Style tab. Run: npx tsx scripts/shot-sketch.ts (dev server on :5202)
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'

const OUT = '.sketch-shot'
mkdirSync(OUT, { recursive: true })

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1200, height: 800 } })
await page.goto('http://localhost:5202/', { waitUntil: 'networkidle' })
await page.getByText('Sketch Style (rough.js)').first().click()
await page.waitForTimeout(1200)

// Flat (surface off) — current baseline (default RPN seamless paper).
await page.screenshot({ path: `${OUT}/flat.png` })

// Switch to the smooth height field, crank grain scale (few big tiles so the broad undulation
// reads as relief, not minified grit), then turn on Surface lighting (normal map + directional).
await page.locator('select').selectOption({ label: 'Height smooth (for normals)' })
await page.waitForTimeout(300)
await page.evaluate(() => {
  const labels = Array.from(document.querySelectorAll('label'))
  const gs = labels.find(l => l.textContent?.includes('Grain scale'))?.querySelector('input[type=range]') as HTMLInputElement
  if (gs) { gs.value = '400'; gs.dispatchEvent(new Event('input', { bubbles: true })) }
})
await page.waitForTimeout(300)
await page.getByText('Surface lighting').click()
await page.waitForTimeout(500)
await page.screenshot({ path: `${OUT}/surface.png` })

// Visualize the derived normal map.
await page.getByText('Show raw grain / normals').click()
await page.waitForTimeout(400)
await page.screenshot({ path: `${OUT}/normals.png` })
await page.getByText('Show raw grain / normals').click()
await page.waitForTimeout(200)

// Zoom in with surface lighting on.
const canvas = page.locator('canvas').first()
const box = await canvas.boundingBox()
if (box) {
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  for (let i = 0; i < 9; i++) { await page.mouse.wheel(0, -120); await page.waitForTimeout(70) }
}
await page.waitForTimeout(400)
await page.screenshot({ path: `${OUT}/surface-zoomed.png` })

await browser.close()
console.log('wrote flat.png, surface.png, normals.png, surface-zoomed.png')
