#version 300 es
// Procedural watercolor fill — fragment shader (GLSL ES 3.00). Single baked pass per
// plant instance. Imported as a string via `?raw` into ProceduralWatercolorFilter.ts.
//
// uTexture = the filter INPUT: a per-plant texture where R = sdfN (0 at silhouette edge ->
//   1 at deepest interior), G = rim (0 at edge -> 1 by ~10px in). Pixi maps vTextureCoord to it.
// Pigments are Kubelka-Munk K/S (uKA/uSA green, uKB/uSB warm) derived on the CPU from Curtis
//   Rw/Rb samples; uPaperColor = cream. Dead uniforms (uTexelWorld/uOffBase/uOffNoiseAmp/
//   uInteriorScale/uShadowDir/uShadowAmp) are leftovers from an abandoned puddle approach.
precision highp float;
in vec2 vTextureCoord;
out vec4 finalColor;
uniform sampler2D uTexture;
uniform float uTexelWorld, uSeed, uOffBase, uOffNoiseAmp, uWarpAmp, uShadowAmp, uFbmB, uPaperC;
uniform float uInteriorScale;
uniform vec2 uShadowDir;
uniform float uBandCount, uEdgeWidth, uBandGain;
uniform vec3 uKA, uSA, uKB, uSB, uPaperColor;
uniform float uPlateauLo, uPlateauHi, uMixT0, uMixT1, uBaseDensity, uCoverKnee;
uniform float uDebugStage;   // 0 = final; 1..8 = dump an intermediate stage

// ── vendored noise (Ashima simplex, MIT; standard fbm + hashed dither) ────────────────
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
}
float fbm(vec2 p, int octaves){
  float sum=0.0, amp=0.5, freq=1.0;
  for(int i=0;i<8;i++){ if(i>=octaves) break; sum+=amp*snoise(p*freq); freq*=2.0; amp*=0.5; }
  return sum;
}
float ditherBlue(vec2 fragXY){
  return fract(sin(dot(fragXY,vec2(12.9898,78.233)))*43758.5453);
}

// ── pipeline ──────────────────────────────────────────────────────────────────────────
float seedPhase(){ return fract(sin(uSeed * 12.9898) * 43758.5453) * 100.0; }

// inside/rim/registration from the UNWARPED lookup so the fill matches the silhouette;
// warp ONLY the interior structure (tapered near the boundary) so tide-lines wander.
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
    float wTk = mix(0.009, 0.045, soft) * w * (0.7 + 0.6*hash1(fk*3.1 + sp));     // (c)+(d)
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

// One free-floating secondary glaze puddle -> (density contribution, wetness). Backrun
// conservation: pale core (lightens within the wash) + dark scalloped, occupancy-gated,
// drier-side-biased front (broken C, not a full ring).
vec2 secondaryGlaze(vec2 uv, vec2 c, float r, float seedOff){
  vec2 rel = uv - c;
  float aAng = hash1(seedOff * 1.7) * 6.283;
  vec2 ax = vec2(cos(aAng), sin(aAng));
  float stretch = 1.3 + 0.3 * hash1(seedOff * 2.3);            // 1.3..1.6 elliptical
  vec2 relE = vec2(dot(rel, ax), dot(rel, vec2(-ax.y, ax.x)) * stretch);
  float dist = length(relE) + (fbm(uv*9.0 + seedOff, 3)) * 0.30 * r;   // signed -> concave lobes
  float wet = 1.0 - smoothstep(0.0, r, dist);
  if(wet <= 0.001) return vec2(0.0);
  float Tg = wet + uFbmB * fbm(uv*6.0 + seedOff + 3.7, 4);
  float bandsG = bandTerm(uv, Tg, uEdgeWidth, int(uBandCount), seedOff);
  float rim  = exp(-pow((wet - 0.16) / 0.12, 2.0));
  float core = smoothstep(0.28, 0.85, wet);
  float ang = atan(rel.y, rel.x);
  vec2 flowDir = normalize(c - vec2(0.5) + 1e-5);
  float dirBias = 0.5 + 0.5 * dot(normalize(rel + 1e-5), flowDir);
  float rimOcc = smoothstep(0.25, 0.72, fbm(vec2(cos(ang), sin(ang))*1.5 + seedOff, 3) * 0.5 + 0.5)
               * (0.3 + 0.7 * dirBias);
  float rimStr = rim * rimOcc;
  float dContrib = rimStr * (0.22 + bandsG * uBandGain) - core * 0.16;
  float warm = rimStr + 0.25 * core;                          // neutral (green) where rim absent
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

  // 3b) 0..2 free-floating secondary glaze puddles (seeded) -> overlap darkening, crossing
  //     tide-lines, and small pale-cored backrun blooms; some straddle the silhouette edge.
  float haveG1 = step(hash1(sp + 41.0), 0.75);
  float haveG2 = step(hash1(sp + 57.0), 0.55);
  float r1 = 0.20 * (0.6 + 0.8 * hash1(sp + 3.0));   // ±40%
  float r2 = 0.15 * (0.6 + 0.8 * hash1(sp + 9.0));
  vec2 c1 = vec2(0.55, 0.45) + 0.30 * vec2(snoise(vec2(sp, 1.0)), snoise(vec2(sp, 2.0)));
  vec2 c2 = vec2(0.45, 0.58) + 0.34 * vec2(snoise(vec2(sp, 3.0)), snoise(vec2(sp, 4.0)));
  vec2 g1 = haveG1 * secondaryGlaze(uv, c1, r1, sp + 11.0);
  vec2 g2 = haveG2 * secondaryGlaze(uv, c2, r2, sp + 23.0);
  dens = max(dens + g1.x + g2.x, densP * 0.55);   // scoop lightens within the wash (no bare paper)

  // granulation: value tooth (gated by dens) + high-freq subtractive on COVERAGE (paper through)
  float grain = fbm(uv*62.0 + sp, 2) * fbm(uv*23.0 - sp, 2);
  dens *= 1.0 + 0.15 * grain * smoothstep(0.06, 0.45, dens);
  float grainHi = fbm(uv*110.0 + sp, 2) * 0.5 + 0.5;

  // 4) pigment split: warm follows the late-drying glaze pools (moves per seed), capped at 0.75
  float warmField = clamp(0.4 * smoothstep(uMixT0, uMixT1, sdfN) + 0.85 * (g1.y + g2.y), 0.0, 1.0);
  float m = clamp(warmField + rimBand * 0.4, 0.0, 0.75);
  vec3 K = mix(uKA, uKB, m) * dens;                 // concentration scales K only
  vec3 S = mix(uSA, uSB, m);
  vec3 R = kmReflectance(K, S);
  float cover = clamp(dens / uCoverKnee, 0.0, 1.0);
  cover *= 1.0 - 0.28 * smoothstep(0.55, 0.85, grainHi);   // paper shows through
  vec3 col = mix(uPaperColor, R, cover);
  col += (ditherBlue(gl_FragCoord.xy) - 0.5) / 255.0;      // 5) dither

  // Stage dump switch (uDebugStage>0 outputs one intermediate as grayscale/color).
  int stg = int(uDebugStage + 0.5);
  if(stg == 1){ finalColor = vec4(vec3(texture(uTexture, uv).r),1.0); return; } // raw sdfN
  if(stg == 2){ finalColor = vec4(vec3(sdfN),1.0); return; }                    // sdfN
  if(stg == 3){ finalColor = vec4(vec3(clamp(T,0.0,1.0)),1.0); return; }        // drying field T
  if(stg == 4){ finalColor = vec4(vec3(clamp(bands,0.0,1.0)),1.0); return; }    // raw bandTerm
  if(stg == 5){ finalColor = vec4(vec3(clamp(dens,0.0,1.0)),1.0); return; }     // total density
  if(stg == 6){ finalColor = vec4(vec3(m),1.0); return; }                       // pigment mix m
  if(stg == 7){ finalColor = vec4(vec3(cover),1.0); return; }                   // coverage alpha
  if(stg == 8){ finalColor = vec4(R,1.0); return; }                            // K-M reflectance
  finalColor = vec4(col, 1.0);                                                  // 0 = final
}
