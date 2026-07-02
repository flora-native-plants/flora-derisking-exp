We built the single-pass procedural watercolor you helped design, and implemented your naturalism
advice. Attached: (1) **grid9** — current procedural output, 9 seeds of the same Red Maple; (2)
**flat-loose** — one leaf in detail; (3) **variants-realtex** — the real scanned-texture reference
we're trying to match. It went from a flat airbrush blob to what you see now. I want your critique
on what still reads artificial and the highest-leverage next moves.

## What's implemented (your levers)
- **Kubelka–Munk** 2-pigment compositing (settling green + mobile warm), hue driven by the drying field.
- **Drying-time field T** → asymmetric, max-combined **iso-band tide-lines** (compact tails so bands stay discrete).
- **Flat-plateau discipline**: hue-mix reads off the SMOOTH field (not noisy T), base wash flattened → calm plateau, tonal energy in the bands.
- **Layered glazes**: 2 free-floating secondary puddles composited over the primary → overlap darkening + crossing tide-lines.
- **Warm bloom follows the per-seed glaze pools** (not a centered bullseye) — you can see the warm pool move across the 9 seeds.
- **Granulation**: 2-frequency grain gated by pigment density (tooth in the washes, clean plateau).
- **Pencil-pressure contour**: per-segment width/alpha + lifted-pencil gaps (not a uniform "worm").
- Low-frequency warp decentres the tide-lines so they wander.

## What still reads artificial to us (please confirm / correct / add)
1. **"Topographic map" quality** — the biggest tell. The tide-lines read like smooth, continuous
   *contour lines / elevation bands* nested around the pools, not loose watercolor tide-marks. Real
   ones (see realtex) are more broken, irregular in strength along their length, and don't form tidy
   nested loops. How do we break the "contour map" read?
2. **The warm pools look like defined "eyes"/blobs** in some seeds — too smooth-edged and object-like,
   not like pigment that pooled and dried.
3. **No wet-in-wet softness** — everything is wet-on-dry hard-ish edges; there's no soft feathered
   diffusion anywhere. Real washes mix hard and soft edges.
4. **It's a bit saturated / "digital green"** vs the realtex's more muted, granular, paper-shot greens.
5. Compared to realtex: the reference has a quieter, flatter overall value with sparse dark accents;
   ours has more mid-tone busyness.

## Questions
- What are the 2–3 highest-leverage changes to kill the "topographic contour map" look specifically?
- How do we introduce believable **hard-AND-soft edge variety** (some tide-lines crisp, some feathered)
  in a single baked pass?
- Is the warm-pool treatment right, or should blooms be handled differently (backrun cascades, pale
  cores, irregular dendritic edges)?
- Anything in the value/saturation/paper interaction that would close the gap to the realtex reference?
- Given all this is a single baked pass per instance, what would you prioritize next, and what would
  you explicitly NOT bother with?

Be specific and concrete. If something we did is wrong or working against realism, say so. The core
GLSL is below so you can point at exact lines.

---

## Core shader (GLSL ES 3.00, single baked pass per instance)

Context: `uTexture` = a per-plant texture where **R = sdfN** (0 at silhouette edge → 1 at deepest
interior) and **G = rim** (0 at edge → 1 by ~10px in). `fbm`/`snoise` are standard. Pigments are
Kubelka–Munk K/S derived from Curtis Rw/Rb samples: A = settling green (Rw 0.35,0.62,0.48 / Rb
0.06,0.20,0.13), B = mobile warm (Rw 0.80,0.56,0.24 / Rb 0.26,0.13,0.05). `uPaperColor` = cream.

```glsl
float sampleField(vec2 uv, out float inside, out float rimField){
  float sp = seedPhase();
  vec2 wuv = uv + uWarpAmp * vec2(fbm(uv*1.6 + sp, 3), fbm(uv*1.6 - sp + 4.3, 3)); // decentre bands
  vec4 s = texture(uTexture, clamp(wuv, 0.001, 0.999));
  rimField = s.g; inside = step(0.004, s.r);
  return s.r;                                  // sdfN, radial 0..1
}
float dryingField(vec2 uv, float sdfN){
  return sdfN + uFbmB*fbm(uv*6.0 + uSeed*2.0, 4) + uPaperC*fbm(uv*40.0 + uSeed, 3);   // T
}
float bandThreshold(int k, int n){ return pow(float(k+1)/float(n+1), 1.6); }   // ~[0.05..0.79]
// asymmetric iso-band tide-line; MAX-combined so bands stay discrete
float bandTerm(float T, float w, int n){
  float wT = 0.008 + 0.02*w;                   // narrow T-space width
  float acc = 0.0;
  for(int k=0;k<7;k++){
    float inRange = (k<n)?1.0:0.0;
    float d = (T - bandThreshold(k, max(n,1)))/wT;
    float spike = (d<0.0) ? smoothstep(-1.0,0.0,d) : exp(-d*d*0.6); // sharp rise, short gaussian tail
    acc = max(acc, spike*inRange);
  }
  return acc;
}
vec3 kmReflectance(vec3 K, vec3 S){ vec3 ks=K/max(S,vec3(1e-4)); return clamp(1.0+ks-sqrt(ks*ks+2.0*ks), vec3(1e-4), vec3(1.0-1e-4)); }
float plateau(float d, float lo, float hi){ return mix(lo, d, smoothstep(lo,hi,d)); }

// one free-floating secondary glaze puddle -> returns (density, wetness)
vec2 secondaryGlaze(vec2 uv, vec2 c, float r, float seedOff){
  float warp = uWarpAmp*fbm(uv*1.6 + seedOff, 3);
  float wet = 1.0 - smoothstep(0.0, r, length(uv-c) + warp*r);   // soft 1@centre -> 0@r
  if(wet <= 0.001) return vec2(0.0);
  float Tg = wet + uFbmB*fbm(uv*6.0 + seedOff + 3.7, 4);
  float bandsG = bandTerm(Tg, uEdgeWidth, int(uBandCount));
  float f = wet*wet;                           // fade to 0 at edge (no hard ring)
  return vec2(f*(uBaseDensity*0.45 + bandsG*uBandGain), f);
}

void main(){
  vec2 uv = vTextureCoord;
  float inside, rimField; float sdfN = sampleField(uv, inside, rimField);
  if(inside < 0.5){ finalColor = vec4(0.0); return; }
  float T = dryingField(uv, sdfN);
  float sp = seedPhase();

  float base = uBaseDensity*(0.92 + 0.16*(fbm(uv*2.2 + sp, 3)*0.5+0.5));   // flat-ish base wash
  float densP = plateau(base, uPlateauLo, uPlateauHi);                     // plateau BEFORE bands
  float bands = bandTerm(T, uEdgeWidth, int(uBandCount));
  float dens = densP + bands*uBandGain;

  float rimBand = (1.0 - rimField)*(0.5 + 0.5*snoise(uv*20.0 + sp));       // warm tidied edge
  dens += 0.4*rimBand;

  // layered glazes (2 free-floating puddles, seeded positions)
  vec2 c1 = vec2(0.60,0.44) + 0.18*vec2(snoise(vec2(sp,1.0)), snoise(vec2(sp,2.0)));
  vec2 c2 = vec2(0.42,0.60) + 0.18*vec2(snoise(vec2(sp,3.0)), snoise(vec2(sp,4.0)));
  vec2 g1 = secondaryGlaze(uv, c1, 0.34, sp+11.0);
  vec2 g2 = secondaryGlaze(uv, c2, 0.27, sp+23.0);
  dens += g1.x + g2.x;                                                     // overlap darkening

  float grain = fbm(uv*62.0 + sp, 2)*fbm(uv*23.0 - sp, 2);                 // granulation tooth
  dens *= 1.0 + 0.18*grain*smoothstep(0.06, 0.45, dens);

  // warm follows late-drying glaze pools (moves per seed), not the fixed radial centre
  float warmField = clamp(0.45*smoothstep(uMixT0,uMixT1,sdfN) + 0.8*(g1.y+g2.y), 0.0, 1.0);
  float m = clamp(warmField + rimBand*0.5, 0.0, 1.0);

  vec3 K = mix(uKA,uKB,m)*dens;                                            // K-M, concentration=K*dens
  vec3 S = mix(uSA,uSB,m);
  vec3 R = kmReflectance(K, S);
  float cover = clamp(dens/uCoverKnee, 0.0, 1.0);                          // coverage alpha (separate)
  vec3 col = mix(uPaperColor, R, cover);
  col += (ditherBlue(gl_FragCoord.xy) - 0.5)/255.0;                        // dither
  finalColor = vec4(col, 1.0);
}
```
Defaults in the attached renders: warpAmp 0.20, fbmB 0.15, paperC 0.03, bandCount 3, edgeWidth 1.2,
bandGain 0.7, baseDensity 0.42, coverKnee 0.55, plateauLo 0.20, plateauHi 0.62, mixT0 0.50, mixT1 1.00.
