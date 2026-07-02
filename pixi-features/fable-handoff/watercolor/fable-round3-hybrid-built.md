# Round 3 for Fable — hybrid is BUILT and tuned. Where do we push next?

Your last verdict was **sim = STRUCTURE, static = MATERIAL** (sim generates the soft wash mass +
correlated tide-line fronts; the static `proceduralWatercolor` shader does K-M / granulation /
blooms / pigment). We built exactly that. This is the result + our findings + the honest gaps.
**We want your next-round direction — what's the highest-value move to close the rest of the gap to
`variants-realtex.png`?**

## Images in this folder
- `fable-round2-gating.png` — **the key 4-way**: prev EFFECTS grid9 | **HYBRID best (mo-warm)** |
  HYBRID alt (mo-b, pure green) | REALTEX target.
- `best-mo-warm.png` — our current best, 9 Red Maple seeds.
- `alt-mo-b-puregreen.png` — calmer, pure-green alternative (no warm mottle push).
- `hybrid-fronts-on-example.png` — hybrid with the sim tide-line FRONTS turned on (see finding #2).
- `debug-bandpass-fronts.png` — the raw band-pass front channel (grayscale), so you can see the
  front geometry directly.
- `prev-effects-grid9.png`, `variants-realtex.png` — the old shipping effects render and the target.

## What we built (mechanics)
`ErosionSim.bakeStructure()` runs the erosion sim then EXPORTS a low-contrast **(mass, front)** map
instead of its own K-M composite (that composite is what overshot into busy high-contrast mottle
last round). The static shader samples that map: `mass` replaces the old 3-washblob field and drives
the fill-step tonal form + hue; `front` optionally adds the only dark marks (the synthetic bandTerm
is faded out in hybrid so two uncorrelated mark fields can't reintroduce the "crack" tell).
- **MASS = wide Gaussian blur of the deposited pigment** → large calm tonal fields.
- **FRONT = band-pass `max(narrow_blur − wide_blur, 0)`** of the same deposit.

## Findings (what we learned building it)
1. **Mass alone already gets most of the way there — and for free on brightness.** The sim mass is
   an emergent, correlated large-scale value field the static 3-blob mass couldn't fake; and because
   its density is lower/more even, the K-M layers stay thin → the green reads **brighter/cleaner**
   (your #2 gap "everything is darker/greyer than realtex") *without* a pigment change. `mo-b` is
   mass-only, fronts off.
2. **Your tide-line premise was validated — but the fronts don't help at map scale yet.** First we
   high-passed the *accumulated* deposit → paper-fleck **stipple** (we almost wrongly concluded
   "erosion fronts don't work"). Switching to a **band-pass** (narrow-vs-wide) **recovered coherent
   curved arcs** (`debug-bandpass-fronts.png`) — your "real nested tide-lines" ARE in there. BUT when
   composited at this CAD symbol size, even sparse fronts read as scattered dark **flecks/dapples**,
   not the few soft nested arcs realtex has (`hybrid-fronts-on-example.png`). So our BEST render has
   **fronts OFF**. The arcs are interior; they don't hug the silhouette the way the shallow-water
   sim's edge tide-lines did.
3. **Warm mottle was the biggest richness lever.** realtex isn't monochrome green — it has warm
   brown/olive variegation THROUGHOUT. Pushing the pigment-mix threshold down (`mixT0` 0.5→0.3) so
   more of the field leans warm (`mo-warm`) closed a lot of the perceived gap vs the pure-green `mo-b`.

## Current best recipe (`best-mo-warm.png`)
structMix 1 · structGain 0.55 · massBlur 8 · **frontGain 0 (fronts OFF)** · massLo 0.18 · massHi 0.72
· massContrast 0.88 · baseDensity 0.62 · coverKnee 0.55 · **mixT0 0.30 · mixT1 0.90** · bandGain 0.4.

## Honest remaining gaps vs realtex (even in mo-warm)
- **Blooms read creamy-white**, realtex's are defined **warm-brown** patches. We have NOT done the
  eyedropper K/S pigment fit yet (pigB warm). This is queued and would help every variant.
- **Green could be a touch more saturated/vivid** — again a pigment-fit question (your #2).
- **The whole thing may read a little flat/uniform** to the human client ("not doing anything for
  me") — the calm we achieved might be *too* calm; realtex has more mid-scale value drama.
- Fronts: unsolved at map scale (finding #2).

## Specific questions for you
1. **Is mass-only-flat the right target, or is it too calm?** Should we reintroduce structure — and
   if so, mid-scale **value drama in the MASS** (bigger light/dark tonal masses) rather than the
   fine tide-line fronts? What's the right knob: higher massContrast, fewer/larger blur blobs, a
   second coarser mass octave?
2. **Fronts at CAD scale.** The band-pass arcs are real but read as flecks when small. Options we see:
   (a) drop interior fronts entirely, rely on mass; (b) keep ONLY the longest/edge-hugging arcs
   (how — connected-component length filter? bias fronts toward low `sdfN`?); (c) use the
   shallow-water sim's *edge* tide-lines instead (they hug the silhouette). Which is worth building?
3. **Warm variegation.** `mixT0` push works but is crude. Better way to get realtex's warm-brown
   mottle — a separate low-freq warm field, or tie warmth to the mass value (thick=warm)?
4. **Bloom color.** Confirm the eyedropper K/S fit is the right fix for creamy→warm-brown blooms,
   or is there a compositing reason they bleach?
5. **Priority call:** if you had to name the ONE change that most closes the gap to realtex for the
   human client, what is it — pigment/color fit, more mass drama, or edge tide-lines?

## Constraints (unchanged)
PixiJS v8 / WebGL, K-M compositing only (Beer–Lambert = mud, confirmed), bake-once-per-instance +
cache (zero per-frame cost), one fixed silhouette → many believable per-seed variations, top-down
CAD plan symbol. All in the derisking playground — nothing ported to flora-studio.
