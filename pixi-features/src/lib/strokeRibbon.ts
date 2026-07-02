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
