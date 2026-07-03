# Pencil / Graphite Material — Status & Handoff (2026-07-03)

**Where things stand:** procedural material is *in the neighborhood* but clearly distinguishable
from the AI reference marks. Geoff is not thrilled with the procedural results and wants to play
with the interactive online tools to find a mark that *feels* right before we build more. This doc
captures what we did, what we learned, and the live tools to try.

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
- **Selectable MEDIUM** (this session, commit `748943f`) — `STROKE_MEDIA` presets + a Graphite/Crayon
  selector in the tab. One engine, two material presets, each at its **native width**:
  - **Graphite** — native 6px. Soft directional tooth. Reads as graphite only *at width*.
  - **Crayon / colored pencil** — native 3px. Waxy pepper-skip speckle. Reads *at thin* real-use width.

### Capture harnesses (output → `.naturalize-out/`, gitignored)
- `scripts/shot-ribbon-thin.ts` — 2.5px @ 1× (real-use condition)
- `scripts/shot-ribbon-detail.ts` — 12px @ ~3.5× (diagnostic)
- `scripts/shot-ribbon-media.ts` — each medium at its native width
- `scripts/compare-vs-refs.ts` — **our latest renders next to the AI reference ladder** in one frame
  (`.naturalize-out/compare-vs-refs.png`)

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

### B. Honest gap vs. the reference (from `compare-vs-refs.png`)
We are NOT matching the reference yet. Three gaps:
1. **Grain character (biggest tell):** reference = fine, dense, *powdery* deposit. Ours = coarse
   diagonal *striations* (the `grainStreak: 0.6` directional stretch reads as combed/hatched/
   wood-grain). Reference is mostly fine isotropic speckle with little directionality.
2. **Tonal drama:** reference ramps whisper→near-black with pressure; ours is comparatively flat.
3. **Width:** even our "wide" 6px is thinner than the reference's fattest marks.

**Cheapest procedural next step (untried):** de-comb — drop `grainStreak` to ~0.1–0.2 + use a finer
grain tile so tooth reads as powder not stripes; add more tonal range. Would close *some* of the gap.

**The ceiling:** the reference's fine powder is exactly what **stamping a real scanned graphite
texture** gives you for free (you sample actual graphite dust instead of stretching a procedural
tile). Procedural can get closer; the scanned-texture route is what would truly match.

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

## 6. Open decisions (parked until Geoff finds a mark that feels good)

1. **Which medium(s) are we actually shipping** — graphite, colored-pencil/crayon, ink, or a
   selectable set? (Current lean: selectable set, per-object.)
2. **Procedural vs. scanned-texture stamp (pass B).** Procedural is cheaper and already zoom-stable;
   scanned stamp has the higher ceiling (matches the reference's fine powder) but adds the
   repetition-on-long-strokes and asset-extraction work.
3. If pass B: build from **Joshi** (WebGL analytic) or **p5.brush** (WebGL stamp) — NOT Ciallo's
   WebGPU path.

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
