/**
 * Watercolor Sim batch renderer — Playwright headless, JSON-driven. Mirrors
 * scripts/watercolor-render.ts but drives the NEW Watercolor Sim tab via its
 * `window.__waterSimTune(params)` hook. Saves PNGs to `.watercolor/<name>.png`.
 *
 *   npx tsx scripts/watersim-render.ts                    # all presets
 *   npx tsx scripts/watersim-render.ts --only sim-default
 *
 * Presets file: scripts/watersim-presets.json
 *   { "plantId": 2, "variants": 9, "presets": [ { "name": "sim-default", ...knobs } ] }
 *
 * Prereq: pixi-features Vite server on port 5202 (`npm run dev`).
 */
import { chromium } from 'playwright'
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const PORT = 5202
const OUTPUT_DIR = resolve(import.meta.dirname, '..', '.watercolor')

interface Preset { name: string; [k: string]: number | string }
interface PresetFile { plantId?: number; variants?: number; presets: Preset[] }

function arg(flag: string): string | undefined { const i = process.argv.indexOf(flag); return i !== -1 ? process.argv[i + 1] : undefined }

async function run(): Promise<void> {
  const fileArg = arg('--file') ?? 'scripts/watersim-presets.json'
  const filePath = resolve(import.meta.dirname, '..', fileArg)
  const cfg = JSON.parse(readFileSync(filePath, 'utf8')) as PresetFile
  const onlyRaw = arg('--only')
  const only = onlyRaw ? new Set(onlyRaw.split(',').map(s => s.trim())) : null
  const fileDefaults: Record<string, number> = {}
  if (typeof cfg.plantId === 'number') fileDefaults.plantId = cfg.plantId
  if (typeof cfg.variants === 'number') fileDefaults.variants = cfg.variants
  const presets = cfg.presets.filter(p => !only || only.has(p.name))
  console.log(`Rendering: ${presets.map(p => p.name).join(', ')}`)

  try { const res = await fetch(`http://localhost:${PORT}`); if (!res.ok) throw new Error() }
  catch { console.error(`\n✗ Dev server not on port ${PORT}. Run: npm run dev\n`); process.exit(1) }
  mkdirSync(OUTPUT_DIR, { recursive: true })

  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({ viewport: { width: 1600, height: 900 } })
  await context.addInitScript(() => { localStorage.setItem('pixi-features-active-v2', 'watersim') })
  const page = await context.newPage()
  const errs: string[] = []
  page.on('console', m => { if (m.type() === 'error') { console.error(`[browser] ${m.text()}`); errs.push(m.text()) } })

  await page.goto(`http://localhost:${PORT}`, { waitUntil: 'networkidle' })
  await page.waitForFunction(() => typeof (window as unknown as { __waterSimTune?: unknown }).__waterSimTune === 'function', { timeout: 15000 })

  const canvas = page.locator('canvas').first()
  const PANEL_W = 400
  const shoot = async (name: string) => {
    await page.waitForTimeout(500)
    const outPath = join(OUTPUT_DIR, `${name}.png`)
    const box = await canvas.boundingBox()
    if (box && box.width > PANEL_W) await page.screenshot({ path: outPath, clip: { x: box.x + PANEL_W, y: box.y, width: box.width - PANEL_W, height: box.height } })
    else await canvas.screenshot({ path: outPath })
    console.log(`✓ ${outPath}`)
  }
  const tune = async (p: Record<string, number>) => {
    await page.evaluate(async (x) => { await (window as unknown as { __waterSimTune: (y: Record<string, number>) => Promise<void> }).__waterSimTune(x) }, p)
  }
  for (const preset of presets) { const { name, ...knobs } = preset; await tune({ ...fileDefaults, ...knobs } as Record<string, number>); await shoot(String(name)) }

  await browser.close()
  if (errs.length) console.warn(`\n⚠ ${errs.length} browser error(s)`)
  void writeFileSync
  console.log('\nDone.')
}
run().catch(err => { console.error(err); process.exit(1) })
