<script setup lang="ts">
/**
 * Jump-Flood outline / glow (T6) — its own tab because the pipeline (multi-pass
 * ping-pong over float RenderTextures driven off a selection mask) is an
 * architectural misfit with the filter-on-a-container modes in TabSelectionFX2.
 *
 * The whole point: one screen-space pipeline whose cost is independent of how
 * many shapes are selected. See lib/jumpFlood.ts and
 * docs/selection-animation-research-synthesis.md (T6).
 *
 * Click shapes to select. The blue outline/glow is a true distance field, so
 * thickness and glow are continuous, and "Sweep" animates a band travelling
 * outward (only possible because every pixel knows its distance to the edge).
 */
import { ref, onMounted, onUnmounted, markRaw, watch } from 'vue'
import { Application, Graphics, Container, Sprite } from 'pixi.js'
import { JumpFloodOutline, type JfaOptions } from '../lib/jumpFlood'
import { useFps } from '../shared/useFps'

const { fps, frameMs } = useFps()
const canvasEl = ref<HTMLCanvasElement>()

const thickness = ref(6)
const feather = ref(1.5)
const glowOn = ref(true)
const glowStr = ref(0.7)
const glowFalloff = ref(30)
const sweep = ref(false)

interface ShapeDef { draw: (g: Graphics) => void; outline: [number, number][] }
interface Shape { gfx: Graphics; def: ShapeDef; pos: [number, number]; selected: boolean }

let app = markRaw({} as Application)
let jfa: JumpFloodOutline | null = null
let maskSource = markRaw({} as Container)   // solid silhouettes of selected shapes
let outSprite = markRaw({} as Sprite)
let shapes: Shape[] = []
let sweepT = 0

const COLOR: [number, number, number] = [0.27, 0.6, 1.0]

const SHAPES: ShapeDef[] = [
  {
    draw(g) { g.setFillStyle({ color: 0x2a4a6c, alpha: 0.9 }); g.setStrokeStyle({ width: 1.5, color: 0x4488cc }); g.rect(0, 0, 190, 120).fill().stroke() },
    outline: [[0,0],[190,0],[190,120],[0,120]],
  },
  {
    draw(g) {
      g.setFillStyle({ color: 0x1a4a2a, alpha: 0.9 }); g.setStrokeStyle({ width: 1.5, color: 0x44aa66 })
      const p = hex(); g.moveTo(p[0][0], p[0][1]); for (let i = 1; i < p.length; i++) g.lineTo(p[i][0], p[i][1]); g.closePath().fill().stroke()
    },
    outline: hex(),
  },
  {
    draw(g) {
      g.setFillStyle({ color: 0x3a2810, alpha: 0.9 }); g.setStrokeStyle({ width: 1.5, color: 0xbb7733 })
      const p: [number,number][] = [[20,80],[100,10],[230,30],[260,100],[160,150],[40,140]]
      g.moveTo(p[0][0], p[0][1]); for (let i = 1; i < p.length; i++) g.lineTo(p[i][0], p[i][1]); g.closePath().fill().stroke()
    },
    outline: [[20,80],[100,10],[230,30],[260,100],[160,150],[40,140]],
  },
  {
    draw(g) { g.setFillStyle({ color: 0x4a2a4a, alpha: 0.9 }); g.setStrokeStyle({ width: 1.5, color: 0xaa66bb }); g.circle(70, 70, 65).fill().stroke() },
    outline: (() => Array.from({ length: 33 }, (_, i) => { const a = (Math.PI*2*i)/32; return [70+Math.cos(a)*65, 70+Math.sin(a)*65] as [number,number] }))(),
  },
]

function hex(): [number, number][] {
  return Array.from({ length: 6 }, (_, i) => { const a = (Math.PI/3)*i - Math.PI/6; return [85+Math.cos(a)*80, 85+Math.sin(a)*80] as [number,number] })
}

function rebuildMaskSource(): void {
  maskSource.removeChildren().forEach(c => c.destroy())
  for (const s of shapes) {
    if (!s.selected) continue
    const sil = new Graphics()
    sil.setFillStyle({ color: 0xffffff, alpha: 1 })
    const o = s.def.outline
    sil.moveTo(o[0][0], o[0][1])
    for (let i = 1; i < o.length; i++) sil.lineTo(o[i][0], o[i][1])
    sil.closePath().fill()
    sil.position.set(s.pos[0], s.pos[1])
    maskSource.addChild(sil)
  }
}

function currentOpts(): JfaOptions {
  return {
    color: COLOR,
    thickness: thickness.value,
    feather: feather.value,
    glow: glowOn.value ? glowStr.value : 0,
    glowFalloff: glowFalloff.value,
  }
}

function onShapeClick(i: number): void {
  shapes[i].selected = !shapes[i].selected
  rebuildMaskSource()
}

function onTick(t: { deltaTime: number }): void {
  if (!jfa) return
  const opts = currentOpts()
  if (sweep.value) {
    sweepT += t.deltaTime * 0.6
    // a band that travels outward: oscillate the outline thickness center
    opts.thickness = thickness.value + (Math.sin(sweepT * 0.08) * 0.5 + 0.5) * 40
  }
  jfa.run(maskSource, opts)
}

onMounted(async () => {
  const canvas = canvasEl.value!
  app = markRaw(new Application())
  await app.init({
    canvas, preference: 'webgl',
    width: canvas.clientWidth, height: canvas.clientHeight,
    antialias: true, background: '#0d1117',
    resolution: 1, autoDensity: true,   // resolution 1 keeps the float RTs at CSS px
  })

  const shapesLayer = markRaw(new Container())
  maskSource = markRaw(new Container())
  app.stage.addChild(shapesLayer)

  const positions: [number, number][] = [[80, 70], [380, 60], [80, 330], [400, 300]]
  for (let i = 0; i < SHAPES.length; i++) {
    const def = SHAPES[i]
    const gfx = markRaw(new Graphics())
    def.draw(gfx)
    gfx.position.set(positions[i][0], positions[i][1])
    gfx.eventMode = 'static'; gfx.cursor = 'pointer'
    const idx = i
    gfx.on('pointerdown', () => onShapeClick(idx))
    shapesLayer.addChild(gfx)
    shapes.push({ gfx, def, pos: positions[i], selected: i === 0 })
  }

  jfa = markRaw(new JumpFloodOutline(app.renderer, app.screen.width, app.screen.height))

  // outline sprite renders ABOVE shapes (always-on-top selection chrome)
  outSprite = markRaw(new Sprite(jfa.out))
  app.stage.addChild(outSprite)

  rebuildMaskSource()
  app.ticker.add(onTick)
})

onUnmounted(() => {
  app?.ticker?.remove(onTick)
  jfa?.destroy()
  app?.destroy(true, { children: true, texture: true, context: true })
})

watch([thickness, feather, glowOn, glowStr, glowFalloff], () => { /* picked up next tick */ })
</script>

<template>
  <div class="wrap">
    <canvas ref="canvasEl" />

    <div class="hud">
      <div class="fps">{{ fps }} <span>fps</span></div>
      <div>{{ frameMs }} ms</div>
    </div>

    <div class="controls">
      <div class="ctrl-title">Jump-Flood Outline (T6)</div>
      <label>Thickness
        <input type="range" v-model.number="thickness" min="1" max="40" step="1" /> {{ thickness }}px
      </label>
      <label>Feather
        <input type="range" v-model.number="feather" min="0.5" max="6" step="0.5" /> {{ feather }}px
      </label>
      <label class="check"><input type="checkbox" v-model="glowOn" /> Glow</label>
      <label v-if="glowOn">Glow str
        <input type="range" v-model.number="glowStr" min="0.1" max="2" step="0.1" /> {{ glowStr.toFixed(1) }}
      </label>
      <label v-if="glowOn">Glow falloff
        <input type="range" v-model.number="glowFalloff" min="8" max="80" step="2" /> {{ glowFalloff }}px
      </label>
      <label class="check"><input type="checkbox" v-model="sweep" /> Sweep band</label>
      <div class="hint-small">Click shapes to select</div>
    </div>

    <div class="desc">
      T6 — Jump-Flood distance field off a selection mask. Outline/glow cost is independent of
      object count. Float RTs hold seed coords; {{ Math.ceil(Math.log2(Math.max(800,600))) }} ping-pong passes. Click shapes to select.
    </div>
  </div>
</template>

<style scoped>
.wrap { position: relative; width: 100%; height: 100%; background: #0d1117; }
canvas { display: block; width: 100%; height: 100%; }
.hud { position: absolute; top: 10px; left: 10px; font-family: monospace; font-size: 12px; color: #0f0; line-height: 1.7; pointer-events: none; }
.fps { font-size: 18px; font-weight: bold; }
.fps span { font-size: 12px; color: #0a0; }
.controls {
  position: absolute; top: 10px; right: 10px;
  display: flex; flex-direction: column; gap: 9px;
  font-family: monospace; font-size: 12px; color: #bbb;
  background: rgba(0,0,0,0.75); padding: 12px 16px; border-radius: 6px;
  border: 1px solid #333; min-width: 210px;
}
.ctrl-title { font-size: 11px; color: #666; margin-bottom: 2px; }
label { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
label.check { gap: 8px; }
input[type=range] { width: 80px; flex-shrink: 0; }
.hint-small { font-size: 10px; color: #555; margin-top: 4px; }
.desc {
  position: absolute; bottom: 10px; left: 50%; transform: translateX(-50%);
  font-family: monospace; font-size: 11px; color: #667;
  background: rgba(0,0,0,0.65); padding: 5px 14px; border-radius: 4px;
  max-width: 90%; text-align: center; pointer-events: none;
}
</style>
