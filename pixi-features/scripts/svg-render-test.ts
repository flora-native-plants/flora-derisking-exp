/**
 * SVG Render Test — headless Playwright harness
 *
 * Renders an SVG through all four strategies (A/B1/B2/C) at multiple zoom
 * levels and saves PNG screenshots to .pixi-render-test/.
 *
 * Usage:
 *   npm run svg-test                          # uses test-fixtures/fnp-logo.svg
 *   npm run svg-test -- path/to/logo.svg      # any complete <svg> file
 *
 * Prerequisites:
 *   npm run dev   # pixi-features Vite server must be running on port 5174
 *
 * Screenshots use window.__screenshot() (renderer.extract.base64) which reads
 * directly from Pixi's GPU texture — no preserveDrawingBuffer dependency.
 */

import { chromium } from 'playwright'
import { readFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { join, basename, resolve } from 'node:path'

const PORT       = 5174
const OUTPUT_DIR = resolve(import.meta.dirname, '..', '.pixi-render-test')
const FIXTURE    = resolve(import.meta.dirname, '..', 'test-fixtures', 'fnp-logo.svg')
const ZOOM_LEVELS = [1, 4, 10, 40] as const
// How long to wait for strategy C's async raster load before screenshotting
const RASTER_WAIT_MS = 1500

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

function readSvg(filePath: string): string {
  if (!existsSync(filePath)) {
    console.error(`✗ File not found: ${filePath}`)
    process.exit(1)
  }
  return readFileSync(filePath, 'utf-8')
}

async function run(): Promise<void> {
  const svgFilePath = process.argv[2] ?? FIXTURE
  const svgMarkup   = readSvg(svgFilePath)
  const name        = basename(svgFilePath, '.svg')

  console.log(`SVG file : ${svgFilePath}`)
  console.log(`Output   : ${OUTPUT_DIR}/`)
  console.log(`Zoom lvls: ${ZOOM_LEVELS.join('×, ')}×\n`)

  await assertServerRunning()
  mkdirSync(OUTPUT_DIR, { recursive: true })

  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({
    viewport: { width: 1600, height: 700 },
  })

  // Activate the svg-render tab before page load
  await context.addInitScript(() => {
    localStorage.setItem('pixi-features-active-v2', 'svg-render')
  })

  const page = await context.newPage()

  page.on('console', msg => {
    if (msg.type() === 'error') console.error(`[browser] ${msg.text()}`)
  })

  console.log('Navigating to pixi-features…')
  await page.goto(`http://localhost:${PORT}`, { waitUntil: 'networkidle' })

  // Wait for the tab's window hooks to be ready
  console.log('Waiting for __renderSvg hook…')
  await page.waitForFunction(
    () => typeof (window as any).__renderSvg === 'function',
    { timeout: 15_000 }
  )

  // Inject the SVG and wait for the raster strategy to finish loading
  console.log('Rendering all strategies…')
  await page.evaluate((markup: string) => {
    ;(window as any).__renderSvg(markup)
  }, svgMarkup)

  await page.waitForTimeout(RASTER_WAIT_MS)

  // Open CDP session for composited-frame screenshots.
  // CDP reads the OS compositor output at viewport resolution — no WebGL buffer
  // allocation, no preserveDrawingBuffer dependency, no size limit at high zoom.
  const cdp = await context.newCDPSession(page)

  // Screenshot at each zoom level
  for (const zoom of ZOOM_LEVELS) {
    await page.evaluate((z: number) => {
      ;(window as any).__setZoom(z)
    }, zoom)

    // Let the render frame settle
    await page.waitForTimeout(150)

    // Force a Pixi render tick so the frame is composited before CDP reads it
    await page.evaluate(() => {
      const app = (window as any).__pixiApp
      if (app) app.renderer.render(app.stage)
    })

    const { data } = await cdp.send('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: false,
    })

    const buf     = Buffer.from(data, 'base64')
    const outPath = join(OUTPUT_DIR, `${name}_zoom-${zoom}x.png`)
    writeFileSync(outPath, buf)
    console.log(`  ✓ ${outPath}`)
  }

  await cdp.detach()

  await browser.close()
  console.log('\nDone.')
}

run().catch((err) => {
  console.error(err)
  process.exit(1)
})
