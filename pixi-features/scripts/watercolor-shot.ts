/**
 * Watercolor screenshot harness — Playwright headless
 *
 * Opens http://localhost:5202, clicks the "Botanical Variants" tab, optionally
 * selects `mode = procedural` (gracefully skips if the option isn't wired yet),
 * waits for the canvas to settle, and saves a PNG to `.watercolor/<label>.png`.
 *
 * Usage:
 *   npx tsx scripts/watercolor-shot.ts                  # label defaults to "shot"
 *   npx tsx scripts/watercolor-shot.ts --label bands
 *
 * Prerequisites:
 *   npm run dev   # pixi-features Vite server must be running on port 5202
 */

import { chromium } from 'playwright'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const PORT       = 5202
const OUTPUT_DIR = resolve(import.meta.dirname, '..', '.watercolor')

async function assertServerRunning(): Promise<void> {
  try {
    const res = await fetch(`http://localhost:${PORT}`)
    if (!res.ok) throw new Error(`Status ${res.status}`)
  } catch {
    console.error(
      `\n✗ Dev server not responding on port ${PORT}.\n` +
      `  Run: cd pixi-features && npm run dev\n`
    )
    process.exit(1)
  }
}

function parseLabel(): string {
  const idx = process.argv.indexOf('--label')
  return idx !== -1 && process.argv[idx + 1] ? process.argv[idx + 1] : 'shot'
}

async function run(): Promise<void> {
  const label = parseLabel()
  const outPath = join(OUTPUT_DIR, `${label}.png`)

  console.log(`Label    : ${label}`)
  console.log(`Output   : ${outPath}`)

  await assertServerRunning()
  mkdirSync(OUTPUT_DIR, { recursive: true })

  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({
    viewport: { width: 1600, height: 900 },
  })

  // Pre-select the botanical-variants tab before page load via localStorage
  await context.addInitScript(() => {
    localStorage.setItem('pixi-features-active-v2', 'botanical-variants')
  })

  const page = await context.newPage()

  const consoleErrors: string[] = []
  page.on('console', msg => {
    if (msg.type() === 'error') {
      console.error(`[browser] ${msg.text()}`)
      consoleErrors.push(msg.text())
    }
  })

  console.log('Navigating to pixi-features…')
  await page.goto(`http://localhost:${PORT}`, { waitUntil: 'networkidle' })

  // Allow a moment for Pixi to initialise the tab
  await page.waitForTimeout(2000)

  // Attempt to select mode=procedural (Task 7 wires this; gracefully skip if absent)
  try {
    const modeSelect = page.locator('select').filter({ hasText: /procedural|texture|sim/ }).first()
    const options = await modeSelect.locator('option').allTextContents()
    if (options.some(t => /procedural/i.test(t))) {
      await modeSelect.selectOption({ label: /procedural/i })
      console.log('Selected mode: procedural')
      await page.waitForTimeout(1500)
    } else {
      console.log('mode=procedural not available yet — capturing current state')
    }
  } catch {
    console.log('Could not find mode selector — capturing current state')
  }

  // Let the render settle
  await page.waitForTimeout(500)

  // Force a Pixi render tick (same pattern as svg-render-test.ts)
  await page.evaluate(() => {
    const app = (window as any).__pixiApp
    if (app) app.renderer.render(app.stage)
  })

  // CDP screenshot to read the compositor output (no preserveDrawingBuffer needed)
  const cdp = await context.newCDPSession(page)
  const { data } = await cdp.send('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: false,
  })
  await cdp.detach()

  writeFileSync(outPath, Buffer.from(data, 'base64'))
  console.log(`✓ ${outPath}`)

  if (consoleErrors.length > 0) {
    console.warn(`\n⚠ ${consoleErrors.length} browser error(s) — see above`)
  }

  await browser.close()
  console.log('\nDone.')
}

run().catch((err) => {
  console.error(err)
  process.exit(1)
})
