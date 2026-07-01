// check-tile.ts — tile a texture 2x2 to eyeball seams. Run: npx tsx scripts/check-tile.ts <png>
import { PNG } from 'pngjs'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const src = PNG.sync.read(readFileSync(resolve(process.argv[2] ?? 'public/textures/paper/watercolor-height.png')))
const { width: w, height: h } = src
const out = new PNG({ width: w * 2, height: h * 2 })
for (let ty = 0; ty < 2; ty++) for (let tx = 0; tx < 2; tx++) {
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const si = (y * w + x) << 2
    const di = ((ty * h + y) * w * 2 + (tx * w + x)) << 2
    out.data[di] = src.data[si]; out.data[di + 1] = src.data[si + 1]
    out.data[di + 2] = src.data[si + 2]; out.data[di + 3] = 255
  }
}
const p = resolve('.sketch-shot/tile-check.png')
writeFileSync(p, PNG.sync.write(out))
console.log('wrote', p)
