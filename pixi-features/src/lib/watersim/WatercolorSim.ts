/**
 * WatercolorSim — a baked GPU watercolor pigment-transport sim (PixiJS v8 / WebGL2).
 *
 * A lean Curtis-1997-flavoured shallow-water bake. Per instance we run ~N iterations of
 * float RenderTexture ping-pong, then a Kubelka-Munk composite, and bake the result to an
 * independent texture. Marks EMERGE from the dynamics rather than being drawn:
 *
 *   fields (rgba16float, ping-pong):
 *     STATE  : R=vel.u  G=vel.v  B=water h   A=wetMax
 *     PIGMENT: R=gGreen  G=dGreen  B=gWarm  A=dWarm   (g=suspended, d=deposited)
 *   static: SDF texture (R=sdfN, G=rim, A=inside coverage) built by sdfToTexture.
 *
 *   per iteration:  velocity/water pass (STATE) -> pigment advect+deposit pass (PIGMENT)
 *   final:          Kubelka-Munk composite (PIGMENT + paper) -> rgba8 out
 *
 * The edge evaporates faster -> water sinks at the rim -> flow carries pigment outward to
 * the receding contact line == emergent coffee-ring / tide-lines. A subtle curl-noise swirl
 * adds organic wet-in-wet wander. See the .glsl files for the physics comments.
 */
import { Geometry, Shader, Mesh, Container, RenderTexture, UniformGroup, type Renderer, type Texture } from 'pixi.js'

import VERT from './shaders/sim.vert.glsl?raw'
import SEED from './shaders/seed.frag.glsl?raw'
import VELOCITY from './shaders/velocity.frag.glsl?raw'
import PIGMENT from './shaders/pigment.frag.glsl?raw'
import COMPOSITE from './shaders/composite.frag.glsl?raw'

export interface SimParams {
  iterations: number
  // seed
  water: number
  pigment: number
  bloomAmt: number
  // velocity / water
  pressure: number
  damp: number
  curlAmp: number
  curlScale: number
  evap: number
  edgeEvap: number
  capillary: number
  // pigment advect / deposit
  advect: number
  depositG: number
  depositW: number
  granule: number
  paperScale: number
  edgeDeposit: number
  dryWet: number
  // composite
  KA: [number, number, number]; SA: [number, number, number]
  KB: [number, number, number]; SB: [number, number, number]
  paperColor: [number, number, number]
  density: number
  coverKnee: number
  residual: number
  grainScale: number
}

function quad(): Geometry {
  return new Geometry({
    attributes: { aPosition: [-1, -1, 1, -1, -1, 1, 1, 1], aUV: [0, 0, 1, 0, 0, 1, 1, 1] },
    indexBuffer: [0, 1, 2, 2, 1, 3],
  })
}
const f32 = (a: number[]) => new Float32Array(a)

export class WatercolorSim {
  private r: Renderer
  private size: number
  private geo: Geometry
  private stateA: RenderTexture; private stateB: RenderTexture
  private pigA: RenderTexture;   private pigB: RenderTexture
  out: RenderTexture

  private seedMesh: Mesh<Geometry, Shader>; private seedHolder: Container
  private velMesh: Mesh<Geometry, Shader>; private velHolder: Container
  private pigMesh: Mesh<Geometry, Shader>; private pigHolder: Container
  private compMesh: Mesh<Geometry, Shader>; private compHolder: Container

  constructor(renderer: Renderer, size = 256) {
    this.r = renderer
    this.size = size
    const fo = { width: size, height: size, format: 'rgba16float' as const, scaleMode: 'nearest' as const }
    this.stateA = RenderTexture.create(fo); this.stateB = RenderTexture.create(fo)
    this.pigA = RenderTexture.create(fo);   this.pigB = RenderTexture.create(fo)
    this.out = RenderTexture.create({ width: size, height: size, scaleMode: 'linear' })
    this.geo = quad()
    const texel = f32([1 / size, 1 / size])

    const seedU = new UniformGroup({
      uSeed: { value: 0, type: 'f32' }, uTarget: { value: 0, type: 'f32' },
      uWater: { value: 0.9, type: 'f32' }, uPigment: { value: 0.6, type: 'f32' }, uBloomAmt: { value: 0.6, type: 'f32' },
    })
    this.seedMesh = new Mesh({ geometry: this.geo, shader: Shader.from({ gl: { vertex: VERT, fragment: SEED }, resources: { uSdf: this.stateA.source, seedU } }) })

    const velU = new UniformGroup({
      uTexel: { value: texel, type: 'vec2<f32>' }, uSeed: { value: 0, type: 'f32' }, uIter: { value: 0, type: 'f32' },
      uPressure: { value: 0.6, type: 'f32' }, uDamp: { value: 0.92, type: 'f32' },
      uCurlAmp: { value: 0.0015, type: 'f32' }, uCurlScale: { value: 4, type: 'f32' },
      uEvap: { value: 0.02, type: 'f32' }, uEdgeEvap: { value: 1.5, type: 'f32' }, uCapillary: { value: 0.15, type: 'f32' },
    })
    this.velMesh = new Mesh({ geometry: this.geo, shader: Shader.from({ gl: { vertex: VERT, fragment: VELOCITY }, resources: { uState: this.stateA.source, uSdf: this.stateA.source, velU } }) })

    const pigU = new UniformGroup({
      uTexel: { value: texel, type: 'vec2<f32>' }, uSeed: { value: 0, type: 'f32' },
      uAdvect: { value: 1.0, type: 'f32' }, uDepositG: { value: 0.06, type: 'f32' }, uDepositW: { value: 0.06, type: 'f32' },
      uGranule: { value: 0.4, type: 'f32' }, uPaperScale: { value: 40, type: 'f32' },
      uEdgeDeposit: { value: 2.5, type: 'f32' }, uDryWet: { value: 0.1, type: 'f32' },
    })
    this.pigMesh = new Mesh({ geometry: this.geo, shader: Shader.from({ gl: { vertex: VERT, fragment: PIGMENT }, resources: { uPig: this.pigA.source, uState: this.stateA.source, uSdf: this.stateA.source, pigU } }) })

    const compU = new UniformGroup({
      uKA: { value: f32([0, 0, 0]), type: 'vec3<f32>' }, uSA: { value: f32([1, 1, 1]), type: 'vec3<f32>' },
      uKB: { value: f32([0, 0, 0]), type: 'vec3<f32>' }, uSB: { value: f32([1, 1, 1]), type: 'vec3<f32>' },
      uPaperColor: { value: f32([0.96, 0.93, 0.84]), type: 'vec3<f32>' },
      uDensity: { value: 3.0, type: 'f32' }, uCoverKnee: { value: 0.5, type: 'f32' },
      uResidual: { value: 0.5, type: 'f32' }, uSeed: { value: 0, type: 'f32' }, uGrainScale: { value: 90, type: 'f32' },
    })
    this.compMesh = new Mesh({ geometry: this.geo, shader: Shader.from({ gl: { vertex: VERT, fragment: COMPOSITE }, resources: { uPig: this.pigA.source, uSdf: this.stateA.source, compU } }) })

    this.seedHolder = new Container(); this.seedHolder.addChild(this.seedMesh)
    this.velHolder = new Container(); this.velHolder.addChild(this.velMesh)
    this.pigHolder = new Container(); this.pigHolder.addChild(this.pigMesh)
    this.compHolder = new Container(); this.compHolder.addChild(this.compMesh)
  }

  /** Run the full sim for one instance and composite. Returns `this.out` (reused). */
  bake(sdf: Texture, seed: number, p: SimParams): RenderTexture {
    const r = this.r
    const su = this.seedMesh.shader!.resources.seedU.uniforms
    const vu = this.velMesh.shader!.resources.velU.uniforms
    const gu = this.pigMesh.shader!.resources.pigU.uniforms
    const cu = this.compMesh.shader!.resources.compU.uniforms

    // --- SEED: SDF -> initial STATE and PIGMENT ---
    this.seedMesh.shader!.resources.uSdf = sdf.source
    su.uSeed = seed; su.uWater = p.water; su.uPigment = p.pigment; su.uBloomAmt = p.bloomAmt
    su.uTarget = 0; r.render({ container: this.seedHolder, target: this.stateA, clear: true })
    su.uTarget = 1; r.render({ container: this.seedHolder, target: this.pigA, clear: true })

    // shared static uniforms
    vu.uSeed = seed; vu.uPressure = p.pressure; vu.uDamp = p.damp; vu.uCurlAmp = p.curlAmp
    vu.uCurlScale = p.curlScale; vu.uEvap = p.evap; vu.uEdgeEvap = p.edgeEvap; vu.uCapillary = p.capillary
    gu.uSeed = seed; gu.uAdvect = p.advect; gu.uDepositG = p.depositG; gu.uDepositW = p.depositW
    gu.uGranule = p.granule; gu.uPaperScale = p.paperScale; gu.uEdgeDeposit = p.edgeDeposit; gu.uDryWet = p.dryWet
    this.velMesh.shader!.resources.uSdf = sdf.source
    this.pigMesh.shader!.resources.uSdf = sdf.source

    let sSrc = this.stateA, sDst = this.stateB
    let pSrc = this.pigA, pDst = this.pigB

    for (let i = 0; i < p.iterations; i++) {
      // velocity/water: STATE src -> STATE dst
      vu.uIter = i
      this.velMesh.shader!.resources.uState = sSrc.source
      r.render({ container: this.velHolder, target: sDst, clear: true })
      { const t = sSrc; sSrc = sDst; sDst = t }
      // pigment: PIG src (+ updated STATE) -> PIG dst
      this.pigMesh.shader!.resources.uState = sSrc.source
      this.pigMesh.shader!.resources.uPig = pSrc.source
      r.render({ container: this.pigHolder, target: pDst, clear: true })
      { const t = pSrc; pSrc = pDst; pDst = t }
    }

    // --- COMPOSITE: final PIGMENT -> out ---
    cu.uKA.set(p.KA); cu.uSA.set(p.SA); cu.uKB.set(p.KB); cu.uSB.set(p.SB)
    cu.uPaperColor.set(p.paperColor)
    cu.uDensity = p.density; cu.uCoverKnee = p.coverKnee; cu.uResidual = p.residual
    cu.uSeed = seed; cu.uGrainScale = p.grainScale
    this.compMesh.shader!.resources.uPig = pSrc.source
    this.compMesh.shader!.resources.uSdf = sdf.source
    r.render({ container: this.compHolder, target: this.out, clear: true })
    return this.out
  }

  destroy(): void {
    this.seedMesh.destroy(); this.velMesh.destroy(); this.pigMesh.destroy(); this.compMesh.destroy()
    this.geo.destroy()
    this.stateA.destroy(true); this.stateB.destroy(true)
    this.pigA.destroy(true); this.pigB.destroy(true); this.out.destroy(true)
  }
}
