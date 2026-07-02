/**
 * hybridStructure — defaults for the HYBRID watercolor path (Fable's verdict: the erosion
 * sim generates STRUCTURE — a low-contrast soft wash mass + correlated tide-line fronts — and
 * the static proceduralWatercolor shader does MATERIAL — K-M, granulation, blooms, pigment fit).
 *
 * These are the "calm nested fronts" erosion settings (the v3b-era tuning) with the composite
 * fields left at neutral placeholders, since bakeStructure() never runs the K-M composite —
 * it exports the raw fields before they are "finished". Keeping the builder here keeps the
 * TabBotanicalVariants file focused and under the 700-line cap.
 */
import type { ErosionParams } from '../watersim/ErosionSim'

/** The erosion field params for the hybrid structure bake (calm, low-curvature fronts). */
export function hybridEroParams(iterations = 45): ErosionParams {
  return {
    iterations,
    waterEdge: 0.6, pigment: 0.6, bloomAmt: 0.7,
    erode: 1.0, evapBase: 0.012, pin: 0.5,
    paperScale: 4, lowScale: 3, lowAmp: 0.25,
    advect: 0.9, diffuse: 0.12, dryLevel: 0.12,
    frontGain: 4, depRate: 0.6, dryDump: 0.25,
    releaseSoft: 0.09, depthBias: 0.55,
    backruns: 2, backrunRad: 0.14, backrunBurst: 0.5,
    // composite fields — UNUSED by bakeStructure (kept to satisfy the ErosionParams type)
    KA: [0, 0, 0], SA: [1, 1, 1], KB: [0, 0, 0], SB: [1, 1, 1],
    paperColor: [0.96, 0.93, 0.84], density: 3, coverKnee: 0.5, residual: 0.5, grainScale: 90,
  }
}
