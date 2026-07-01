// A/B screenshot the kinematic vs rough.js generator in the Sketch Style tab.
// Run: npx tsx scripts/shot-kinematic.ts   (dev server on :5202)
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'

const OUT = '.kinematic-shot'
mkdirSync(OUT, { recursive: true })

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1200, height: 820 } })
await page.goto('http://localhost:5202/', { waitUntil: 'networkidle' })
await page.getByText('Sketch Style (rough.js)').first().click()
await page.waitForTimeout(1000)

// Helper: set the generator <select> (the one that has a 'kinematic' option).
async function setGenerator(value: 'rough' | 'kinematic') {
  await page.evaluate((v) => {
    const sel = Array.from(document.querySelectorAll('select'))
      .find((s) => Array.from((s as HTMLSelectElement).options).some((o) => o.value === 'kinematic')) as HTMLSelectElement | undefined
    if (sel) { sel.value = v; sel.dispatchEvent(new Event('change', { bubbles: true })) }
  }, value)
  await page.waitForTimeout(500)
}
// Helper: set a labelled range slider by its label text.
async function setRange(labelText: string, val: number) {
  await page.evaluate(({ labelText, val }) => {
    const lab = Array.from(document.querySelectorAll('label')).find((l) => l.textContent?.includes(labelText))
    const inp = lab?.querySelector('input[type=range]') as HTMLInputElement | undefined
    if (inp) { inp.value = String(val); inp.dispatchEvent(new Event('input', { bubbles: true })) }
  }, { labelText, val })
  await page.waitForTimeout(300)
}
// Helper: toggle a labelled checkbox to a desired checked state.
async function setCheck(labelText: string, checked: boolean) {
  await page.evaluate(({ labelText, checked }) => {
    const lab = Array.from(document.querySelectorAll('label')).find((l) => l.textContent?.includes(labelText))
    const cb = lab?.querySelector('input[type=checkbox]') as HTMLInputElement | undefined
    if (cb && cb.checked !== checked) cb.click()
  }, { labelText, checked })
  await page.waitForTimeout(300)
}

// Grain OFF so we judge pure line quality; keep the faint exact-geometry overlay ON for reference.
await setCheck('Paper grain', false)
await setCheck('Show exact geometry', true)
await setRange('Stroke width', 2.5)

// 1) rough.js baseline (grain off)
await setGenerator('rough')
await page.screenshot({ path: `${OUT}/1-rough-clean.png` })

// 2) kinematic, default squiggle 6
await setGenerator('kinematic')
await page.screenshot({ path: `${OUT}/2-kinematic-default.png` })

// 3) kinematic, higher squiggle (looser hand)
await setRange('Squiggle', 14)
await page.screenshot({ path: `${OUT}/3-kinematic-squiggle14.png` })

// 4) kinematic, tighter — low squiggle, finer control points (architectural hand)
await setRange('Squiggle', 4)
await setRange('CP spacing', 22)
await page.screenshot({ path: `${OUT}/4-kinematic-tight.png` })

// 5) zoom in to inspect corners + the closed-bed seam up close (kinematic, default-ish)
await setRange('Squiggle', 8)
await setRange('CP spacing', 40)
const canvas = page.locator('canvas').first()
const box = await canvas.boundingBox()
if (box) {
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  for (let i = 0; i < 8; i++) { await page.mouse.wheel(0, -120); await page.waitForTimeout(70) }
}
await page.waitForTimeout(400)
await page.screenshot({ path: `${OUT}/5-kinematic-zoom.png` })

// 6) full pencil look: grain back ON with graphite-in-stroke, kinematic
await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2)
for (let i = 0; i < 8; i++) { await page.mouse.wheel(0, 120); await page.waitForTimeout(60) } // zoom back out
await setCheck('Paper grain', true)
await page.waitForTimeout(500)
await page.screenshot({ path: `${OUT}/6-kinematic-grain.png` })

await browser.close()
console.log('wrote 1-rough-clean, 2-kinematic-default, 3-kinematic-squiggle14, 4-kinematic-tight, 5-kinematic-zoom, 6-kinematic-grain')
