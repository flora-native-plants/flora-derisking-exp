# Procedural Watercolor Fill — Design Spec

**Date:** 2026-07-01
**Status:** Draft, rev 3 (advisor + kimi critique + Fable Q&A folded in). Ready for the impl plan.
**Location of work:** `derisking-experiments/pixi-features` — tab **Botanical Variants**
(`src/tabs/TabBotanicalVariants.vue`). Proven here, then re-ported into
`flora-studio/src/pixi/botanical/buildBotanicalComposite.ts`.

---

## 1. Goal

Render botanical plant **symbols** (fixed silhouette = plant identity) as hand-painted
watercolor, with **many believable per-instance variations** generated **procedurally** — no
reused scanned texture files. The current `mode: 'texture'` path (real scanned `wash-green.png`)
looks convincing but repeats at scale; the current `mode: 'sim'` baked mini-inkwash
(`inkwashBake.ts`) looks fake/airbrushed and is **not usable**. This spec replaces the sim path
with a new procedural filter.

## 2. Why the current sim fails (confirmed by two research reports + 3 expert reviews)

- **Wrong compositing.** Beer–Lambert `exp(−density·strength)` has no scattering term; layers
  multiply toward mud, dense cores crush to black.
- **Wrong spatial structure.** Isotropic box-blur diffusion is symmetric; edge darkening, tide
  lines, and granulation are *anisotropic, boundary- and paper-driven* and never emerge from
  symmetric blur. Smooth fBm alone reproduces the same faded look.
- **Boundary-correlation tell.** Deriving interior from the silhouette makes the texture "know
  where the edge is."

Research basis: `docs/watercolor-research-gemini.md`, `../Procedural Watercolor Rendering.md`
(Curtis SIGGRAPH'97; Bousseau NPAR'06; Montesdeoca MNPR; Deegan coffee-ring; Kubelka–Munk).

## 3. Core design decisions

### 3.1 The wash boundary is NOT the symbol boundary (the reframe)
Interior tonal structure in the believable reference is statistically **independent** of the
silhouette; the mask is a **crop** of a loose puddle, clipped **last**, with only a weak "tidied
edge" rim. This is a deliberate compromise (see 3.2), not a claim that real flow ignores the
boundary — it's the frequency split that matters.

### 3.2 Identity preserved cheaply — the primary puddle
- Identity rides the **alpha silhouette + contour line** (interior mips to mush below ~64px).
- **V1 primary puddle = the precomputed mask-SDF sampled at a domain-warped UV, minus a
  SPATIALLY-VARYING outward offset** (Fable): `sdf_puddle(x) = sdf_mask(warp(x)) − offset(x)`, with
  ```
  offset(x) = base + a₁·noise(θ) + a₂·dot(n̂, shadowDir)
  ```
  - **`base` ≥ lobe amplitude** — an SDF offset is a morphological low-pass, so any silhouette
    feature shallower than the offset depth vanishes from the offset contour *for free*. This is
    what actually kills lobe-scale correlation (warp alone doesn't: the warped lookup inherits the
    mask's curvature spectrum).
  - **`a₁·noise(θ)`** — 2–3 angular cycles at ~8–12% crown-radius amplitude. This is the
    harmonic-polar blob re-expressed in offset space (recovers stage-3 character with zero new
    machinery). **Vary the noise PHASE per seed — the biggest gross-shape variety lever in
    one-puddle V1.**
  - **`a₂·dot(n̂, shadowDir)`** — a single **global** uniform (~5% amplitude, shared across all
    instances) → the lit-form read across the whole map.
  - **Keep warp amplitude ≤ ~15% crown radius** — past that it shears the T-field nesting.
  → **The harmonic-polar blob construction is a stage-3 tool for the free-floating SECONDARY
  puddles — NOT in V1.** V1 has one puddle only, derived from the mask.
- Note `sdf_puddle` is a **pseudo-distance field** after warping. We never rely on its analytic
  gradient magnitude for band width — band width uses screen-space `fwidth(T)` (see 3.3).
- **Weak mask rim** = a **tonal (pigment-density) darkening**, NOT an alpha change: 30–50% of a
  puddle rim's peak density, ~half width (2–3px vs 4–8px at bake resolution), same asymmetric
  profile. **The rim is WARM — ~half the interior rims' pigment-B enrichment** (Fable): a
  hue-neutral density bump sits directly under the graphite contour and reads as a *doubled
  outline* (a CG tell); warmth chromatically separates paint-edge from pencil-line. Modulate the
  rim's density *and* warmth with **lost-and-found dropouts** (fade where the underlying wash is
  already dark) so it never becomes a uniform warm halo. Alpha stays the binary silhouette mask.

### 3.3 Tide-lines = iso-contours of a drying-time field
```
T(x) = a·sdf_puddle(x) + b·warpedFbm(x) + c·paperHeight(x)
```
- Normalize `sdf` to [0,1] over the puddle; fBm to [−0.5,0.5] at 2–3 cycles/puddle-radius.
  Weights `a=1, b=0.3–0.5, c=0.05–0.15`. Nesting holds while `b·f_fbm ≲ a`; a *few* pinch-offs are
  desirable (pooling accidents), so keep `b` near the top. `c` small — paper height only adds
  micro-raggedness to the band *line*.
- Take **5–7 iso-bands** at **non-uniform thresholds `τ_k` tightening toward the rim** (uniform ΔT
  is a periodicity tell).
- **Band-darkening operator (simplified per advisor):** in the fragment shader this is a **1-D
  asymmetric function of the scalar `(T − τ_k)`, summed over the thresholds** — a sharp spike at
  `T=τ_k`, exponential decay toward the interior (higher-T) side; **handedness = `sign(T − τ_k)`**
  (advancing/lower-T side darker), with a puddle-centroid radial reference to orient "advancing"
  (valid for V1's single simply-connected puddle). **Normalize the band coordinate by `fwidth(T)`**
  (`d = (T − τ_k)/max(fwidth(T), ε)`) so line width is constant in screen space. `T` and the SDF
  sample must be **`highp`**.
  - **Multi-resolution caveat (Fable):** `fwidth(T)` fixes width in *render-target* space — correct
    for a fixed-resolution bake. If the same symbol is ever baked at multiple resolutions, drive
    the width in **texel units of the bake** instead, or band weight drifts with zoom level.

### 3.4 Compositing = Kubelka–Munk, two pigments, ratio driven by T
Replace Beer–Lambert with K–M. **Mixing happens in K/S space, never RGB:**
`K_mix = mix(K_A,K_B,m); S_mix = mix(S_A,S_B,m); R∞ = 1 + K_mix/S_mix − sqrt((K_mix/S_mix)² +
2·K_mix/S_mix)`, then `clamp(R, 1e-4, 1−1e-4)`.
- **A — settling cool green** (viridian-like), higher S, wash body: `Rw≈(0.35,0.62,0.48)`,
  `Rb≈(0.06,0.20,0.13)`.
- **B — mobile warm stain** (quinacridone-gold/burnt-sienna-like), low S, transparent glaze:
  `Rw≈(0.80,0.56,0.24)`, `Rb≈(0.26,0.13,0.05)`.
- `m = smoothstep(t0,t1,T)` from ~80% A (early-drying) to ~60% B (late-drying); **concentrate B at
  band rims** (mobile pigment travels with the front → warmer band edges). Complementary channel
  absorption keeps the trajectory through **olive**, not gray. **Clamp** Rw/Rb inversion inputs to
  `0<Rb<Rw<1` per channel.
- **K/S is derived once on the CPU** (spectral.js, MIT — or the ~30-line Curtis Rw/Rb inversion)
  and uploaded as `K_A,S_A,K_B,S_B` vec3 uniforms. spectral.js is **not** a shader library.

#### 3.4b Pipeline order (Fable — strict)
The plateau is a compressive nonlinearity; it must run **before** the bands or it flattens the very
band spikes that form the dark tail. Bands are **additive in pigment DENSITY, pre-K-M, never in RGB
post-composite**:
```
base wash density  →  plateau (flatten mids toward wash constant)  →  + band term (rim spike +
conservation lightening)  →  pigment A/B split (T-coupled)  →  K–M compositing  →  clip + weak
warm mask rim  →  blue-noise dither
```
**Trap:** plateau the *amplitude/density* field ONLY — **never `T`** (flattening `T` collapses
contour spacing and destroys nesting).

## 3.5 Histogram + anti-CG-tell measures
**In V1** (needed for acceptance #3): the **plateau operator** manufactures the histogram mode
(flat light plateau); the **bands** supply the sparse dark tail; the two are independently tunable
against the check — plus **blue-noise dither** before 8-bit. **Contingency:** if the histogram
doesn't skew enough, pull the **brush-load ramp** (one monotone low-freq ramp per glaze,
`density *= mix(1, ramp, 0.3–0.5)` along a seeded direction) forward from stage 5 into V1.

**Later stages:** granulation (procedural paper height Worley + aniso fBm, per-seed grain axis,
bimodal heavy/light; **paper sampled in world/canvas space** shared across instances, **pigment in
per-instance seeded space**); glaze order grammar (light-to-dark/big-to-small, crisp wet-on-dry
shared boundary → overlap darkening, per-*species* hue drift, shared global shadow-side bias);
blooms (pigment conservation: rim darkens *and* interior lightens); contour alpha inversely
modulated by wash density; breathing gaps (unpainted paper specks at high-curvature rim
concavities).

## 4. Architecture

### 4.1 Vehicle
New **`ProceduralWatercolorFilter`** (Pixi v8 `Filter` + `GlProgram` + `UniformGroup`, GLSL ES
3.00 — so `fwidth`/`dFdx` are available), following `src/lib/filters/WashTextureTintFilter.ts`.
Applied to a full-cell quad; the existing silhouette **mask Graphics** clips it. Added as a third
**`mode: 'procedural'`** in `TabBotanicalVariants.vue` alongside `texture`/`sim`. The existing
**contour** is reused. Bloom + graphite-grain layers stay off for V1.

### 4.2 Inputs / uniforms
- `uMaskSdf` (sampler) — signed distance to the silhouette, **`R16F` / half-float, `CLAMP_TO_EDGE`
  with border padding** (8-bit UNORM posterizes T → fails acceptance for the wrong reason).
  Precomputed **once per plant** via CPU distance transform of the rasterized mask. Cache key
  `assetId`.
- `uSdfTexelWorldSize` (float) — so the shader converts SDF texels to world units (the mask is
  drawn at varying scales); required to make "15–30% of crown radius" scale-correct.
- `uSeed` + per-seed scalars: band **spacing scale**, edge width, γ (later), grain axis (later),
  pigment `t0/t1`, warp amplitude, brush-load direction. **Scale variation prioritized over
  rotation.**
- `uWorldOffset` (vec2) — this instance's world position, so paper/granulation sample a shared
  sheet (later stages).
- `K_A,S_A,K_B,S_B` (vec3) — CPU-derived pigment coefficients.

### 4.3 Per-plant precompute vs per-seed
- **Per plant:** rasterize silhouette → mask → **float SDF texture**. Cache key `assetId`.
- **Per seed:** all else is shader math from `uSeed`. Flora-studio bake cache key stays
  `(assetId, paramHash, variantIndex)`.

## 5. V1 — the de-risking build

Prove band *structure* before polish (Fable: "if a single clipped puddle with good bands doesn't
read as watercolor, more layers won't rescue it").

**Scope:** one primary puddle (warped mask-SDF − offset) → drying-time field `T` → 5–7 jittered
iso-bands with the `fwidth`-normalized asymmetric front profile → two-pigment K–M (K/S-space,
T-coupled ratio) → **plateau operator → hard clip + weak tonal mask rim → existing contour →
blue-noise dither**. **Bake at 2× and mip down.**

**Excluded from V1:** granulation, blooms, glaze stacking, bloom color, per-seed glaze-count
variation, harmonic-polar secondary puddles. Brush-load = named contingency only.

**Acceptance — Playwright-screenshot the playground vs `variants-realtex` crops, same plant:**
1. **Asymmetric edge cross-profile** — 1-D luminance across a band = spike-then-decay, not a
   symmetric ramp.
2. **Nested + irregular band geometry** — loops that wander/pinch, non-periodic spacing.
   **Calibration (Fable flag b):** a mask-derived single puddle will *by construction* have bands
   that loosely parallel the silhouette at LOW frequency — that is the intended §1 tradeoff. Judge
   this check on **mid/high-frequency irregularity** (wander, pinch-offs, non-uniform spacing), NOT
   against realtex's fully free-floating bands (which need stage-3 secondary puddles). Do not fail
   V1 for a low-frequency silhouette echo it was designed to have until stage 3.
3. **Value histogram** = flat light plateau + sparse dark tails (plateau operator + bands deliver
   this; if not, pull brush-load forward).
Bar: an expert can't easily tell which cell is procedural, *allowing for the stage-3 gap in #2*.

## 6. Libraries (prefer pre-existing where possible)

- **GLSL primitives:** **vendor the ~5 functions we need** (fBm, simplex `snoise`, domain-warp,
  blue-noise dither; Worley later) inline into the shader string — from **lygia** or Inigo
  Quilez — because Pixi `GlProgram` has **no `#include` resolver**. **Spike:** get one function
  (e.g. `snoise`) compiling in a Pixi filter under GLSL ES 3.00 before committing the source.
- **Kubelka–Munk:** **spectral.js** (MIT) as a **CPU precompute** → K/S uniforms; fallback is the
  Curtis Rw/Rb inversion (~30 lines). **Do NOT use Mixbox** (CC BY-NC — commercial license needed;
  flora is commercial).
- **SDF:** CPU distance transform of the rasterized mask for V1 (jump-flood needs ping-pong FBOs —
  defer). The tab already rasterizes the mask to a canvas.
- **Filter plumbing:** Pixi v8 `Filter`/`GlProgram`/`UniformGroup` (already in use).

### 6.1 Reference implementations to study (Fable — not necessarily adopt)
- **MNPR** (github.com/semontesdeoca/MNPR, **MIT**) — best open-source "effects, not simulation"
  watercolor shader math: edge darkening, pigment turbulence, granulation-in-paper-valleys. Written
  for Maya; the GLSL math ports. **Primary reference for stage 2 (granulation).**
- **Watercolorizer** (github.com/32bitkid/watercolorizer) — JS/canvas glaze-stack (Tyler Hobbs
  technique). **Reference for stage 3 (glaze stacking).** CPU, not shader.
- **Tyler Hobbs essay + Sighack Processing walkthrough** — existence proof that layered-blob
  architecture yields cheap believable variety. Note: produces *soft wet-in-wet*, not our hard
  tide-lines — a complement to the drying-field approach, not a replacement.
- **p5.brush** (github.com/acamposuribe/p5.brush) — WEBGL watercolor fill; study their diffusion.
- **Rebelle browser experiment** (escapemotions.com/experiments/rebelle) — **use as a REFERENCE
  GENERATOR**: paint blobby washes, let them dry, screenshot the tide lines, compare against our
  shader's band statistics for the acceptance checks.
- **Curtis project page** (grail.cs.washington.edu/projects/watercolor) — full equations if we ever
  go the gated-sim route. **Luft-Deussen WebGL** (c-chen99.github.io/watercolorShader) — live
  botanical watercolor pipeline to inspect in-browser.
- **Mixbox** — the K-M piece as ready GLSL, but **CC BY-NC**; study only, do not ship.

## 7. Additive roadmap (each independently testable vs the reference)
1. **V1** — clipped single puddle + T-bands + 2-pigment K–M + plateau + dither. *(build target)*
2. **Granulation** — world-space paper height, bimodal heavy/light, grain axis.
3. **Glaze stacking** — 2–4 puddle glazes (harmonic-polar blobs), order grammar, overlap
   darkening, shadow-side bias.
4. **Blooms** — small late-drying glaze with pigment conservation.
5. **Per-seed variation** — glaze count/placement (biggest variety lever) + scale jitters.
6. **Gated:** 2–3 iterations of cheap curl/semi-Lagrangian advection to pre-warp T — **only if**
   single-pass interior plateaus below bar.

## 8. Notes for the flora-studio port (NOT V1 concerns)
- **Determinism:** the app bakes each instance to a texture once, so procedural noise is frozen —
  no per-zoom recomputation. Keep noise a pure function of `(uSeed, worldPos)`.
- **LOD fallback:** below ~64px the interior is mush; the port should swap to a cheap flat/tinted
  fill. Define the threshold during the port.
- **Perf budget:** the playground renders a small grid (fine). The port must budget the
  per-instance bake; the bake is one-time per placement, so cost is amortized.

## 9. Out of scope
- Full time-stepped shallow-water / CFL fluid sim (unnecessary for a fixed mask).
- Interactive "paint your plant" (parked; shares the field model).
- Re-port into flora-studio (after the look is approved here).

## 10. Resolved design questions (Fable, 2026-07-01)
1. **Primary-puddle offset — spatially varying, both drivers.** `offset = base + a₁·noise(θ) +
   a₂·dot(n̂, shadowDir)` with `base ≥ lobe amplitude`. Warp alone doesn't break lobe correlation;
   the SDF offset (morphological low-pass) does. Folded into §3.2.
2. **Plateau strictly BEFORE bands**, on the density field only (never `T`). Folded into §3.4b.
3. **Weak mask rim is WARM** (~half interior B-enrichment) to avoid the doubled-outline tell, with
   lost-and-found dropouts. Folded into §3.2.
