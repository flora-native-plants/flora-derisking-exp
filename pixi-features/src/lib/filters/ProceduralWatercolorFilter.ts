// src/lib/filters/ProceduralWatercolorFilter.ts
import { Filter, GlProgram, UniformGroup, defaultFilterVert, Texture } from 'pixi.js'
import type { TextureSource } from 'pixi.js'
import { pigmentKS } from '../watercolor/pigmentKS'
// The fragment shader lives in its own .glsl file (syntax highlighting, linting, and one
// source of truth); Vite's `?raw` imports it as a string for Pixi's GlProgram.
import FRAG from './proceduralWatercolor.frag.glsl?raw'

export interface ProcWaterOpts {
  sdf: Texture
  sdfTexelWorldSize: number   // world units per SDF texel (crown-radius scaling)
  interiorScale: number       // deepest interior distance (world units) — drying-field denom
  seed: number
  offsetBase: number          // >= lobe amplitude, in the SAME units as the SDF sample
  offsetNoiseAmp: number      // a1: 8-12% crown radius
  warpAmp: number             // small UV-space amplitude (~0.03); keep « 0.1 or nesting shears
  shadowDir: [number, number] // global, shared across instances — MUST be normalized in JS
  shadowAmp: number           // a2: ~5%
  fbmB: number                // T-field fBm weight (0.3-0.5)
  paperC: number              // T-field paper weight (0.05-0.15)
  bandCount?: number          // number of iso-bands (default 6)
  edgeWidth?: number          // band edge width multiplier (default 1.2)
  bandGain?: number           // band density gain (default 0.6)
  // K-M pigments (Task 6)
  pigA: { K: [number, number, number]; S: [number, number, number] }
  pigB: { K: [number, number, number]; S: [number, number, number] }
  // tuning scalars (Task 6)
  plateauLo?: number          // default 0.12
  plateauHi?: number          // default 0.5
  mixT0?: number              // default 0.2
  mixT1?: number              // default 0.85
  baseDensity?: number        // default 0.5
  coverKnee?: number          // default 0.35
  debugStage?: number         // 0 = final render; 1..9 = dump an intermediate stage
  // HYBRID: sim-baked structure map (R=mass, G=fronts). Leave structMix 0 for pure effects.
  structMix?: number          // 0 = pure effects (default); 1 = mass+marks from the sim
}

export class ProceduralWatercolorFilter extends Filter {
  private g: UniformGroup
  constructor(o: ProcWaterOpts) {
    const pigA = o.pigA
    const pigB = o.pigB
    const g = new UniformGroup({
      uTexelWorld:  { value: o.sdfTexelWorldSize,                    type: 'f32' },
      uInteriorScale:{ value: o.interiorScale,                       type: 'f32' },
      uSeed:        { value: o.seed,                                 type: 'f32' },
      uOffBase:     { value: o.offsetBase,                           type: 'f32' },
      uOffNoiseAmp: { value: o.offsetNoiseAmp,                       type: 'f32' },
      uWarpAmp:     { value: o.warpAmp,                              type: 'f32' },
      uShadowDir:   { value: new Float32Array(o.shadowDir),          type: 'vec2<f32>' },
      uShadowAmp:   { value: o.shadowAmp,                            type: 'f32' },
      uFbmB:        { value: o.fbmB,                                 type: 'f32' },
      uPaperC:      { value: o.paperC,                               type: 'f32' },
      uBandCount:   { value: o.bandCount   ?? 6,                     type: 'f32' },
      uEdgeWidth:   { value: o.edgeWidth   ?? 1.2,                   type: 'f32' },
      uBandGain:    { value: o.bandGain    ?? 0.6,                   type: 'f32' },
      // K-M pigment K/S pairs
      uKA:          { value: new Float32Array(pigA.K),               type: 'vec3<f32>' },
      uSA:          { value: new Float32Array(pigA.S),               type: 'vec3<f32>' },
      uKB:          { value: new Float32Array(pigB.K),               type: 'vec3<f32>' },
      uSB:          { value: new Float32Array(pigB.S),               type: 'vec3<f32>' },
      // paper and compositing
      uPaperColor:  { value: new Float32Array([0.96, 0.93, 0.84]),   type: 'vec3<f32>' },
      uPlateauLo:   { value: o.plateauLo   ?? 0.12,                  type: 'f32' },
      uPlateauHi:   { value: o.plateauHi   ?? 0.5,                   type: 'f32' },
      uMixT0:       { value: o.mixT0       ?? 0.2,                   type: 'f32' },
      uMixT1:       { value: o.mixT1       ?? 0.85,                  type: 'f32' },
      uBaseDensity: { value: o.baseDensity ?? 0.5,                   type: 'f32' },
      uCoverKnee:   { value: o.coverKnee   ?? 0.35,                  type: 'f32' },
      uDebugStage:  { value: o.debugStage  ?? 0,                     type: 'f32' },
      uStructMix:   { value: o.structMix   ?? 0,                     type: 'f32' },
    })
    super({
      glProgram: GlProgram.from({ vertex: defaultFilterVert, fragment: FRAG }),
      resources: {
        procUniforms: g,
        uStruct: Texture.WHITE.source,   // placeholder until a sim structure map is bound
      },
    })
    this.g = g
  }
  /** Bind the sim-baked structure map (R=mass, G=fronts) and enable the hybrid path. */
  setStructure(source: TextureSource, mix = 1): void {
    ;(this.resources as unknown as { uStruct: TextureSource }).uStruct = source
    this.g.uniforms.uStructMix = mix
  }
  setStructMix(v: number)    { this.g.uniforms.uStructMix   = v }
  setSeed(v: number)         { this.g.uniforms.uSeed        = v }
  setFbmB(v: number)         { this.g.uniforms.uFbmB        = v }
  setPaperC(v: number)       { this.g.uniforms.uPaperC      = v }
  setBandCount(v: number)    { this.g.uniforms.uBandCount   = v }
  setEdgeWidth(v: number)    { this.g.uniforms.uEdgeWidth   = v }
  setBandGain(v: number)     { this.g.uniforms.uBandGain    = v }
  setBaseDensity(v: number)  { this.g.uniforms.uBaseDensity = v }
  setPlateauLo(v: number)    { this.g.uniforms.uPlateauLo   = v }
  setPlateauHi(v: number)    { this.g.uniforms.uPlateauHi   = v }
  setMixT0(v: number)        { this.g.uniforms.uMixT0       = v }
  setMixT1(v: number)        { this.g.uniforms.uMixT1       = v }
  setCoverKnee(v: number)    { this.g.uniforms.uCoverKnee   = v }
}

// Re-export pigmentKS for convenience of callers who wire the filter.
export { pigmentKS }
