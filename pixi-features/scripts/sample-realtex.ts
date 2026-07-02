// Eyedropper the realtex reference: report the light/mid/dark green washes + the warm bloom,
// so we can fit the procedural shader's pigment K/S to real targets instead of tuning by eye.
import { PNG } from 'pngjs'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const path = resolve(import.meta.dirname, '../../..', 'flora-studio/variants-realtex.png')
const png = PNG.sync.read(readFileSync(path))
const { width, height, data } = png

const greens: Array<[number, number, number, number]> = [] // r,g,b,luma
const warms: Array<[number, number, number]> = []
for (let i = 0; i < data.length; i += 4) {
  const r = data[i], g = data[i + 1], b = data[i + 2], a = data[i + 3]
  if (a < 200) continue
  // skip cream paper background (all channels high & close)
  if (r > 205 && g > 200 && b > 175 && Math.abs(r - g) < 25) continue
  const luma = 0.299 * r + 0.587 * g + 0.114 * b
  if (g >= r && g >= b) greens.push([r, g, b, luma])              // green wash
  else if (r > g && g > b && r - b > 25 && luma < 210) warms.push([r, g, b]) // warm brown bloom
}
greens.sort((a, b) => a[3] - b[3])
const pct = (p: number) => greens[Math.floor(greens.length * p)]
const hex = (r: number, g: number, b: number) => '#' + [r, g, b].map(v => Math.round(v).toString(16).padStart(2, '0')).join('')
const norm = (r: number, g: number, b: number) => `(${(r / 255).toFixed(2)}, ${(g / 255).toFixed(2)}, ${(b / 255).toFixed(2)})`

console.log(`realtex: ${width}x${height}, ${greens.length} green px, ${warms.length} warm px`)
for (const [label, p] of [['dark accent (10%)', 0.10], ['mid wash (50%)', 0.50], ['light wash (85%)', 0.85]] as const) {
  const [r, g, b] = pct(p)
  console.log(`${label.padEnd(20)} ${hex(r, g, b)}  rgb01 ${norm(r, g, b)}`)
}
if (warms.length) {
  const avg = warms.reduce((s, w) => [s[0] + w[0], s[1] + w[1], s[2] + w[2]], [0, 0, 0]).map(v => v / warms.length)
  console.log(`warm bloom (avg)     ${hex(avg[0], avg[1], avg[2])}  rgb01 ${norm(avg[0], avg[1], avg[2])}`)
}
