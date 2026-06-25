<script setup lang="ts">
/**
 * Soft shadows spike — DropShadowFilter for botanical "paper depth" under plants.
 * Left = flat (no shadow), right = shadowed, same plants. The shadow renders UNDER
 * the symbol; it never alters the artwork. Live offset / blur / alpha controls.
 */
import { ref, watch, onMounted, onUnmounted, markRaw } from 'vue';
import { Application, Graphics, Container, Text, TextStyle } from 'pixi.js';
import { DropShadowFilter } from 'pixi-filters';
import { useFps } from '../shared/useFps';

const { fps, frameMs } = useFps();
const canvasEl = ref<HTMLCanvasElement>();
const blur = ref(4);
const distance = ref(6);
const alpha = ref(0.35);

let app = markRaw({} as Application);
let shadowed = markRaw({} as Container);
let shadow = markRaw({} as DropShadowFilter);

const PAPER = 0xf2ede3;
const SHADOW_ANGLE = Math.PI / 4;   // light from top-left

// Plan-view plant cluster — drawn identically in both panels (stand-in, not real art).
function drawCluster(parent: Container, w: number, h: number) {
  const g = markRaw(new Graphics());
  const plants = [
    [w * 0.30, h * 0.34, 34, 0x6f8f5e], [w * 0.62, h * 0.30, 28, 0x86a06a],
    [w * 0.48, h * 0.56, 40, 0x5c7c4a], [w * 0.74, h * 0.62, 24, 0x9cb87e],
    [w * 0.26, h * 0.66, 30, 0x7c9659], [w * 0.58, h * 0.78, 22, 0x6f8f5e],
  ];
  for (const [x, y, r, color] of plants) {
    g.circle(x, y, r).fill({ color }).stroke({ color: 0x3c5230, width: 1.5, alpha: 0.8 });
    for (let i = 0; i < 7; i++) {
      const a = (i / 7) * Math.PI * 2 + (x % 1);
      g.beginPath();
      g.moveTo(x, y).lineTo(x + Math.cos(a) * r * 0.7, y + Math.sin(a) * r * 0.7).stroke({ color: 0x3c5230, width: 1, alpha: 0.4 });
    }
  }
  parent.addChild(g);
}

function panelLabel(text: string, x: number, y: number) {
  const t = markRaw(new Text({ text, style: new TextStyle({ fontSize: 13, fill: 0x4a5a40, fontFamily: 'monospace', fontWeight: 'bold' }) }));
  t.position.set(x, y);
  app.stage.addChild(t);
}

function buildScene(width: number, height: number) {
  const bg = markRaw(new Graphics());
  bg.rect(0, 0, width, height).fill({ color: PAPER });
  app.stage.addChild(bg);

  const panelW = width / 2;

  // Left — flat
  const flat = markRaw(new Container());
  flat.position.set(0, 30);
  drawCluster(flat, panelW, height - 30);
  app.stage.addChild(flat);
  panelLabel('flat · no shadow', 24, 14);

  // Right — shadowed
  shadowed = markRaw(new Container());
  shadowed.position.set(panelW, 30);
  drawCluster(shadowed, panelW, height - 30);
  shadow = markRaw(makeShadow());
  shadowed.filters = [shadow];
  app.stage.addChild(shadowed);
  panelLabel('soft shadow · paper depth', panelW + 24, 14);

  // Divider
  const div = markRaw(new Graphics());
  div.moveTo(panelW, 0).lineTo(panelW, height).stroke({ color: 0xd0c8ba, width: 1 });
  app.stage.addChild(div);
}

function makeShadow(): DropShadowFilter {
  return new DropShadowFilter({
    offset: { x: Math.cos(SHADOW_ANGLE) * distance.value, y: Math.sin(SHADOW_ANGLE) * distance.value },
    blur: blur.value, alpha: alpha.value, color: 0x2a3520, quality: 4,
  });
}

watch([blur, distance, alpha], () => {
  if (!shadow) return;
  shadow.blur = blur.value;
  shadow.alpha = alpha.value;
  shadow.offset = { x: Math.cos(SHADOW_ANGLE) * distance.value, y: Math.sin(SHADOW_ANGLE) * distance.value } as never;
});

onMounted(async () => {
  const canvas = canvasEl.value!;
  app = markRaw(new Application());
  await app.init({ canvas, width: canvas.clientWidth, height: canvas.clientHeight, antialias: true, background: '#e8e4da', resolution: devicePixelRatio, autoDensity: true });
  buildScene(canvas.clientWidth, canvas.clientHeight);

  if (import.meta.env.DEV) {
    const { registerPixiBridge } = await import('pixi-bridge');
    registerPixiBridge(app, { tabName: 'soft-shadows', getSnapshot: () => ({ blur: blur.value, distance: distance.value, alpha: alpha.value }) });
  }
});

onUnmounted(() => {
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
      <label>distance <input type="range" min="0" max="18" step="1" v-model.number="distance" /> {{ distance }}</label>
      <label>blur <input type="range" min="0" max="12" step="0.5" v-model.number="blur" /> {{ blur }}</label>
      <label>alpha <input type="range" min="0" max="0.7" step="0.05" v-model.number="alpha" /> {{ alpha.toFixed(2) }}</label>
    </div>
    <div class="hint">DropShadowFilter renders under the symbol · same plants left/right · screen-only, would disable for flat print</div>
  </div>
</template>

<style scoped>
.wrap { position: relative; width: 100%; height: 100%; background: #e8e4da; }
canvas { display: block; width: 100%; height: 100%; }
.hud { position: absolute; top: 10px; left: 10px; font-family: monospace; font-size: 12px; color: #777; line-height: 1.6; pointer-events: none; }
.fps { font-size: 18px; font-weight: bold; } .fps span { font-size: 12px; }
.controls { position: absolute; bottom: 40px; left: 50%; transform: translateX(-50%); display: flex; gap: 16px; font-family: monospace; font-size: 12px; color: #555; background: rgba(255,255,255,0.82); padding: 6px 14px; border-radius: 5px; border: 1px solid #d8d0c2; }
.controls label { display: flex; align-items: center; gap: 6px; }
.hint { position: absolute; bottom: 10px; left: 50%; transform: translateX(-50%); font-family: monospace; font-size: 11px; color: #999; background: rgba(255,255,255,0.6); padding: 5px 12px; border-radius: 4px; white-space: nowrap; pointer-events: none; }
</style>
