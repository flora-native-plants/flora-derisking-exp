/**
 * Heitz–Neyret wash-material capture — Playwright headless.
 *
 * Navigates to the "Wash Material (H–N)" tab, screenshots the full 5-panel
 * comparison strip, then calls window.__hnTune({ scale: 0.5 }) for a moderate
 * zoom pass and screenshots again. Outputs:
 *   .watercolor/hn-material.png      — full strip at default scale (1×)
 *   .watercolor/hn-material-mid.png  — full strip after scale=0.5 (moderate zoom)
 *
 * Usage:
 *   npx tsx scripts/hn-render.ts
 *
 * Prerequisites: pixi-features Vite server running on port 5202 (`npm run dev`).
 */

import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

const PORT       = 5202
const OUTPUT_DIR = resolve(import.meta.dirname, '..', '.watercolor')

async function assertServerRunning(): Promise<void> {
  try {
    const res = await fetch(`http://localhost:${PORT}`)
    if (!res.ok) throw new Error(`Status ${res.status}`)
  } catch {
    console.error(`\n✗ Dev server not on port ${PORT}. Run: cd pixi-features && npm run dev\n`)
    process.exit(1)
  }
}

async function run(): Promise<void> {
  await assertServerRunning()
  mkdirSync(OUTPUT_DIR, { recursive: true })

  const browser = await chromium.launch({ headless: true })

  // Pre-select the H–N tab via localStorage so it's the active tab on load.
  const context = await browser.newContext({ viewport: { width: 1800, height: 500 } })
  await context.addInitScript(() => {
    localStorage.setItem('pixi-features-active-v2', 'hnmaterial')
  })

  const page = await context.newPage()
  const consoleErrors: string[] = []
  page.on('console', m => {
    if (m.type() === 'error') {
      console.error(`[browser] ${m.text()}`)
      consoleErrors.push(m.text())
    }
  })

  console.log('Navigating to H–N tab…')
  await page.goto(`http://localhost:${PORT}`, { waitUntil: 'networkidle' })

  // Wait for the tab's tuning hook — installed after LUT precompute finishes.
  console.log('Waiting for __hnTune (LUT precompute may take a moment)…')
  await page.waitForFunction(
    () => typeof (window as unknown as { __hnTune?: unknown }).__hnTune === 'function',
    { timeout: 30000 },
  )

  // Give Pixi one render tick to flush the scene to the canvas.
  await page.waitForTimeout(500)

  // Screenshot the canvas element — the fixed-size comparison strip.
  const canvas = page.locator('canvas').first()

  const stripPath = join(OUTPUT_DIR, 'hn-material.png')
  await canvas.screenshot({ path: stripPath })
  console.log(`✓ ${stripPath}`)

  // Apply moderate zoom (scale=0.5) to the primary H–N panel and re-capture.
  // scale=0.5 is realistic use-range: half the wash tile per panel width.
  await page.evaluate(() => {
    ;(window as unknown as { __hnTune: (p: { scale?: number; seed?: number }) => void })
      .__hnTune({ scale: 0.5 })
  })
  await page.waitForTimeout(300)

  const midPath = join(OUTPUT_DIR, 'hn-material-mid.png')
  await canvas.screenshot({ path: midPath })
  console.log(`✓ ${midPath}`)

  await browser.close()

  if (consoleErrors.length) {
    console.warn(`\n⚠ ${consoleErrors.length} browser error(s) — see above`)
  }
  console.log('\nDone. Build montage next:')
  console.log('  npx tsx scripts/hn-render.ts --montage  (or run the montage step manually)')
}

run().catch(err => { console.error(err); process.exit(1) })
