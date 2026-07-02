// naturalize.ts — headless, data-driven naturalistic-stroke renderer.
//
// Reads a shapes SVG (<path id d>) + a knobs JSON (per-object engine + amount), runs each
// shape through its chosen naturalism generator (rough.js OR kinematic min-jerk), and writes
// an out.svg (crisp vector) + out.png (rasterized via Playwright) so you can eyeball whether
// the naturalistic rendering is working — no UI, no dev server.
//
// Run:
//   npx tsx scripts/naturalize.ts                                  # uses the sample files below
//   npx tsx scripts/naturalize.ts --shapes a.svg --config b.json --out .naturalize-out
//
// Knobs JSON shape:
//   {
//     "background": "#f4f1ea",
//     "defaults": { "engine": "kinematic", "seed": 42, "color": "#2b2b28", "width": 2, ... },
//     "objects": { "<path-id>": { "engine": "rough", "roughness": 1.5, "color": "#4b7a4b" } }
//   }
// Per-object settings override defaults. engine ∈ 'rough' | 'kinematic' | 'crisp'.
import { chromium } from 'playwright'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { opsFor, opsToD, bbox, readShapes, type Knobs } from './naturalize-lib'

interface Config { background?: string; scale?: number; padding?: number; defaults?: Knobs; objects?: Record<string, Knobs> }

// ---- args -------------------------------------------------------------------
function arg(flag: string, fallback: string): string {
  const i = process.argv.indexOf(flag)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}
const HERE = new URL('.', import.meta.url).pathname
const shapesPath = arg('--shapes', `${HERE}naturalize.shapes.svg`)
const configPath = arg('--config', `${HERE}naturalize.config.json`)
const outDir = arg('--out', '.naturalize-out')

// ---- main -------------------------------------------------------------------
mkdirSync(outDir, { recursive: true })
const cfg: Config = JSON.parse(readFileSync(configPath, 'utf8'))
const shapes = readShapes(readFileSync(shapesPath, 'utf8'))
const pad = cfg.padding ?? 40
const scale = cfg.scale ?? 2
const bg = cfg.background ?? '#f4f1ea'

const rendered = shapes.map((s) => {
  const k: Knobs = { ...(cfg.defaults ?? {}), ...(cfg.objects?.[s.id] ?? {}) }
  return { id: s.id, d: opsToD(opsFor(s.d, k)), color: k.color ?? '#2b2b28', width: k.width ?? 2, engine: k.engine ?? cfg.defaults?.engine ?? 'kinematic' }
})

const b = bbox(shapes.map((s) => s.d))
const vb = `${b.x - pad} ${b.y - pad} ${b.w + 2 * pad} ${b.h + 2 * pad}`
const W = b.w + 2 * pad, H = b.h + 2 * pad

const paths = rendered
  .map((r) => `  <path d="${r.d}" fill="none" stroke="${r.color}" stroke-width="${r.width}" stroke-linecap="round" stroke-linejoin="round"/>`)
  .join('\n')
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb}" width="${W}" height="${H}">\n<rect x="${b.x - pad}" y="${b.y - pad}" width="${W}" height="${H}" fill="${bg}"/>\n${paths}\n</svg>\n`
writeFileSync(`${outDir}/out.svg`, svg)

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: Math.ceil(W * scale), height: Math.ceil(H * scale) } })
await page.setContent(`<!doctype html><body style="margin:0">${svg.replace('width="' + W + '"', 'width="' + W * scale + '"').replace('height="' + H + '"', 'height="' + H * scale + '"')}</body>`)
await page.waitForTimeout(150)
await page.screenshot({ path: `${outDir}/out.png` })
await browser.close()

console.log(`wrote ${outDir}/out.svg + out.png — ${rendered.map((r) => `${r.id}:${r.engine}`).join('  ')}`)
