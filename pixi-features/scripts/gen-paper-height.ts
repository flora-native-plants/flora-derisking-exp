// gen-paper-height.ts — Random Phase Noise (Galerne/Gousseau/Morel 2011) paper synthesizer.
//
// Turns a real paper scan into a SEAMLESS, TILEABLE, infinite-variation height map that has the
// SAME power spectrum (fiber size / tooth roughness) and tonal histogram as the source, but new
// phase. Because DFT-based synthesis is inherently periodic, the output tiles with no seams —
// which also retires the "visible repetition" problem of tiling a photo.
//
// Method: FFT the source luminance → keep the magnitude spectrum → replace the phase with a
// random field that is Hermitian-symmetric (so the inverse transform is real) → inverse FFT →
// histogram-match back to the source tone → write a grayscale PNG height map.
//
// Run: npx tsx scripts/gen-paper-height.ts [srcPng] [outPng] [N] [seed] [rolloff]
//   defaults: watercolor-white.png -> watercolor-height.png, N=512, seed=1, rolloff=0
//
// rolloff > 0 low-passes the magnitude spectrum (Gaussian, cutoff = rolloff fraction of Nyquist)
// so the height becomes BROAD paper undulation instead of per-fiber grain — this is what makes
// derived normals light as smooth 3D relief rather than sandpaper. In rolloff mode the output is
// min/max-normalized (clean gradients for normals) instead of histogram-matched to source tone.

import { PNG } from 'pngjs'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const BASE = resolve('public/textures/paper')
const srcPath = resolve(process.argv[2] ?? `${BASE}/watercolor-white.png`)
const outPath = resolve(process.argv[3] ?? `${BASE}/watercolor-height.png`)
const N = Number(process.argv[4] ?? 512)          // must be a power of two
const seed = Number(process.argv[5] ?? 1)
const rolloff = Number(process.argv[6] ?? 0)      // 0 = off; else Gaussian cutoff frac of Nyquist

if ((N & (N - 1)) !== 0) throw new Error(`N must be a power of two, got ${N}`)

// --- seeded RNG (mulberry32) ------------------------------------------------
function mulberry32(a: number) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const rand = mulberry32(seed)

// --- iterative radix-2 Cooley-Tukey FFT (in place) --------------------------
function fft1d(re: Float64Array, im: Float64Array, inverse: boolean): void {
  const n = re.length
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      ;[re[i], re[j]] = [re[j], re[i]]
      ;[im[i], im[j]] = [im[j], im[i]]
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = ((inverse ? 2 : -2) * Math.PI) / len
    const wr = Math.cos(ang), wi = Math.sin(ang)
    for (let i = 0; i < n; i += len) {
      let cwr = 1, cwi = 0
      for (let k = 0; k < len >> 1; k++) {
        const a = i + k, b = a + (len >> 1)
        const vRe = re[b] * cwr - im[b] * cwi
        const vIm = re[b] * cwi + im[b] * cwr
        re[b] = re[a] - vRe; im[b] = im[a] - vIm
        re[a] += vRe;        im[a] += vIm
        const ncwr = cwr * wr - cwi * wi
        cwi = cwr * wi + cwi * wr
        cwr = ncwr
      }
    }
  }
  if (inverse) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n }
}

// 2D FFT by separable row then column passes.
function fft2d(re: Float64Array, im: Float64Array, inverse: boolean): void {
  const rowRe = new Float64Array(N), rowIm = new Float64Array(N)
  for (let y = 0; y < N; y++) {
    const o = y * N
    for (let x = 0; x < N; x++) { rowRe[x] = re[o + x]; rowIm[x] = im[o + x] }
    fft1d(rowRe, rowIm, inverse)
    for (let x = 0; x < N; x++) { re[o + x] = rowRe[x]; im[o + x] = rowIm[x] }
  }
  const colRe = new Float64Array(N), colIm = new Float64Array(N)
  for (let x = 0; x < N; x++) {
    for (let y = 0; y < N; y++) { colRe[y] = re[y * N + x]; colIm[y] = im[y * N + x] }
    fft1d(colRe, colIm, inverse)
    for (let y = 0; y < N; y++) { re[y * N + x] = colRe[y]; im[y * N + x] = colIm[y] }
  }
}

// --- load source, center-crop to N x N, take luminance ----------------------
const src = PNG.sync.read(readFileSync(srcPath))
if (src.width < N || src.height < N) throw new Error(`source ${src.width}x${src.height} smaller than N=${N}`)
const ox = (src.width - N) >> 1, oy = (src.height - N) >> 1
const lum = new Float64Array(N * N)
for (let y = 0; y < N; y++) {
  for (let x = 0; x < N; x++) {
    const si = ((oy + y) * src.width + (ox + x)) << 2
    lum[y * N + x] = 0.299 * src.data[si] + 0.587 * src.data[si + 1] + 0.114 * src.data[si + 2]
  }
}

// --- forward FFT ------------------------------------------------------------
const re = Float64Array.from(lum)
const im = new Float64Array(N * N)
fft2d(re, im, false)

// --- randomize phase with Hermitian symmetry (keeps magnitude) --------------
const psi = new Float64Array(N * N)
const done = new Uint8Array(N * N)
for (let u = 0; u < N; u++) {
  for (let v = 0; v < N; v++) {
    const k = u * N + v
    if (done[k]) continue
    const cu = (N - u) % N, cv = (N - v) % N
    const ck = cu * N + cv
    if (ck === k) { psi[k] = 0; done[k] = 1 }          // self-conjugate (DC / Nyquist) -> 0
    else {
      const a = (rand() * 2 - 1) * Math.PI
      psi[k] = a; psi[ck] = -a; done[k] = done[ck] = 1  // odd symmetry -> real inverse
    }
  }
}
const nyq = N / 2
for (let u = 0; u < N; u++) {
  const fu = u <= nyq ? u : u - N
  for (let v = 0; v < N; v++) {
    const k = u * N + v
    const fv = v <= nyq ? v : v - N
    let mag = Math.hypot(re[k], im[k])
    if (rolloff > 0) {
      const r = Math.hypot(fu, fv) / nyq          // 0 at DC .. ~1.41 at corner
      mag *= Math.exp(-(r / rolloff) * (r / rolloff))
    }
    const ph = Math.atan2(im[k], re[k]) + psi[k]
    re[k] = mag * Math.cos(ph); im[k] = mag * Math.sin(ph)
  }
}

// --- inverse FFT -> real height field ---------------------------------------
fft2d(re, im, true)

// --- map to 0..255 ----------------------------------------------------------
const out = new Uint8Array(N * N)
if (rolloff > 0) {
  // Smooth height for normals: min/max normalize for clean, strong gradients.
  let mn = Infinity, mx = -Infinity
  for (let k = 0; k < N * N; k++) { if (re[k] < mn) mn = re[k]; if (re[k] > mx) mx = re[k] }
  const span = mx - mn || 1
  for (let k = 0; k < N * N; k++) out[k] = Math.round((255 * (re[k] - mn)) / span)
} else {
  // Photoreal paper: histogram-match the result to the source tone (same rank -> same value).
  const idx = Array.from({ length: N * N }, (_, i) => i).sort((a, b) => re[a] - re[b])
  const srcSorted = Float64Array.from(lum).sort()
  for (let r = 0; r < idx.length; r++) out[idx[r]] = Math.max(0, Math.min(255, Math.round(srcSorted[r])))
}

// --- write grayscale PNG ----------------------------------------------------
const png = new PNG({ width: N, height: N })
for (let i = 0; i < N * N; i++) {
  const o = i << 2
  png.data[o] = png.data[o + 1] = png.data[o + 2] = out[i]
  png.data[o + 3] = 255
}
writeFileSync(outPath, PNG.sync.write(png))
console.log(`wrote ${outPath} (${N}x${N}, seamless RPN height, seed ${seed})`)
