// src/lib/filters/ProceduralWatercolorFilter.ts
import { Filter, GlProgram, UniformGroup, defaultFilterVert, Texture } from 'pixi.js'
import { GLSL_SIMPLEX, GLSL_FBM, GLSL_DITHER } from '../watercolor/glslNoise'
import { pigmentKS } from '../watercolor/pigmentKS'

export interface ProcWaterOpts {
  sdf: Texture
  sdfTexelWorldSize: number   // world units per SDF texel (crown-radius scaling)
  interiorScale: number       // deepest interior distance (world units) — drying-field denom
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
  debugStage?: number         // 0 = final render; 1..8 = dump an intermediate stage
}

const FRAG = /* glsl */`#version 300 es
precision highp float;
in vec2 vTextureCoord;
out vec4 finalColor;
uniform sampler2D uTexture;   // filter INPUT = the SDF texture (R=sdfN, G=rim); Pixi maps vTextureCoord to it
uniform float uTexelWorld, uSeed, uOffBase, uOffNoiseAmp, uWarpAmp, uShadowAmp, uFbmB, uPaperC;
uniform float uInteriorScale;
uniform vec2 uShadowDir;
uniform float uBandCount, uEdgeWidth, uBandGain;
uniform vec3 uKA, uSA, uKB, uSB, uPaperColor;
uniform float uPlateauLo, uPlateauHi, uMixT0, uMixT1, uBaseDensity, uCoverKnee;
uniform float uDebugStage;   // 0 = final; 1..8 = dump an intermediate stage
${GLSL_SIMPLEX}
${GLSL_FBM}
${GLSL_DITHER}

// deterministic per-seed phase — inject seed HERE, never into the texture coord.
float seedPhase(){ return fract(sin(uSeed * 12.9898) * 43758.5453) * 100.0; }

// Sample the pre-normalized SDF texture (R = sdfN 0edge->1center, G = rim 0edge->1by10px).
// A tiny warp per seed makes the field organic. Returns sdfN; exposes rimField + inside.
float sampleField(vec2 uv, out float inside, out float rimField){
  float sp = seedPhase();
  vec2 wuv = uv + uWarpAmp * vec2(fbm(uv*4.0 + sp, 3), fbm(uv*4.0 - sp, 3));
  vec4 s = texture(uTexture, clamp(wuv, 0.001, 0.999));
  rimField = s.g;                 // 0 at silhouette edge -> 1 by ~10px inside
  inside = step(0.004, s.r);      // sdfN > ~1/255 => inside the silhouette
  return s.r;                     // sdfN (radial 0->1)
}

float dryingField(vec2 uv, float sdfN){
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
// Band width is measured in RESOLUTION-INDEPENDENT T-space (a fraction of the drying
// range), NOT render-target pixels — a grad/fwidth normalization sizes bands in bake-target
// pixels, so the 2x bake + downscale to the cell shrank them below visibility (Fable's
// multi-resolution caveat). T-space width survives the downscale.
float bandTerm(float T, float w, int n){
  float wT = 0.008 + 0.02 * w;            // w in [0.4..3] -> narrow T-space width ~0.016..0.068
  float acc = 0.0;
  // fixed 7-iteration loop + mask (non-const \`break\` fails some mobile compilers).
  for(int k=0;k<7;k++){
    float inRange = (k < n) ? 1.0 : 0.0;
    float tau = bandThreshold(k, max(n,1));
    float d = (T - tau)/wT;               // signed, in T-space band-widths
    // COMPACT asymmetric line: sharp rise below tau, gaussian (short) decay inward.
    // Compact tails + MAX-combine keep the 5-7 bands DISCRETE — summing long exp
    // tails smeared adjacent bands into a smooth gradient (no visible rings).
    float spike = (d < 0.0) ? smoothstep(-1.0, 0.0, d) : exp(-d*d*0.6);
    acc = max(acc, spike * inRange);      // MAX, not sum: overlapping tails don't accumulate.
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
  // The filter INPUT (uTexture) IS the SDF sprite, so vTextureCoord maps to it directly.
  vec2 uv = vTextureCoord;

  float inside, rimField; float sdfN = sampleField(uv, inside, rimField);
  if(inside < 0.5){ finalColor = vec4(0.0); return; }
  float T = dryingField(uv, sdfN);
  float sp = seedPhase();

  // 1) base wash with LOW-FREQ spatial variation, so the plateau does real work
  float base = uBaseDensity * (0.7 + 0.6 * (fbm(uv*3.0 + sp, 3) * 0.5 + 0.5));
  // 2) plateau BEFORE bands (density field only, never T)
  float densP = plateau(base, uPlateauLo, uPlateauHi);
  // 3) + bands (additive in density)
  float bands = bandTerm(T, uEdgeWidth, int(uBandCount));
  float dens = densP + bands * uBandGain;

  // weak WARM mask rim: rimField ~0 at the silhouette edge -> 1 by ~10px inside.
  float rimBand = (1.0 - rimField) * (0.5 + 0.5 * snoise(uv*20.0 + sp));
  dens += 0.4 * rimBand;

  // 4) pigment split by T + warm rim enrichment. Concentration scales K only.
  float m = clamp(smoothstep(uMixT0, uMixT1, T) + rimBand * 0.5, 0.0, 1.0);
  vec3 K = mix(uKA, uKB, m) * dens;
  vec3 S = mix(uSA, uSB, m);
  vec3 R = kmReflectance(K, S);
  float cover = clamp(dens / uCoverKnee, 0.0, 1.0);
  vec3 col = mix(uPaperColor, R, cover);
  col += (ditherBlue(gl_FragCoord.xy) - 0.5) / 255.0;       // 5) dither

  // Stage dump switch (uDebugStage>0 outputs one intermediate as grayscale/color).
  int stg = int(uDebugStage + 0.5);
  if(stg == 1){ finalColor = vec4(vec3(texture(uTexture, uv).r),1.0); return; }     // raw sdfN (should be radial 0..1)
  if(stg == 2){ finalColor = vec4(vec3(sdfN),1.0); return; }                     // sdfN (radial)
  if(stg == 3){ finalColor = vec4(vec3(clamp(T,0.0,1.0)),1.0); return; }         // drying field T
  if(stg == 4){ finalColor = vec4(vec3(clamp(bands,0.0,1.0)),1.0); return; }     // raw bandTerm
  if(stg == 5){ finalColor = vec4(vec3(clamp(dens,0.0,1.0)),1.0); return; }      // total density
  if(stg == 6){ finalColor = vec4(vec3(m),1.0); return; }                        // pigment mix m
  if(stg == 7){ finalColor = vec4(vec3(cover),1.0); return; }                    // coverage alpha
  if(stg == 8){ finalColor = vec4(R,1.0); return; }                             // K-M reflectance
  finalColor = vec4(col, 1.0);                                                   // 0 = final
}`

export class ProceduralWatercolorFilter extends Filter {
  private g: UniformGroup
  constructor(o: ProcWaterOpts) {
    const pigA = o.pigA
    const pigB = o.pigB
    const g = new UniformGroup({
      uTexelWorld:  { value: o.sdfTexelWorldSize,                    type: 'f32' },
      uInteriorScale:{ value: o.interiorScale,                       type: 'f32' },
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
      uDebugStage:  { value: o.debugStage  ?? 0,                     type: 'f32' },
    })
    super({
      glProgram: GlProgram.from({ vertex: defaultFilterVert, fragment: FRAG }),
      resources: { procUniforms: g },
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
