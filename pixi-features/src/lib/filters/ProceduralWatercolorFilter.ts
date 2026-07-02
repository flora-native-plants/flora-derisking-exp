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
  // inside/rim/registration come from the UNWARPED lookup so the fill matches the
  // silhouette exactly (warping the mask itself detached the fill from the contour).
  vec4 s0 = texture(uTexture, uv);
  rimField = s0.g;                 // 0 at silhouette edge -> 1 by ~10px inside
  inside = step(0.004, s0.r);      // sdfN > ~1/255 => inside the silhouette
  // Warp ONLY the interior structure (tapered to 0 near the boundary) so tide-lines
  // wander without pulling the fill off the plant shape.
  float edgeDamp = smoothstep(0.02, 0.30, s0.r);
  vec2 wuv = uv + uWarpAmp * edgeDamp * vec2(fbm(uv*1.6 + sp, 3), fbm(uv*1.6 - sp + 4.3, 3));
  return texture(uTexture, clamp(wuv, 0.001, 0.999)).r;  // warped sdfN for the drying field
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
float hash1(float x){ return fract(sin(x*12.9898) * 43758.5453); }

// Tide-lines, NOT contour lines. Each band is (a) independently warped so bands aren't
// parallel level-sets of one field, (b) gated by a low-freq OCCUPANCY mask so it exists
// for an arc then fades/vanishes/reappears, (c) width/gain jittered per band, and (d)
// crisp↔feathered along its length via a low-freq "residual wetness" field.
float bandTerm(vec2 uv, float T, float w, int n, float sp){
  float acc = 0.0;
  float soft = fbm(uv*2.0 + sp + 31.0, 3) * 0.5 + 0.5;   // 0..1: high = feathered, low = crisp
  for(int k=0;k<7;k++){
    float inRange = (k < n) ? 1.0 : 0.0;
    float fk = float(k);
    float Tk = T + 0.04 * fbm(uv*7.0 + fk*17.3 + sp, 3);          // (a) per-band decorrelation
    float wTk = mix(0.009, 0.045, soft) * w * (0.7 + 0.6*hash1(fk*3.1 + sp)); // (c)+(d) width
    float gainK = mix(1.0, 0.4, soft) * (0.55 + 0.9*hash1(fk*7.7 + sp));      // (c)+(d) gain
    float d = (Tk - bandThreshold(k, max(n,1)))/wTk;
    float spike = (d < 0.0) ? smoothstep(-1.0, 0.0, d) : exp(-d*d*0.6);
    float occ = smoothstep(0.32, 0.62, fbm(uv*3.0 + fk*9.1 + sp, 3) * 0.5 + 0.5); // (b) occupancy
    acc = max(acc, spike * occ * gainK * inRange);
  }
  return acc;
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

// A secondary FREE-FLOATING glaze puddle centred at c (radius r): its own drying field
// -> bands, wetness-gated. Its density ADDS to the primary (overlap darkening — Fable's
// strongest cue) and its bands cross the primary's (a single field's bands never cross).
// Returns (density contribution, wetness) — wetness marks a LATE-DRYING pocket that
// pulls the hue warm, so the warm bloom follows the (per-seed) glaze positions instead
// of always sitting at the leaf centre.
vec2 secondaryGlaze(vec2 uv, vec2 c, float r, float seedOff){
  vec2 rel = uv - c;
  // Elliptical stretch along a per-bloom axis (real backruns elongate along the flow).
  float aAng = hash1(seedOff * 1.7) * 6.283;
  vec2 ax = vec2(cos(aAng), sin(aAng));
  float stretch = 1.3 + 0.3 * hash1(seedOff * 2.3);            // 1.3..1.6
  vec2 relE = vec2(dot(rel, ax), dot(rel, vec2(-ax.y, ax.x)) * stretch);
  // SIGNED noise front -> concave lobes (pushes in AND out), not just convex fuzz.
  float dist = length(relE) + (fbm(uv*9.0 + seedOff, 3)) * 0.30 * r;
  float wet = 1.0 - smoothstep(0.0, r, dist);
  if(wet <= 0.001) return vec2(0.0);
  float Tg = wet + uFbmB * fbm(uv*6.0 + seedOff + 3.7, 4);
  float bandsG = bandTerm(uv, Tg, uEdgeWidth, int(uBandCount), seedOff);
  // Backrun conservation: pale core (lightens WITHIN the wash), dark front piled at the rim.
  float rim  = exp(-pow((wet - 0.16) / 0.12, 2.0));           // near the advancing front
  float core = smoothstep(0.28, 0.85, wet);                  // bloom interior
  // Rim OCCUPANCY along the arc: broken C-shape (not a full ring), biased to the drier side
  // (flow toward the leaf edge dries first). Where rimOcc is low the front is faint.
  float ang = atan(rel.y, rel.x);
  vec2 flowDir = normalize(c - vec2(0.5) + 1e-5);
  float dirBias = 0.5 + 0.5 * dot(normalize(rel + 1e-5), flowDir);   // 1 on the drier side
  float rimOcc = smoothstep(0.25, 0.72, fbm(vec2(cos(ang), sin(ang))*1.5 + seedOff, 3) * 0.5 + 0.5)
               * (0.3 + 0.7 * dirBias);
  float rimStr = rim * rimOcc;
  float dContrib = rimStr * (0.22 + bandsG * uBandGain) - core * 0.16;
  float warm = rimStr + 0.25 * core;                         // neutral (green) where rim absent
  return vec2(dContrib, warm);
}

void main(){
  // The filter INPUT (uTexture) IS the SDF sprite, so vTextureCoord maps to it directly.
  vec2 uv = vTextureCoord;

  float inside, rimField; float sdfN = sampleField(uv, inside, rimField);
  if(inside < 0.5){ finalColor = vec4(0.0); return; }
  float T = dryingField(uv, sdfN);
  float sp = seedPhase();

  // 1) base wash — FLAT (only a whisper of low-freq variation) so most of the leaf is a
  // calm plateau and the tide-lines carry the tonal energy (Fable: "nothing is flat" tell).
  float base = uBaseDensity * (0.92 + 0.16 * (fbm(uv*2.2 + sp, 3) * 0.5 + 0.5));
  // 2) plateau BEFORE bands (density field only, never T)
  float densP = plateau(base, uPlateauLo, uPlateauHi);
  // 3) + bands (additive in density)
  float bands = bandTerm(uv, T, uEdgeWidth, int(uBandCount), sp);
  float dens = densP + bands * uBandGain;

  // weak WARM mask rim: rimField ~0 at the silhouette edge -> 1 by ~10px inside. Halved +
  // occupancy dropouts so it doesn't form a triple outline with the first band + contour.
  float rimBand = (1.0 - rimField) * smoothstep(0.35, 0.7, snoise(uv*14.0 + sp) * 0.5 + 0.5);
  dens += 0.2 * rimBand;

  // 3b) LAYERED GLAZES — two free-floating secondary puddles (seeded positions). Their
  // density adds (overlap darkening) and their bands cross the primary's -> paint process.
  // 0..2 blooms per seed, jittered size + wide spread (some straddle the silhouette -> the
  // clip cuts a half-bloom at the crown edge, a boundary-independence cue).
  float haveG1 = step(hash1(sp + 41.0), 0.75);
  float haveG2 = step(hash1(sp + 57.0), 0.55);
  float r1 = 0.20 * (0.6 + 0.8 * hash1(sp + 3.0));   // ±40%
  float r2 = 0.15 * (0.6 + 0.8 * hash1(sp + 9.0));
  vec2 c1 = vec2(0.55, 0.45) + 0.30 * vec2(snoise(vec2(sp, 1.0)), snoise(vec2(sp, 2.0)));
  vec2 c2 = vec2(0.45, 0.58) + 0.34 * vec2(snoise(vec2(sp, 3.0)), snoise(vec2(sp, 4.0)));
  vec2 g1 = haveG1 * secondaryGlaze(uv, c1, r1, sp + 11.0);
  vec2 g2 = haveG2 * secondaryGlaze(uv, c2, r2, sp + 23.0);
  // Scoop lightens the core WITHIN the wash — never below ~55% of the local plateau (no bare paper).
  dens = max(dens + g1.x + g2.x, densP * 0.55);

  // Granulation: fine paper tooth where pigment settles. Two-frequency, gated by dens so
  // the flat plateau stays clean; a high-freq component acts SUBTRACTIVELY on coverage so
  // real paper specks show THROUGH the wash (realtex's muted, granular sparkle).
  float grain = fbm(uv*62.0 + sp, 2) * fbm(uv*23.0 - sp, 2);
  dens *= 1.0 + 0.15 * grain * smoothstep(0.06, 0.45, dens);
  float grainHi = fbm(uv*110.0 + sp, 2) * 0.5 + 0.5;

  // 4) pigment split: warm follows the late-drying glaze pools (moves per seed). Capped at
  // 0.75 so pure pigment-B never fully displaces the green (avoids traffic-cone cores).
  float warmField = clamp(0.4 * smoothstep(uMixT0, uMixT1, sdfN) + 0.85 * (g1.y + g2.y), 0.0, 1.0);
  float m = clamp(warmField + rimBand * 0.4, 0.0, 0.75);
  vec3 K = mix(uKA, uKB, m) * dens;
  vec3 S = mix(uSA, uSB, m);
  vec3 R = kmReflectance(K, S);
  float cover = clamp(dens / uCoverKnee, 0.0, 1.0);
  cover *= 1.0 - 0.28 * smoothstep(0.55, 0.85, grainHi);    // paper shows through
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
