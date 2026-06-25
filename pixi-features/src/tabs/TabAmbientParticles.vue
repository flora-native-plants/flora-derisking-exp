<script setup lang="ts">
/**
 * Ambient particles spike — drifting petals / leaves over a plan, seasonal palette.
 * Hand-rolled (not @pixi/particle-emitter, which predates Pixi v8) so it's a zero-risk
 * sprite-pool drift in the ticker. Pure atmosphere; this is presentation-mode delight
 * that vanishes in a printed PDF — never a core static-plan feature.
 */
import { ref, watch, onMounted, onUnmounted, markRaw } from 'vue';
import { Application, Graphics, Container } from 'pixi.js';
import { useFps } from '../shared/useFps';

const { fps, frameMs } = useFps();
const canvasEl = ref<HTMLCanvasElement>();
const season = ref<'spring' | 'summer' | 'autumn'>('spring');
const density = ref(60);
const wind = ref(0.4);

interface Mote { spr: Graphics; vx: number; vy: number; spin: number; sway: number; phase: number; }
let app = markRaw({} as Application);
let layer = markRaw({} as Container);
const motes: Mote[] = [];
let sceneW = 0, sceneH = 0;

const PALETTES = {
  spring: [0xf4c2d7, 0xf7d6e4, 0xe89bbd, 0xffffff],   // blossom petals
  summer: [0x8fbf6a, 0xa8d07e, 0x6f9e52],             // green leaf flecks
  autumn: [0xd98841, 0xc25b2a, 0xe0a85a, 0x9c6b2f],   // fall leaves
} as const;

const PETAL_R = 6;

function makeMote(palette: readonly number[], atTop: boolean): Mote {
  const color = palette[Math.floor(Math.random() * palette.length)];
  const g = markRaw(new Graphics());
  // small soft ellipse "petal"
  g.ellipse(0, 0, PETAL_R, PETAL_R * 0.6).fill({ color, alpha: 0.85 });
  g.x = Math.random() * sceneW;
  g.y = atTop ? -10 - Math.random() * 60 : Math.random() * sceneH;
  g.rotation = Math.random() * Math.PI * 2;
  g.scale.set(0.6 + Math.random() * 0.8);
  layer.addChild(g);
  return {
    spr: g,
    vx: (Math.random() - 0.3) * 0.4,
    vy: 0.5 + Math.random() * 0.9,
    spin: (Math.random() - 0.5) * 0.04,
    sway: 0.4 + Math.random() * 0.8,
    phase: Math.random() * Math.PI * 2,
  };
}

function rebuildPool() {
  for (const m of motes) m.spr.destroy();
  motes.length = 0;
  const palette = PALETTES[season.value];
  for (let i = 0; i < density.value; i++) motes.push(makeMote(palette, false));
}

// Faint plant cluster underneath for context.
function drawBackdrop(width: number, height: number) {
  const bg = markRaw(new Graphics());
  bg.rect(0, 0, width, height).fill({ color: 0xf2ede3 });
  app.stage.addChild(bg);
  const g = markRaw(new Graphics());
  const plants = [[width * 0.25, height * 0.5, 50], [width * 0.5, height * 0.62, 64], [width * 0.74, height * 0.46, 44], [width * 0.6, height * 0.32, 36]];
  for (const [x, y, r] of plants) {
    g.circle(x, y, r).fill({ color: 0x6f8f5e, alpha: 0.5 }).stroke({ color: 0x44602f, width: 1.5, alpha: 0.5 });
  }
  app.stage.addChild(g);
}

function tick(ticker: { deltaTime: number; lastTime: number }) {
  const d = ticker.deltaTime;
  const t = ticker.lastTime * 0.001;
  for (const m of motes) {
    m.phase += m.spin;
    m.spr.x += (m.vx + wind.value + Math.sin(t + m.phase) * m.sway * 0.3) * d;
    m.spr.y += m.vy * d;
    m.spr.rotation += m.spin * d;
    if (m.spr.y > sceneH + 20 || m.spr.x > sceneW + 20 || m.spr.x < -20) {
      m.spr.x = Math.random() * sceneW;
      m.spr.y = -10 - Math.random() * 40;
    }
  }
}

watch([season, density], rebuildPool);

onMounted(async () => {
  const canvas = canvasEl.value!;
  sceneW = canvas.clientWidth; sceneH = canvas.clientHeight;
  app = markRaw(new Application());
  await app.init({ canvas, width: sceneW, height: sceneH, antialias: true, background: '#e8e4da', resolution: devicePixelRatio, autoDensity: true });
  drawBackdrop(sceneW, sceneH);
  layer = markRaw(new Container());
  app.stage.addChild(layer);
  rebuildPool();
  app.ticker.add(tick);

  if (import.meta.env.DEV) {
    const { registerPixiBridge } = await import('pixi-bridge');
    registerPixiBridge(app, { tabName: 'ambient-particles', getSnapshot: () => ({ season: season.value, motes: motes.length }) });
  }
});

onUnmounted(() => {
  app?.ticker?.remove(tick);
  window.__pixiTestBridge = undefined;
  window.__pixiTestBridgeReady = false;
  app?.destroy(true, { children: true, texture: true, context: true });
});
</script>

<template>
  <div class="wrap">
    <canvas ref="canvasEl" />
    <div class="hud"><div class="fps">{{ fps }} <span>fps</span></div><div>{{ frameMs }} ms</div></div>
    <div class="controls">
      <label>season
        <select v-model="season"><option value="spring">spring (blossom)</option><option value="summer">summer (leaf)</option><option value="autumn">autumn (fall)</option></select>
      </label>
      <label>density <input type="range" min="10" max="200" step="10" v-model.number="density" /> {{ density }}</label>
      <label>wind <input type="range" min="-0.5" max="1.5" step="0.1" v-model.number="wind" /> {{ wind.toFixed(1) }}</label>
    </div>
    <div class="hint">Hand-rolled drift (not particle-emitter) · presentation-mode atmosphere, not for printed plans</div>
  </div>
</template>

<style scoped>
.wrap { position: relative; width: 100%; height: 100%; background: #e8e4da; }
canvas { display: block; width: 100%; height: 100%; }
.hud { position: absolute; top: 10px; left: 10px; font-family: monospace; font-size: 12px; color: #777; line-height: 1.6; pointer-events: none; }
.fps { font-size: 18px; font-weight: bold; } .fps span { font-size: 12px; }
.controls { position: absolute; top: 10px; left: 50%; transform: translateX(-50%); display: flex; gap: 14px; font-family: monospace; font-size: 12px; color: #555; background: rgba(255,255,255,0.82); padding: 6px 14px; border-radius: 5px; border: 1px solid #d8d0c2; }
.controls label { display: flex; align-items: center; gap: 6px; }
.controls select { font-family: monospace; }
.hint { position: absolute; bottom: 10px; left: 50%; transform: translateX(-50%); font-family: monospace; font-size: 11px; color: #999; background: rgba(255,255,255,0.6); padding: 5px 12px; border-radius: 4px; white-space: nowrap; pointer-events: none; }
</style>
