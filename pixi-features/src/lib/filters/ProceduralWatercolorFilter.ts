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
// \`sdfW\` (silhouette distance, world units, neg inside) is exposed for the warm rim.
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
      uTexelWorld:  { value: o.sdfTexelWorldSize,           type: 'f32' },
      uSeed:        { value: o.seed,                        type: 'f32' },
      uOffBase:     { value: o.offsetBase,                  type: 'f32' },
      uOffNoiseAmp: { value: o.offsetNoiseAmp,              type: 'f32' },
      uWarpAmp:     { value: o.warpAmp,                     type: 'f32' },
      uShadowDir:   { value: new Float32Array(o.shadowDir), type: 'vec2<f32>' },
      uShadowAmp:   { value: o.shadowAmp,                   type: 'f32' },
      uFbmB:        { value: o.fbmB,                        type: 'f32' },
      uPaperC:      { value: o.paperC,                      type: 'f32' },
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
