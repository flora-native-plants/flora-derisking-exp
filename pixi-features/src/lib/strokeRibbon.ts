// strokeRibbon.ts — Phase C: render a stroke as a ribbon MESH with a stroke-space graphite
// shader. Geometry is built ONCE from the cached op-list; the ribbon expansion now happens in the
// VERTEX shader (aCenter + aNormal * side * halfWidth), so zoom is a single uniform write instead
// of a per-zoom CPU rebuild, and width can be coupled to pressure for free.
//
// Attributes (one Geometry per run):
//   aPosition (vec2)  centreline point, world coords  — doubles as bounds source
//   aUV       (vec2)  (arcLength_world, side 0|1)
//   aNormal   (vec2)  unit normal at the centreline point, world coords
//   aPressure (float) seeded arc-length pressure — drives BOTH width (vert) and tone (frag),
//                     one source of truth computed on the CPU at build time.
//
// The tip taper is NOT baked into aPressure: it is computed in the vertex shader from arc length
// so its length stays constant in SCREEN px across zoom (uTaperPx / uZoom) while geometry is still
// built exactly once. Material (thresholded tooth, ragged edge, tone, tip fade) is in the fragment
// shader; meshes multiply-blend over the paper. Deposition grain comes from a dedicated
// HIGH-frequency tile (graphite-grain.png), not the broad watercolor-relief tile.

import { Mesh, Geometry, Shader, GlProgram, UniformGroup } from 'pixi.js'
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

// --- CPU pressure field (single source of truth for width + tone) ------------
// Ported from the graphite hash so pressure is deterministic per (seed, arc-length). Two octaves:
// a slow body swell + a faster tremor — one octave alone is just a gradient (Fable Q3).
function fract(x: number): number { return x - Math.floor(x) }
function hash11(p: number): number {
  p = fract(p * 0.1031)
  p *= p + 33.33
  p *= p + p
  return fract(p)
}
function vnoise1(x: number): number {
  const i = Math.floor(x), f = x - i
  const u = f * f * (3 - 2 * f)
  return hash11(i) * (1 - u) + hash11(i + 1) * u
}
function pressureAt(s: number, seed: number): number {
  // Graphite pressure: mostly FIRM with occasional irregular lightening — NOT a clean sine. A single
  // low-frequency octave reads as a periodic swell; three octaves + a firm bias breaks that up.
  const n = 0.5 * vnoise1(s * 0.05 + seed)
          + 0.3 * vnoise1(s * 0.12 + seed * 1.7)
          + 0.2 * vnoise1(s * 0.28 + seed * 2.3)
  return Math.max(0, Math.min(1, 0.66 + (n - 0.5) * 0.8)) // centred firm (~0.66), gentle spread
}

/** Ribbon geometry for one run: centreline + normal + seeded pressure per point (built once). */
function runGeometry(pts: Pt[], seed: number): { geo: Geometry; runLen: number } | null {
  const p = pts.filter((q, i) => i === 0 || Math.hypot(q[0] - pts[i - 1][0], q[1] - pts[i - 1][1]) > 1e-6)
  if (p.length < 2) return null
  const n = p.length
  const s: number[] = new Array(n)
  s[0] = 0
  for (let i = 1; i < n; i++) s[i] = s[i - 1] + Math.hypot(p[i][0] - p[i - 1][0], p[i][1] - p[i - 1][1])
  const positions = new Float32Array(n * 4)   // centreline, duplicated per side
  const uvs = new Float32Array(n * 4)         // (s, side 0|1)
  const normals = new Float32Array(n * 4)     // unit normal, duplicated per side
  const pressures = new Float32Array(n * 2)   // seeded pressure per vertex
  for (let i = 0; i < n; i++) {
    const a = p[Math.max(0, i - 1)], b = p[Math.min(n - 1, i + 1)]
    let tx = b[0] - a[0], ty = b[1] - a[1]
    const tl = Math.hypot(tx, ty) || 1
    tx /= tl; ty /= tl
    const nx = -ty, ny = tx
    const pr = pressureAt(s[i], seed)
    positions[i * 4] = p[i][0]; positions[i * 4 + 1] = p[i][1]
    positions[i * 4 + 2] = p[i][0]; positions[i * 4 + 3] = p[i][1]
    uvs[i * 4] = s[i]; uvs[i * 4 + 1] = 0
    uvs[i * 4 + 2] = s[i]; uvs[i * 4 + 3] = 1
    normals[i * 4] = nx; normals[i * 4 + 1] = ny
    normals[i * 4 + 2] = nx; normals[i * 4 + 3] = ny
    pressures[i * 2] = pr; pressures[i * 2 + 1] = pr
  }
  const indices = new Uint32Array((n - 1) * 6)
  for (let i = 0; i < n - 1; i++) {
    const v = i * 2, o = i * 6
    indices[o] = v; indices[o + 1] = v + 1; indices[o + 2] = v + 2
    indices[o + 3] = v + 1; indices[o + 4] = v + 3; indices[o + 5] = v + 2
  }
  const geo = new Geometry({
    attributes: {
      aPosition: { buffer: positions, format: 'float32x2' },
      aUV:       { buffer: uvs, format: 'float32x2' },
      aNormal:   { buffer: normals, format: 'float32x2' },
      aPressure: { buffer: pressures, format: 'float32' },
    },
    indexBuffer: indices,
    topology: 'triangle-list',
  })
  return { geo, runLen: s[n - 1] }
}

// ---- shaders ----------------------------------------------------------------
// Vertex expands the ribbon: half-width = uStrokePx/uZoom (screen-constant) × seeded pressure ×
// a screen-length tip taper. vWorld is the EXPANDED position so the two edges sample grain at
// different world points (per-side raggedness) and the field is zoom-stable.
const VERT = `#version 300 es
in vec2 aPosition;   // centreline, world
in vec2 aUV;         // (arcLength_world, side 0|1)
in vec2 aNormal;     // unit normal, world
in float aPressure;  // seeded pressure 0..1
out vec2 vUV;
out vec2 vWorld;
out float vPressure;
out vec2 vTangent;   // world-space stroke direction (for directional grain)
uniform mat3 uProjectionMatrix;
uniform mat3 uWorldTransformMatrix;
uniform mat3 uTransformMatrix;
uniform float uZoom;       // world.scale
uniform float uStrokePx;   // half-width in screen px
uniform float uRunLen;     // world arc length of this run
uniform float uTaperPx;    // tip taper length, screen px
uniform float uWidthVar;   // 0..1 pressure->width swing (Fable: ~0.3, NOT 0..1 -> sub-pixel dropout)
void main() {
  float side = aUV.y * 2.0 - 1.0;                 // -1..1 across the ribbon
  float s = aUV.x;
  float d = min(s, uRunLen - s);                  // world arc-dist to nearest end
  float taperLen = max(uTaperPx / uZoom, 1e-4);   // screen px -> world
  float tip = smoothstep(0.0, 1.0, clamp(d / taperLen, 0.0, 1.0));
  // Bounded width band: floor at (1 - uWidthVar) so a thin base stroke never goes sub-pixel.
  float widthPressure = mix(1.0 - uWidthVar, 1.0, aPressure);
  float halfW = (uStrokePx / uZoom) * widthPressure * tip;
  vec2 pos = aPosition + aNormal * side * halfW;
  mat3 mvp = uProjectionMatrix * uWorldTransformMatrix * uTransformMatrix;
  gl_Position = vec4((mvp * vec3(pos, 1.0)).xy, 0.0, 1.0);
  vUV = aUV;
  vWorld = pos;
  vPressure = aPressure;
  vTangent = vec2(aNormal.y, -aNormal.x); // perpendicular to the normal = stroke tangent
}`

const FRAG = `#version 300 es
precision highp float;
in vec2 vUV;        // (s world, side 0..1)
in vec2 vWorld;
in float vPressure;
in vec2 vTangent;   // world-space stroke direction
out vec4 finalColor;

uniform sampler2D uGrainTex; // HIGH-frequency deposition grain (not the broad relief tile)
uniform float uZoom;
uniform float uRunLen;
uniform float uGrainFine;    // world-units divisor: sets apparent tooth-cell size
uniform vec3  uInk;          // warm graphite (NOT uColor — that name is Pixi's reserved mesh tint)
uniform float uToneAmp;      // 0..1 tone (pressure) variation
uniform float uTooth;        // 0..1 paper-tooth breakup strength
uniform float uToothContrast;// 0 even fine tooth -> 1 hard pepper-fleck skips
uniform float uGrainStreak;  // 0 isotropic speckle -> 1 grain stretched into striations along travel
uniform float uBuildup;      // 0..1 tonal build-up: darker mid-stroke, lighter toward the ends
uniform float uEdgeSoft;     // 0..1 edge erosion amount (position, not transition width)
uniform float uStipple;      // 0 combed-grain deposit -> 1 stipple (scatter of soft dots = graphite powder)
uniform float uStippleScale; // world-units per stipple cell (dot spacing / size)

float hash11(float p){ p = fract(p * 0.1031); p *= p + 33.33; p *= p + p; return fract(p); }
float hash21(vec2 p){ p = fract(p * vec2(123.34, 345.45)); p += dot(p, p + 34.345); return fract(p.x * p.y); }

// Stipple deposition: scatter of soft round dots, isotropic, world-anchored — the fine "graphite
// powder settling into tooth" look (vs the combed striations of directional grain). density =
// fraction of cells carrying a dot; the caller folds edge-falloff + pressure into it so dots thin
// toward the ribbon edges (feathered) and with low pressure.
float stippleOctave(vec2 p, float density){
  vec2 cell = floor(p), f = fract(p);
  float cover = 0.0;
  for(int j = -1; j <= 1; j++){ for(int i = -1; i <= 1; i++){
    vec2 c = cell + vec2(float(i), float(j));
    if(hash21(c) > 1.0 - density){
      vec2 jit = vec2(hash21(c + 7.1), hash21(c + 19.3));
      float d = length(f - vec2(float(i), float(j)) - jit);
      float r = 0.46 * (0.6 + 0.4 * hash21(c + 3.7));      // varied dot radius (bigger → denser core)
      cover = max(cover, 1.0 - smoothstep(r * 0.45, r, d)); // soft dot
    }
  }}
  return cover;
}
// Two-octave crossfade on zoom → apparent dot size stays constant (same trick as grainField).
float stipple(vec2 world, float density){
  float L = log2(max(uZoom, 0.0001)); float o = floor(L); float fr = fract(L);
  vec2 base = world / uStippleScale;
  return mix(stippleOctave(base * exp2(o), density), stippleOctave(base * exp2(o + 1.0), density), fr);
}
float lum(vec3 c){ return dot(c, vec3(0.299,0.587,0.114)); }
// grain field, world-anchored, two-octave crossfade for constant apparent size on zoom
float grainField(vec2 uv){
  float L = log2(max(uZoom,0.0001)); float o = floor(L); float f = fract(L);
  float h0 = lum(texture(uGrainTex, uv*exp2(o)).rgb);
  float h1 = lum(texture(uGrainTex, uv*exp2(o+1.0)).rgb);
  return mix(h0,h1,f);
}

void main(){
  float s = vUV.x;
  float side = vUV.y * 2.0 - 1.0;
  float edge = abs(side);               // 0 centre -> 1 edge
  float pressure = vPressure;

  // Directional grain: sample the tile in the stroke's tangent/normal frame, stretched ALONG travel
  // so the isotropic tile reads as striations following the stroke (the #1 tell vs real pencil).
  vec2 tgt = normalize(vTangent + vec2(1e-5, 0.0));
  vec2 nrm = vec2(-tgt.y, tgt.x);
  float streak = 1.0 + uGrainStreak * 3.5;                 // >1 elongates features along the stroke
  vec2 gUV = vec2(dot(vWorld, tgt) / streak, dot(vWorld, nrm) * mix(1.0, 1.6, uGrainStreak)) / uGrainFine;
  float g = grainField(gUV);

  // Q3 tone: perceptual-gamma'd pressure (alpha 0.6 vs 1.0 barely reads on near-white w/ multiply)
  float tone = pow(mix(1.0 - uToneAmp, 1.0, pressure), 1.6);

  // Q1 tooth: near-binary deposit per tooth cell, AA'd; light pressure -> more skips.
  // uToothContrast stretches the fine grain toward bimodal + tightens the threshold band, taking
  // the read from "even fine tooth" (0) to "pepper-fleck skips" (1). Edge-biased: the threshold
  // rises toward the ribbon edges, so graphite skips there (ragged edge) over a more solid core.
  float gc = clamp((g - 0.5) * (1.0 + uToothContrast * 3.0) + 0.5, 0.0, 1.0);
  float thresh = mix(0.72, 0.18, pressure) + 0.28 * edge * edge;
  float wth = min(fwidth(gc), 0.2) + mix(0.06, 0.006, uToothContrast);
  float deposit = smoothstep(thresh - wth, thresh + wth, gc);

  // Stipple deposition (graphite powder): dot density high in the core, feathering to ~0 before the
  // edge, and rising with pressure. Blend against the combed-grain deposit by uStipple.
  float dens = clamp((1.15 - 0.85 * edge * edge) * mix(0.6, 1.0, pressure), 0.0, 1.0);
  float stip = stipple(vWorld, dens);
  deposit = mix(deposit, stip, uStipple);

  // Stipple wants FULL tooth authority (dot = dark, gap = clean paper); the grain path softens the
  // breakup at high pressure. Blend the two behaviours by uStipple so gaps don't wash to muddy ink.
  float toothAmt = uTooth * mix(1.0 - 0.6 * pressure, 1.0, uStipple);
  float tooth = mix(1.0, deposit, toothAmt);

  // Q2 edge: erode the LIMIT where grain is low; transition width stays fwidth (sharp, ragged).
  // Ascending form (edge0 < edge1) then invert — descending smoothstep is undefined GLSL.
  float limit = 1.0 - uEdgeSoft * 0.45 * (1.0 - g);
  float aa = fwidth(edge);
  float cover = 1.0 - smoothstep(limit - aa, limit + aa, edge);

  // Q4 tip: width already thinned in vert; fade alpha only over the last ~1.5 screen px of arc
  float d = min(s, uRunLen - s);
  float fade = smoothstep(0.0, 1.5 / uZoom, d);

  // Tonal build-up: gentle darkening toward mid-stroke, lighter toward the ends (real marks build
  // up in the middle of the arc). Broader than the tip fade.
  float buildup = mix(1.0 - uBuildup, 1.0, smoothstep(0.0, uRunLen * 0.4, d));

  // subtle darker core (across the width)
  float core = mix(1.0, 1.12, 1.0 - edge);

  float a = clamp(tone * tooth * cover * fade * core * buildup, 0.0, 1.0);
  finalColor = vec4(uInk * a, a);      // premultiplied; mesh uses multiply blend
}`

let _program: GlProgram | null = null
function program(): GlProgram {
  if (!_program) _program = GlProgram.from({ vertex: VERT, fragment: FRAG, name: 'stroke-ribbon' })
  return _program
}

export interface StrokeRibbonParams {
  color: [number, number, number]
  strokePx: number   // half-width in screen px
  taperPx: number    // tip taper length, screen px
  grainFine: number  // world-units divisor for the deposition grain
  widthVar: number   // 0..1 pressure->width swing (keep ~0.3; 1.0 drops thin strokes to sub-pixel)
  toneAmp: number
  tooth: number
  toothContrast: number // 0 even fine tooth -> 1 hard pepper-fleck skips
  grainStreak: number   // 0 isotropic -> 1 directional striations along the stroke
  buildup: number       // 0..1 tonal build-up toward mid-stroke
  edgeSoft: number
  stipple: number       // 0 combed-grain deposit -> 1 stipple (dot-scatter graphite powder)
  stippleScale: number  // world-units per stipple cell (dot spacing / size)
  seed: number       // pressure-field seed (per-run variation is folded in by run index)
}

export const STROKE_RIBBON_DEFAULTS: StrokeRibbonParams = {
  color: [0.17, 0.16, 0.15], // warm graphite ~#2b2825
  strokePx: 1.25,            // half of a 2.5px stroke
  taperPx: 14,
  grainFine: 300,
  widthVar: 0.3,             // gentle width band — never sub-pixel at 2.5px base
  toneAmp: 0.35,             // gentle tone swing (0.55 read as a sinusoidal fade)
  tooth: 0.85,
  toothContrast: 0.5,        // midway — some fleck character without going harsh
  grainStreak: 0.6,          // directional striations along the stroke (vs isotropic speckle)
  buildup: 0.25,             // gentle mid-stroke tonal build-up
  edgeSoft: 0.5,
  stipple: 0,                // combed-grain deposit by default
  stippleScale: 2.5,
  seed: 42,
}

/**
 * Selectable drawing MEDIUM — a bundle of material params, orthogonal to geometry roughness.
 * The medium is a per-object choice (like Excalidraw sloppiness): graphite for heavy profile
 * lines, crayon/colored-pencil for beds & symbols.
 *
 * KEY: each medium carries its OWN native width. Soft graphite only reads at width (the tooth
 * needs room across the ribbon); crayon reads at thin real-use width because the waxy *speckle*
 * IS the look, not a fallback from a failed soft band. Offering both is the whole point — a thin
 * line can't be soft graphite, but it can be convincing crayon.
 */
export type StrokeMedium = 'graphite' | 'graphite-stipple' | 'crayon'

type StrokeMaterial = Pick<StrokeRibbonParams,
  'grainFine' | 'widthVar' | 'toneAmp' | 'tooth' | 'toothContrast' | 'grainStreak' | 'buildup' | 'edgeSoft'
  | 'stipple' | 'stippleScale'>

export const STROKE_MEDIA: Record<StrokeMedium, {
  label: string
  widthPx: number          // native stroke width for this medium
  material: StrokeMaterial
}> = {
  graphite: {
    label: 'Graphite (combed)',
    widthPx: 6,            // soft graphite reads only at width — thin collapses to clean-pen
    material: {
      grainFine: 300, widthVar: 0.30, toneAmp: 0.35, tooth: 0.85,
      toothContrast: 0.50, grainStreak: 0.60, buildup: 0.25, edgeSoft: 0.50,
      stipple: 0, stippleScale: 2.5,
    },
  },
  'graphite-stipple': {
    label: 'Graphite (stipple)',
    widthPx: 9,            // dot-scatter powder needs width to show a dense core feathering to edges
    material: {
      grainFine: 300, widthVar: 0.30, toneAmp: 0.45, tooth: 1.0,
      toothContrast: 0.50, grainStreak: 0.0, buildup: 0.25, edgeSoft: 0.60,
      stipple: 1.0, stippleScale: 1.4,   // fine cells → many dots across → dense core, fine powder
    },
  },
  crayon: {
    label: 'Crayon / colored pencil',
    widthPx: 3,            // waxy speckle reads at thin real-use width
    material: {
      grainFine: 220,      // coarser tooth cell → visible waxy grain even when thin
      widthVar: 0.25,
      toneAmp: 0.40,
      tooth: 1.0,          // full paper-tooth breakup
      toothContrast: 0.85, // hard pepper-fleck skips = the dotted, skipping crayon deposit
      grainStreak: 0.10,   // near-isotropic speckle (crayon grain is dotty, not combed)
      buildup: 0.12,       // crayon lays down more evenly than build-up-in-the-middle graphite
      edgeSoft: 0.70,      // waxy ragged edges
      stipple: 0, stippleScale: 2.5,
    },
  },
}

/**
 * Build one Mesh per run of a cached op-list. Geometry is built ONCE (no zoom rebuild); width and
 * zoom are uniforms. `grain` is the tiling high-frequency deposition tile. Live values (uZoom,
 * uStrokePx, uTaperPx, uGrainFine, uToneAmp, uTooth, uEdgeSoft) can be updated on the returned
 * meshes' `strokeUniforms` group without rebuilding.
 */
export function buildStrokeMeshes(
  ops: Op[],
  grain: TextureSource,
  p: StrokeRibbonParams = STROKE_RIBBON_DEFAULTS,
): Mesh[] {
  const meshes: Mesh[] = []
  const runs = runsFromOps(ops)
  for (let r = 0; r < runs.length; r++) {
    const g = runGeometry(runs[r], p.seed * 0.123 + r * 13.7)
    if (!g) continue
    const uniforms = new UniformGroup({
      uZoom:      { value: 1, type: 'f32' },
      uStrokePx:  { value: p.strokePx, type: 'f32' },
      uRunLen:    { value: g.runLen, type: 'f32' },
      uTaperPx:   { value: p.taperPx, type: 'f32' },
      uWidthVar:  { value: p.widthVar, type: 'f32' },
      uGrainFine: { value: p.grainFine, type: 'f32' },
      uInk:       { value: new Float32Array(p.color), type: 'vec3<f32>' },
      uToneAmp:   { value: p.toneAmp, type: 'f32' },
      uTooth:     { value: p.tooth, type: 'f32' },
      uToothContrast: { value: p.toothContrast, type: 'f32' },
      uGrainStreak: { value: p.grainStreak, type: 'f32' },
      uBuildup:   { value: p.buildup, type: 'f32' },
      uEdgeSoft:  { value: p.edgeSoft, type: 'f32' },
      uStipple:   { value: p.stipple, type: 'f32' },
      uStippleScale: { value: p.stippleScale, type: 'f32' },
    })
    const shader = new Shader({ glProgram: program(), resources: { uGrainTex: grain, strokeUniforms: uniforms } })
    // Mesh's shader generic expects a TextureShader; our custom shader binds its texture as a
    // resource, so the cast is safe (runtime-verified: renders with no console errors).
    const mesh = new Mesh({ geometry: g.geo, shader: shader as any })
    mesh.blendMode = 'multiply'
    meshes.push(mesh as unknown as Mesh)
  }
  return meshes
}
