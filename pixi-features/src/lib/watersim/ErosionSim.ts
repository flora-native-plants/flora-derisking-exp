/**
 * ErosionSim — a lean "receding wet-mask erosion with front deposition" watercolor bake
 * (PixiJS v8 / WebGL2). A SIMPLER, cheaper alternative to the shallow-water WatercolorSim
 * in this same folder: no velocity/pressure/divergence solve. It directly produces the
 * load-bearing effect — smooth, low-curvature, CORRELATED (nested) drying fronts with
 * history — via stick-slip recession of a wet mask that pins on paper ridges and strands
 * pigment as it crosses.
 *
 *   fields (rgba16float, ping-pong):
 *     A   : R=wetness  G=susGreen  B=susWarm  A=lossFrac(per-step, written by erode pass)
 *     ACC : R=depGreen G=depWarm                 (deposited pigment == the tide-lines)
 *   static: SDF texture (R=sdfN, A=inside) — reused as-is from the shallow-water path.
 *
 *   per iteration:  ERODE (A src -> A dst, recede + advect + write lossFrac)
 *                   DEPOSIT (A old + A new + ACC src -> ACC dst, strand pigment)
 *   final:          PACK (A + ACC -> PIGMENT layout) -> shared COMPOSITE -> rgba8 out
 *
 * The deposit/composite stack is deliberately identical in spirit to WatercolorSim so the
 * two variants differ ONLY in how the marks are generated — a clean apples-to-apples test.
 */
import { Geometry, Shader, Mesh, Container, RenderTexture, UniformGroup, type Renderer, type Texture } from 'pixi.js'

import VERT from './shaders/sim.vert.glsl?raw'
import SEED from './shaders/erodeSeed.frag.glsl?raw'
import ERODE from './shaders/erode.frag.glsl?raw'
import DEPOSIT from './shaders/deposit.frag.glsl?raw'
import PACK from './shaders/pack.frag.glsl?raw'
import COMPOSITE from './shaders/composite.frag.glsl?raw'

export interface ErosionParams {
  iterations: number
  // seed
  waterEdge: number
  pigment: number
  bloomAmt: number
  // erosion / fronts
  erode: number
  evapBase: number
  pin: number
  paperScale: number
  lowScale: number
  lowAmp: number
  advect: number
  diffuse: number
  dryLevel: number
  frontGain: number
  depRate: number
  dryDump: number
  releaseSoft: number
  depthBias: number
  // backruns
  backruns: number
  backrunRad: number
  backrunBurst: number
  // composite (shared with the shallow-water path)
  KA: [number, number, number]; SA: [number, number, number]
  KB: [number, number, number]; SB: [number, number, number]
  paperColor: [number, number, number]
  density: number
  coverKnee: number
  residual: number
  grainScale: number
  // debug: render raw deposited buffer as grayscale instead of the composite
  debug?: boolean
  debugScale?: number
}

function quad(): Geometry {
  return new Geometry({
    attributes: { aPosition: [-1, -1, 1, -1, -1, 1, 1, 1], aUV: [0, 0, 1, 0, 0, 1, 1, 1] },
    indexBuffer: [0, 1, 2, 2, 1, 3],
  })
}
const f32 = (a: number[]) => new Float32Array(a)

function rngFor(seed: number): () => number {
  let a = (seed >>> 0) || 1
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
}

export class ErosionSim {
  private r: Renderer
  private size: number
  private geo: Geometry
  private aA: RenderTexture; private aB: RenderTexture
  private accA: RenderTexture; private accB: RenderTexture
  private pig: RenderTexture
  out: RenderTexture

  private seedMesh: Mesh<Geometry, Shader>; private seedHolder: Container
  private eroMesh: Mesh<Geometry, Shader>; private eroHolder: Container
  private depMesh: Mesh<Geometry, Shader>; private depHolder: Container
  private packMesh: Mesh<Geometry, Shader>; private packHolder: Container
  private compMesh: Mesh<Geometry, Shader>; private compHolder: Container

  constructor(renderer: Renderer, size = 160) {
    this.r = renderer
    this.size = size
    const fo = { width: size, height: size, format: 'rgba16float' as const, scaleMode: 'nearest' as const }
    this.aA = RenderTexture.create(fo); this.aB = RenderTexture.create(fo)
    this.accA = RenderTexture.create(fo); this.accB = RenderTexture.create(fo)
    this.pig = RenderTexture.create(fo)
    this.out = RenderTexture.create({ width: size, height: size, scaleMode: 'linear' })
    this.geo = quad()
    const texel = f32([1 / size, 1 / size])

    const seedU = new UniformGroup({
      uSeed: { value: 0, type: 'f32' }, uTarget: { value: 0, type: 'f32' },
      uWaterEdge: { value: 0.6, type: 'f32' }, uPigment: { value: 0.6, type: 'f32' }, uBloomAmt: { value: 0.7, type: 'f32' },
    })
    this.seedMesh = new Mesh({ geometry: this.geo, shader: Shader.from({ gl: { vertex: VERT, fragment: SEED }, resources: { uSdf: this.aA.source, seedU } }) })

    const eroU = new UniformGroup({
      uTexel: { value: texel, type: 'vec2<f32>' }, uSeed: { value: 0, type: 'f32' },
      uErode: { value: 1.0, type: 'f32' }, uEvapBase: { value: 0.012, type: 'f32' }, uPin: { value: 0.5, type: 'f32' },
      uPaperScale: { value: 4, type: 'f32' }, uLowScale: { value: 3, type: 'f32' }, uLowAmp: { value: 0.25, type: 'f32' },
      uStep: { value: 0, type: 'f32' }, uReleaseSoft: { value: 0.09, type: 'f32' }, uDepthBias: { value: 0.55, type: 'f32' },
      uAdvect: { value: 0.9, type: 'f32' }, uDiffuse: { value: 0.12, type: 'f32' }, uDryLevel: { value: 0.12, type: 'f32' },
      uFrontGain: { value: 4, type: 'f32' }, uDepRate: { value: 0.6, type: 'f32' }, uDryDump: { value: 0.25, type: 'f32' },
      uReWetActive: { value: 0, type: 'f32' }, uReWetC: { value: f32([0.5, 0.5]), type: 'vec2<f32>' },
      uReWetRad: { value: 0.14, type: 'f32' }, uReWetBurst: { value: 0.5, type: 'f32' },
    })
    this.eroMesh = new Mesh({ geometry: this.geo, shader: Shader.from({ gl: { vertex: VERT, fragment: ERODE }, resources: { uA: this.aA.source, uSdf: this.aA.source, eroU } }) })

    this.depMesh = new Mesh({ geometry: this.geo, shader: Shader.from({ gl: { vertex: VERT, fragment: DEPOSIT }, resources: { uAold: this.aA.source, uAnew: this.aB.source, uAcc: this.accA.source, uSdf: this.aA.source } }) })

    const packU = new UniformGroup({ uDebug: { value: 0, type: 'f32' }, uDebugScale: { value: 0.5, type: 'f32' } })
    this.packMesh = new Mesh({ geometry: this.geo, shader: Shader.from({ gl: { vertex: VERT, fragment: PACK }, resources: { uA: this.aA.source, uAcc: this.accA.source, uSdf: this.aA.source, packU } }) })

    const compU = new UniformGroup({
      uKA: { value: f32([0, 0, 0]), type: 'vec3<f32>' }, uSA: { value: f32([1, 1, 1]), type: 'vec3<f32>' },
      uKB: { value: f32([0, 0, 0]), type: 'vec3<f32>' }, uSB: { value: f32([1, 1, 1]), type: 'vec3<f32>' },
      uPaperColor: { value: f32([0.96, 0.93, 0.84]), type: 'vec3<f32>' },
      uDensity: { value: 3.0, type: 'f32' }, uCoverKnee: { value: 0.5, type: 'f32' },
      uResidual: { value: 0.5, type: 'f32' }, uSeed: { value: 0, type: 'f32' }, uGrainScale: { value: 90, type: 'f32' },
    })
    this.compMesh = new Mesh({ geometry: this.geo, shader: Shader.from({ gl: { vertex: VERT, fragment: COMPOSITE }, resources: { uPig: this.pig.source, uSdf: this.aA.source, compU } }) })

    this.seedHolder = new Container(); this.seedHolder.addChild(this.seedMesh)
    this.eroHolder = new Container(); this.eroHolder.addChild(this.eroMesh)
    this.depHolder = new Container(); this.depHolder.addChild(this.depMesh)
    this.packHolder = new Container(); this.packHolder.addChild(this.packMesh)
    this.compHolder = new Container(); this.compHolder.addChild(this.compMesh)
  }

  /** Run the erosion sim for one instance and composite. Returns `this.out` (reused). */
  bake(sdf: Texture, seed: number, p: ErosionParams): RenderTexture {
    const r = this.r
    const su = this.seedMesh.shader!.resources.seedU.uniforms
    const eu = this.eroMesh.shader!.resources.eroU.uniforms
    const packU = this.packMesh.shader!.resources.packU.uniforms
    const cu = this.compMesh.shader!.resources.compU.uniforms

    // --- SEED: SDF -> A + clear ACC ---
    this.seedMesh.shader!.resources.uSdf = sdf.source
    su.uSeed = seed; su.uWaterEdge = p.waterEdge; su.uPigment = p.pigment; su.uBloomAmt = p.bloomAmt
    su.uTarget = 0; r.render({ container: this.seedHolder, target: this.aA, clear: true })
    su.uTarget = 1; r.render({ container: this.seedHolder, target: this.accA, clear: true })

    // shared erosion uniforms
    eu.uSeed = seed; eu.uErode = p.erode; eu.uEvapBase = p.evapBase; eu.uPin = p.pin
    eu.uPaperScale = p.paperScale; eu.uLowScale = p.lowScale; eu.uLowAmp = p.lowAmp
    eu.uAdvect = p.advect; eu.uDiffuse = p.diffuse; eu.uDryLevel = p.dryLevel
    eu.uFrontGain = p.frontGain; eu.uDepRate = p.depRate; eu.uDryDump = p.dryDump
    eu.uReleaseSoft = p.releaseSoft; eu.uDepthBias = p.depthBias
    eu.uReWetRad = p.backrunRad; eu.uReWetBurst = p.backrunBurst
    this.eroMesh.shader!.resources.uSdf = sdf.source
    this.depMesh.shader!.resources.uSdf = sdf.source

    // schedule backrun steps + centres from the seed
    const rng = rngFor(seed * 131 + 7)
    const backrunSteps = new Map<number, [number, number]>()
    for (let b = 0; b < p.backruns; b++) {
      const step = Math.floor((0.30 + 0.45 * rng()) * p.iterations)
      const ang = rng() * Math.PI * 2, rad = 0.12 + 0.22 * rng()
      backrunSteps.set(step, [0.5 + rad * Math.cos(ang), 0.5 + rad * Math.sin(ang)])
    }

    let aSrc = this.aA, aDst = this.aB
    let cSrc = this.accA, cDst = this.accB

    for (let i = 0; i < p.iterations; i++) {
      // global drying pressure climbs 0 -> 1 across the run (drives stick-slip release)
      eu.uStep = p.iterations > 1 ? i / (p.iterations - 1) : 1
      // backrun this step?
      const br = backrunSteps.get(i)
      if (br) { eu.uReWetActive = 1; (eu.uReWetC as Float32Array).set(br) } else { eu.uReWetActive = 0 }

      // ERODE: A src -> A dst
      this.eroMesh.shader!.resources.uA = aSrc.source
      r.render({ container: this.eroHolder, target: aDst, clear: true })

      // DEPOSIT: A old (src) + A new (dst) + ACC src -> ACC dst
      this.depMesh.shader!.resources.uAold = aSrc.source
      this.depMesh.shader!.resources.uAnew = aDst.source
      this.depMesh.shader!.resources.uAcc = cSrc.source
      r.render({ container: this.depHolder, target: cDst, clear: true })

      { const t = aSrc; aSrc = aDst; aDst = t }
      { const t = cSrc; cSrc = cDst; cDst = t }
    }

    // --- PACK: A + ACC -> PIGMENT layout (or debug grayscale) ---
    this.packMesh.shader!.resources.uA = aSrc.source
    this.packMesh.shader!.resources.uAcc = cSrc.source
    this.packMesh.shader!.resources.uSdf = sdf.source
    packU.uDebug = p.debug ? 1 : 0; packU.uDebugScale = p.debugScale ?? 0.5
    if (p.debug) {
      r.render({ container: this.packHolder, target: this.out, clear: true })
      return this.out
    }
    r.render({ container: this.packHolder, target: this.pig, clear: true })

    // --- COMPOSITE: PIGMENT -> out ---
    cu.uKA.set(p.KA); cu.uSA.set(p.SA); cu.uKB.set(p.KB); cu.uSB.set(p.SB)
    cu.uPaperColor.set(p.paperColor)
    cu.uDensity = p.density; cu.uCoverKnee = p.coverKnee; cu.uResidual = p.residual
    cu.uSeed = seed; cu.uGrainScale = p.grainScale
    this.compMesh.shader!.resources.uPig = this.pig.source
    this.compMesh.shader!.resources.uSdf = sdf.source
    r.render({ container: this.compHolder, target: this.out, clear: true })
    return this.out
  }

  destroy(): void {
    this.seedMesh.destroy(); this.eroMesh.destroy(); this.depMesh.destroy(); this.packMesh.destroy(); this.compMesh.destroy()
    this.geo.destroy()
    this.aA.destroy(true); this.aB.destroy(true)
    this.accA.destroy(true); this.accB.destroy(true)
    this.pig.destroy(true); this.out.destroy(true)
  }
}
