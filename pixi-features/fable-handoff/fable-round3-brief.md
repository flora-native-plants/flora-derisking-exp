# Fable round-3 brief — Pencil Ribbon (Phase C), after your round-2 material spec

We implemented your round-2 spec (vertex-shader expansion + `aPressure`, high-frequency grain tile,
thresholded tooth, ragged edge, gamma tone, tip taper). **Big wins, one honest failure, a couple of
questions.** All captures are **headless software-GL (SwiftShader)** — Geoff is eyeballing on real
hardware before we tune against anything AA-related, since the blend/AA can differ.

## What landed (per your order)
1. **Vertex-shader expansion + build-once geometry.** Attributes `aPosition`(centre), `aUV`(s,side),
   `aNormal`, `aPressure`(seeded, CPU). Zoom + stroke width are now single uniform writes; no
   per-zoom rebuild.
2. **Deposition grain = dedicated high-frequency tile** (`graphite-grain.png`), made by inverting the
   RPN generator's rolloff into a high-pass (cutoff 0.25 of Nyquist). Watercolor tile now only drives
   the background relief, as you said.
3. **Thresholded tooth**, pressure-dependent threshold `mix(0.72,0.18,pressure)`, AA'd with `fwidth(g)`.
4. **Edge:** erode the *limit* via the grain field, transition stays `fwidth` (rewrote your descending
   `smoothstep(limit+aa, limit-aa, edge)` as the ascending `1.0 - smoothstep(limit-aa, limit+aa, edge)`
   — the descending form is undefined GLSL and rendered nothing on software-GL).
5. **Tone:** `pow(mix(1-uToneAmp,1,pressure),1.6)`.
6. **Tip taper — deliberate deviation from your spec:** you said bake the taper into `aPressure` at
   build. But you also want `taperLen = uTaperPx/uZoom` (screen-constant tip length), and geometry is
   now built once — those conflict. So `aPressure` carries only seeded pressure, and the **tip taper is
   computed in the vertex shader** from `aS`/`uRunLen`/`uTaperPx/uZoom`. Screen-constant tips + build-once.
   (Also renamed our ink-color uniform `uColor`→`uInk`: `uColor` is Pixi's reserved mesh-tint vec4 and
   was colliding.)

## Results
- **`00-BEFORE-white-rectangles.png`** — the round-2 problem.
- **`02-fat-12px-detail-tooth-shot.png`** (the acceptance shot, 12px diagnostic, ~3.5×) — **the white
  rectangles are GONE.** Consistent tooth grain, crisp tapered tips, no fuzzy ghosts, pressure width+tone
  swell. This view is genuinely good.

## The honest failures / questions

### Q1 (BLOCKER for shipping) — thin strokes at REAL use look broken. `01-thin-2.5px-1x-REAL-USE.png`
Strokes are used at ~2–2.5px near 1× zoom. There, `fwidth(edge) ≈ 1/halfWidthPx ≈ 1`, so the edge AA
band spans the **entire** ribbon → there's no opaque core → faint, and low-pressure sections dissolve
entirely. It's compounded: tone (pow-gamma) × tooth × multiply all dim together at thin widths. The fat
shot hides this. **How do we keep a solid opaque core at 2px while preserving the ragged edge?** Candidates
we see: (a) clamp `fwidth` AA to a fraction of half-width; (b) a min-width fully-opaque core that the edge
erosion/tooth can't touch; (c) attenuate pressure→tone coupling as width→thin; (d) a coverage floor. What's
the right structure so 2px reads as a confident pencil line, not a hairline?

### Q2 — "pepper-fleck skips" became "even fine texture."
You wanted graphite skipping over tooth. We got even, low-contrast grain (see the fat shot) — no dramatic
white flecks. Is our high-pass tile too fine / too low-contrast (cutoff 0.25), or is the threshold band
`thresh±(fwidth+0.02)` too wide? Should the grain tile be coarser / higher-contrast, or the band tighter?

### Q3 — burst artifact where strokes converge (tree-circle centre in the thin shot).
At tight cusps/closures the per-vertex-normal ribbon overlaps into a fuzzy blob. Is this worth solving in
geometry (miter/cusp handling) or just a fixture quirk to ignore for the material work?

## Files
- `01-thin-2.5px-1x-REAL-USE.png` — **the problem to solve.**
- `02-fat-12px-detail-tooth-shot.png` — material working (diagnostic view).
- `03-fat-12px-fullview.png` — overall fat look.
- `00-BEFORE-white-rectangles.png` — round-2 state.
- Shader: `src/lib/strokeRibbon.ts`. Tab: `src/tabs/TabPencilRibbon.vue`. Grain gen: `scripts/gen-paper-height.ts`.
