# HANDOFF — Pencil Ribbon Phase C (graphite material tuning)

## Active Task
Making vector strokes render as convincing **pencil/graphite** in the PixiJS v8 testbed
`derisking-experiments/pixi-features`. Geometry (hand-drawn wobble) is DONE and good. Now tuning the
**material** in the ribbon-mesh stroke shader per Fable's round-2 advice. Work is in the
**"Pencil Ribbon (mesh)"** tab. Branch `plant-style-playground` (Geoff commits WIP here too, in
parallel). **Never push; commit locally only.** Dev server: `npm run dev` in pixi-features → :5202.

## Where We Left Off
Fable (external big-model advisor) just delivered the round-2 spec. Nothing mid-edit. The full spec is
in **`pixi-features/docs/fable-round2-response.md`** — READ IT FIRST, it's the build spec.
Current material has 4 problems (all math, per Fable): blocky-white-gap tooth, blurry edges, weak tone,
fuzzy tapered tips. Key files:
- `pixi-features/src/lib/strokeRibbon.ts` — ribbon geometry builder + VERT/FRAG shaders (the thing to change).
- `pixi-features/src/tabs/TabPencilRibbon.vue` — wiring: meshes, camera, paper sprite, rebuild-on-zoom.
- `pixi-features/scripts/gen-paper-height.ts` — FFT random-phase paper-tile generator (invert rolloff → fine grain tile, Q1).
- `pixi-features/src/lib/filters/PaperGrainFilter.ts` — paper background (mode 0, screen-fixed, cheap).

## Key Decisions
- Material lives ON the strokes (ribbon mesh + fragment shader), NOT a full-screen filter — the old
  `world`-container filter caused stairstepping + a 4fps cliff (killed in Phase A/B).
- Currently CPU-expands the ribbon (positions=expanded verts). Fable says move expansion to the VERTEX
  shader with custom attributes `aCenter,aNormal,aS,aSide,aPressure` (needs Pixi `Geometry.addAttribute`
  since MeshGeometry only has positions+uvs) — fixes perf + enables width coupling.
- `aPressure` = seeded arc-length pressure × width-taper, computed CPU at build (one source of truth).

## Next Steps (Fable's order)
1. Vertex-shader expansion + `aPressure` attribute (perf + enables everything).
2. Fine high-frequency grain tile (invert `gen-paper-height.ts` rolloff → high-pass) + **thresholded**
   deposit with pressure-dependent threshold (Q1 shader snippet in the spec). Kills blocky white gaps.
3. Edge: jitter the *limit*, keep transition at `fwidth`, couple erosion to the grain field (Q2).
4. Width-taper tips (fold into `aPressure`), `taperLen = uTaperPx/uZoom` (Q4).
5. Re-run the detail loop: `npx tsx scripts/shot-ribbon-detail.ts [tag]` → Read `.naturalize-out/ribbon-detail*.png`.
   **Acceptance test = the tooth shot: pepper-fleck skips, NO white rectangles.**

## Critical Context
- **Headless screenshot fps is software-GL — unreliable.** Don't trust absolute fps from scripts;
  judge perf on Geoff's real machine. (Fable misread the 10fps as per-frame rebuild — it's software GL.)
- Detail loop needs FAT strokes (~12px) + zoom into a crossing to see grain; `shot-ribbon-detail.ts` does this.
- **Fable workflow:** we consult Fable as guide/auditor. Stage its materials in
  `pixi-features/fable-handoff/` — **CLEAR old files before copying new ones** (don't mix rounds).
  **After this round of tweaks, return to Fable with fresh captures for more feedback.**
- Memory `project-npr-sketch-rendering` + `feedback-fable-handoff-folder` have more.
