// src/lib/filters/ProceduralWatercolorFilter.ts
import { Filter, GlProgram, UniformGroup, defaultFilterVert, Texture } from 'pixi.js'
import { GLSL_SIMPLEX, GLSL_FBM, GLSL_DITHER } from '../watercolor/glslNoise'
import { pigmentKS } from '../watercolor/pigmentKS'

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
  bandCount?: number          // number of iso-bands (default 6)
  edgeWidth?: number          // band edge width multiplier (default 1.2)
  bandGain?: number           // band density gain (default 0.6)
  // K-M pigments (Task 6)
  pigA: { K: [number, number, number]; S: [number, number, number] }
  pigB: { K: [number, number, number]; S: [number, number, number] }
  // tuning scalars (Task 6)
  plateauLo?: number          // default 0.12
  plateauHi?: number          // default 0.5
  mixT0?: number              // default 0.2
  mixT1?: number              // default 0.85
  baseDensity?: number        // default 0.5
  coverKnee?: number          // default 0.35
}

const FRAG = /* glsl */`#version 300 es
precision highp float;
in vec2 vTextureCoord;
out vec4 finalColor;
uniform sampler2D uSdf;
uniform float uTexelWorld, uSeed, uOffBase, uOffNoiseAmp, uWarpAmp, uShadowAmp, uFbmB, uPaperC;
uniform vec2 uShadowDir;
uniform float uBandCount, uEdgeWidth, uBandGain;
uniform vec3 uKA, uSA, uKB, uSB, uPaperColor;
uniform float uPlateauLo, uPlateauHi, uMixT0, uMixT1, uBaseDensity, uCoverKnee;
${GLSL_SIMPLEX}
${GLSL_FBM}
${GLSL_DITHER}

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
  // fixed 7-iteration loop + mask (non-const \`break\` fails some mobile compilers).
  for(int k=0;k<7;k++){
    float inRange = (k < n) ? 1.0 : 0.0;
    float tau = bandThreshold(k, max(n,1));
    float d = (T - tau)/(w*grad);         // signed, in line-widths
    // spike at d=0; quick rise on advancing (d<0) side, long exp decay inward (d>0).
    float spike = (d < 0.0) ? smoothstep(-1.0,0.0,d) : exp(-d*1.5);
    acc += spike * inRange;
  }
  return acc;   // corner at d=0 is the intended sharp pigment front; output is baked (static),
                // so no temporal Mach-band shimmer.
}

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
  dens += bandTerm(T, uEdgeWidth, int(uBandCount)) * uBandGain;

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
}`

export class ProceduralWatercolorFilter extends Filter {
  private g: UniformGroup
  constructor(o: ProcWaterOpts) {
    const pigA = o.pigA
    const pigB = o.pigB
    const g = new UniformGroup({
      uTexelWorld:  { value: o.sdfTexelWorldSize,                    type: 'f32' },
      uSeed:        { value: o.seed,                                 type: 'f32' },
      uOffBase:     { value: o.offsetBase,                           type: 'f32' },
      uOffNoiseAmp: { value: o.offsetNoiseAmp,                       type: 'f32' },
      uWarpAmp:     { value: o.warpAmp,                              type: 'f32' },
      uShadowDir:   { value: new Float32Array(o.shadowDir),          type: 'vec2<f32>' },
      uShadowAmp:   { value: o.shadowAmp,                            type: 'f32' },
      uFbmB:        { value: o.fbmB,                                 type: 'f32' },
      uPaperC:      { value: o.paperC,                               type: 'f32' },
      uBandCount:   { value: o.bandCount   ?? 6,                     type: 'f32' },
      uEdgeWidth:   { value: o.edgeWidth   ?? 1.2,                   type: 'f32' },
      uBandGain:    { value: o.bandGain    ?? 0.6,                   type: 'f32' },
      // K-M pigment K/S pairs
      uKA:          { value: new Float32Array(pigA.K),               type: 'vec3<f32>' },
      uSA:          { value: new Float32Array(pigA.S),               type: 'vec3<f32>' },
      uKB:          { value: new Float32Array(pigB.K),               type: 'vec3<f32>' },
      uSB:          { value: new Float32Array(pigB.S),               type: 'vec3<f32>' },
      // paper and compositing
      uPaperColor:  { value: new Float32Array([0.96, 0.93, 0.84]),   type: 'vec3<f32>' },
      uPlateauLo:   { value: o.plateauLo   ?? 0.12,                  type: 'f32' },
      uPlateauHi:   { value: o.plateauHi   ?? 0.5,                   type: 'f32' },
      uMixT0:       { value: o.mixT0       ?? 0.2,                   type: 'f32' },
      uMixT1:       { value: o.mixT1       ?? 0.85,                  type: 'f32' },
      uBaseDensity: { value: o.baseDensity ?? 0.5,                   type: 'f32' },
      uCoverKnee:   { value: o.coverKnee   ?? 0.35,                  type: 'f32' },
    })
    super({
      glProgram: GlProgram.from({ vertex: defaultFilterVert, fragment: FRAG }),
      resources: { procUniforms: g, uSdf: o.sdf.source },
    })
    this.g = g
  }
  setSeed(v: number)         { this.g.uniforms.uSeed        = v }
  setFbmB(v: number)         { this.g.uniforms.uFbmB        = v }
  setPaperC(v: number)       { this.g.uniforms.uPaperC      = v }
  setBandCount(v: number)    { this.g.uniforms.uBandCount   = v }
  setEdgeWidth(v: number)    { this.g.uniforms.uEdgeWidth   = v }
  setBandGain(v: number)     { this.g.uniforms.uBandGain    = v }
  setBaseDensity(v: number)  { this.g.uniforms.uBaseDensity = v }
  setPlateauLo(v: number)    { this.g.uniforms.uPlateauLo   = v }
  setPlateauHi(v: number)    { this.g.uniforms.uPlateauHi   = v }
  setMixT0(v: number)        { this.g.uniforms.uMixT0       = v }
  setMixT1(v: number)        { this.g.uniforms.uMixT1       = v }
  setCoverKnee(v: number)    { this.g.uniforms.uCoverKnee   = v }
}

// Re-export pigmentKS for convenience of callers who wire the filter.
export { pigmentKS }
