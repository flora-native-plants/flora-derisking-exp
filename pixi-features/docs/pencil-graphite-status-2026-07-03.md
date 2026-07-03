# Pencil / Graphite Material — Status & Handoff (2026-07-03)

**Where things stand (updated end of 2026-07-03 session):** after Geoff pointed at the Ciallo
**airbrush/stipple** stroke as "authentic graphite on paper," we built a **stipple deposition** mode
into the ribbon shader — a dot-scatter of graphite powder on our *believable* kinematic path (not a
robotic sine). It's the closest we've gotten: the black stipple border reads as genuine graphite.
It matches the reference's **light-to-mid** marks; still doesn't reach the **dense-heavy** end
(near-solid dark core). This doc is the pick-up point.

**Latest commits on `plant-style-playground` (NOT pushed):**
- `748943f` — selectable MEDIUM (Graphite / Crayon presets + tab selector)
- `c99570e` — **stipple deposition** (Graphite-stipple medium) + status doc
- `5648bf3` — gray out combed-grain sliders in stipple mode (honest no-ops)

---

## 1. The goal

Give flora-studio's rendered vector line art a convincing **hand-drawn pencil/graphite-on-paper**
look — where marks catch on paper tooth, vary in tone, and read as real soft graphite. Would also
accept charcoal / colored-pencil / crayon / ink. Must work in the **zoom-stable, cached-vector,
PixiJS v8 (WebGL2)** renderer — not a raster painting engine.

**The target reference:** `public/textures/pencil/stroke-arcs-grid.png` — a Gemini-generated
"pressure ladder" of 16 graphite arcs (light→heavy). This is the look we're chasing.

---

## 2. What we built (all committed on `plant-style-playground`, NOT pushed)

The testbed is the **"Pencil Ribbon (mesh)"** tab in `pixi-features` (dev server `npm run dev` → :5202).

- **`src/lib/strokeRibbon.ts`** — ribbon-mesh geometry builder + WebGL vertex/fragment shaders.
  Vertex-shader expansion, geometry built ONCE; zoom + width are uniforms. Material (paper-tooth
  threshold deposit, ragged edge, pressure tone, directional grain, tip taper) is in the fragment
  shader. World-anchored two-octave grain → constant apparent grain size on zoom (no crawl).
- **Naturalness passes** (earlier this week): directional grain, edge-biased tooth, tonal build-up,
  tooth-contrast control, thin-stroke dropout fix. Left it fully procedural — never wired a scanned
  mark texture.
- **Selectable MEDIUM** — `STROKE_MEDIA` presets + a selector in the tab. One engine, N material
  presets, each at its **native width**:
  - **Graphite (combed)** — 6px. Soft directional tooth (grain stretched along travel). Reads at width.
  - **Graphite (stipple)** — 9px. **Dot-scatter graphite powder** (the Ciallo-airbrush look). The
    current best. `stipple: 1, stippleScale: 1.4`, fine cells → dense core feathering to edges.
  - **Crayon / colored pencil** — 3px. Waxy pepper-skip speckle. Reads *at thin* real-use width.
- **Stipple shader** (commit `c99570e`) — added to the fragment shader: isotropic soft-dot scatter,
  world-anchored **two-octave crossfade** (zoom-stable dot size, same trick as the grain field),
  density high in core / feathering to edges / rising with pressure. `stipple`/`stippleScale` params
  on `StrokeRibbonParams`. Toggle/blend via `uStipple` (0 combed → 1 stipple).
- **Slider validity** (commit `5648bf3`) — in stipple mode, the combed-grain sliders (Grain scale,
  Tooth contrast, Grain streak, Edge softness) are grayed out + disabled (`combedOff` computed).
  Made honest: edge erosion decoupled from combed grain when stippling (`gEdge = mix(g, 1.0,
  uStipple)`) so those four are genuine no-ops. NO stipple-specific slider exists yet (dot scale /
  core density are baked into the preset) — adding them is the obvious next UX step for live tuning.

### Capture harnesses (output → `.naturalize-out/`, gitignored; dev server on :5202)
- `scripts/shot-ribbon-thin.ts` — 2.5px @ 1× (real-use condition)
- `scripts/shot-ribbon-detail.ts` — 12px @ ~3.5× (diagnostic)
- `scripts/shot-ribbon-media.ts` — each medium (combed / stipple / crayon) at its native width
- `scripts/shot-ribbon-panel.ts` — full control panel in stipple mode (verifies slider gray-out)
- `scripts/compare-vs-refs.ts` — **our latest renders next to the AI reference ladder** in one frame
  (`.naturalize-out/compare-vs-refs.png`). Run `shot-ribbon-media` FIRST, then this.

---

## 3. The two things we learned that actually matter

### A. The width gate (confirmed three times, including by Geoff's own hand)
**Convincing soft graphite needs stroke WIDTH.** Every convincing mark — the reference ladder,
MyPaint's pencil, p5.brush's graphite, the Ciallo demos — is a broad soft band, never a thin clean
line. At 2.5px real-use thinness there's ~2px across the ribbon; AA eats the tooth and it reads as
*pen*, not pencil. This is physics, not a missing library. Verified in p5.brush's Brush Maker
(Geoff drew thin lines → read as "crayons") and in our own comparison.

**Consequence — the medium fork (Geoff's pick: "both, as selectable styles"):**
- Thin lines → **crayon / colored-pencil** (speckle IS the look; thin-friendly; natural for planting
  plans; Annie's world already uses colored-pencil rendering).
- Heavy lines → **soft graphite** (needs width; use for profile/property lines via weight hierarchy).
- Medium = a **per-object choice**, orthogonal to the geometry-roughness ladder (Crisp/Architect/
  Artist from the kinematic work).

### B. Honest gap vs. the reference (from `compare-vs-refs.png` — regenerate to refresh)
The **stipple** medium closed the biggest gap (grain character): it's now fine isotropic dot-powder,
not combed striations. Remaining gap:
1. ~~Grain character~~ — **FIXED by stipple.** Was combed striations (`grainStreak: 0.6`); now
   dot-scatter powder.
2. **Tonal drama (the remaining gap):** reference ramps whisper→near-black; the reference's *heavy*
   arcs go near-solid black in the core with granular edges. Ours stays uniformly dotty and never
   reaches that dense dark core. **Fix:** ramp stipple density/dot-overlap harder with pressure so
   the core merges toward solid at high pressure while edges stay feathered. (Untried — next tuning.)
3. **Colored strokes read light** (expected — colored ink at mid value; graphite-gray reads best).

**The ceiling (unchanged):** the reference's fine powder is what **stamping a real scanned graphite
texture** gives for free. Our procedural stipple approximates it and is zoom-stable + asset-free;
the scanned-texture route (pass B via Joshi/p5.brush) is the higher ceiling if stipple plateaus.

---

## 4. Research findings — the method, and what's real

Two AI deep-research reports (saved: `docs/gemini-graphite-simulation-research.md` +
`~/Downloads/compass_artifact_wf-94953464-*.md`) plus our own verification converged on ONE method:

> **Texture-synthesis stroke stamping** — scatter a scanned/procedural grain footprint along the
> stroke path, over a paper-tooth height field, with pressure→deposition (Sousa & Buchanan's
> tooth-valley model). This is our reserved "pass B."

**Architecture split that matters (both reports blur it):**
- **Raster dab/fluid engines** (libmypaint, Krita, inkwash) — make the *most convincing* marks, but
  are raster-accumulation painting engines → NOT zoom-stable, thin = broken. Architecturally opposed
  to a CAD renderer. Great to learn from, wrong to port wholesale.
- **Vector-native GPU stroke rendering** (Ciallo, Joshi, p5.brush) — texture-expressive AND
  zoom-stable AND applied along a path. **This is our regime.** (Correction to an earlier claim:
  such tools DO exist.)
- **Academic deposition model** (Sousa & Buchanan 2000) — the algorithm behind convincing graphite;
  it's a paper-height-field + pressure threshold, which is **what our ribbon shader already does**.

**We are WebGL2, no WebGPU** (whole testbed is `preference: 'webgl'`, `GlProgram` only). So Ciallo's
compute-shader-prefix-sum fast path does NOT port — build from **Joshi's per-quad analytic
integration** or **p5.brush's plain-WebGL** approach instead.

---

## 5. Interactive tools to play with (Geoff's next move)

Ordered by relevance. **Start with p5.brush** — it has literal `2B`/`HB`/`2H` graphite brushes and
lets you feel the width gate by dragging a slider.

| Tool | URL | What it is / try |
|---|---|---|
| **p5.brush Brush Maker** | https://acamposuribe.github.io/p5.brush/tools/brush-maker.html | MIT, WebGL, stamp-along-vector-path. Ships `2B`/`HB`/`2H`/`cpencil`. Draw thin vs fat → feel the width gate. **Our exact method.** |
| p5.brush examples | https://editor.p5js.org/acamposuribe/collections/PmyBeAfQP | See brushes in context; editable code |
| p5.brush site | https://p5-brush.cargo.site/ | Gallery / overview |
| **Ciallo tutorial** | https://shenciao.github.io/brush-rendering-tutorial/ | SIGGRAPH '24 vector brush strokes, interactive editable TS/GLSL code blocks. (Fast path is WebGPU; concepts port.) |
| **inkwash** | https://johnowhitaker.github.io/inkwash/ | WebGL2 ink/wash fluid sim (~1000 lines, no deps). Beer-Lambert compositing + granulation. For the **ink/watercolor** branch. |
| Joshi linear strokes | https://www.shadertoy.com/view/lstyzN | The efficient WebGL stamp formulation we'd build pass B from |
| Shadertoy pencil looks | [ldXfRj](https://www.shadertoy.com/view/ldXfRj) · [MsSGD1](https://www.shadertoy.com/view/MsSGD1) · [ldSyzV](https://www.shadertoy.com/view/ldSyzV) · [3dtBWX](https://www.shadertoy.com/view/3dtBWX) | Cheap procedural post-process looks (closest to what we already have) |

**Desktop apps** (not web, but the gold standard for *feel*): **Krita** and **MyPaint** — their
pencil/charcoal brushes are what "convincing" means. If a brush there feels right, we can read how
it's built (both open-source: libmypaint is ISC, freely portable).

---

## 6. Next steps & open decisions

**Immediate next steps (concrete):**
1. **Tonal ramp** — make stipple density/dot-overlap ramp harder with pressure so heavy strokes fill
   to near-solid dark core (edges stay feathered). Closes the last gap to the reference's heavy end.
2. **Stipple sliders** — expose `stipple` (dot scale / core density) as live sliders so Geoff can dial
   the look on **real hardware** (headless software-GL AA is unreliable — the thing I can't judge).
   Gray *those* out in the combed modes, symmetrically.
3. **Eyeball on real hardware** — flip to "Graphite (stipple)" in the tab. Headless is lying about AA.

**Open decisions (parked):**
1. **Which medium(s) ship** — graphite (combed and/or stipple), crayon, ink? (Lean: selectable set,
   per-object choice, orthogonal to the geometry-roughness ladder.)
2. **Procedural stipple vs. scanned-texture stamp (pass B).** Stipple is cheap + zoom-stable + asset-
   free and now looks good; pass B (scanned graphite along path) has the higher ceiling if stipple
   plateaus. If pass B: build from **Joshi** (WebGL analytic) or **p5.brush** (WebGL stamp), NOT
   Ciallo's WebGPU compute path.
3. **flora-studio port** — once a medium is chosen, wire `medium` as a per-object StrokeStyle field on
   `PixiFeatureLine.drawPath` (must replay cached ops on setZoom, never regen).

## 7. Key files & context
- Testbed: `pixi-features` → "Pencil Ribbon (mesh)" tab (`src/tabs/TabPencilRibbon.vue`)
- Material: `src/lib/strokeRibbon.ts` (`STROKE_RIBBON_DEFAULTS`, `STROKE_MEDIA`)
- Comparison: `.naturalize-out/compare-vs-refs.png` (regenerate: `npx tsx scripts/compare-vs-refs.ts`)
- Reference marks: `public/textures/pencil/stroke-arcs-{grid,long}.png`
- Research: `docs/gemini-graphite-simulation-research.md`, `~/Downloads/compass_artifact_wf-94953464-*.md`
- Full narrative + prior passes: memory `project-npr-sketch-rendering`
- **Gotchas:** `uColor` is Pixi's reserved mesh-tint (use `uInk`); descending `smoothstep` is
  undefined GLSL; `public/textures/paper/` is gitignored (regen via `scripts/gen-paper-height.ts`);
  headless captures are software-GL — AA unreliable, judge on real hardware.
- **NEVER push.** Commit locally only. Branch shared with a concurrent watercolor session — touch
  only pencil-ribbon files.
