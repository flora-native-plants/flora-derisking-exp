# Round 2: tuning the graphite stroke-shader (ribbon mesh) so it reads as pencil

## Recap — your Phase A/B plan worked
You diagnosed the full-screen filter over the scaled `world` container as the cause of the
stairstepping (below-screen-res RenderTexture) and the 4fps cliff (bounds grow with zoom). We
did:
- **Phase A:** killed the world filter; strokes now draw multiply-blended over a screen-fixed
  paper sprite. Stairstepping gone.
- **Phase B (this):** strokes are now **ribbon meshes** (CPU-expanded from our cached kinematic
  op-list, one mesh per run) with a **stroke-space fragment shader**. Confirmed: crisp at 5.5×
  (no stairstep), no full-screen filter, cost per-stroke. The architecture is right.

Now we're tuning the **material** in that stroke shader and it's not reading as graphite yet.
Zoomed-in detail captures (fat 14px strokes, ~3.5× on a crossing) are attached — please look.

## What the zoomed detail shows (the problems)
1. **Edge softness is a blur, not a graphite edge.** At `edgeSoft=0.5` the whole stroke reads
   *out of focus* (see `fable2-default`). At `edgeSoft=0` the edge is crisp but then:
2. **The paper "tooth" reads as coarse BLOCKY WHITE GAPS punching through the stroke**, not fine
   graphite grain (see `fable2-tooth`, tooth=1, edge=0). The white chunks are large relative to
   the line — it looks like the stroke is disintegrating in rectangles, because we sample the
   paper *height* texture (a 512² scanned watercolor-paper tile) at `grainScale=40` world units
   with a two-octave crossfade, and at this zoom the chosen octave is coarse.
3. **Tone-along-stroke is too subtle** to read as pencil pressure, even cranked (`fable2-tone`,
   toneAmp=0.85).
4. **Tapered tips are fuzzy** at the sharp overshoot-crossing corners (blue zigzag tips).

Net: crisp OR toothy-but-blocky, and never "fine graphite grain on a confident line."

## The current code — the whole thing to critique

`src/lib/strokeRibbon.ts` builds one ribbon `Mesh` per run. Geometry (CPU-expanded):
- `positions` = each centreline point pushed to ±normal × `halfWidth` (halfWidth = strokePx/zoom
  in world units; we rebuild on zoom so screen width is constant and wobble stays cached/stable).
- `uvs` = `(arcLength_world, side)` where side ∈ {0,1} across the ribbon.
- indices = triangle list.
Each mesh: `blendMode = 'multiply'`, shared `GlProgram`, per-mesh `UniformGroup` (uRunLen etc.),
and the paper texture bound as a resource. `uColor` is the CAD-layer colour tinting the graphite.

### Vertex shader
```glsl
#version 300 es
in vec2 aPosition;   // expanded ribbon vertex, world coords
in vec2 aUV;         // (arcLength_world, side 0|1)
out vec2 vUV;
out vec2 vWorld;
uniform mat3 uProjectionMatrix;      // provided by Pixi's mesh pipe
uniform mat3 uWorldTransformMatrix;
uniform mat3 uTransformMatrix;
void main() {
  mat3 mvp = uProjectionMatrix * uWorldTransformMatrix * uTransformMatrix;
  gl_Position = vec4((mvp * vec3(aPosition, 1.0)).xy, 0.0, 1.0);
  vUV = aUV;
  vWorld = aPosition;
}
```

### Fragment shader (the material — please rewrite/advise)
```glsl
#version 300 es
precision highp float;
in vec2 vUV;      // (s world arc length, side 0..1)
in vec2 vWorld;   // world position
out vec4 finalColor;

uniform sampler2D uPaperTex;   // 512x512 scanned watercolor-paper height tile, addressMode repeat
uniform float uZoom;
uniform float uRunLen;         // this run's total arc length (world)
uniform float uGrainScale;     // 40 (world units per paper tile)
uniform vec3  uColor;          // warm graphite tint (or CAD layer colour)
uniform float uTaperLen;       // world units to taper at each end (~12)
uniform float uToneAmp;        // 0..1 alpha variation along stroke
uniform float uTooth;          // 0..1 paper-tooth breakup
uniform float uEdgeSoft;       // 0..1 ragged-edge softness

float hash11(float p){ p=fract(p*0.1031); p*=p+33.33; p*=p+p; return fract(p); }
float vnoise1(float x){ float i=floor(x),f=fract(x); float u=f*f*(3.0-2.0*f); return mix(hash11(i),hash11(i+1.0),u); }
float lum(vec3 c){ return dot(c, vec3(0.299,0.587,0.114)); }
// paper height, world-anchored, two-octave crossfade for constant apparent size on zoom
float paperHeight(vec2 uv){
  float L=log2(max(uZoom,0.0001)); float o=floor(L); float f=fract(L);
  float h0=lum(texture(uPaperTex, uv*exp2(o)).rgb);
  float h1=lum(texture(uPaperTex, uv*exp2(o+1.0)).rgb);
  return mix(h0,h1,f);
}
void main(){
  float s = vUV.x;
  float side = vUV.y*2.0 - 1.0;      // -1..1 across the ribbon
  float edge = abs(side);            // 0 centre -> 1 edge

  // 1. tone along the stroke (low-freq graphite deposit)
  float tone = mix(1.0 - uToneAmp, 1.0, vnoise1(s*0.03 + 7.0));

  // 2. tapered entry/exit
  float d = min(s, uRunLen - s);
  float taper = clamp(d / max(uTaperLen,1.0), 0.0, 1.0);

  // 3. ragged, slightly eroded edge (jitter falloff along s)
  float jit = (vnoise1(s*0.6) - 0.5) * 0.35;
  float aa = fwidth(edge) + 1e-4;
  float cover = 1.0 - smoothstep(1.0 - uEdgeSoft - jit - aa, 1.0 + jit, edge);

  // 4. paper tooth: graphite skips valleys; bites harder where tone is light
  float h = paperHeight(vWorld / uGrainScale);
  float tooth = mix(1.0, h, uTooth * (1.3 - tone));

  float a = clamp(tone*taper*cover*tooth, 0.0, 1.0);
  finalColor = vec4(uColor * a, a);  // premultiplied; mesh multiply-blends over paper
}
```

## Constraints (unchanged)
- PixiJS v8 / WebGL. Ribbon mesh, multiply blend over a world-anchored paper sprite.
- Strokes are ~2px screen at real use (fat here only to see grain). World-feet coords, continuous
  pan/zoom; tooth must stay world-anchored + constant apparent size (the octave crossfade).
- We have a 512² scanned paper-height tile; can bake/generate others (we have an FFT random-phase
  generator that emits seamless height tiles). No scanned graphite-*mark* strip yet.

## Questions
1. **Tooth that reads as fine graphite grain, not blocky white holes.** How should the tooth
   actually work? Our `mix(1, h, ...)` on a coarse height tile punches big white gaps. Is the fix
   a much finer grain frequency (smaller uGrainScale / a dedicated high-freq grain, separate from
   the paper *relief*), a threshold/pressure model (graphite only fills above a pressure vs
   paper-height threshold), sampling in *screen* space at a fixed px frequency instead of world
   space, or a real scanned graphite-mark alpha? What's the right graphite-on-tooth math at ~2px
   AND when zoomed to fat?
2. **Crisp-but-textured edge, not a blur.** At `edgeSoft>0` it looks out of focus. How do we get
   a slightly eroded/ragged graphite edge that still reads sharp? (edge noise on `side` vs on a
   world-space grain? higher-frequency? alpha threshold with fwidth AA?)
3. **Tone/pressure that reads as graphite.** Is smooth low-freq alpha noise on arc length the
   right model, or do we need width variation + multiply build-up + darker cores?
4. **Sharp tips.** Taper fuzzes the sharp overshoot-crossing corners. Better cap/taper handling?
5. Given all the above, is procedural enough at 2px, or do we now need the scanned mark strip —
   and if so, how to author + map a tileable graphite-mark alpha along `s` cleanly?

## Screenshots attached
- `fable2-default.png` — current defaults (tone 0.4, tooth 0.5, edge 0.5): blurry, soft.
- `fable2-tooth.png` — edge 0, tooth 1: crisp edges BUT tooth = coarse blocky white gaps.
- `fable2-tone.png` — heavy tone (0.85): tone still subtle.
- (also `ribbon-fit.png` for whole-drawing context, `ribbon-zoom5x.png` showing it's crisp at 5.5×.)
