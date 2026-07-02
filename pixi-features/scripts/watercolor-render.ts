/**
 * Watercolor batch renderer — Playwright headless, JSON-driven.
 *
 * Reads a presets file (default scripts/watercolor-presets.json), and for each
 * named preset sets the procedural knobs via the tab's `window.__procTune(params)`
 * hook, then saves a PNG to `.watercolor/<name>.png`. Deterministic and HMR-proof —
 * replaces hand-poking sliders through the DOM.
 *
 * Usage:
 *   npx tsx scripts/watercolor-render.ts                         # all presets in the default file
 *   npx tsx scripts/watercolor-render.ts --file my-presets.json  # a different presets file
 *   npx tsx scripts/watercolor-render.ts --only baseline,strong  # subset by name
 *
 * Presets file shape:
 *   { "plantId": 2, "variants": 9, "presets": [ { "name": "baseline", "offsetBase": 8, ... }, ... ] }
 * Any per-preset key overrides the file-level defaults. Knob keys match __procTune:
 *   plantId, variants, dilation, offsetBase, warpAmp, fbmB, paperC, bandCount, edgeWidth,
 *   bandGain, plateauLo, plateauHi, mixT0, mixT1, baseDensity, coverKnee, shadowDX, shadowDY, shadowAmp
 *
 * Prerequisites: pixi-features Vite server running on port 5202 (`npm run dev`).
 */

import { chromium } from 'playwright'
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const PORT = 5202
const OUTPUT_DIR = resolve(import.meta.dirname, '..', '.watercolor')

interface Preset { name: string; [knob: string]: number | string }
interface PresetFile { plantId?: number; variants?: number; presets: Preset[] }

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag)
  return i !== -1 ? process.argv[i + 1] : undefined
}

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
  const fileArg = arg('--file') ?? 'scripts/watercolor-presets.json'
  const filePath = resolve(import.meta.dirname, '..', fileArg.replace(/^scripts\//, 'scripts/'))
  const cfg = JSON.parse(readFileSync(filePath, 'utf8')) as PresetFile
  const onlyRaw = arg('--only')
  const only = onlyRaw ? new Set(onlyRaw.split(',').map(s => s.trim())) : null
  const fileDefaults: Record<string, number> = {}
  if (typeof cfg.plantId === 'number') fileDefaults.plantId = cfg.plantId
  if (typeof cfg.variants === 'number') fileDefaults.variants = cfg.variants

  const presets = cfg.presets.filter(p => !only || only.has(p.name))
  console.log(`Presets file : ${filePath}`)
  console.log(`Rendering    : ${presets.map(p => p.name).join(', ')}`)

  await assertServerRunning()
  mkdirSync(OUTPUT_DIR, { recursive: true })

  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({ viewport: { width: 1600, height: 900 } })
  await context.addInitScript(() => {
    localStorage.setItem('pixi-features-active-v2', 'botvariants')
  })
  const page = await context.newPage()
  const consoleErrors: string[] = []
  page.on('console', m => { if (m.type() === 'error') { console.error(`[browser] ${m.text()}`); consoleErrors.push(m.text()) } })

  console.log('Navigating…')
  await page.goto(`http://localhost:${PORT}`, { waitUntil: 'networkidle' })
  // Wait for the tuning hook the tab installs on mount.
  await page.waitForFunction(() => typeof (window as unknown as { __procTune?: unknown }).__procTune === 'function', { timeout: 15000 })

  // Screenshot just the <canvas> element (clean, no UI chrome).
  const canvas = page.locator('canvas').first()
  const shoot = async (name: string) => {
    await page.waitForTimeout(450) // let the bake settle
    const outPath = join(OUTPUT_DIR, `${name}.png`)
    await canvas.screenshot({ path: outPath })
    console.log(`✓ ${outPath}`)
  }
  const tune = async (params: Record<string, number>) => {
    await page.evaluate(async (p) => {
      await (window as unknown as { __procTune: (x: Record<string, number>) => Promise<void> }).__procTune(p)
    }, params)
  }

  // --stages: dump every pipeline stage (1..8) for ONE preset (first, or --only), one big leaf.
  const stagesMode = process.argv.includes('--stages')
  const STAGE_NAMES = ['final', 'raw-sdf', 'sdfN', 'T-drying', 'bandTerm', 'density', 'mix-m', 'coverage', 'reflectance']

  if (stagesMode) {
    const base = { ...fileDefaults, ...(({ name, ...k }) => k)(presets[0]), variants: 1 } as Record<string, number>
    for (let stg = 0; stg <= 8; stg++) {
      await tune({ ...base, debugStage: stg })
      await shoot(`stage-${stg}-${STAGE_NAMES[stg]}`)
    }
  } else {
    for (const preset of presets) {
      const { name, ...knobs } = preset
      await tune({ ...fileDefaults, ...knobs })
      await shoot(name)
    }
  }

  await browser.close()
  if (consoleErrors.length) console.warn(`\n⚠ ${consoleErrors.length} browser error(s) — see above`)
  console.log('\nDone.')
}

run().catch(err => { console.error(err); process.exit(1) })
