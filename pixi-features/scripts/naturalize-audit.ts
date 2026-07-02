// naturalize-audit.ts — stress/comparison rig for the naturalistic stroke pipeline.
// Emits contact sheets so I can SEE where the rendering breaks, instead of judging one frame:
//   audit-sweep.png  — rows = shapes (incl. hard ones), cols = crisp / rough[.5,1,2,3] / kin[0,2,6,14]
//   audit-seeds.png  — one shape per row, cols = 5 seeds (is variation natural + per-seed stable?)
// Each cell draws a faint CRISP underlay (deviation from truth is visible) + a cell BORDER
// (marks crossing it = clipping/overshoot beyond the fit box).
// Run: npx tsx scripts/naturalize-audit.ts   (writes to .naturalize-out/)
import { chromium } from 'playwright'
import { writeFileSync, mkdirSync } from 'node:fs'
import { opsFor, opsToD, bbox, type Knobs } from './naturalize-lib'

const OUT = '.naturalize-out'
const BG = '#f4f1ea'
mkdirSync(OUT, { recursive: true })

// ---- shapes: 3 sample + 3 generated stress shapes ---------------------------
function polyD(pts: number[][], close: boolean): string {
  const r = (n: number) => n.toFixed(1)
  return `M ${r(pts[0][0])} ${r(pts[0][1])} ` +
    pts.slice(1).map((p) => `L ${r(p[0])} ${r(p[1])}`).join(' ') + (close ? ' Z' : '')
}
function star(R: number, r: number, points: number): string {
  const pts: number[][] = []
  for (let k = 0; k < points * 2; k++) {
    const rad = k % 2 === 0 ? R : r
    const a = -Math.PI / 2 + (k * Math.PI) / points
    pts.push([Math.cos(a) * rad, Math.sin(a) * rad])
  }
  return polyD(pts, true)
}
function gon(R: number, n: number): string {
  const pts: number[][] = []
  for (let k = 0; k < n; k++) { const a = (k / n) * Math.PI * 2; pts.push([Math.cos(a) * R, Math.sin(a) * R]) }
  return polyD(pts, true)
}
function tinyWave(x0: number, x1: number, amp: number, seg: number): string {
  const pts: number[][] = []
  for (let x = x0; x <= x1; x += seg) pts.push([x, Math.sin(x * 0.06) * amp])
  return polyD(pts, false)
}
// Plant-canopy stand-in: closed organic outline with `lobes` fine scallops (feature size
// < cpSpacing), sampled to `n` dense vertices. Stresses whether resample keeps fine detail.
function canopy(R: number, lobes: number, amp: number, n: number): string {
  const pts: number[][] = []
  for (let k = 0; k < n; k++) {
    const a = (k / n) * Math.PI * 2
    const rad = R + Math.sin(a * lobes) * amp
    pts.push([Math.cos(a) * rad, Math.sin(a) * rad])
  }
  return polyD(pts, true)
}

const SHAPES: Array<{ id: string; d: string }> = [
  { id: 'boundary', d: 'M -260 -150 L 260 -150 L 260 150 L 40 150 L -60 90 L -260 90 Z' },
  { id: 'bed', d: 'M -180 -40 C -140 -110, -40 -120, 30 -80 C 90 -48, 120 20, 70 70 C 20 118, -110 110, -170 60 C -210 26, -220 10, -180 -40 Z' },
  { id: 'leader', d: 'M -200 120 L -160 60 L -120 120 L -80 60 L -40 120' },
  { id: 'star(sharp)', d: star(150, 58, 5) },
  { id: 'gon40(smooth)', d: gon(140, 40) },
  { id: 'tinywave(3px)', d: tinyWave(-200, 200, 40, 3) },
  { id: 'canopy(fine)', d: canopy(120, 14, 14, 120) },
]

// ---- variant columns --------------------------------------------------------
const COLS: Array<{ label: string; k: Knobs }> = [
  { label: 'crisp', k: { engine: 'crisp' } },
  { label: 'rough .5', k: { engine: 'rough', roughness: 0.5 } },
  { label: 'rough 1', k: { engine: 'rough', roughness: 1 } },
  { label: 'rough 2', k: { engine: 'rough', roughness: 2 } },
  { label: 'rough 3', k: { engine: 'rough', roughness: 3 } },
  { label: 'kin sq0', k: { engine: 'kinematic', squiggle: 0 } },
  { label: 'kin sq2', k: { engine: 'kinematic', squiggle: 2 } },
  { label: 'kin sq6', k: { engine: 'kinematic', squiggle: 6 } },
  { label: 'kin sq14', k: { engine: 'kinematic', squiggle: 14 } },
]

const CELL_W = 200, CELL_H = 150, HEADER = 44, GUTTER = 78, FIT = 0.82

// One cell: faint crisp underlay + naturalized stroke, fit into the cell box, plus a border.
function cell(shape: { id: string; d: string }, k: Knobs, px: number, py: number): string {
  const bb = bbox([shape.d])
  const s = Math.min((CELL_W - 18) / (bb.w || 1), (CELL_H - 18) / (bb.h || 1)) * FIT
  const cx = px + CELL_W / 2, cy = py + CELL_H / 2
  const tf = `translate(${cx} ${cy}) scale(${s}) translate(${-(bb.x + bb.w / 2)} ${-(bb.y + bb.h / 2)})`
  const natD = opsToD(opsFor(shape.d, { ...k, seed: k.seed ?? 42 }))
  const isCrisp = k.engine === 'crisp'
  const under = isCrisp ? '' : `<path d="${shape.d}" fill="none" stroke="#c9c4b8" stroke-width="1" vector-effect="non-scaling-stroke"/>`
  return `<g>
  <rect x="${px}" y="${py}" width="${CELL_W}" height="${CELL_H}" fill="none" stroke="#ddd7c8" stroke-width="1"/>
  <g transform="${tf}">
    ${under}
    <path d="${natD}" fill="none" stroke="#2b2b28" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>
  </g></g>`
}

function sheet(rows: Array<{ id: string; d: string }>, cols: Array<{ label: string; k: Knobs }>, title: string): string {
  const W = GUTTER + cols.length * CELL_W, H = HEADER + rows.length * CELL_H
  const parts: string[] = []
  parts.push(`<rect x="0" y="0" width="${W}" height="${H}" fill="${BG}"/>`)
  parts.push(`<text x="6" y="16" font-family="monospace" font-size="12" fill="#555">${title}</text>`)
  cols.forEach((c, ci) => {
    const x = GUTTER + ci * CELL_W + CELL_W / 2
    parts.push(`<text x="${x}" y="38" text-anchor="middle" font-family="monospace" font-size="11" fill="#666">${c.label}</text>`)
  })
  rows.forEach((sh, ri) => {
    const y = HEADER + ri * CELL_H + CELL_H / 2
    parts.push(`<text x="6" y="${y}" font-family="monospace" font-size="11" fill="#666">${sh.id}</text>`)
    cols.forEach((c, ci) => parts.push(cell(sh, c.k, GUTTER + ci * CELL_W, HEADER + ri * CELL_H)))
  })
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">\n${parts.join('\n')}\n</svg>\n`
}

// seed-stability sheet: for shapes with corners/curves, does changing seed give natural variety?
const SEED_ROWS = [
  { id: 'leader·kin', base: { engine: 'kinematic', squiggle: 6 } as Knobs, shape: SHAPES[2] },
  { id: 'leader·rough', base: { engine: 'rough', roughness: 1.5 } as Knobs, shape: SHAPES[2] },
  { id: 'bed·kin', base: { engine: 'kinematic', squiggle: 7 } as Knobs, shape: SHAPES[1] },
]
function seedSheet(): string {
  const seeds = [1, 2, 3, 4, 5]
  const W = GUTTER + seeds.length * CELL_W, H = HEADER + SEED_ROWS.length * CELL_H
  const parts: string[] = [`<rect width="${W}" height="${H}" fill="${BG}"/>`,
    `<text x="6" y="16" font-family="monospace" font-size="12" fill="#555">seed stability — natural variety, each seed reproducible</text>`]
  seeds.forEach((sd, ci) => parts.push(`<text x="${GUTTER + ci * CELL_W + CELL_W / 2}" y="38" text-anchor="middle" font-family="monospace" font-size="11" fill="#666">seed ${sd}</text>`))
  SEED_ROWS.forEach((row, ri) => {
    parts.push(`<text x="6" y="${HEADER + ri * CELL_H + CELL_H / 2}" font-family="monospace" font-size="11" fill="#666">${row.id}</text>`)
    seeds.forEach((sd, ci) => parts.push(cell(row.shape, { ...row.base, seed: sd }, GUTTER + ci * CELL_W, HEADER + ri * CELL_H)))
  })
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">\n${parts.join('\n')}\n</svg>\n`
}

// ---- render -----------------------------------------------------------------
const sweepSvg = sheet(SHAPES, COLS, 'naturalize sweep — crisp underlay in gray; cell border catches clipping')
const seedsSvg = seedSheet()
writeFileSync(`${OUT}/audit-sweep.svg`, sweepSvg)
writeFileSync(`${OUT}/audit-seeds.svg`, seedsSvg)

const browser = await chromium.launch()
async function shot(svg: string, name: string, scale = 2) {
  const wm = /width="(\d+)"/.exec(svg)!, hm = /height="(\d+)"/.exec(svg)!
  const W = +wm[1], H = +hm[1]
  const page = await browser.newPage({ viewport: { width: W * scale, height: H * scale } })
  const scaled = svg.replace(`width="${W}"`, `width="${W * scale}"`).replace(`height="${H}"`, `height="${H * scale}"`)
  await page.setContent(`<!doctype html><body style="margin:0">${scaled}</body>`)
  await page.waitForTimeout(150)
  await page.screenshot({ path: `${OUT}/${name}` })
  await page.close()
}
await shot(sweepSvg, 'audit-sweep.png')
await shot(seedsSvg, 'audit-seeds.png')
await browser.close()
console.log(`wrote ${OUT}/audit-sweep.png (${SHAPES.length}×${COLS.length}) + audit-seeds.png`)
