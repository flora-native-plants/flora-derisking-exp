# Fable pipeline reference — full source of the pencil-ribbon rendering path

Companion to `fable-material-round2.md`. Full source of every file in the stroke-render
pipeline, so you can see exactly how strokes are built, shaded, and composited over paper.

## 1. src/lib/strokeRibbon.ts — ribbon geometry builder + stroke shaders (the thing to tune)
```ts
// strokeRibbon.ts — Phase B: render a stroke as a ribbon MESH with a stroke-space graphite
// shader, instead of a full-screen filter. The mesh is real geometry through the normal
// (MSAA'd) pipeline, so it's crisp at any zoom and costs per-stroke, not per-screen — this is
// what kills the stairstepping and the filter perf cliff by construction.
//
// Approach (first cut): CPU-expand the cached op-list into a ribbon (two verts per centreline
// point, ±normal × halfWidth), one mesh per run so each run gets its own length uniform for
// taper. Width is authored in world units (halfWidth = strokePx / zoom) and the ribbon is rebuilt
// on zoom — but from the CACHED op-list, so the wobble never re-randomizes. All the graphite
// (tone along the stroke, tapered ends, ragged edge, paper-tooth breakup) lives in the fragment
// shader. Meant to be multiply-blended over the paper.

import { Mesh, MeshGeometry, Shader, GlProgram, UniformGroup, Texture } from 'pixi.js'
import type { TextureSource } from 'pixi.js'

type Op = { op: string; data: number[] }
type Pt = [number, number]

const BEZIER_STEPS = 12

function cubic(p0: Pt, c1: Pt, c2: Pt, p1: Pt, t: number): Pt {
  const u = 1 - t, a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, e = t * t * t
  return [a * p0[0] + b * c1[0] + c * c2[0] + e * p1[0], a * p0[1] + b * c1[1] + c * c2[1] + e * p1[1]]
}

/** Split an op-list into one polyline per run (a new run starts at each `move`). */
function runsFromOps(ops: Op[]): Pt[][] {
  const runs: Pt[][] = []
  let cur: Pt[] = []
  let pen: Pt = [0, 0]
  for (const { op, data } of ops) {
    if (op === 'move') { if (cur.length > 1) runs.push(cur); pen = [data[0], data[1]]; cur = [pen] }
    else if (op === 'lineTo') { pen = [data[0], data[1]]; cur.push(pen) }
    else if (op === 'bcurveTo') {
      const c1: Pt = [data[0], data[1]], c2: Pt = [data[2], data[3]], p: Pt = [data[4], data[5]]
      for (let s = 1; s <= BEZIER_STEPS; s++) cur.push(cubic(pen, c1, c2, p, s / BEZIER_STEPS))
      pen = p
    }
  }
  if (cur.length > 1) runs.push(cur)
  return runs
}

/** Ribbon geometry for one run: positions = ±normal-expanded verts, uv = (arcLength, side 0|1). */
function runGeometry(pts: Pt[], halfWidth: number): { geo: MeshGeometry; runLen: number } | null {
  const p = pts.filter((q, i) => i === 0 || Math.hypot(q[0] - pts[i - 1][0], q[1] - pts[i - 1][1]) > 1e-6)
  if (p.length < 2) return null
  const n = p.length
  const s: number[] = new Array(n)
  s[0] = 0
  for (let i = 1; i < n; i++) s[i] = s[i - 1] + Math.hypot(p[i][0] - p[i - 1][0], p[i][1] - p[i - 1][1])
  const positions = new Float32Array(n * 4)
  const uvs = new Float32Array(n * 4)
  for (let i = 0; i < n; i++) {
    const a = p[Math.max(0, i - 1)], b = p[Math.min(n - 1, i + 1)]
    let tx = b[0] - a[0], ty = b[1] - a[1]
    const tl = Math.hypot(tx, ty) || 1
    tx /= tl; ty /= tl
    const nx = -ty, ny = tx
    positions[i * 4] = p[i][0] + nx * halfWidth; positions[i * 4 + 1] = p[i][1] + ny * halfWidth
    positions[i * 4 + 2] = p[i][0] - nx * halfWidth; positions[i * 4 + 3] = p[i][1] - ny * halfWidth
    uvs[i * 4] = s[i]; uvs[i * 4 + 1] = 0
    uvs[i * 4 + 2] = s[i]; uvs[i * 4 + 3] = 1
  }
  const indices = new Uint32Array((n - 1) * 6)
  for (let i = 0; i < n - 1; i++) {
    const v = i * 2, o = i * 6
    indices[o] = v; indices[o + 1] = v + 1; indices[o + 2] = v + 2
    indices[o + 3] = v + 1; indices[o + 4] = v + 3; indices[o + 5] = v + 2
  }
  return { geo: new MeshGeometry({ positions, uvs, indices, topology: 'triangle-list' }), runLen: s[n - 1] }
}

// ---- shader -----------------------------------------------------------------
const VERT = `#version 300 es
in vec2 aPosition;   // expanded ribbon vertex, world coords
in vec2 aUV;         // (arcLength_world, side 0|1)
out vec2 vUV;
out vec2 vWorld;
uniform mat3 uProjectionMatrix;
uniform mat3 uWorldTransformMatrix;
uniform mat3 uTransformMatrix;
void main() {
  mat3 mvp = uProjectionMatrix * uWorldTransformMatrix * uTransformMatrix;
  gl_Position = vec4((mvp * vec3(aPosition, 1.0)).xy, 0.0, 1.0);
  vUV = aUV;
  vWorld = aPosition;
}`

const FRAG = `#version 300 es
precision highp float;
in vec2 vUV;      // (s world, side 0..1)
in vec2 vWorld;
out vec4 finalColor;

uniform sampler2D uPaperTex;
uniform float uZoom;
uniform float uRunLen;
uniform float uGrainScale;
uniform vec3  uColor;        // warm graphite
uniform float uTaperLen;     // world units to taper at each end
uniform float uToneAmp;      // 0..1 alpha variation along stroke
uniform float uTooth;        // 0..1 paper-tooth breakup
uniform float uEdgeSoft;     // 0..1 ragged-edge softness

float hash11(float p){ p = fract(p * 0.1031); p *= p + 33.33; p *= p + p; return fract(p); }
// smooth 1-D value noise
float vnoise1(float x){ float i = floor(x), f = fract(x); float u = f*f*(3.0-2.0*f); return mix(hash11(i), hash11(i+1.0), u); }
float lum(vec3 c){ return dot(c, vec3(0.299,0.587,0.114)); }
// paper height, world-anchored, two-octave crossfade for constant apparent size on zoom
float paperHeight(vec2 uv){
  float L = log2(max(uZoom,0.0001)); float o = floor(L); float f = fract(L);
  float h0 = lum(texture(uPaperTex, uv*exp2(o)).rgb);
  float h1 = lum(texture(uPaperTex, uv*exp2(o+1.0)).rgb);
  return mix(h0,h1,f);
}

void main(){
  float s = vUV.x;
  float side = vUV.y * 2.0 - 1.0;       // -1..1 across the ribbon
  float edge = abs(side);               // 0 centre -> 1 edge

  // 1. tone along the stroke (low-freq graphite deposit)
  float tone = mix(1.0 - uToneAmp, 1.0, vnoise1(s * 0.03 + 7.0));

  // 2. tapered entry/exit
  float d = min(s, uRunLen - s);
  float taper = clamp(d / max(uTaperLen, 1.0), 0.0, 1.0);

  // 3. ragged, slightly eroded edge (jitter the falloff along s)
  float jit = (vnoise1(s * 0.6) - 0.5) * 0.35;
  float aa = fwidth(edge) + 1e-4;
  float cover = 1.0 - smoothstep(1.0 - uEdgeSoft - jit - aa, 1.0 + jit, edge);

  // 4. paper tooth: graphite skips valleys; bites harder where tone is light
  float h = paperHeight(vWorld / uGrainScale);
  float tooth = mix(1.0, h, uTooth * (1.3 - tone));

  float a = clamp(tone * taper * cover * tooth, 0.0, 1.0);
  finalColor = vec4(uColor * a, a);      // premultiplied; mesh uses multiply blend
}`

let _program: GlProgram | null = null
function program(): GlProgram {
  if (!_program) _program = GlProgram.from({ vertex: VERT, fragment: FRAG, name: 'stroke-ribbon' })
  return _program
}

export interface StrokeRibbonParams {
  color: [number, number, number]
  grainScale: number
  taperLen: number
  toneAmp: number
  tooth: number
  edgeSoft: number
}

export const STROKE_RIBBON_DEFAULTS: StrokeRibbonParams = {
  color: [0.17, 0.16, 0.15], // warm graphite ~#2b2825
  grainScale: 40,
  taperLen: 12,
  toneAmp: 0.4,
  tooth: 0.5,
  edgeSoft: 0.5,
}

/**
 * Build one Mesh per run of a cached op-list. `halfWidth` is in WORLD units (= strokePx/zoom),
 * so callers rebuild on zoom for screen-constant width. `paper` is the tiling paper texture.
 */
export function buildStrokeMeshes(
  ops: Op[],
  halfWidth: number,
  paper: TextureSource,
  p: StrokeRibbonParams = STROKE_RIBBON_DEFAULTS,
): Mesh[] {
  const meshes: Mesh[] = []
  for (const run of runsFromOps(ops)) {
    const g = runGeometry(run, halfWidth)
    if (!g) continue
    const uniforms = new UniformGroup({
      uZoom:       { value: 1, type: 'f32' },
      uRunLen:     { value: g.runLen, type: 'f32' },
      uGrainScale: { value: p.grainScale, type: 'f32' },
      uColor:      { value: new Float32Array(p.color), type: 'vec3<f32>' },
      uTaperLen:   { value: p.taperLen, type: 'f32' },
      uToneAmp:    { value: p.toneAmp, type: 'f32' },
      uTooth:      { value: p.tooth, type: 'f32' },
      uEdgeSoft:   { value: p.edgeSoft, type: 'f32' },
    })
    const shader = new Shader({ glProgram: program(), resources: { uPaperTex: paper, strokeUniforms: uniforms } })
    // Mesh's shader generic expects a TextureShader; our custom shader binds its texture as a
    // resource, so the cast is safe (runtime-verified: renders with no console errors).
    const mesh = new Mesh({ geometry: g.geo, shader: shader as any })
    mesh.blendMode = 'multiply'
    meshes.push(mesh)
  }
  return meshes
}

```

## 2. src/tabs/TabPencilRibbon.vue — wiring: meshes, camera, paper sprite, multiply, rebuild-on-zoom
```vue
<script setup lang="ts">
/**
 * Pencil Ribbon (Phase B) — strokes as ribbon MESHES with a stroke-space graphite shader,
 * instead of the full-screen PaperGrainFilter (which stairstepped + tanked fps at zoom).
 * Geometry from the cached kinematic op-list, CPU-expanded to a ribbon, rebuilt on zoom for
 * screen-constant width (wobble stays stable — it's cached). Material (tone/taper/ragged/tooth)
 * is in the fragment shader; meshes multiply-blend over a screen-fixed paper sprite.
 */
import { ref, reactive, onMounted, onUnmounted, markRaw, watch } from 'vue'
import { Application, Assets, Container, Sprite, Texture, Mesh } from 'pixi.js'
import { kinematicOpsForPath } from '../lib/kinematicStroke'
import { buildStrokeMeshes, STROKE_RIBBON_DEFAULTS } from '../lib/strokeRibbon'
import { PaperGrainFilter } from '../lib/filters/PaperGrainFilter'
import { pencilTestShapes } from '../fixtures/pencilTestShapes'
import { useFps } from '../shared/useFps'

const { fps, frameMs } = useFps()
const canvasEl = ref<HTMLCanvasElement>()

const opts = reactive({
  strokeWidth: 2.5,
  squiggle: 6, cpSpacing: 40, overshoot: 4, cornerAngle: 35, seed: 42,
  taperLen: STROKE_RIBBON_DEFAULTS.taperLen,
  toneAmp: STROKE_RIBBON_DEFAULTS.toneAmp,
  tooth: STROKE_RIBBON_DEFAULTS.tooth,
  edgeSoft: STROKE_RIBBON_DEFAULTS.edgeSoft,
  paper: true,
})

let app = markRaw({} as Application)
let world = markRaw({} as Container)
let paperSprite = markRaw({} as Sprite)
let paperFilter = markRaw({} as PaperGrainFilter)
let paperSource = markRaw({} as any)
let meshes: Mesh[] = []
let camX = 0, camY = 0, zoom = 1
let isPanning = false, panStart = { x: 0, y: 0 }

function rgb(c: number): [number, number, number] {
  return [((c >> 16) & 255) / 255, ((c >> 8) & 255) / 255, (c & 255) / 255]
}

function rebuild(): void {
  world.removeChildren().forEach((c) => c.destroy())
  meshes = []
  const halfWidth = (opts.strokeWidth / zoom) / 2
  for (const s of pencilTestShapes()) {
    const ops = kinematicOpsForPath(s.d, {
      squiggle: opts.squiggle, cpSpacing: opts.cpSpacing, seed: opts.seed,
      overshoot: opts.overshoot, cornerAngle: opts.cornerAngle,
    })
    const built = buildStrokeMeshes(ops, halfWidth, paperSource, {
      ...STROKE_RIBBON_DEFAULTS, color: rgb(s.color),
      taperLen: opts.taperLen, toneAmp: opts.toneAmp, tooth: opts.tooth, edgeSoft: opts.edgeSoft,
    })
    for (const m of built) { world.addChild(m); meshes.push(m) }
  }
  setMeshZoom()
}

function setMeshZoom(): void {
  for (const m of meshes) {
    const u = (m.shader!.resources.strokeUniforms as any).uniforms
    u.uZoom = zoom
  }
}

function syncCamera(): void {
  if (paperSprite.position) paperSprite.position.set(-camX, -camY)
  paperFilter.setCamera?.(camX, camY, zoom)
  setMeshZoom()
}

onMounted(async () => {
  const canvas = canvasEl.value!
  app = markRaw(new Application())
  await app.init({ canvas, width: canvas.clientWidth, height: canvas.clientHeight, antialias: true, backgroundAlpha: 0, resolution: devicePixelRatio, autoDensity: true })
  camX = canvas.clientWidth / 2; camY = canvas.clientHeight / 2
  app.stage.position.set(camX, camY)

  paperFilter = markRaw(new PaperGrainFilter())
  paperSprite = markRaw(new Sprite(Texture.WHITE))
  paperSprite.setSize(canvas.clientWidth, canvas.clientHeight)
  app.stage.addChild(paperSprite)
  world = markRaw(new Container())
  app.stage.addChild(world)

  const tex = await Assets.load('/textures/paper/watercolor-height.png')
  tex.source.style.addressMode = 'repeat'; tex.source.style.update()
  paperSource = markRaw(tex.source)
  paperFilter.setPaperTexture(tex.source)
  applyPaper()
  rebuild()

  canvas.addEventListener('wheel', onWheel, { passive: false })
  canvas.addEventListener('pointerdown', onPD)
  window.addEventListener('pointermove', onPM)
  window.addEventListener('pointerup', onPU)
})

onUnmounted(() => {
  canvasEl.value?.removeEventListener('wheel', onWheel)
  canvasEl.value?.removeEventListener('pointerdown', onPD)
  window.removeEventListener('pointermove', onPM)
  window.removeEventListener('pointerup', onPU)
  app?.destroy(true, { children: true, texture: true, context: true })
})

// Rebuild on any generator/material change; paper toggle is cheap.
watch(() => [opts.strokeWidth, opts.squiggle, opts.cpSpacing, opts.overshoot, opts.cornerAngle, opts.seed, opts.taperLen, opts.toneAmp, opts.tooth, opts.edgeSoft], () => rebuild())
watch(() => opts.paper, () => applyPaper())

function applyPaper(): void {
  paperSprite.filters = opts.paper ? [paperFilter] : []
  paperSprite.visible = opts.paper
  syncCamera()
}

function onWheel(e: WheelEvent) {
  e.preventDefault()
  const rect = canvasEl.value!.getBoundingClientRect()
  const sx = e.clientX - rect.left, sy = e.clientY - rect.top
  const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12
  const wx = (sx - camX) / zoom, wy = (sy - camY) / zoom
  zoom = Math.max(0.1, Math.min(30, zoom * factor))
  camX = sx - wx * zoom; camY = sy - wy * zoom
  app.stage.position.set(camX, camY)
  world.scale.set(zoom)
  syncCamera()
  rebuild() // half-width is world-space; rebuild from the cached op-list (wobble stays stable)
}
function onPD(e: PointerEvent) { isPanning = true; panStart = { x: e.clientX - camX, y: e.clientY - camY }; (e.target as HTMLElement).setPointerCapture(e.pointerId) }
function onPM(e: PointerEvent) { if (!isPanning) return; camX = e.clientX - panStart.x; camY = e.clientY - panStart.y; app.stage.position.set(camX, camY); syncCamera() }
function onPU() { isPanning = false }
function reseed() { opts.seed = Math.floor(Math.random() * 100000) + 1 }
</script>

<template>
  <div class="wrap">
    <canvas ref="canvasEl" />
    <div class="hud">
      <div class="fps">{{ fps }} <span>fps</span></div>
      <div>{{ frameMs }} ms</div>
      <div>zoom: {{ zoom.toFixed(2) }}×</div>
    </div>
    <div class="panel">
      <div class="title">Pencil Ribbon · mesh + stroke shader (Phase B)</div>
      <label>Stroke width <b>{{ opts.strokeWidth.toFixed(1) }}px</b><input type="range" min="0.5" max="8" step="0.5" v-model.number="opts.strokeWidth" /></label>
      <label>Squiggle <b>{{ opts.squiggle.toFixed(1) }}</b><input type="range" min="0" max="20" step="0.5" v-model.number="opts.squiggle" /></label>
      <label>Taper len <b>{{ opts.taperLen.toFixed(0) }}</b><input type="range" min="0" max="60" step="1" v-model.number="opts.taperLen" /></label>
      <label>Tone amp <b>{{ opts.toneAmp.toFixed(2) }}</b><input type="range" min="0" max="0.9" step="0.05" v-model.number="opts.toneAmp" /></label>
      <label>Tooth <b>{{ opts.tooth.toFixed(2) }}</b><input type="range" min="0" max="1" step="0.05" v-model.number="opts.tooth" /></label>
      <label>Edge softness <b>{{ opts.edgeSoft.toFixed(2) }}</b><input type="range" min="0" max="0.95" step="0.05" v-model.number="opts.edgeSoft" /></label>
      <label class="chk"><input type="checkbox" v-model="opts.paper" /> Paper background</label>
      <button class="btn" @click="reseed">🎲 Re-seed</button>
    </div>
    <div class="hint"><kbd>scroll</kbd> zoom · <kbd>drag</kbd> pan — ribbon meshes, no full-screen filter</div>
  </div>
</template>

<style scoped>
.wrap { position: relative; width: 100%; height: 100%; background: #f4f1ea; }
canvas { display: block; width: 100%; height: 100%; cursor: grab; }
canvas:active { cursor: grabbing; }
.hud { position: absolute; top: 10px; left: 10px; font-family: monospace; font-size: 12px; color: #3a3a3a; line-height: 1.7; pointer-events: none; }
.fps { font-size: 18px; font-weight: bold; } .fps span { font-size: 12px; color: #888; }
.panel { position: absolute; top: 10px; right: 10px; font-family: monospace; font-size: 11px; color: #333; line-height: 1.5; background: rgba(255,255,255,0.9); padding: 12px 14px; border-radius: 6px; border: 1px solid #ddd; width: 230px; }
.title { font-weight: bold; margin-bottom: 10px; color: #222; }
.panel label { display: block; margin-bottom: 8px; }
.panel label b { color: #4b7a4b; }
.panel input[type=range] { width: 100%; margin-top: 2px; }
.chk { display: flex; align-items: center; gap: 6px; }
.btn { width: 100%; padding: 5px; font-family: monospace; font-size: 11px; cursor: pointer; background: #4b7a4b; color: #fff; border: none; border-radius: 4px; margin-top: 6px; }
.hint { position: absolute; bottom: 10px; left: 50%; transform: translateX(-50%); font-family: monospace; font-size: 11px; color: #666; background: rgba(255,255,255,0.7); padding: 5px 12px; border-radius: 4px; }
kbd { background: #eee; border: 1px solid #ccc; border-radius: 3px; padding: 1px 5px; font-size: 10px; }
</style>

```

## 3. src/lib/filters/PaperGrainFilter.ts — the PAPER BACKGROUND shader the strokes multiply over
(mode 0 = paper; the two-octave "surface-stable fractal dithering" the stroke tooth reuses lives here)
```ts
// PaperGrainFilter — world-anchored paper/graphite grain for the Sketch Style tab.
//
// The grain SOURCE can be either procedural value-noise (looks like digital static — kept only
// for A/B) or a REAL scanned paper/graphite texture (authentic). Either way the same two hard
// problems are solved in the shader:
//
//   1. World-anchoring (uWorldMatrix, exactly like GridFilter) — grain is glued to the drawing
//      and pans with it, instead of the "shower door" slide.
//   2. Surface-stable fractal dithering — the grain is sampled at two octaves 2^floor(log2 zoom)
//      and the next, cross-faded by fract(log2 zoom), so the apparent grain size stays constant
//      as you zoom (no bloat/pixelation) even though it's anchored in world space.
//
// Applied to a full-screen, screen-fixed Sprite behind the strokes (its bounds == the canvas,
// so the filter covers everything). Bind a paper texture via setPaperTexture(); it should be
// tiling (addressMode 'repeat').

import { Filter, GlProgram, UniformGroup, Texture, defaultFilterVert } from 'pixi.js'
import type { TextureSource } from 'pixi.js'
import { GLSL_HASH21_VNOISE } from './glslNoise'

const FRAG = `
precision highp float;

in  vec2 vTextureCoord;
out vec4 finalColor;

uniform sampler2D uTexture;      // filter input (the white paper sprite) — unused for color
uniform sampler2D uPaperTex;     // real paper/graphite texture (tiling)
uniform vec4 uInputSize;
uniform vec4 uOutputFrame;
uniform mat3  uWorldMatrix;      // screen -> world (inverse camera)
uniform float uZoom;

uniform float uGrainScale;       // world units per texture tile (bigger = coarser)
uniform float uGrainContrast;    // 0..1 how strongly grain darkens the paper
uniform vec3  uPaperColor;       // paper base color
uniform float uUseTexture;       // 0 = procedural noise (static-looking), 1 = real texture
uniform float uAnchor;           // 0 = world-lock (correct), 1 = screen-lock (shower door)
uniform float uOctaves;          // 0 = single freq (pixelates on zoom), 1 = fractal octaves
uniform float uShowGrain;        // 0 = paper, 1 = visualize raw grain field
uniform float uMode;             // 0 = paper background, 1 = graphite-in-stroke modulation
uniform float uInkGrain;         // 0..1 how much grain breaks up the strokes (mode 1)
uniform float uSurface;          // 0 = flat luminance, 1 = height->normal lighting + directional
uniform vec2  uLightDir;         // raking light direction (cos,sin of angle)
uniform float uBumpStrength;     // steepness of the derived surface normal
uniform float uLightStrength;    // how strongly relief shading tints the paper

${GLSL_HASH21_VNOISE}

float sampleSource(vec2 uv) {
  if (uUseTexture > 0.5) {
    return dot(texture(uPaperTex, uv).rgb, vec3(0.299, 0.587, 0.114)); // luminance
  }
  return vnoise(uv);
}

// Fractal-octave sample: constant apparent tile size at any zoom, anchored to uv (world).
float grainField(vec2 uv) {
  if (uOctaves < 0.5) return sampleSource(uv);
  float L   = log2(max(uZoom, 0.0001));
  float oct = floor(L);
  float f   = fract(L);
  float n0  = sampleSource(uv * exp2(oct));
  float n1  = sampleSource(uv * exp2(oct + 1.0));
  return mix(n0, n1, f);
}

void main() {
  vec2 screenPx = vTextureCoord * uInputSize.xy + uOutputFrame.xy;
  vec2 worldP   = (uWorldMatrix * vec3(screenPx, 1.0)).xy;

  // World-lock (correct) vs screen-lock (deliberately wrong, for the shower-door demo).
  vec2 guv = mix(worldP, screenPx, uAnchor) / uGrainScale;

  float g = grainField(guv);   // ~0..1, luminance as height: 1 = peak, 0 = tooth valley

  // Derive a surface normal from the height field ONLY when something needs it (surface lighting,
  // the normal-map viz, or graphite-in-stroke). The flat paper background — the default — skips
  // these 4 extra grainField() evals (8 texture taps/pixel), which was the full-screen paper
  // pass's dominant cost for something that isn't even used. Uniform branch = coherent, cheap.
  vec3 N = vec3(0.0, 0.0, 1.0);
  float lit = 1.0;
  if (uSurface > 0.5 || uShowGrain > 0.5 || uMode > 0.5) {
    float e  = 0.02;
    float hxp = grainField(guv + vec2(e, 0.0));
    float hxn = grainField(guv - vec2(e, 0.0));
    float hyp = grainField(guv + vec2(0.0, e));
    float hyn = grainField(guv - vec2(0.0, e));
    N   = normalize(vec3(-(hxp - hxn) * uBumpStrength, -(hyp - hyn) * uBumpStrength, 1.0));
    vec3 L = normalize(vec3(uLightDir, 0.55));
    lit = clamp(dot(N, L) + 0.15, 0.0, 1.0);
  }

  if (uShowGrain > 0.5 && uMode < 0.5) {
    vec3 vis = uSurface > 0.5 ? (N * 0.5 + 0.5) : vec3(g); // normal map vs raw height
    finalColor = vec4(vis, 1.0);
    return;
  }

  if (uMode < 0.5) {
    // Paper background. Flat = luminance multiply; surface = relief-lit tooth.
    float flatShade   = mix(1.0, g,   uGrainContrast);
    float reliefShade = mix(1.0, lit, uGrainContrast * uLightStrength);
    float shade = mix(flatShade, reliefShade, uSurface);
    finalColor = vec4(uPaperColor * shade, 1.0);
  } else {
    // Graphite-in-stroke. Filter input is premultiplied.
    vec4 ink = texture(uTexture, vTextureCoord);
    vec3 rgb = ink.a > 0.001 ? ink.rgb / ink.a : ink.rgb;

    // Stroke tangent from the alpha gradient (grad = across-stroke; perp = along-stroke).
    vec2 px = 1.0 / uInputSize.xy;
    float aL = texture(uTexture, vTextureCoord - vec2(px.x, 0.0)).a;
    float aR = texture(uTexture, vTextureCoord + vec2(px.x, 0.0)).a;
    float aD = texture(uTexture, vTextureCoord - vec2(0.0, px.y)).a;
    float aU = texture(uTexture, vTextureCoord + vec2(0.0, px.y)).a;
    vec2 tangent = normalize(vec2(-(aU - aD), (aR - aL)) + vec2(1e-5));

    // Graphite catches on micro-facets facing INTO the pencil's travel (directional tooth).
    float face  = clamp(-dot(N.xy, tangent) * 2.0, 0.0, 1.0);
    float basis = mix(g, mix(g, face, 0.7), uSurface); // isotropic peaks -> directional catch
    float deposit = mix(1.0 - uInkGrain, 1.0, basis);

    float a = ink.a * deposit;
    vec3 col = rgb * mix(1.0 - 0.25 * uInkGrain, 1.0, basis);
    finalColor = vec4(col * a, a);
  }
}
`

export interface PaperGrainParams {
  grainScale: number
  grainContrast: number
  paperColor: [number, number, number]
  useTexture: number
  anchor: number   // 0 world, 1 screen
  octaves: number  // 0 single, 1 fractal
  showGrain: number
  mode: number     // 0 paper background, 1 graphite-in-stroke
  inkGrain: number // 0..1 stroke breakup (mode 1)
  surface: number  // 0 flat, 1 height->normal lighting + directional tooth
  lightDir: [number, number] // cos,sin of the raking light angle
  bumpStrength: number
  lightStrength: number
}

export const PAPER_GRAIN_DEFAULTS: PaperGrainParams = {
  grainScale: 40,         // world units per texture tile (larger = less obvious tiling)
  grainContrast: 0.7,
  paperColor: [0.957, 0.945, 0.918], // #f4f1ea
  useTexture: 1,
  anchor: 0,
  octaves: 1,
  showGrain: 0,
  mode: 0,
  inkGrain: 0.55,
  surface: 0,
  lightDir: [-0.707, 0.707], // 135° raking
  bumpStrength: 3,
  lightStrength: 0.8,
}

export class PaperGrainFilter extends Filter {
  constructor(p: PaperGrainParams = PAPER_GRAIN_DEFAULTS) {
    const grainUniforms = new UniformGroup({
      uWorldMatrix:  { value: new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]), type: 'mat3x3<f32>' },
      uZoom:         { value: 1.0,             type: 'f32' },
      uGrainScale:   { value: p.grainScale,    type: 'f32' },
      uGrainContrast:{ value: p.grainContrast, type: 'f32' },
      uPaperColor:   { value: new Float32Array(p.paperColor), type: 'vec3<f32>' },
      uUseTexture:   { value: p.useTexture,    type: 'f32' },
      uAnchor:       { value: p.anchor,        type: 'f32' },
      uOctaves:      { value: p.octaves,       type: 'f32' },
      uShowGrain:    { value: p.showGrain,     type: 'f32' },
      uMode:         { value: p.mode,          type: 'f32' },
      uInkGrain:     { value: p.inkGrain,      type: 'f32' },
      uSurface:      { value: p.surface,       type: 'f32' },
      uLightDir:     { value: new Float32Array(p.lightDir), type: 'vec2<f32>' },
      uBumpStrength: { value: p.bumpStrength,  type: 'f32' },
      uLightStrength:{ value: p.lightStrength, type: 'f32' },
    })
    super({
      glProgram: GlProgram.from({ vertex: defaultFilterVert, fragment: FRAG }),
      resources: {
        grainUniforms,
        uPaperTex: Texture.WHITE.source, // placeholder until a real texture is set
      },
    })
  }

  /** Bind the paper/graphite texture. Its source should have addressMode 'repeat'. */
  setPaperTexture(source: TextureSource): void {
    ;(this.resources as any).uPaperTex = source
  }

  /** Call every frame the camera moves. cam in screen px. */
  setCamera(camX: number, camY: number, zoom: number): void {
    const iz = 1 / zoom
    const u = (this.resources.grainUniforms as any).uniforms
    u.uWorldMatrix = new Float32Array([iz, 0, 0, 0, iz, 0, -camX * iz, -camY * iz, 1])
    u.uZoom = zoom
  }

  setParams(p: Partial<PaperGrainParams>): void {
    const u = (this.resources.grainUniforms as any).uniforms
    if (p.grainScale !== undefined) u.uGrainScale = p.grainScale
    if (p.grainContrast !== undefined) u.uGrainContrast = p.grainContrast
    if (p.paperColor !== undefined) u.uPaperColor = new Float32Array(p.paperColor)
    if (p.useTexture !== undefined) u.uUseTexture = p.useTexture
    if (p.anchor !== undefined) u.uAnchor = p.anchor
    if (p.octaves !== undefined) u.uOctaves = p.octaves
    if (p.showGrain !== undefined) u.uShowGrain = p.showGrain
    if (p.mode !== undefined) u.uMode = p.mode
    if (p.inkGrain !== undefined) u.uInkGrain = p.inkGrain
    if (p.surface !== undefined) u.uSurface = p.surface
    if (p.lightDir !== undefined) u.uLightDir = new Float32Array(p.lightDir)
    if (p.bumpStrength !== undefined) u.uBumpStrength = p.bumpStrength
    if (p.lightStrength !== undefined) u.uLightStrength = p.lightStrength
  }
}

```

## 4. src/lib/filters/glslNoise.ts — the procedural value-noise helper
```ts
// Shared GLSL noise utilities — prefix filter fragment shaders with this string.
// Provides hash21() + vnoise() (value-noise, Inigo Quilez style).
// Each filter defines its own fbm() since octave counts differ.
export const GLSL_HASH21_VNOISE = `
float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash21(i),           b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0)), d = hash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
`

```

## 5. scripts/gen-paper-height.ts — how the paper-height TILE is generated (FFT random-phase noise)
Relevant to the "tooth reads as coarse blocky gaps" problem — this bakes the height tile the tooth samples.
```ts
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

```
