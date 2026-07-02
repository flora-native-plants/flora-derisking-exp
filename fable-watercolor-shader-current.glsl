// ProceduralWatercolorFilter — CURRENT shader (after Fable round-2), GLSL ES 3.00,
// single baked pass per plant instance. Source of truth:
//   derisking-experiments/pixi-features/src/lib/filters/ProceduralWatercolorFilter.ts (the FRAG string)
//
// uTexture = the filter INPUT, a per-plant texture: R = sdfN (0 at silhouette edge -> 1 at
//   deepest interior), G = rim (0 at edge -> 1 by ~10px in). Pixi maps vTextureCoord to it.
// fbm(p, octaves), snoise(p), ditherBlue(fragXY) = standard vendored noise helpers (omitted).
// Pigments are Kubelka-Munk K/S from Curtis Rw/Rb samples (set on the CPU):
//   A (settling olive green): Rw (0.32,0.48,0.30), Rb (0.07,0.16,0.08)
//   B (grayed warm brown):    Rw (0.72,0.55,0.40), Rb (0.26,0.13,0.05)
//   uPaperColor = cream (0.96,0.93,0.84).
// Default params in the current renders: warpAmp 0.20, fbmB 0.30, paperC 0.03, bandCount 3,
//   edgeWidth 1.2, bandGain 0.7, baseDensity 0.42, coverKnee 0.85, plateauLo 0.20,
//   plateauHi 0.62, mixT0 0.50, mixT1 1.00.
// NOTE: uTexelWorld/uOffBase/uOffNoiseAmp/uShadowDir/uShadowAmp/uInteriorScale are dead
//   (leftovers from an abandoned puddle-inflation approach) — ignore them.

float seedPhase(){ return fract(sin(uSeed * 12.9898) * 43758.5453) * 100.0; }

// inside/rim/registration from the UNWARPED lookup so the fill matches the silhouette;
// warp ONLY the interior structure (tapered to 0 near the boundary) so tide-lines wander
// without pulling the fill off the plant shape.
float sampleField(vec2 uv, out float inside, out float rimField){
  float sp = seedPhase();
  vec4 s0 = texture(uTexture, uv);
  rimField = s0.g;
  inside = step(0.004, s0.r);
  float edgeDamp = smoothstep(0.02, 0.30, s0.r);
  vec2 wuv = uv + uWarpAmp * edgeDamp * vec2(fbm(uv*1.6 + sp, 3), fbm(uv*1.6 - sp + 4.3, 3));
  return texture(uTexture, clamp(wuv, 0.001, 0.999)).r;   // warped sdfN for the drying field
}

float dryingField(vec2 uv, float sdfN){
  return sdfN + uFbmB*fbm(uv*6.0 + uSeed*2.0, 4) + uPaperC*fbm(uv*40.0 + uSeed, 3);   // T
}

float bandThreshold(int k, int n){ return pow(float(k+1)/float(n+1), 1.6); }   // ~[0.05..0.79]
float hash1(float x){ return fract(sin(x*12.9898) * 43758.5453); }

// Tide-lines, NOT contour lines: (a) each band independently warped so they aren't parallel
// level-sets, (b) low-freq OCCUPANCY mask so a band exists for an arc then fades/reappears,
// (c) per-band width/gain jitter, (d) crisp<->feathered along its length via a low-freq field.
float bandTerm(vec2 uv, float T, float w, int n, float sp){
  float acc = 0.0;
  float soft = fbm(uv*2.0 + sp + 31.0, 3) * 0.5 + 0.5;   // 0..1: high = feathered, low = crisp
  for(int k=0;k<7;k++){
    float inRange = (k < n) ? 1.0 : 0.0;
    float fk = float(k);
    float Tk = T + 0.04 * fbm(uv*7.0 + fk*17.3 + sp, 3);                          // (a)
    float wTk = mix(0.006, 0.045, soft) * w * (0.7 + 0.6*hash1(fk*3.1 + sp));     // (c)+(d)
    float gainK = mix(1.0, 0.4, soft) * (0.55 + 0.9*hash1(fk*7.7 + sp));          // (c)+(d)
    float d = (Tk - bandThreshold(k, max(n,1)))/wTk;
    float spike = (d < 0.0) ? smoothstep(-1.0, 0.0, d) : exp(-d*d*0.6);           // asym line
    float occ = smoothstep(0.32, 0.62, fbm(uv*3.0 + fk*9.1 + sp, 3) * 0.5 + 0.5); // (b)
    acc = max(acc, spike * occ * gainK * inRange);
  }
  return acc;
}

vec3 kmReflectance(vec3 K, vec3 S){
  vec3 ks = K / max(S, vec3(1e-4));
  return clamp(1.0 + ks - sqrt(ks*ks + 2.0*ks), vec3(1e-4), vec3(1.0-1e-4));
}
float plateau(float d, float lo, float hi){ return mix(lo, d, smoothstep(lo, hi, d)); }

// One free-floating secondary glaze puddle -> returns (density contribution, wetness).
// Backrun conservation: pale evacuated core + dark scalloped rim (mobile pigment piles at
// the advancing front); NOT max density at the centre.
vec2 secondaryGlaze(vec2 uv, vec2 c, float r, float seedOff){
  float dist = length(uv - c) + 0.15 * r * abs(fbm(uv*9.0 + seedOff, 3));  // scalloped front
  float wet = 1.0 - smoothstep(0.0, r, dist);          // 1 at centre -> 0 at r
  if(wet <= 0.001) return vec2(0.0);
  float Tg = wet + uFbmB * fbm(uv*6.0 + seedOff + 3.7, 4);
  float bandsG = bandTerm(uv, Tg, uEdgeWidth, int(uBandCount), seedOff);
  float rim  = exp(-pow((wet - 0.16) / 0.12, 2.0));     // spike near the advancing front
  float core = smoothstep(0.28, 0.85, wet);            // bloom interior
  float dContrib = rim * (0.38 + bandsG * uBandGain) - core * 0.16;  // negative core = pale
  float warm = rim + 0.3 * core;                       // warmth concentrated at the front
  return vec2(dContrib, warm);
}

void main(){
  vec2 uv = vTextureCoord;
  float inside, rimField; float sdfN = sampleField(uv, inside, rimField);
  if(inside < 0.5){ finalColor = vec4(0.0); return; }
  float T = dryingField(uv, sdfN);
  float sp = seedPhase();

  // 1) flat-ish base wash so most of the leaf is a calm plateau
  float base = uBaseDensity * (0.92 + 0.16 * (fbm(uv*2.2 + sp, 3) * 0.5 + 0.5));
  // 2) plateau BEFORE bands (density field only, never T)
  float densP = plateau(base, uPlateauLo, uPlateauHi);
  // 3) + primary tide-lines
  float bands = bandTerm(uv, T, uEdgeWidth, int(uBandCount), sp);
  float dens = densP + bands * uBandGain;

  // weak WARM tidied mask rim (halved + occupancy dropouts -> not a triple outline)
  float rimBand = (1.0 - rimField) * smoothstep(0.35, 0.7, snoise(uv*14.0 + sp) * 0.5 + 0.5);
  dens += 0.2 * rimBand;

  // 3b) two free-floating secondary glaze puddles (seeded positions) -> overlap darkening,
  //     crossing tide-lines, and small pale-cored backrun blooms
  vec2 c1 = vec2(0.58, 0.42) + 0.24 * vec2(snoise(vec2(sp, 1.0)), snoise(vec2(sp, 2.0)));
  vec2 c2 = vec2(0.40, 0.62) + 0.24 * vec2(snoise(vec2(sp, 3.0)), snoise(vec2(sp, 4.0)));
  vec2 g1 = secondaryGlaze(uv, c1, 0.20, sp + 11.0);
  vec2 g2 = secondaryGlaze(uv, c2, 0.15, sp + 23.0);
  dens = max(dens + g1.x + g2.x, 0.0);   // scooped bloom cores can subtract -> clamp >= 0

  // granulation: value tooth (gated by dens) + high-freq subtractive on COVERAGE so paper
  // specks show through the wash
  float grain = fbm(uv*62.0 + sp, 2) * fbm(uv*23.0 - sp, 2);
  dens *= 1.0 + 0.15 * grain * smoothstep(0.06, 0.45, dens);
  float grainHi = fbm(uv*110.0 + sp, 2) * 0.5 + 0.5;

  // 4) pigment split: warm follows the late-drying glaze pools (moves per seed), capped at
  //    0.75 so pigment-B never fully displaces the green
  float warmField = clamp(0.4 * smoothstep(uMixT0, uMixT1, sdfN) + 0.85 * (g1.y + g2.y), 0.0, 1.0);
  float m = clamp(warmField + rimBand * 0.4, 0.0, 0.75);
  vec3 K = mix(uKA, uKB, m) * dens;                    // concentration scales K only
  vec3 S = mix(uSA, uSB, m);
  vec3 R = kmReflectance(K, S);
  float cover = clamp(dens / uCoverKnee, 0.0, 1.0);
  cover *= 1.0 - 0.28 * smoothstep(0.55, 0.85, grainHi);   // paper shows through
  vec3 col = mix(uPaperColor, R, cover);
  col += (ditherBlue(gl_FragCoord.xy) - 0.5) / 255.0;      // 5) dither
  finalColor = vec4(col, 1.0);
}
