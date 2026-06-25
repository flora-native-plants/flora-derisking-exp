/**
 * Jump-Flood Algorithm (JFA) distance-field outline / glow for Pixi.js v8.
 *
 * Why JFA: a single screen-space pipeline whose cost is independent of how many
 * objects are selected — outline 1 or 100 shapes for ~the same time. Produces a
 * true distance field, so the outline band can be any thickness and the same
 * field drives a soft glow or an animated sweep. (Ben Golus, "The Quest for Very
 * Wide Outlines"; three.js `bzztbomb/three_js_outline`; Godot
 * `pink-arcana/godot-distance-field-outlines`.)
 *
 * Pipeline (5 stages):
 *   1. MASK   — render selected shapes solid into an 8-bit RT.
 *   2. SEED   — each masked pixel stores its OWN uv in RG; valid flag in B. (float RT)
 *   3. JFA ×N — ping-pong; each pass samples 9 neighbours at offset `step` and keeps
 *               the nearest seed. step = 2^(ceil(log2(maxDim)))…1. After the last pass
 *               every pixel holds the uv of its nearest seed (a Voronoi diagram).
 *   4. DECODE — distance(pixel, nearestSeed) in px → coloured outline band and/or glow.
 *
 * Float RTs (`rgba16float`) hold the seed coordinates — 8-bit RGBA only gives 256
 * levels/channel and the field goes blocky past ~256px. WebGL2 + EXT_color_buffer_float
 * (verified present) makes rgba16float renderable. Sampling is NEAREST so seed coords
 * are never interpolated.
 *
 * GL-only (WebGL preference). A WGSL `gpu` block is a TODO before this ships to
 * flora-studio's WebGPU-capable renderer.
 */
import {
  Geometry, Shader, Mesh, Container, RenderTexture,
  type Renderer,
} from 'pixi.js'

const VERT = /* glsl */ `#version 300 es
in vec2 aPosition;
in vec2 aUV;
out vec2 vUV;
void main() {
  vUV = aUV;
  gl_Position = vec4(aPosition, 0.0, 1.0);
}
`

// SEED: masked pixels store their own uv; everything else is "no seed".
const SEED_FRAG = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUV;
out vec4 finalColor;
uniform sampler2D uTexture;   // the mask
void main() {
  float m = texture(uTexture, vUV).a;
  finalColor = m > 0.5 ? vec4(vUV, 1.0, 0.0) : vec4(0.0);
}
`

// JFA STEP: keep the nearest valid seed among the 9 samples at distance `uStep`.
const JFA_FRAG = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUV;
out vec4 finalColor;
uniform sampler2D uTexture;
uniform vec2  uTexel;   // 1 / size
uniform float uStep;    // sample distance in pixels
uniform vec2  uSize;    // texture size in pixels
void main() {
  vec4 best = vec4(0.0);
  float bestD = 1e20;
  for (int dy = -1; dy <= 1; dy++) {
    for (int dx = -1; dx <= 1; dx++) {
      vec2 off = vec2(float(dx), float(dy)) * uStep * uTexel;
      vec4 s = texture(uTexture, vUV + off);
      if (s.z > 0.5) {
        vec2 dpx = (vUV - s.xy) * uSize;
        float d = dot(dpx, dpx);
        if (d < bestD) { bestD = d; best = s; }
      }
    }
  }
  finalColor = best;
}
`

// DECODE: distance field → outline band + optional glow, premultiplied output.
const DECODE_FRAG = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUV;
out vec4 finalColor;
uniform sampler2D uTexture;   // final JFA seed field
uniform vec2  uSize;
uniform vec4  uColor;         // rgb used; a ignored (vec4 avoids WebGL vec3 upload warning)
uniform float uThickness;     // outline band width (px)
uniform float uFeather;       // AA falloff (px)
uniform float uGlow;          // glow strength (0 = off)
uniform float uGlowFalloff;   // glow falloff distance (px)
void main() {
  vec4 s = texture(uTexture, vUV);
  if (s.z < 0.5) { finalColor = vec4(0.0); return; }
  float distPx = length((vUV - s.xy) * uSize);

  // Outline band: pixels just OUTSIDE the shape (distPx in (0, thickness]).
  float outer = 1.0 - smoothstep(uThickness - uFeather, uThickness, distPx);
  float inner = smoothstep(0.0, uFeather, distPx);   // exclude interior (dist≈0)
  float band = outer * inner;

  // Soft glow falling off with distance (also outside only).
  float glow = uGlow > 0.0 ? uGlow * exp(-distPx / uGlowFalloff) * inner : 0.0;

  float a = clamp(band + glow, 0.0, 1.0);
  finalColor = vec4(uColor.rgb * a, a);
}
`

function fullScreenQuad(): Geometry {
  return new Geometry({
    attributes: {
      aPosition: [-1, -1,  1, -1,  -1, 1,  1, 1],
      aUV:       [ 0,  0,  1,  0,   0, 1,  1, 1],
    },
    indexBuffer: [0, 1, 2, 2, 1, 3],
  })
}

export interface JfaOptions {
  color: [number, number, number]   // 0..1 rgb
  thickness: number                  // px
  feather: number                    // px
  glow: number                       // 0 = off
  glowFalloff: number                // px
}

export class JumpFloodOutline {
  private renderer: Renderer
  private w: number
  private h: number

  private quad: Geometry
  private seedMesh: Mesh<Geometry, Shader>
  private jfaMesh: Mesh<Geometry, Shader>
  private decodeMesh: Mesh<Geometry, Shader>
  private seedHolder: Container
  private jfaHolder: Container
  private decodeHolder: Container

  mask: RenderTexture
  private rtA: RenderTexture
  private rtB: RenderTexture
  out: RenderTexture

  constructor(renderer: Renderer, width: number, height: number) {
    this.renderer = renderer
    this.w = Math.max(1, Math.round(width))
    this.h = Math.max(1, Math.round(height))

    this.mask = RenderTexture.create({ width: this.w, height: this.h, scaleMode: 'nearest' })
    const floatOpts = { width: this.w, height: this.h, format: 'rgba16float' as const, scaleMode: 'nearest' as const }
    this.rtA = RenderTexture.create(floatOpts)
    this.rtB = RenderTexture.create(floatOpts)
    this.out = RenderTexture.create({ width: this.w, height: this.h, scaleMode: 'nearest' })

    this.quad = fullScreenQuad()

    const texel: [number, number] = [1 / this.w, 1 / this.h]
    const size: [number, number] = [this.w, this.h]

    this.seedMesh = new Mesh({
      geometry: this.quad,
      shader: Shader.from({ gl: { vertex: VERT, fragment: SEED_FRAG }, resources: { uTexture: this.mask.source } }),
    })
    this.jfaMesh = new Mesh({
      geometry: this.quad,
      shader: Shader.from({
        gl: { vertex: VERT, fragment: JFA_FRAG },
        resources: {
          uTexture: this.rtA.source,
          jfaU: { uTexel: { value: new Float32Array(texel), type: 'vec2<f32>' },
                  uStep:  { value: 1, type: 'f32' },
                  uSize:  { value: new Float32Array(size), type: 'vec2<f32>' } },
        },
      }),
    })
    this.decodeMesh = new Mesh({
      geometry: this.quad,
      shader: Shader.from({
        gl: { vertex: VERT, fragment: DECODE_FRAG },
        resources: {
          uTexture: this.rtB.source,
          decU: { uSize: { value: new Float32Array(size), type: 'vec2<f32>' },
                  uColor: { value: new Float32Array([0.27, 0.6, 1, 1]), type: 'vec4<f32>' },
                  uThickness: { value: 6, type: 'f32' },
                  uFeather: { value: 1.5, type: 'f32' },
                  uGlow: { value: 0, type: 'f32' },
                  uGlowFalloff: { value: 24, type: 'f32' } },
        },
      }),
    })

    this.seedHolder = new Container();   this.seedHolder.addChild(this.seedMesh)
    this.jfaHolder = new Container();     this.jfaHolder.addChild(this.jfaMesh)
    this.decodeHolder = new Container();  this.decodeHolder.addChild(this.decodeMesh)
  }

  /** Run the full pipeline. `source` holds the selected shapes (in canvas coords). */
  run(source: Container, opts: JfaOptions): void {
    const r = this.renderer

    // 1. MASK
    r.render({ container: source, target: this.mask, clear: true })

    // 2. SEED  (mask → rtA)
    this.seedMesh.shader!.resources.uTexture = this.mask.source
    r.render({ container: this.seedHolder, target: this.rtA, clear: true })

    // 3. JFA passes (ping-pong rtA <-> rtB). Start step = largest power of two <= maxDim.
    let step = Math.pow(2, Math.ceil(Math.log2(Math.max(this.w, this.h))))
    let src = this.rtA, dst = this.rtB
    const u = this.jfaMesh.shader!.resources.jfaU.uniforms
    while (step >= 1) {
      this.jfaMesh.shader!.resources.uTexture = src.source
      u.uStep = step
      r.render({ container: this.jfaHolder, target: dst, clear: true })
      const t = src; src = dst; dst = t
      step = Math.floor(step / 2)
    }
    // final field is in `src`

    // 4. DECODE (src → out)
    this.decodeMesh.shader!.resources.uTexture = src.source
    const d = this.decodeMesh.shader!.resources.decU.uniforms
    d.uColor.set(opts.color)
    d.uThickness = opts.thickness
    d.uFeather = opts.feather
    d.uGlow = opts.glow
    d.uGlowFalloff = opts.glowFalloff
    r.render({ container: this.decodeHolder, target: this.out, clear: true })
  }

  destroy(): void {
    this.seedMesh.destroy(); this.jfaMesh.destroy(); this.decodeMesh.destroy()
    this.quad.destroy()
    this.mask.destroy(true); this.rtA.destroy(true); this.rtB.destroy(true); this.out.destroy(true)
  }
}
