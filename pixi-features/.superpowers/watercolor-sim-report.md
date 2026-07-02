# Watercolor Sim spike — report

Baked GPU watercolor for botanical plant symbols (parallel to the shipping "effects" path).
Two sim variants now live in the **Watercolor Sim** tab (`src/tabs/TabWatercolorSim.vue`),
switchable by the `mode` dropdown. Reference to beat: `reference/variants-realtex.png`
(a scan of a real wash). Target to beat on the synthetic side: the effects renders in
`.watercolor/grid9.png`. Red Maple = plantId 2.

Comparison montage: `.watercolor/sim-erosion-compare.png`
(erosion / shallow-water / effects grid9 / realtex).

---

## Variant A — shallow-water (prior work)

Curtis-1997-flavoured shallow-water bake: velocity/water pass + pigment advect/deposit pass,
float RenderTexture ping-pong at 256px, Kubelka-Munk composite. Files:
`src/lib/watersim/WatercolorSim.ts` + `shaders/{seed,velocity,pigment,composite}.frag.glsl`.
Tuned preset `sim-v3b` (`scripts/watersim-presets.json`).

**Result:** a calm, even, luminous wash with a few soft dark blobs — but **almost no fronts**.
The coffee-ring/tide-line the velocity solve was supposed to produce stays weak; what you get
reads as flat mottling. Overall tone is actually close to realtex's restraint, but it is missing
the load-bearing structure (correlated drying fronts). See `.watercolor/sim-v3b.png`.

---

## Variant B — receding wet-mask erosion with front deposition (this spike)

A **simpler, cheaper** generator aimed directly at the load-bearing effect: smooth, low-curvature,
**correlated / nested** drying fronts with history. No velocity/pressure/divergence solve.
Files (all new): `src/lib/watersim/ErosionSim.ts` +
`shaders/{erodeSeed,erode,deposit,pack}.frag.glsl`. The **composite is
`shaders/composite.frag.glsl` reused byte-for-byte** from the shallow-water path (Kubelka-Munk in
K/S space + granulation + paper), so the two variants differ ONLY in how the marks are generated.

### Method as built (160px float ping-pong, ~40 iterations)

Fields (`rgba16float`, ping-pong):
- **A**: `R=wetness  G=susGreen  B=susWarm  A=depFrac(per-step)`
- **ACC**: `R=depGreen G=depWarm` — the deposited pigment == the tide-lines
- static: the same silhouette **SDF** texture (`R=sdfN, A=inside`) the shallow path uses.

Per iteration (two tiny passes):
1. **ERODE** (`erode.frag`): a **threshold drying front**. Each pixel has a smooth drying
   **barrier** = interior depth (`sdfN`, so the front sweeps inward echoing the silhouette)
   + broad low-freq **paper ridges** (the front dwells at ridges -> nested lines spaced by paper
   topology) + a low-freq wobble + heavily-warped interior **wells** (nucleate interior fronts
   that COLLIDE with the edge front -> watershed lines). A global pressure `uStep` climbs 0->1;
   a pixel dries when `uStep` passes its barrier (`wetNext = min(wet, driedTarget)`, monotonic).
   Suspended pigment advects **down the wetness gradient** (toward the front) and piles.
   The **coffee-ring gate** is the crux: pigment strands where the contact line IS
   (`onLine = |grad wet|`) AND just receded this step — NOT uniformly as water leaves. That is
   what turns smooth throughput into a crisp line. `depFrac` is written to `A.a`.
2. **DEPOSIT** (`deposit.frag`): trivial by construction — `ACC += susOld * A.a`. No erosion math
   is duplicated, so the two passes cannot drift apart.
3. **PACK** (`pack.frag`): `A + ACC -> PIGMENT layout` the shared composite consumes (or a
   grayscale debug view of the raw tide-line buffer). Then the reused COMPOSITE -> `out`.

Backruns: a seeded pigment burst dumped into the still-wet wash on a couple of steps, carried to
and stranded at the next fronts.

### The two dead-ends found on the way (both fixed)

- **Deposit-on-water-loss integrates to a flat wash.** The first deposit rule
  (`suspended x water-lost`) summed over the run to ~uniform = exactly the shallow-water look.
  Fix: **gate deposition on `|grad wet|`** (the contact line), not on total water lost.
- **Min-filter morphological propagation gives a Manhattan DIAMOND** with axis-aligned streaks.
  Fix: drive the front from a **threshold on the smooth organic barrier field** instead of
  neighbour-propagation — sharp via a narrow release band, organic because the field is organic.

### Honest verdict

**Do the erosion FRONTS read more like realtex's fronts than the shallow-water sim AND grid9?**

- **vs effects grid9: yes, clearly.** grid9's tide-marks are thin, uniform, concentric
  *iso-band contour rings* — the synthetic "topographic map / veins" tell the effects path can't
  shake. The erosion fronts are irregular, curved, correlated and pigment-weighted (only some
  contours read as strong lines), with no iso-band signature. This is the one unambiguous win.
- **vs shallow-water: yes on the specific question.** Shallow-water has essentially no fronts;
  erosion produces abundant correlated nested fronts with history + watershed collisions. On
  "fronts with history" erosion wins decisively. (Caveat: shallow-water's overall *tone* is calmer
  and closer to realtex's restraint — it wins on tonal balance while losing on structure.)
- **vs realtex overall: no, not yet.** The erosion front *character* (organic, low-curvature,
  nested, correlated) is closer to realtex than either alternative, but the current composite
  overshoots into a **busy, high-contrast "foliage-canopy" mottle** rather than realtex's few
  restrained, luminous tide-lines. This is a compositing/tuning gap, not a structural failure of
  the method — the raw tide-line buffer (`.watercolor/sim-erosion-debug.png`) shows clean nested
  organic fronts; the composite is what turns them chunky.

**Bottom line:** the variant delivers the load-bearing effect the spike set out to prove
(correlated, low-curvature, organic nested drying fronts with history — the thing static iso-band
noise structurally cannot make) at a fraction of the complexity. It is the right *engine*; it
still needs a restraint pass on the *composite* to reach realtex.

### Cost

- **Sim:** ~40 iters x 2 passes at 160x160 = extremely cheap. Measured bake loop ~**0.9 ms per
  instance** (status line "9 sims · 8ms"), dominated by the composite + `generateTexture` copy, not
  the sim. Structurally simpler than shallow-water (2 passes, no velocity/pressure/divergence solve)
  and 2.5x fewer texels (160 vs 256). Both variants are already sub-ms/instance; erosion is the
  cheaper and simpler of the two.
- The HUD `frameMs` (~40-72ms) is the full 9-cell rebuild (bake + generateTexture + Vue scene), not
  per-instance sim cost.

### What I'd do next (restraint pass, ~half a day)

1. **Fewer, stronger fronts:** drop iterations to ~25-30 and/or deposit only on stronger `onLine`
   so you get realtex's *few broad* tide-lines instead of a whole-canopy mottle.
2. **Luminosity:** lower composite `density`, raise `coverKnee`, and blur the ACC buffer a touch
   before compositing to melt the grain speckle into washes.
3. **Warm balance:** realtex carries more warm-brown bloom; raise `bloomAmt` and the warm pigment's
   K/S weight.
4. If it then reads well, port `ErosionSim` + the 4 shaders into flora-studio behind the same
   composite the effects path could share.

### Isolation (respected)

New files only + additive edits to `TabWatercolorSim.vue` (a `mode` toggle + an erosion param
group). `composite.frag.glsl` is reused unchanged. The effects path
(`ProceduralWatercolorFilter.ts`, `proceduralWatercolor.frag.glsl`, `TabBotanicalVariants.vue`) was
not touched. Screenshots land only in `.watercolor/` (via `scripts/watersim-render.ts`, which clips
the UI panel); presets in `scripts/erosion-presets.json`.
