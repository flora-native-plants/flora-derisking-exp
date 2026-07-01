# Procedural Watercolor V1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the failed CPU `bakeInkwash` sim with a single-pass `ProceduralWatercolorFilter` that renders one clipped virtual puddle with drying-time-field tide-lines and 2-pigment Kubelka–Munk compositing, wired as a third `mode: 'procedural'` in the Botanical Variants tab.

> **Rev 2 — advisor + kimi GLSL review corrections applied** (2026-07-01): seed no longer injected into the SDF sample coordinate (hashed phase instead); warm rim keys off silhouette distance `sdfW`, not the puddle `pud`; K-M concentration (`K*dens`) separated from coverage alpha (no double-count) + early-out at `dens≈0`; SDF texture `r16float`; band-width gradient via clamped `dFdx/dFdy`; center `atan/normalize` guarded; low-freq base wash so the plateau operator is non-trivial.

**Architecture:** A Pixi v8 `Filter` (GLSL ES 3.00) samples a per-plant float SDF texture, builds a spatially-offset warped "puddle" pseudo-distance, derives a drying-time field `T`, cuts 5–7 `fwidth`-normalized asymmetric iso-band spikes into a plateau'd density field, splits into two pigments by `T`, composites via K–M in K/S space, clips to the silhouette with a warm tidied rim, and dithers. Pure CPU math (SDF distance transform, pigment K/S derivation) is extracted to tested TS modules. Verification is a screenshot harness + an objective acceptance-analysis script.

**Tech Stack:** PixiJS v8.16 (`Filter`/`GlProgram`/`UniformGroup`), Vue 3, Vite, TypeScript, `simplex-noise` (already a dep), vitest (added in Task 1), Playwright MCP for visual checks.

## Global Constraints

- **Pixi v8, GLSL ES 3.00** — `fwidth`/`dFdx` available; filter uniforms via `UniformGroup`; follow `src/lib/filters/WashTextureTintFilter.ts`.
- **SDF texture is `R16F` half-float**, `highp` in-shader, `CLAMP_TO_EDGE` with border padding. 8-bit UNORM is forbidden (posterizes bands).
- **Kubelka–Munk mixing happens in K/S space, never RGB.** `clamp(R, 1e-4, 1-1e-4)`. Clamp Rw/Rb inversion inputs to `0<Rb<Rw<1` per channel.
- **Plateau operator runs BEFORE band darkening**, on the density/amplitude field only — **never on `T`**.
- **Bands are additive in pigment density, pre-K-M** — never in RGB post-composite.
- **Vendor GLSL helper functions inline** (fBm, simplex, dither) — Pixi `GlProgram` has no `#include` resolver. Do NOT depend on lygia includes at runtime. **Mixbox is forbidden** (CC BY-NC; flora is commercial).
- **Bake at 2× and mip down** for the on-screen sprite.
- **Files ≤700 lines, one responsibility each.** Never `rm` (use `trash-put`). **Never `git push`** (commit locally only).
- **Playwright screenshots dump into the flora-studio repo root** — delete them after reading (per project convention). Playground runs on `localhost:5202`.
- V1 EXCLUDES: granulation, blooms, glaze stacking, bloom color, per-seed glaze-count, harmonic-polar secondary puddles. Brush-load is contingency only.

---

## File Structure

- `src/lib/watercolor/maskSdf.ts` — CPU signed-distance transform of a coverage mask → `Float32Array`. (Task 1)
- `src/lib/watercolor/pigmentKS.ts` — Curtis Rw/Rb → K/S inversion for one pigment. (Task 2)
- `src/lib/watercolor/sdfTexture.ts` — pack a `Float32Array` SDF into a Pixi `R16F` `Texture`. (Task 3)
- `src/lib/watercolor/glslNoise.ts` — vendored GLSL snippet strings (simplex, fBm, blue-noise dither) as exported consts. (Task 3)
- `src/lib/filters/ProceduralWatercolorFilter.ts` — the filter + GLSL, built up across Tasks 4–6.
- `src/tabs/TabBotanicalVariants.vue` — add `mode: 'procedural'` + controls + 2× bake. (Task 7)
- `scripts/watercolor-shot.ts` — screenshot harness (drives Playwright, saves to `.watercolor/`). (Task 3)
- `scripts/watercolor-accept.ts` — objective acceptance analysis (histogram skew + edge-profile asymmetry). (Task 8)
- `src/lib/watercolor/*.test.ts` — vitest unit tests colocated. (Tasks 1–2)

---

## Task 1: vitest setup + CPU mask signed-distance transform

**Files:**
- Modify: `package.json` (add vitest devDep + `test` script)
- Create: `vitest.config.ts`
- Create: `src/lib/watercolor/maskSdf.ts`
- Test: `src/lib/watercolor/maskSdf.test.ts`

**Interfaces:**
- Produces: `computeMaskSdf(mask: Float32Array, size: number): Float32Array` — input is a row-major `size*size` coverage field (1 inside, 0 outside); output is signed Euclidean distance in **pixels**, **negative inside**, positive outside. Uses a two-pass (forward/backward) chamfer approximation (3-4-5 chamfer) run on inside and outside separately.

- [ ] **Step 1: Add vitest and the test script**

In `package.json`, add to `devDependencies`: `"vitest": "^2.1.0"`, and to `scripts`: `"test": "vitest run"`, `"test:watch": "vitest"`. Then run `npm install`.

- [ ] **Step 2: Create `vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: { environment: 'node', include: ['src/**/*.test.ts'] },
})
```

- [ ] **Step 3: Write the failing test**

```ts
// src/lib/watercolor/maskSdf.test.ts
import { describe, it, expect } from 'vitest'
import { computeMaskSdf } from './maskSdf'

/** Build a size×size mask with a centered filled square of side `sq`. */
function squareMask(size: number, sq: number): Float32Array {
  const m = new Float32Array(size * size)
  const lo = (size - sq) / 2, hi = lo + sq
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++)
      if (x >= lo && x < hi && y >= lo && y < hi) m[y * size + x] = 1
  return m
}

describe('computeMaskSdf', () => {
  it('is negative at the center and positive far outside', () => {
    const size = 64, sdf = computeMaskSdf(squareMask(size, 20), size)
    const center = sdf[(size / 2) * size + size / 2]
    const corner = sdf[0]
    expect(center).toBeLessThan(0)
    expect(corner).toBeGreaterThan(0)
  })

  it('center distance approximates half the square side', () => {
    const size = 64, sq = 20, sdf = computeMaskSdf(squareMask(size, sq), size)
    const center = sdf[(size / 2) * size + size / 2]
    // center is ~sq/2 from the nearest edge; chamfer approx within 1.5px
    expect(Math.abs(Math.abs(center) - sq / 2)).toBeLessThan(1.5)
  })

  it('is ~0 within a pixel of the boundary', () => {
    const size = 64, sq = 20, sdf = computeMaskSdf(squareMask(size, sq), size)
    const lo = (size - sq) / 2
    const onEdge = sdf[(size / 2) * size + lo] // just inside left edge
    expect(Math.abs(onEdge)).toBeLessThan(1.5)
  })
})
```

- [ ] **Step 4: Run test to verify it fails**

Run: `npm test -- maskSdf`
Expected: FAIL — `computeMaskSdf is not a function` / module not found.

- [ ] **Step 5: Implement `maskSdf.ts`**

```ts
// src/lib/watercolor/maskSdf.ts
/**
 * CPU signed-distance transform of a coverage mask, via a two-pass 3-4-5 chamfer
 * (cheap, ~2% error vs exact Euclidean — plenty for driving the drying field).
 * Output: distance in pixels, NEGATIVE inside the mask, positive outside.
 */
const CHAMFER_ORTH = 1
const CHAMFER_DIAG = Math.SQRT2

function chamferDistance(binary: Uint8Array, size: number): Float32Array {
  const INF = 1e9
  const d = new Float32Array(size * size)
  for (let i = 0; i < d.length; i++) d[i] = binary[i] ? 0 : INF
  const at = (x: number, y: number) => d[y * size + x]
  const relax = (x: number, y: number, from: number, w: number) => {
    const v = from + w
    if (v < d[y * size + x]) d[y * size + x] = v
  }
  // forward pass
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      if (x > 0) relax(x, y, at(x - 1, y), CHAMFER_ORTH)
      if (y > 0) relax(x, y, at(x, y - 1), CHAMFER_ORTH)
      if (x > 0 && y > 0) relax(x, y, at(x - 1, y - 1), CHAMFER_DIAG)
      if (x < size - 1 && y > 0) relax(x, y, at(x + 1, y - 1), CHAMFER_DIAG)
    }
  // backward pass
  for (let y = size - 1; y >= 0; y--)
    for (let x = size - 1; x >= 0; x--) {
      if (x < size - 1) relax(x, y, at(x + 1, y), CHAMFER_ORTH)
      if (y < size - 1) relax(x, y, at(x, y + 1), CHAMFER_ORTH)
      if (x < size - 1 && y < size - 1) relax(x, y, at(x + 1, y + 1), CHAMFER_DIAG)
      if (x > 0 && y < size - 1) relax(x, y, at(x - 1, y + 1), CHAMFER_DIAG)
    }
  return d
}

export function computeMaskSdf(mask: Float32Array, size: number): Float32Array {
  const inside = new Uint8Array(size * size)   // 1 where covered
  const outside = new Uint8Array(size * size)  // 1 where NOT covered
  for (let i = 0; i < mask.length; i++) {
    const covered = mask[i] >= 0.5
    inside[i] = covered ? 1 : 0
    outside[i] = covered ? 0 : 1
  }
  const distOut = chamferDistance(inside, size)  // distance to nearest covered pixel (0 inside)
  const distIn = chamferDistance(outside, size)  // distance to nearest empty pixel (0 outside)
  const sdf = new Float32Array(size * size)
  for (let i = 0; i < sdf.length; i++) {
    sdf[i] = mask[i] >= 0.5 ? -distIn[i] : distOut[i]  // negative inside
  }
  return sdf
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npm test -- maskSdf`
Expected: PASS (3 tests).

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json vitest.config.ts src/lib/watercolor/maskSdf.ts src/lib/watercolor/maskSdf.test.ts
git commit -m "feat(watercolor): CPU mask signed-distance transform + vitest"
```

---

## Task 2: Pigment K/S derivation (Curtis Rw/Rb inversion)

**Files:**
- Create: `src/lib/watercolor/pigmentKS.ts`
- Test: `src/lib/watercolor/pigmentKS.test.ts`

**Interfaces:**
- Produces: `pigmentKS(Rw: RGB, Rb: RGB): { K: RGB; S: RGB }` where `RGB = [number, number, number]`. `Rw` = pigment reflectance over white, `Rb` = over black; both clamped so `0 < Rb < Rw < 1` per channel. Uses the Curtis single-constant K–M inversion: `a = ½(Rw + (Rb − Rw + 1)/Rb)`, `b = sqrt(a² − 1)`, `S = (1/b)·acoth((b² − (a − Rw)(a − 1)) / (b(1 − Rw)))`, `K = S·(a − 1)`. `acoth(x) = 0.5·ln((x+1)/(x−1))`.
- Produces: `reflectanceInfinite(K: RGB, S: RGB): RGB` — `R∞ = 1 + K/S − sqrt((K/S)² + 2·K/S)` per channel, clamped to `[1e-4, 1-1e-4]`. (Used by tests and mirrored in GLSL.)

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/watercolor/pigmentKS.test.ts
import { describe, it, expect } from 'vitest'
import { pigmentKS, reflectanceInfinite } from './pigmentKS'

const A_RW: [number, number, number] = [0.35, 0.62, 0.48]
const A_RB: [number, number, number] = [0.06, 0.20, 0.13]

describe('pigmentKS', () => {
  it('produces finite non-negative K and S', () => {
    const { K, S } = pigmentKS(A_RW, A_RB)
    for (const c of [...K, ...S]) { expect(Number.isFinite(c)).toBe(true); expect(c).toBeGreaterThanOrEqual(0) }
  })

  it('round-trips: R∞ from derived K/S lies between Rb and Rw per channel', () => {
    // R∞ is infinite-thickness masstone — it should sit at/above the over-white
    // reflectance and below 1; assert a physical band, NOT R∞≈Rw (different quantities).
    const { K, S } = pigmentKS(A_RW, A_RB)
    const rInf = reflectanceInfinite(K, S)
    for (let c = 0; c < 3; c++) {
      expect(rInf[c]).toBeGreaterThan(A_RB[c] - 0.02)
      expect(rInf[c]).toBeLessThan(1)
    }
  })

  it('clamps degenerate inputs (Rb>=Rw) without NaN', () => {
    const { K, S } = pigmentKS([0.2, 0.2, 0.2], [0.5, 0.5, 0.5]) // Rb>Rw -> must clamp
    for (const c of [...K, ...S]) expect(Number.isFinite(c)).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- pigmentKS`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `pigmentKS.ts`**

```ts
// src/lib/watercolor/pigmentKS.ts
export type RGB = [number, number, number]

const EPS = 1e-4
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
const acoth = (x: number) => 0.5 * Math.log((x + 1) / (x - 1))

/** Force 0 < Rb < Rw < 1 per channel so the inversion stays real. */
function sanitize(Rw: RGB, Rb: RGB): { rw: RGB; rb: RGB } {
  const rw: RGB = [0, 0, 0], rb: RGB = [0, 0, 0]
  for (let c = 0; c < 3; c++) {
    rw[c] = clamp(Rw[c], 2 * EPS, 1 - EPS)
    rb[c] = clamp(Rb[c], EPS, rw[c] - EPS)
  }
  return { rw, rb }
}

export function pigmentKS(Rw: RGB, Rb: RGB): { K: RGB; S: RGB } {
  const { rw, rb } = sanitize(Rw, Rb)
  const K: RGB = [0, 0, 0], S: RGB = [0, 0, 0]
  for (let c = 0; c < 3; c++) {
    const a = 0.5 * (rw[c] + (rb[c] - rw[c] + 1) / rb[c])
    const b = Math.sqrt(Math.max(a * a - 1, EPS))
    const arg = (b * b - (a - rw[c]) * (a - 1)) / (b * (1 - rw[c]))
    const s = (1 / b) * acoth(clamp(arg, 1 + EPS, 1e6)) // arg must exceed 1 for acoth
    S[c] = Math.max(s, EPS)
    K[c] = S[c] * (a - 1)
  }
  return { K, S }
}

export function reflectanceInfinite(K: RGB, S: RGB): RGB {
  const out: RGB = [0, 0, 0]
  for (let c = 0; c < 3; c++) {
    const ks = K[c] / Math.max(S[c], EPS)
    out[c] = clamp(1 + ks - Math.sqrt(ks * ks + 2 * ks), EPS, 1 - EPS)
  }
  return out
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- pigmentKS`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/watercolor/pigmentKS.ts src/lib/watercolor/pigmentKS.test.ts
git commit -m "feat(watercolor): Curtis Rw/Rb -> K/S pigment inversion"
```

---

## Task 3: Float SDF texture + vendored GLSL noise spike

**Files:**
- Create: `src/lib/watercolor/sdfTexture.ts`
- Create: `src/lib/watercolor/glslNoise.ts`
- Create: `scripts/watercolor-shot.ts`

**Interfaces:**
- Produces: `sdfToTexture(sdf: Float32Array, size: number): Texture` — a Pixi `Texture` backed by an `R16F` (`FLOAT`/`RED`) `TextureSource`, `scaleMode: 'linear'`, `addressMode: 'clamp-to-edge'`. Values are raw signed pixels; the shader divides by `uSdfTexelWorldSize`.
- Produces: `GLSL_SIMPLEX: string`, `GLSL_FBM: string`, `GLSL_DITHER: string` — self-contained GLSL ES 3.00 function-definition strings (no `#include`), each usable by concatenation into a fragment shader. `snoise(vec2)->float`, `fbm(vec2,int octaves)->float` in [-1,1]-ish, `ditherBlue(vec2)->float` in [0,1).
- Produces (spike gate): a throwaway proof the concatenated GLSL compiles inside a Pixi `Filter` (verified by `scripts/watercolor-shot.ts` rendering a noise field).

- [ ] **Step 1: Implement `glslNoise.ts` (vendored snippets)**

Vendor Ashima/IQ simplex + a small fBm + a value-noise dither. Keep them as exported template strings.

```ts
// src/lib/watercolor/glslNoise.ts
// Vendored GLSL ES 3.00 helpers (no #include; Pixi GlProgram concatenates these).
// simplex: Ashima "webgl-noise" (MIT). fbm/dither: standard small forms.
export const GLSL_SIMPLEX = /* glsl */`
vec3 mod289(vec3 x){return x-floor(x*(1.0/289.0))*289.0;}
vec2 mod289(vec2 x){return x-floor(x*(1.0/289.0))*289.0;}
vec3 permute(vec3 x){return mod289(((x*34.0)+1.0)*x);}
float snoise(vec2 v){
  const vec4 C=vec4(0.211324865405187,0.366025403784439,-0.577350269189626,0.024390243902439);
  vec2 i=floor(v+dot(v,C.yy)); vec2 x0=v-i+dot(i,C.xx);
  vec2 i1=(x0.x>x0.y)?vec2(1.0,0.0):vec2(0.0,1.0);
  vec4 x12=x0.xyxy+C.xxzz; x12.xy-=i1;
  i=mod289(i);
  vec3 p=permute(permute(i.y+vec3(0.0,i1.y,1.0))+i.x+vec3(0.0,i1.x,1.0));
  vec3 m=max(0.5-vec3(dot(x0,x0),dot(x12.xy,x12.xy),dot(x12.zw,x12.zw)),0.0);
  m=m*m; m=m*m;
  vec3 x=2.0*fract(p*C.www)-1.0; vec3 h=abs(x)-0.5; vec3 ox=floor(x+0.5); vec3 a0=x-ox;
  m*=1.79284291400159-0.85373472095314*(a0*a0+h*h);
  vec3 g; g.x=a0.x*x0.x+h.x*x0.y; g.yz=a0.yz*x12.xz+h.yz*x12.yw;
  return 130.0*dot(m,g);
}`

export const GLSL_FBM = /* glsl */`
float fbm(vec2 p, int octaves){
  float sum=0.0, amp=0.5, freq=1.0;
  for(int i=0;i<8;i++){ if(i>=octaves) break; sum+=amp*snoise(p*freq); freq*=2.0; amp*=0.5; }
  return sum;
}
vec2 warp2(vec2 p, float amp){ return p + amp*vec2(fbm(p+11.7,3), fbm(p-5.3,3)); }`

export const GLSL_DITHER = /* glsl */`
float ditherBlue(vec2 fragXY){
  // cheap hashed value dither in [0,1); good enough to break 8-bit banding at bake.
  float h=fract(sin(dot(fragXY,vec2(12.9898,78.233)))*43758.5453);
  return h;
}`
```

- [ ] **Step 2: Implement `sdfTexture.ts`**

```ts
// src/lib/watercolor/sdfTexture.ts
import { Texture, TextureSource, BufferImageSource } from 'pixi.js'

/** Pack a signed-distance Float32Array into an R16F Pixi texture (highp-friendly). */
export function sdfToTexture(sdf: Float32Array, size: number): Texture {
  // Float32 upload is fine; the source format is single-channel float.
  // r16float: widely supports LINEAR filtering (r32float linear needs OES_texture_float_linear).
  // Convert to Float16 is unnecessary — Pixi uploads Float32 data into an r16float source.
  const source = new BufferImageSource({
    resource: sdf,
    width: size,
    height: size,
    format: 'r16float',
    scaleMode: 'linear',       // linear interp of an SDF is smooth & correct
    addressMode: 'clamp-to-edge',
  })
  return new Texture({ source: source as unknown as TextureSource })
}
```

> Note: `r16float` satisfies the "no 8-bit" constraint and supports linear filtering broadly. If the target GL rejects the Float32 buffer into an r16float source, upload as `r32float` with `scaleMode: 'nearest'` (a 512² SDF into a ~300px cell is smooth per-texel). Verify in Step 4.

- [ ] **Step 3: Write the screenshot harness `scripts/watercolor-shot.ts`**

Model on `scripts/svg-render-test.ts` (read it first for the Playwright boot pattern). It must: launch Playwright, open `http://localhost:5202`, click the **Botanical Variants** tab, select `mode = procedural`, wait for the canvas, and save a PNG to `.watercolor/shot.png`. Accept an optional `--label` arg for the filename. (Full Playwright boilerplate mirrors the existing `svg-render-test.ts`; reuse its browser-launch and page-wait helpers verbatim.)

- [ ] **Step 4: Spike — prove the GLSL compiles in a Pixi filter**

Temporarily, in `ProceduralWatercolorFilter.ts` (created next task), or a scratch filter, build a fragment shader = `precision highp float;` + `GLSL_SIMPLEX` + `GLSL_FBM` + a `main()` that outputs `vec4(vec3(fbm(vTextureCoord*8.0,4)*0.5+0.5),1.0)`. Start the dev server (`npm run dev`), and run:

Run: `npm run dev` (terminal 1), then load the app and confirm **no shader compile error** in the browser console, and the noise field renders.
Expected: a grayscale simplex/fBm field, no `GlProgram` compile errors.

- [ ] **Step 5: Commit**

```bash
git add src/lib/watercolor/glslNoise.ts src/lib/watercolor/sdfTexture.ts scripts/watercolor-shot.ts
git commit -m "feat(watercolor): float SDF texture + vendored GLSL noise (compile-verified)"
```

---

## Task 4: ProceduralWatercolorFilter — puddle SDF + drying-time field

**Files:**
- Create: `src/lib/filters/ProceduralWatercolorFilter.ts`

**Interfaces:**
- Consumes: `GLSL_SIMPLEX`, `GLSL_FBM` (Task 3); `sdfToTexture` (Task 3).
- Produces: `class ProceduralWatercolorFilter extends Filter` with constructor `(opts: ProcWaterOpts)` and setters. This task renders **`T` as grayscale** (no bands, no color yet) clipped to the mask, to validate the field is smooth, nested, and lobe-decorrelated.
- `ProcWaterOpts = { sdf: Texture; sdfTexelWorldSize: number; seed: number; offsetBase: number; offsetNoiseAmp: number; warpAmp: number; shadowDir: [number,number]; shadowAmp: number; fbmB: number; paperC: number }`

- [ ] **Step 1: Implement the filter with a T-visualizing shader**

```ts
// src/lib/filters/ProceduralWatercolorFilter.ts
import { Filter, GlProgram, UniformGroup, defaultFilterVert, Texture } from 'pixi.js'
import { GLSL_SIMPLEX, GLSL_FBM } from '../watercolor/glslNoise'

export interface ProcWaterOpts {
  sdf: Texture
  sdfTexelWorldSize: number   // world units per SDF texel (crown-radius scaling)
  seed: number
  offsetBase: number          // >= lobe amplitude, in the SAME units as the SDF sample
  offsetNoiseAmp: number      // a1: 8-12% crown radius
  warpAmp: number             // small UV-space amplitude (~0.03); keep « 0.1 or nesting shears
  shadowDir: [number, number] // global, shared across instances — MUST be normalized in JS
  shadowAmp: number           // a2: ~5%
  fbmB: number                // T-field fBm weight (0.3-0.5)
  paperC: number              // T-field paper weight (0.05-0.15)
}

const FRAG = /* glsl */`
precision highp float;
in vec2 vTextureCoord;
out vec4 finalColor;
uniform sampler2D uSdf;
uniform float uTexelWorld, uSeed, uOffBase, uOffNoiseAmp, uWarpAmp, uShadowAmp, uFbmB, uPaperC;
uniform vec2 uShadowDir;
${GLSL_SIMPLEX}
${GLSL_FBM}

// deterministic per-seed phase — inject seed HERE, never into the texture coord.
float seedPhase(){ return fract(sin(uSeed * 12.9898) * 43758.5453) * 100.0; }

// puddle pseudo-distance: SDF sampled at uv (NOT seed-offset), tiny warp only.
// `sdfW` (silhouette distance, world units, neg inside) is exposed for the warm rim.
float puddleSdf(vec2 uv, out float inside, out float sdfW){
  float sp = seedPhase();
  // warp amplitude is small in UV space (uWarpAmp ~ 0.03); stays well within [0,1].
  vec2 wuv = uv + uWarpAmp * vec2(fbm(uv*4.0 + sp, 3), fbm(uv*4.0 - sp, 3));
  float sdfPx = texture(uSdf, clamp(wuv, 0.001, 0.999)).r; // signed pixels, neg inside
  sdfW = sdfPx * uTexelWorld;                              // -> world units
  vec2 c = uv - 0.5;
  float len = max(length(c), 1e-4);                        // guard center singularity
  vec2 n = c / len;
  float theta = atan(n.y, n.x);
  float angNoise = uOffNoiseAmp * snoise(vec2(cos(theta), sin(theta))*2.0 + sp);
  float shadow = uShadowAmp * dot(n, uShadowDir);          // uShadowDir normalized in JS
  float offset = uOffBase + angNoise + shadow;
  float pud = sdfW - offset;                               // negative inside inflated puddle
  inside = step(pud, 0.0);
  return pud;
}

float dryingField(vec2 uv, float pud){
  // normalize puddle sdf to ~[0,1] inside (0 at rim, 1 deep interior)
  float sdfN = clamp(-pud / max(uOffBase, 1e-3), 0.0, 1.0);
  float fb = uFbmB * fbm(uv*6.0 + uSeed*2.0, 4);      // [-0.5..0.5]-ish
  float paper = uPaperC * fbm(uv*40.0 + uSeed, 3);
  return sdfN + fb + paper;                            // T
}

void main(){
  float inside, sdfW; float pud = puddleSdf(vTextureCoord, inside, sdfW);
  if(inside < 0.5){ finalColor = vec4(0.0); return; }
  float T = dryingField(vTextureCoord, pud);
  finalColor = vec4(vec3(clamp(T,0.0,1.0)), 1.0);   // grayscale T for validation
}`

export class ProceduralWatercolorFilter extends Filter {
  private g: UniformGroup
  constructor(o: ProcWaterOpts) {
    const g = new UniformGroup({
      uTexelWorld: { value: o.sdfTexelWorldSize, type: 'f32' },
      uSeed: { value: o.seed, type: 'f32' },
      uOffBase: { value: o.offsetBase, type: 'f32' },
      uOffNoiseAmp: { value: o.offsetNoiseAmp, type: 'f32' },
      uWarpAmp: { value: o.warpAmp, type: 'f32' },
      uShadowDir: { value: new Float32Array(o.shadowDir), type: 'vec2<f32>' },
      uShadowAmp: { value: o.shadowAmp, type: 'f32' },
      uFbmB: { value: o.fbmB, type: 'f32' },
      uPaperC: { value: o.paperC, type: 'f32' },
    })
    super({
      glProgram: GlProgram.from({ vertex: defaultFilterVert, fragment: FRAG }),
      resources: { procUniforms: g, uSdf: o.sdf.source },
    })
    this.g = g
  }
  setSeed(v: number) { this.g.uniforms.uSeed = v }
  setFbmB(v: number) { this.g.uniforms.uFbmB = v }
  setPaperC(v: number) { this.g.uniforms.uPaperC = v }
}
```

- [ ] **Step 2: Temporarily wire into the tab to view it** (revert in Task 7's proper wiring, or leave the mode stubbed)

Add a minimal `mode === 'procedural'` branch in `TabBotanicalVariants.vue rebuild()` that: builds the mask `Float32Array` (reuse `silhouetteMask`-style rasterization already in `inkwashBake.ts` — extract or duplicate a small rasterizer), calls `computeMaskSdf` + `sdfToTexture`, creates a white `Sprite` sized `DISPLAY`, applies `ProceduralWatercolorFilter`, and masks it with `buildMaskGraphics(1)`. Choose `offsetBase` ≈ `dilation`-scale lobe amplitude in the same world units as `sdfTexelWorldSize` (start `sdfTexelWorldSize = DISPLAY/RASTER`, `offsetBase ≈ 8`).

- [ ] **Step 3: Verify the field visually**

Run: `npm run dev`, open Botanical Variants, `mode = procedural`. Then `npx tsx scripts/watercolor-shot.ts --label t-field`.
Expected (read `.watercolor/t-field.png`): a smooth grayscale gradient, darkest at the rim brightening inward, clipped to the silhouette, with gentle low-freq wobble — and NO tight echo of the leaf lobes (the `offsetBase` low-pass should have swallowed them). If lobes show, raise `offsetBase`.

- [ ] **Step 4: Commit**

```bash
git add src/lib/filters/ProceduralWatercolorFilter.ts src/tabs/TabBotanicalVariants.vue
git commit -m "feat(watercolor): procedural filter - puddle SDF + drying-time field"
```

---

## Task 5: Iso-band asymmetric darkening

**Files:**
- Modify: `src/lib/filters/ProceduralWatercolorFilter.ts`

**Interfaces:**
- Consumes: the `T` field from Task 4.
- Produces: a `density` scalar field (bands added), still rendered grayscale (dark = more pigment) for validation. Adds uniforms `uBandCount` (int, 5–7), `uEdgeWidth` (f32), `uBandGain` (f32). Adds setters `setBandCount`, `setEdgeWidth`, `setBandGain`.

- [ ] **Step 1: Add the band operator to the shader**

Replace `main()` and add a helper. Bands are an asymmetric spike in `(T - τ_k)` normalized by `fwidth(T)`; thresholds tighten toward the rim (low T). Handedness: the decay lives on the interior (higher-T) side.

```glsl
// non-uniform thresholds tightening toward the rim (T small = near rim)
float bandThreshold(int k, int n){
  float f = float(k+1)/float(n+1);      // 0..1
  return pow(f, 1.6);                    // tighter near rim (small T)
}
// asymmetric front profile: sharp on the low-T (advancing) side, exp decay into high-T.
float bandTerm(float T, float w, int n){
  // clamped analytic gradient (fwidth of the paper-noise term alone is jagged);
  // floor keeps thin lines finite, ceil stops paper high-freq blowing width up.
  float grad = clamp(length(vec2(dFdx(T), dFdy(T))), 2e-3, 1e-1);
  float acc = 0.0;
  // fixed 7-iteration loop + mask (non-const `break` fails some mobile compilers).
  for(int k=0;k<7;k++){
    float active = (k < n) ? 1.0 : 0.0;
    float tau = bandThreshold(k, max(n,1));
    float d = (T - tau)/(w*grad);         // signed, in line-widths
    // spike at d=0; quick rise on advancing (d<0) side, long exp decay inward (d>0).
    float spike = (d < 0.0) ? smoothstep(-1.0,0.0,d) : exp(-d*1.5);
    acc += spike * active;
  }
  return acc;   // corner at d=0 is the intended sharp pigment front; output is baked (static),
                // so no temporal Mach-band shimmer.
}
void main(){
  float inside, sdfW; float pud = puddleSdf(vTextureCoord, inside, sdfW);
  if(inside < 0.5){ finalColor = vec4(0.0); return; }
  float T = dryingField(vTextureCoord, pud);
  float bands = bandTerm(T, uEdgeWidth, uBandCount) * uBandGain;
  float density = bands;                       // base wash added in Task 6
  finalColor = vec4(vec3(clamp(1.0 - density,0.0,1.0)), 1.0); // dark = pigment
}
```

Add the three uniforms to the `UniformGroup` (`uBandCount` as `i32`, `uEdgeWidth` `f32` default `1.2`, `uBandGain` `f32` default `0.6`) and their setters.

- [ ] **Step 2: Verify bands appear**

Run: `npx tsx scripts/watercolor-shot.ts --label bands`
Expected (`.watercolor/bands.png`): several **nested, irregular dark contour lines** roughly following the puddle rim but wandering with the fBm, non-uniformly spaced (tighter near the rim). Each line is darker on its outer edge and fades inward (asymmetric). Vary `uSeed` across cells → different band arrangements.

- [ ] **Step 3: Commit**

```bash
git add src/lib/filters/ProceduralWatercolorFilter.ts
git commit -m "feat(watercolor): fwidth-normalized asymmetric iso-band tide-lines"
```

---

## Task 6: Plateau + 2-pigment K–M + warm mask rim + dither

**Files:**
- Modify: `src/lib/filters/ProceduralWatercolorFilter.ts`

**Interfaces:**
- Consumes: `density` (bands) + `T` from Task 5; pigment K/S from `pigmentKS` (Task 2) passed as uniforms.
- Produces: final composited RGBA. New uniforms: `uKA,uSA,uKB,uSB` (vec3), `uPaperColor` (vec3), `uPlateauLo,uPlateauHi` (f32), `uMixT0,uMixT1` (f32), `uBaseDensity` (f32), `uCoverKnee` (f32). Constructor now takes `pigA:{K,S}`, `pigB:{K,S}`, plus those scalars. Setters for the tuning-critical ones.
- **Pipeline order (strict, per spec §3.4b):** base wash density → **plateau** → **+ bands** → pigment split by `T` → K–M in K/S space → clip + warm rim → dither.

- [ ] **Step 1: Add K–M + plateau + rim + dither to the shader**

```glsl
// mirror of reflectanceInfinite() — K-M in K/S space, per channel
vec3 kmReflectance(vec3 K, vec3 S){
  vec3 ks = K / max(S, vec3(1e-4));
  vec3 R = 1.0 + ks - sqrt(ks*ks + 2.0*ks);
  return clamp(R, vec3(1e-4), vec3(1.0-1e-4));
}
// plateau: compress mid densities toward the wash constant (skews the histogram).
float plateau(float d, float lo, float hi){
  float t = smoothstep(lo, hi, d);
  return mix(lo, d, t);   // below lo -> flat plateau at lo; above hi -> unchanged
}
```

Replace `main()`:

```glsl
void main(){
  float inside, sdfW; float pud = puddleSdf(vTextureCoord, inside, sdfW);
  if(inside < 0.5){ finalColor = vec4(0.0); return; }
  float T = dryingField(vTextureCoord, pud);
  float sp = seedPhase();

  // 1) base wash with LOW-FREQ spatial variation, so the plateau does real work
  float base = uBaseDensity * (0.7 + 0.6 * (fbm(vTextureCoord*3.0 + sp, 3) * 0.5 + 0.5));
  // 2) plateau BEFORE bands (density field only, never T)
  float dens = plateau(base, uPlateauLo, uPlateauHi);
  // 3) + bands (additive in density)
  dens += bandTerm(T, uEdgeWidth, uBandCount) * uBandGain;

  // weak WARM mask rim: keyed off SILHOUETTE distance sdfW (~0 at edge, <0 inside),
  // NOT the puddle pud. Lost-and-found dropouts so it isn't a uniform halo.
  float rimBand = 1.0 - smoothstep(0.0, 3.0, -sdfW);       // ~1 within 3px inside silhouette
  rimBand *= 0.5 + 0.5 * snoise(vTextureCoord*20.0 + sp);  // dropouts
  dens += 0.4 * rimBand;                                    // 30-50% of a band's density

  if(dens < 1e-3){ finalColor = vec4(uPaperColor, 1.0); return; } // K-M is degenerate at 0

  // 4) pigment split by T (early-drying -> A green, late -> B warm) + warm rim enrichment.
  //    Concentration scales K (absorption) ONLY; coverage is a SEPARATE alpha (no double-count).
  float m = smoothstep(uMixT0, uMixT1, T);
  m = clamp(m + rimBand * 0.5, 0.0, 1.0);                   // half interior B-enrichment at rim
  vec3 K = mix(uKA, uKB, m) * dens;
  vec3 S = mix(uSA, uSB, m);
  vec3 R = kmReflectance(K, S);

  float cover = clamp(dens / uCoverKnee, 0.0, 1.0);         // opacity, independent of concentration
  vec3 col = mix(uPaperColor, R, cover);

  // 5) dither before 8-bit
  col += (ditherBlue(gl_FragCoord.xy) - 0.5) / 255.0;
  finalColor = vec4(col, 1.0);
}
```

Extend the `UniformGroup` with `uKA,uSA,uKB,uSB` (`vec3<f32>`), `uPaperColor` (`vec3<f32>`, e.g. `[0.96,0.93,0.84]`), `uPlateauLo` (0.12), `uPlateauHi` (0.5), `uMixT0` (0.2), `uMixT1` (0.85), `uBaseDensity` (0.5), `uCoverKnee` (0.35, coverage opacity knee). (`uRimGain` is removed — the rim now keys off `sdfW`, not a gain.) Update the constructor signature to accept `pigA`, `pigB` and set the K/S uniforms via `pigmentKS`. Add `GLSL_DITHER` to the shader concatenation.

- [ ] **Step 2: Verify color + histogram direction**

Run: `npx tsx scripts/watercolor-shot.ts --label full`
Expected (`.watercolor/full.png`): a green wash on cream paper with darker olive/brown **tide-line bands** (warmer at band rims), a subtly warm tidied silhouette edge (not a doubled outline), a broad flat light interior, and no posterization on close inspection. Different seeds read as different paintings.

- [ ] **Step 3: Commit**

```bash
git add src/lib/filters/ProceduralWatercolorFilter.ts
git commit -m "feat(watercolor): plateau + 2-pigment K-M (K/S space) + warm rim + dither"
```

---

## Task 7: Wire `mode: 'procedural'` into the tab (proper) + 2× bake

**Files:**
- Modify: `src/tabs/TabBotanicalVariants.vue`

**Interfaces:**
- Consumes: `ProceduralWatercolorFilter`, `computeMaskSdf`, `sdfToTexture`, `pigmentKS`.
- Produces: a third `<option value="procedural">` and its control group; per-plant SDF cached by `assetId`; per-seed filter instances; bake at 2× via `RenderTexture` then a mipped `Sprite`.

- [ ] **Step 1: Add the mode option + controls**

Add `<option value="procedural">procedural (algorithmic)</option>` to the `mode` select. Extend the `mode` ref type to `'texture' | 'sim' | 'procedural'`. Add a `<template v-else-if="mode === 'procedural'">` control block with sliders bound to new refs: `pwOffsetBase`, `pwWarpAmp`, `pwFbmB`, `pwPaperC`, `pwBandCount`, `pwEdgeWidth`, `pwBandGain`, `pwPlateauLo`, `pwPlateauHi`, `pwMixT0`, `pwMixT1`, `pwBaseDensity`, plus a global `pwShadowDir` (two sliders x/y) and `pwShadowAmp`. Add them all to the `scheduleRebuild` watch array.

- [ ] **Step 2: Add per-plant SDF cache + a mask rasterizer**

Extract a `rasterMask(polys, size, raster): Float32Array` helper (mirror `silhouetteMask` in `inkwashBake.ts`). Cache `{ assetId, sdfTex, texelWorld }` keyed by `plantId:dilation`; rebuild only when the key changes.

- [ ] **Step 3: Build procedural cells with 2× bake**

In `rebuild()`, add the `procedural` branch:

```ts
// pseudocode within the seed loop
const pig = mode.value === 'procedural'
const filter = new ProceduralWatercolorFilter({
  sdf: sdfTex, sdfTexelWorldSize: texelWorld, seed,
  offsetBase: pwOffsetBase.value, offsetNoiseAmp: pwOffsetBase.value * 0.35,
  warpAmp: pwWarpAmp.value, shadowDir: [pwShadowDirX.value, pwShadowDirY.value],
  shadowAmp: pwShadowAmp.value, fbmB: pwFbmB.value, paperC: pwPaperC.value,
  pigA: pigmentKS([0.35,0.62,0.48], [0.06,0.20,0.13]),
  pigB: pigmentKS([0.80,0.56,0.24], [0.26,0.13,0.05]),
  bandCount: pwBandCount.value, edgeWidth: pwEdgeWidth.value, bandGain: pwBandGain.value,
  plateauLo: pwPlateauLo.value, plateauHi: pwPlateauHi.value,
  mixT0: pwMixT0.value, mixT1: pwMixT1.value, baseDensity: pwBaseDensity.value,
})
const white = new Sprite(Texture.WHITE); white.width = white.height = DISPLAY * 2; white.filters = [filter]
// render white->RenderTexture at 2x, wrap in a Sprite sized DISPLAY (mip down), mask with buildMaskGraphics(1)
```

Use `app.renderer.generateTexture({ target: white, resolution: 2 })` for the 2× bake, then a `Sprite` scaled to `DISPLAY` with `scaleMode:'linear'`. Mask with `buildMaskGraphics(1)`. Keep the existing contour (`buildContour(seed)`).

**Consumer-side notes (from the GLSL review):**
- **Normalize `shadowDir` in JS** before passing it (shader assumes it's unit-length): `const s=Math.hypot(dx,dy)||1; shadowDir=[dx/s,dy/s]`.
- Slider ranges: `pwWarpAmp` ∈ [0, 0.08] default 0.03 (larger shears T-nesting); `pwOffsetBase` ∈ [4, 24] default 10 (must ≥ lobe amplitude to swallow lobes); `pwBandCount` ∈ [3, 7] int.
- **Space alignment:** the SDF is built in `RASTER` (512) space; the white sprite is `DISPLAY`-sized and the clip mask uses `scalePoly` (centered `DISPLAY` box). The filter samples `uSdf` in the sprite's own 0..1 UV, so the SDF texture must correspond 1:1 to the sprite quad. Rasterize the mask for the SDF at the **same framing** as the sprite (fill the full raster with the silhouette scaled to the sprite), or the puddle won't register with the clip. Verify by toggling the contour off and checking the wash fills the silhouette exactly.

- [ ] **Step 4: Verify the grid**

Run: `npm run dev`; open Botanical Variants; `mode = procedural`; drag sliders; then `npx tsx scripts/watercolor-shot.ts --label grid`.
Expected (`.watercolor/grid.png`): a 3×3 grid of visibly distinct watercolor variants of the same plant, each with nested irregular bands, warm-edged silhouette, and the hand-drawn contour. FPS HUD stays interactive.

- [ ] **Step 5: Commit**

```bash
git add src/tabs/TabBotanicalVariants.vue
git commit -m "feat(watercolor): wire procedural mode into Botanical Variants (2x bake)"
```

---

## Task 8: Objective acceptance analysis + reference compare

**Files:**
- Create: `scripts/watercolor-accept.ts`

**Interfaces:**
- Consumes: a rendered PNG of one procedural cell + one `variants-realtex` crop.
- Produces: prints three metrics and PASS/FAIL vs thresholds — (1) **edge asymmetry** (mean skew of the luminance derivative across detected band crossings must be non-zero / one-sided), (2) **band irregularity** (coefficient of variation of inter-band spacing > 0.25 = non-periodic), (3) **histogram skew** (Pearson skew of the luminance histogram > 0 with a dominant light-plateau bin). Calibrated per spec §5 (do NOT require fully free-floating bands — low-freq silhouette echo is allowed).

- [ ] **Step 1: Implement the analysis script**

Load the PNG (use `pngjs` — add as devDep), compute luminance, then: (a) sample N horizontal/vertical scanlines, detect local minima (band crossings), fit the derivative asymmetry around each; (b) collect inter-band spacings and compute CoV; (c) build a 64-bin luminance histogram and compute Pearson mode-skew and the fraction in the top-3 light bins (the plateau). Print a table and overall PASS if all three thresholds met.

```ts
// scripts/watercolor-accept.ts — skeleton (fill per spec above)
import { PNG } from 'pngjs'; import { readFileSync } from 'node:fs'
function luma(png: PNG){ /* Float32Array of 0..1 luminance */ }
function edgeAsymmetry(l: Float32Array, w: number, h: number): number { /* mean one-sidedness */ }
function bandSpacingCoV(l: Float32Array, w: number, h: number): number { /* CoV of minima spacing */ }
function histSkew(l: Float32Array): { skew: number; plateauFrac: number } { /* Pearson + top bins */ }
const png = PNG.sync.read(readFileSync(process.argv[2]))
// ... compute, print, exit(0) on PASS else exit(1)
```

- [ ] **Step 2: Run against a procedural cell and the reference**

Run: `npx tsx scripts/watercolor-accept.ts .watercolor/full.png` and compare printed metrics to `npx tsx scripts/watercolor-accept.ts <realtex-crop>.png`.
Expected: procedural metrics land in the same ballpark as the realtex crop; overall PASS on all three (given the §5 calibration for #2).

- [ ] **Step 3: Read the crops side-by-side with Playwright**

Use the Playwright MCP (or `watercolor-shot.ts`) to capture a procedural cell and open `variants-realtex.png`; visually confirm the bar: "can't easily tell which is procedural," allowing the stage-3 gap in band freedom.

- [ ] **Step 4: Commit**

```bash
git add scripts/watercolor-accept.ts package.json package-lock.json
git commit -m "feat(watercolor): objective acceptance analysis (edge/band/histogram)"
```

---

## Self-Review notes (author)

- **Spec coverage:** §3.2 puddle/offset → Task 4; §3.3 T + fwidth bands → Tasks 4–5; §3.4 K–M K/S → Task 6; §3.4b pipeline order → Task 6 `main()`; §3.5 plateau+dither → Task 6; §4 vehicle/uniforms → Tasks 4,6,7; §4.2 R16F SDF → Tasks 1,3; §5 acceptance → Task 8; §6 vendored GLSL/no-#include → Task 3; bake-2× → Task 7. Granulation/blooms/stacking correctly ABSENT (later stages).
- **Known risk to flag at execution:** the exact GLSL is a *compiling first cut* meant to be tuned live in the lab; band/plateau/mix constants will move during the "try it out" phase — that is expected, not a plan defect. The acceptance script (Task 8) is the objective gate for when tuning is "done."
- **Type consistency:** `pigmentKS` returns `{K,S}` (Task 2) consumed as `pigA/pigB` in Tasks 6–7; `sdfToTexture`→`Texture` (Task 3) consumed as `sdf` in Task 4; `computeMaskSdf`→`Float32Array` (Task 1) feeds `sdfToTexture`.
