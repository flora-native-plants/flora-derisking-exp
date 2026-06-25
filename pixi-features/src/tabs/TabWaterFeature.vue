<script setup lang="ts">
/**
 * Water feature spike — ReflectionFilter shimmer on a pond, ShockwaveFilter ripples on click.
 * Tests whether a landscape water feature can read as "alive water" on a paper plan
 * without touching any plant artwork. Filters need per-frame `time` advancement.
 */
import { ref, onMounted, onUnmounted, markRaw } from 'vue';
import { Application, Graphics, Container, Text, TextStyle } from 'pixi.js';
import { ReflectionFilter, ShockwaveFilter } from 'pixi-filters';
import { useFps } from '../shared/useFps';

const { fps, frameMs } = useFps();
const canvasEl = ref<HTMLCanvasElement>();
const amplitude = ref(5);

let app = markRaw({} as Application);
let reflection = markRaw({} as ReflectionFilter);
// Active click ripples: each is a ShockwaveFilter with its own clock; removed when spent.
const ripples: Array<{ filter: ShockwaveFilter; t: number }> = [];
let pond = markRaw({} as Container);

const PAPER = 0xf2ede3;
const WATER_FILL = 0x6fa8b8;
const WATER_DEEP = 0x4d8597;
const RIPPLE_LIFE = 1.4;   // seconds before a ripple is removed

// Simple plan-view shrub for context around the pond (NOT the real plant art).
function drawShrub(g: Graphics, x: number, y: number, r: number) {
  g.circle(x, y, r).fill({ color: 0x6f8f5e, alpha: 0.85 }).stroke({ color: 0x44602f, width: 1.5, alpha: 0.8 });
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    g.beginPath();
    g.moveTo(x, y).lineTo(x + Math.cos(a) * r * 0.8, y + Math.sin(a) * r * 0.8).stroke({ color: 0x44602f, width: 1, alpha: 0.5 });
  }
}

function buildScene(width: number, height: number) {
  const bg = markRaw(new Graphics());
  bg.rect(0, 0, width, height).fill({ color: PAPER });
  app.stage.addChild(bg);

  const cx = width / 2, cy = height / 2;

  // Pond container — the only thing the water filters touch.
  pond = markRaw(new Container());
  app.stage.addChild(pond);

  // Irregular pond outline
  const water = markRaw(new Graphics());
  const pts: number[] = [];
  const N = 40, rx = Math.min(width, height) * 0.30, ry = rx * 0.66;
  for (let i = 0; i < N; i++) {
    const a = (i / N) * Math.PI * 2;
    const wob = 1 + Math.sin(a * 3) * 0.06 + Math.sin(a * 5 + 1) * 0.04;
    pts.push(cx + Math.cos(a) * rx * wob, cy + Math.sin(a) * ry * wob);
  }
  water.poly(pts).fill({ color: WATER_FILL }).stroke({ color: 0x3c6f7e, width: 2.5 });
  pond.addChild(water);

  // Light "reflection" bands so the wave distortion has content to ripple.
  const bands = markRaw(new Graphics());
  for (let i = 0; i < 5; i++) {
    const by = cy - ry * 0.6 + (i / 5) * ry * 1.2;
    bands.roundRect(cx - rx * 0.7, by, rx * 1.4, ry * 0.06, 4).fill({ color: 0xffffff, alpha: 0.18 });
  }
  bands.circle(cx - rx * 0.35, cy - ry * 0.35, ry * 0.18).fill({ color: WATER_DEEP, alpha: 0.3 });
  pond.addChild(bands);

  reflection = markRaw(new ReflectionFilter({ mirror: false, boundary: 0, amplitude: [amplitude.value, amplitude.value * 1.6], waveLength: [22, 42], alpha: [1, 1], time: 0 }));
  pond.filters = [reflection];

  // Click anywhere on the pond → ripple
  pond.eventMode = 'static';
  pond.hitArea = { contains: () => true } as never;
  pond.on('pointertap', (e) => {
    const local = pond.toLocal(e.global);
    const sw = markRaw(new ShockwaveFilter({ center: { x: local.x, y: local.y }, amplitude: 18, wavelength: 90, brightness: 1.05, radius: -1, speed: 320 }));
    ripples.push({ filter: sw, t: 0 });
    pond.filters = [reflection, ...ripples.map((r) => r.filter)];
  });

  // Surrounding shrubs for plan context
  const plants = markRaw(new Graphics());
  const ring = [[cx - rx * 1.25, cy - ry * 0.5], [cx + rx * 1.2, cy - ry * 0.8], [cx + rx * 1.3, cy + ry * 0.6], [cx - rx * 1.15, cy + ry * 0.9], [cx, cy - ry * 1.4]];
  for (const [px, py] of ring) drawShrub(plants, px, py, 26);
  app.stage.addChild(plants);

  const label = markRaw(new Text({ text: 'click the pond to ripple', style: new TextStyle({ fontSize: 11, fill: 0x7a8a90, fontFamily: 'monospace' }) }));
  label.anchor.set(0.5);
  label.position.set(cx, cy + ry * 1.55);
  app.stage.addChild(label);
}

function tick(ticker: { deltaMS: number }) {
  const dt = ticker.deltaMS / 1000;
  reflection.time += dt * 1.2;
  reflection.amplitude = [amplitude.value, amplitude.value * 1.6];
  for (let i = ripples.length - 1; i >= 0; i--) {
    ripples[i].t += dt;
    ripples[i].filter.time = ripples[i].t;
    if (ripples[i].t > RIPPLE_LIFE) ripples.splice(i, 1);
  }
  if (ripples.length === 0 && pond.filters && (pond.filters as unknown[]).length > 1) pond.filters = [reflection];
  else if (ripples.length) pond.filters = [reflection, ...ripples.map((r) => r.filter)];
}

onMounted(async () => {
  const canvas = canvasEl.value!;
  app = markRaw(new Application());
  await app.init({ canvas, width: canvas.clientWidth, height: canvas.clientHeight, antialias: true, background: '#e8e4da', resolution: devicePixelRatio, autoDensity: true });
  buildScene(canvas.clientWidth, canvas.clientHeight);
  app.ticker.add(tick);

  if (import.meta.env.DEV) {
    const { registerPixiBridge } = await import('pixi-bridge');
    registerPixiBridge(app, { tabName: 'water-feature', getSnapshot: () => ({ ripples: ripples.length }) });
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
      <label>wave amplitude <input type="range" min="0" max="14" step="0.5" v-model.number="amplitude" /> {{ amplitude }}px</label>
    </div>
    <div class="hint">ReflectionFilter shimmer + click-to-ripple (ShockwaveFilter) · water polygon only, no plant art touched</div>
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
