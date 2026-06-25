<script setup lang="ts">
/**
 * Dappled light spike — GodrayFilter light shafts for sun-and-shade mood over a plan.
 * Atmospheric / presentation-mode (motion vanishes in print). Filter needs per-frame
 * `time`. Could later key `gain`/`angle` to a plant's actual shade tolerance.
 */
import { ref, watch, onMounted, onUnmounted, markRaw } from 'vue';
import { Application, Graphics, Container } from 'pixi.js';
import { GodrayFilter } from 'pixi-filters';
import { useFps } from '../shared/useFps';

const { fps, frameMs } = useFps();
const canvasEl = ref<HTMLCanvasElement>();
const angle = ref(30);
const gain = ref(0.5);
const density = ref(2.5);   // lacunarity
const alpha = ref(0.6);

let app = markRaw({} as Application);
let scene = markRaw({} as Container);
let godray = markRaw({} as GodrayFilter);

function drawScene(width: number, height: number) {
  const bg = markRaw(new Graphics());
  // warm dusk-ish wash so the light shafts read
  bg.rect(0, 0, width, height).fill({ color: 0xe7e0cf });
  scene.addChild(bg);

  // ground/bed shapes
  const beds = markRaw(new Graphics());
  beds.ellipse(width * 0.5, height * 0.78, width * 0.42, height * 0.22).fill({ color: 0x8a9a6b, alpha: 0.5 });
  beds.ellipse(width * 0.3, height * 0.6, width * 0.18, height * 0.1).fill({ color: 0x9aac79, alpha: 0.45 });
  scene.addChild(beds);

  // plant cluster
  const g = markRaw(new Graphics());
  const plants = [[width * 0.32, height * 0.52, 46], [width * 0.5, height * 0.6, 60], [width * 0.68, height * 0.5, 40], [width * 0.58, height * 0.4, 30], [width * 0.42, height * 0.38, 26]];
  for (const [x, y, r] of plants) {
    g.circle(x, y, r).fill({ color: 0x5f7e48, alpha: 0.92 }).stroke({ color: 0x39501f, width: 1.5, alpha: 0.8 });
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      g.beginPath();
      g.moveTo(x, y).lineTo(x + Math.cos(a) * r * 0.75, y + Math.sin(a) * r * 0.75).stroke({ color: 0x39501f, width: 1, alpha: 0.4 });
    }
  }
  scene.addChild(g);
}

function makeGodray(): GodrayFilter {
  return new GodrayFilter({ angle: angle.value, gain: gain.value, lacunarity: density.value, alpha: alpha.value, parallel: true, time: 0 });
}

watch([angle, gain, density, alpha], () => {
  if (!godray.angle && godray.angle !== 0) return;
  godray.angle = angle.value;
  godray.gain = gain.value;
  godray.lacunarity = density.value;
  godray.alpha = alpha.value;
});

function tick(ticker: { deltaMS: number }) {
  godray.time += ticker.deltaMS / 1000;
}

onMounted(async () => {
  const canvas = canvasEl.value!;
  app = markRaw(new Application());
  await app.init({ canvas, width: canvas.clientWidth, height: canvas.clientHeight, antialias: true, background: '#e8e4da', resolution: devicePixelRatio, autoDensity: true });
  scene = markRaw(new Container());
  app.stage.addChild(scene);
  drawScene(canvas.clientWidth, canvas.clientHeight);
  godray = markRaw(makeGodray());
  scene.filters = [godray];
  app.ticker.add(tick);

  if (import.meta.env.DEV) {
    const { registerPixiBridge } = await import('pixi-bridge');
    registerPixiBridge(app, { tabName: 'dappled-light', getSnapshot: () => ({ angle: angle.value, gain: gain.value }) });
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
      <label>angle <input type="range" min="-60" max="60" step="1" v-model.number="angle" /> {{ angle }}</label>
      <label>gain <input type="range" min="0" max="1" step="0.05" v-model.number="gain" /> {{ gain.toFixed(2) }}</label>
      <label>density <input type="range" min="1" max="5" step="0.1" v-model.number="density" /> {{ density.toFixed(1) }}</label>
      <label>alpha <input type="range" min="0" max="1" step="0.05" v-model.number="alpha" /> {{ alpha.toFixed(2) }}</label>
    </div>
    <div class="hint">GodrayFilter light shafts · could later key to a plant's shade tolerance · presentation-mode mood</div>
  </div>
</template>

<style scoped>
.wrap { position: relative; width: 100%; height: 100%; background: #e8e4da; }
canvas { display: block; width: 100%; height: 100%; }
.hud { position: absolute; top: 10px; left: 10px; font-family: monospace; font-size: 12px; color: #777; line-height: 1.6; pointer-events: none; }
.fps { font-size: 18px; font-weight: bold; } .fps span { font-size: 12px; }
.controls { position: absolute; top: 10px; left: 50%; transform: translateX(-50%); display: flex; gap: 14px; font-family: monospace; font-size: 12px; color: #555; background: rgba(255,255,255,0.82); padding: 6px 14px; border-radius: 5px; border: 1px solid #d8d0c2; }
.controls label { display: flex; align-items: center; gap: 6px; }
.hint { position: absolute; bottom: 10px; left: 50%; transform: translateX(-50%); font-family: monospace; font-size: 11px; color: #999; background: rgba(255,255,255,0.6); padding: 5px 12px; border-radius: 4px; white-space: nowrap; pointer-events: none; }
</style>
