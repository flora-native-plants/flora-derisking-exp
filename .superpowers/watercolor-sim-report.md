# Watercolor Sim spike — report

**Status:** Working prototype, isolated, committed to master. Verdict below.

## What I built

A baked GPU pigment-transport sim in a **new, fully isolated tab** ("Watercolor Sim").
Nothing in the effects path (`ProceduralWatercolorFilter`, `proceduralWatercolor.frag.glsl`,
`TabBotanicalVariants.vue`) was touched.

Files (all new):
- `src/lib/watersim/WatercolorSim.ts` — engine (~180 lines). Float `rgba16float` RenderTexture
  ping-pong (the `jumpFlood.ts` Mesh+Shader pattern), 2 ping-pong pairs + an rgba8 `out`.
- `src/lib/watersim/shaders/sim.vert.glsl` — shared full-screen quad.
- `.../seed.frag.glsl` — SDF → initial STATE (water) + PIGMENT (suspended green + 2 seeded warm bloom blobs).
- `.../velocity.frag.glsl` — velocity/water update.
- `.../pigment.frag.glsl` — semi-Lagrangian advect (manual bilinear) + paper/front-coupled deposition.
- `.../composite.frag.glsl` — Kubelka–Munk over paper.
- `src/tabs/TabWatercolorSim.vue` — grid renderer, 22 tuning knobs, `window.__waterSimTune` hook.
- `scripts/watersim-render.ts` + `scripts/watersim-presets.json` — headless Playwright batch renderer.
- One tab entry added to `src/App.vue`.

### Sim method chosen and why
Lean **Curtis-1997 shallow-water**, but with **curl-advected deposition instead of a Jacobi
pressure projection** (the brief's sanctioned lighter alternative — a full incompressible
solver is unjustified for a one-shot bake). The authentic structure comes from the *dynamics*,
per the advisor's key warning (don't just advect along static noise streamlines or you rebuild
grid9's "vein" tell dressed up):

- **Edge-biased evaporation** — the thin rim (low `sdfN`) dries faster → water height `h` sinks
  at the edge → `∇h` points inward → `accel = -∇h` points **outward** → pigment-laden water flows
  to the receding contact line and deposits there. The **coffee-ring / tide-line emerges from the
  evaporation dynamics**, it is not a scripted field. This is the genuinely-different-from-effects part.
- **Front-coupled deposition** — deposition rate spikes where `|∇h|` is high (the wet front) and
  as `h→0` (settling), so the dark tide-line piles up at the drying boundary.
- **Paper-height granulation** — deposition modulated by fBm paper "tooth".
- **Subtle divergence-free curl-noise swirl** — organic wet-in-wet wander only; kept small.
- **Kubelka–Munk composite** — K/S math + paper-through lifted from the working
  `proceduralWatercolor.frag.glsl` (NOT Beer–Lambert — that's the `inkwashBake.ts` mud dead-end).

Float linear filtering risk was sidestepped entirely: advection uses **manual in-shader bilinear**,
textures stay `nearest`.

## How to view
Dev server (already running) at http://localhost:5202 → **"Watercolor Sim"** tab in the RENDERING
group. Opens on the tuned `sim-v3b` defaults (Red Maple, 9 seeds). Batch:
`npx tsx scripts/watersim-render.ts` (presets in `scripts/watersim-presets.json`).

## Best results (screenshots)
- **`pixi-features/.watercolor/sim-best.png`** (== `sim-v3b.png`) — the winner. 9 Red Maple seeds.
- **`pixi-features/.watercolor/sim-compare-montage.png`** — direct 3-way A/B/C: SIM | effects grid9 | realtex ref.
- `sim-v3a/v3c`, `sim-v2a/v2c`, `sim-lum2/lum3` — the tuning trail.
- Compare against: reference `../flora-studio/variants-realtex.png`; effects target `pixi-features/.watercolor/grid9.png`.

### Head-to-head observations (from the montage, judged together, not from memory)
- **SIM vs grid9:** grid9's decisive tell is its thin dark **vein/contour cracks** (level-sets of a
  static field). The sim has **none** of them — its darks are soft pooled blooms + edge darkening.
  That alone makes the sim read more "painted." Confirmed the win survives side-by-side.
- **grid9's one real advantage** is visible here too: it has **pale-cored blooms** (light centers).
  The sim's blooms are the opposite — dark deposits. Confirms the hybrid recommendation below.
- **Neither matches realtex**, the actual goal: the real scan is a **brighter, cleaner green** than
  either render. Both the sim and grid9 are darker/greyer-olive.
- **Edge-vs-center tension is real in v3b.** Both headline wins (edge tide-lines AND a filled
  center) do *not* fully co-exist at max strength. The knobs that fill the center (higher in-place
  deposition, to kill the radial "white cross") also **soften the razor tide-line into a darker
  rim**. `sim-lum3.png` shows crisper edges but a bare white-star center; `sim-v3b` trades edge
  crispness for a filled center. v3b is the better *overall* balance, but the edge is a graded rim,
  not the sharp contact-line tide-mark the crisper presets produce.

## Honest verdict

**Do the emergent marks read as more authentic/brushed than the effects `grid9`? — Yes, on the
things that matter most, at moderate added complexity.**

Where the sim wins:
- **Edge tide-lines** are the decisive win. grid9's dark accents read as thin noise "cracks/veins"
  (level-sets of a static field). The sim's dark edges are a genuine pigment front deposited by
  evaporation-driven outflow — they hug the silhouette, vary in darkness with the local drying rate,
  and simply look *brushed*.
- **Transparent luminosity** — the K/S composite over paper at low density gives the glowing,
  paper-through wash grid9 lacked.
- **Organic wet-in-wet mottling** and strong, believable **per-seed variation**.

Where the effects path still wins / sim's limits:
- **Blooms.** My warm pigment *deposits denser → reads dark-brown*, whereas real backruns (and the
  effects shader's hand-modelled `secondaryGlaze`) are **pale-cored with a dark scalloped front**.
  The sim has no re-suspension/backrun model, so it can't produce that pale-core signature yet.
- **Controllability.** 22 knobs, and near-radial silhouettes hit a failure mode: perfectly radial
  evaporation drained the center to bare paper with an axis-aligned "white cross" artifact. I fixed
  it by raising in-place deposition + curl swirl to break symmetry, but it shows the sim needs
  babysitting the effects path doesn't.
- realtex is still a touch cleaner/lighter with larger calm tonal fields; the sim is busier.

Cost/complexity: **~830 render-to-texture passes per 9-symbol grid** (45 iters × 2 passes × 9
seeds, + seed/composite). The `~4–6 ms` the on-screen timer reports is **CPU submission time only**
— `bake()` + `generateTexture()` queue GPU work without blocking on it, so that number is NOT the
true GPU cost. The real justification is amortization: **it bakes once per instance and is cached**,
so per-frame cost is zero. ~430 lines of new code + 5 small shaders. Deliberately much lighter than
a full stable-fluids/Jacobi pressure solver.

**Recommendation:** The emergent tide-lines and luminosity are a real, visible step up from grid9
and worth pursuing. The highest-value next step is a **pale-core backrun / re-suspension term** so
blooms stop reading as dark blobs — that's the one place the hand-tuned effects shader is clearly
ahead. A pragmatic production path is *hybrid*: use the sim for the emergent wash + edge tide-lines,
keep the effects path's deliberate pale-cored blooms composited on top.

### What I'd do next
1. Re-suspension/backrun pass → pale-cored blooms (biggest visual gap).
2. Warm pigment that lightens (pale warm glaze) instead of darkening at density.
3. Auto-seed initial water from an asymmetric low-freq field so radial silhouettes never need the
   curl-swirl crutch.
4. WGSL `gpu` block before this could ever go near flora-studio's WebGPU renderer (currently GL-only).
