# Fable round-2 response (the spec for Phase C tweaks)

Verbatim advice from Fable after reviewing the four zoomed captures + the ribbon shader.

---

**Perf: 10fps at 111ms in the ribbon tab, even at 1.0×.** You're rebuilding ribbon geometry on the
CPU every zoom change (halfWidth baked into positions), and judging by the frame time, likely every
frame. Fix this before more material tuning: move the expansion into the vertex shader. Attributes
become `aCenter` (centerline point), `aNormal`, `aS`, `aSide`, and (new, see Q3) `aPressure`; vertex
does `pos = aCenter + aNormal * aSide * uStrokePx * aPressure / uZoom`. Zoom is then one global
uniform write, geometry is built exactly once per element, and width variation + width-based tapering
become free. Everything below assumes this move.

**Q1 — Tooth: blocks are a spectrum problem, not a resolution problem, plus a mapping problem**

Two causes:
- *Wrong spectral content.* The height tile is scanned watercolor paper — dominant features are broad
  mm-scale undulations. Threshold/contrast-stretch → blobs the size of paper features (the white
  rectangles). Graphite deposition grain lives at much higher frequency (tooth cells, fractions of a
  stroke width). No grainScale fiddling fixes it; the content isn't there. Fix: your RPN generator
  with the rolloff *inverted* — high-pass the magnitude spectrum instead of low-pass — emits a
  seamless fine-speckle tile with authentic paper statistics. Keep the watercolor tile for background
  relief only; deposition grain gets its own dedicated high-frequency tile.
- *Wrong math.* `mix(1.0, h, k)` linearly dims coverage by height → mid-heights gray mush, low blobs
  white holes. Real deposition is nearly binary per tooth cell — catches or it doesn't — softened by
  AA. Threshold it:
```glsl
float g = grainField(vWorld / uGrainFine);        // fine tile, same octave crossfade
float thresh = mix(0.72, 0.18, pressure);         // light pressure -> more skips
float w = fwidth(g) + 0.02;                       // AA the threshold, not the grain
float deposit = smoothstep(thresh - w, thresh + w, g);
float tooth = mix(1.0, deposit, uTooth * (1.0 - 0.6 * pressure));
```
Set `uGrainFine` so a grain feature is ~1.5–3 screen px apparent; the octave crossfade holds that
under zoom. Fine spectrum + thresholded deposit + pressure-dependent threshold = "graphite skipping
over tooth" at both 2px and fat widths.

**Q2 — Edge: jitter the edge's *position*, never its *transition width***

The smoothstep spans `uEdgeSoft` of the ribbon — at 0.5 that's a half-width gradient = the blur. A
pencil edge is sharp but irregular: boundary wanders/erodes, falloff stays ~1px. Transition width
stays `fwidth(edge)` always; `uEdgeSoft` moves the *limit*:
```glsl
// erode the edge where the fine grain is low — couples raggedness to the same tooth field
float limit = 1.0 - uEdgeSoft * 0.45 * (1.0 - g);
float aa = fwidth(edge);
float cover = smoothstep(limit + aa, limit - aa, edge);
```
Reuse `g` (world-anchored, zoom-stable, per-side different since the two edges sit at different world
positions) — beats a separate 1D jitter (your `vnoise1(s*0.6)` had features tens of world units long
= slow waviness, not raggedness). Optional: `a *= mix(1.0, 1.12, 1.0 - edge)` for a darker core.

**Q3 — Tone: one octave of smooth noise is a gradient, not pressure — and pressure must drive width**

- Two octaves: `pressure = clamp(0.6*vnoise1(s*0.02 + seed) + 0.4*vnoise1(s*0.13 + seed*1.7), 0., 1.)`.
- Perceptual gamma: `tone = pow(mix(1.0 - uToneAmp, 1.0, pressure), 1.6)` (alpha 0.6 vs 1.0 barely
  registers on near-white paper w/ multiply).
- **Width coupling (the one that sells it):** light pressure = thinner AND lighter, together. Compute
  pressure per vertex on the CPU at build time (seeded, arc-length-based), store as `aPressure`, use
  in vertex shader for width and pass to fragment for tone. One source of truth, no JS/GLSL
  noise-matching, zero per-frame cost. ±30% width swing + gamma'd tone kills "plotter line."

**Q4 — Tips: taper width, not alpha**

Taper multiplies *alpha* down over 12 world units → tips dissolve into ghosts; overshoot crossings =
two ghosts overlapping into fuzz. A real pencil stroke ends by *thinning*, nearly opaque to the end.
With vertex expansion this is free: fold `smoothstep(0., 1., d / taperLen)` into the width term (bake
into `aPressure` at build, since `d` is known then), keep alpha fade to only the last ~1.5px of arc.
Size `taperLen` in screen px → world (`uTaperPx / uZoom`), not fixed world units (12 world units is a
different visual length at every zoom → why tips look right at one zoom, wrong at another). Crossing
two thin-but-crisp overshoots is the Phase-1.5 hand-drawn corner; the fuzz was hiding it.

**Q5 — Procedural is enough at 2px once Q1–Q4 land**

Tone/width/tip carry the read; thresholded fine grain covers tooth. Scanned mark strip becomes worth
it for fat zoom-ins/hero shots + hatching/fills later: 1024×64, 3–4 rows of real strokes on smooth
paper, scanned, high-pass filtered, packed into alpha; map `u = aS * uZoomOctaveScale`,
`v = row + aSide within row`; row by element seed. Don't reach for it to solve today's problems — all
four are math, not assets.

**Order:** vertex-shader expansion + aPressure (fixes fps, enables everything) → Q1 fine-grain tile +
threshold → Q2 edge → Q4 width taper (Q3 tone mostly falls out of aPressure). Re-shoot the same four
captures; the **tooth shot is the acceptance test** — want pepper-fleck skips, no white rectangles.
