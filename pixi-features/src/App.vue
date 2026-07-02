<script setup lang="ts">
import { ref, computed, defineAsyncComponent } from 'vue';
import TodoPanel from './components/TodoPanel.vue';

interface TabDef { id: string; label: string; comp: ReturnType<typeof defineAsyncComponent> }
interface Group { label: string; tabs: TabDef[] }

const A = (path: string) => defineAsyncComponent(() => import(path))

const groups: Group[] = [
  {
    label: 'Rendering',
    tabs: [
      { id: 'renderer',    label: 'Plant Renderer',    comp: A('./tabs/TabPlantRenderer.vue') },
      { id: 'leader',      label: 'Leader Line',       comp: A('./tabs/TabLeaderLine.vue') },
      { id: 'msdf',        label: 'MSDF Text',         comp: A('./tabs/TabMsdfText.vue') },
      { id: 'bitmap',      label: 'BitmapText',        comp: A('./tabs/TabBitmapText.vue') },
      { id: 'npr',         label: 'NPR Renderer',      comp: A('./tabs/TabNPRRenderer.vue') },
      { id: 'style-play',  label: 'Plant Style Playground', comp: A('./tabs/TabPlantStylePlayground.vue') },
      { id: 'tree',        label: 'Tree Symbol',       comp: A('./tabs/TabTreeSymbol.vue') },
      { id: 'wind',        label: 'Wind Sway',         comp: A('./tabs/TabWindSway.vue') },
      { id: 'kuwahara',    label: 'Kuwahara Filter',   comp: A('./tabs/TabKuwahara.vue') },
      { id: 'footer-msdf', label: 'Footer MSDF',       comp: A('./tabs/TabFooterMsdf.vue') },
      { id: 'svg-render',  label: 'SVG Render Test',   comp: A('./tabs/TabSvgRender.vue') },
    ],
  },
  {
    label: 'Aliveness / Polish',
    tabs: [
      { id: 'water',       label: 'Water Feature',     comp: A('./tabs/TabWaterFeature.vue') },
      { id: 'shadows',     label: 'Soft Shadows',      comp: A('./tabs/TabSoftShadows.vue') },
      { id: 'particles',   label: 'Ambient Particles', comp: A('./tabs/TabAmbientParticles.vue') },
      { id: 'dappled',     label: 'Dappled Light',     comp: A('./tabs/TabDappledLight.vue') },
      { id: 'botanical',   label: 'Botanical Illustration', comp: A('./tabs/TabBotanicalIllustration.vue') },
      { id: 'botvariants', label: 'Botanical Variants', comp: A('./tabs/TabBotanicalVariants.vue') },
    ],
  },
  {
    label: 'Drawing Tools',
    tabs: [
      { id: 'pen',         label: 'Pen Tool',          comp: A('./tabs/TabPenTool.vue') },
      { id: 'sketch',      label: 'Sketch Style (rough.js)', comp: A('./tabs/TabSketchStyle.vue') },
      { id: 'freehand',    label: 'Freehand',          comp: A('./tabs/TabFreehand.vue') },
      { id: 'knife',       label: 'Knife Tool',        comp: A('./tabs/TabKnife.vue') },
      { id: 'bool',        label: 'Boolean Ops',       comp: A('./tabs/TabBooleanOps.vue') },
      { id: 'dash',        label: 'Dashed Lines',      comp: A('./tabs/TabDashedLines.vue') },
    ],
  },
  {
    label: 'Interaction',
    tabs: [
      { id: 'measure',     label: 'Measure',           comp: A('./tabs/TabMeasure.vue') },
      { id: 'sel',         label: 'Selection',         comp: A('./tabs/TabSelection.vue') },
      { id: 'snap',        label: 'Snapping',          comp: A('./tabs/TabSnapping.vue') },
      { id: 'transform',   label: 'Transform Gizmo',   comp: A('./tabs/TabTransformGizmo.vue') },
      { id: 'spatial',     label: 'Spatial Index',     comp: A('./tabs/TabSpatialIndex.vue') },
      { id: 'ants',         label: 'Ants · Phase Math',  comp: A('./tabs/TabMarchingAnts.vue') },
      { id: 'ants-tiling', label: 'Ants · TilingSprite', comp: A('./tabs/TabMarchingAntsTiling.vue') },
      { id: 'ants-davidfig', label: 'Ants · Davidfig',  comp: A('./tabs/TabMarchingAntsDavidfig.vue') },
      { id: 'selection-fx',     label: 'Selection FX',     comp: A('./tabs/TabSelectionFX.vue') },
      { id: 'selection-fx2',    label: 'Selection FX 2',   comp: A('./tabs/TabSelectionFX2.vue') },
      { id: 'selection-jfa',    label: 'Selection · JFA',  comp: A('./tabs/TabSelectionJFA.vue') },
      { id: 'selection-precise', label: 'Selection · Precise', comp: A('./tabs/TabSelectionPrecise.vue') },
      { id: 'selection-design', label: 'Selection Design', comp: A('./tabs/TabSelectionDesign.vue') },
    ],
  },
  {
    label: 'Text & UI',
    tabs: [
      { id: 'textann',     label: 'Text Annotation',   comp: A('./tabs/TabTextAnnotation.vue') },
      { id: 'pixiui',      label: '@pixi/ui',          comp: A('./tabs/TabPixiUI.vue') },
    ],
  },
  {
    label: 'Viewport',
    tabs: [
      { id: 'viewport',    label: 'Viewport',          comp: A('./tabs/TabViewport.vue') },
    ],
  },
]

const allTabs = groups.flatMap(g => g.tabs)

// v2 key forces a fresh start, clearing any crashed 'viewport' state from the old key
const STORAGE_KEY = 'pixi-features-active-v2'
const storedTab = localStorage.getItem(STORAGE_KEY)
const active = ref(storedTab ?? 'renderer')
const panelOpen = ref(true)
const todoOpen  = ref(false)

const activeComp = computed(() => (allTabs.find(t => t.id === active.value) ?? allTabs[0]).comp)
const activeLabel = computed(() => (allTabs.find(t => t.id === active.value) ?? allTabs[0]).label)

function select(id: string) {
  console.log('[App.vue] select() called with tab id:', id);
  console.log('[App.vue] current active tab before:', active.value);
  active.value = id
  console.log('[App.vue] set active tab to:', active.value);
  localStorage.setItem(STORAGE_KEY, id)
  console.log('[App.vue] saved to localStorage');
}
</script>

<template>
  <div class="shell">
    <button class="toggle-btn" @click="panelOpen = !panelOpen" :title="panelOpen ? 'Hide panel' : 'Show panel'">
      {{ panelOpen ? '◀' : '▶' }}
    </button>
    <button class="todo-toggle-btn" @click="todoOpen = !todoOpen" :class="{ active: todoOpen }" title="Toggle todo">
      ☑
    </button>

    <aside class="panel" :class="{ closed: !panelOpen }">
      <div class="panel-header">Pixi.js v8 · Flora</div>
      <nav class="panel-nav">
        <div v-for="group in groups" :key="group.label" class="group">
          <div class="group-label">{{ group.label }}</div>
          <button
            v-for="t in group.tabs" :key="t.id"
            :class="{ active: active === t.id }"
            @click="select(t.id)"
          >{{ t.label }}</button>
        </div>
      </nav>
    </aside>

    <div class="canvas-area">
      <div class="tab-title">{{ activeLabel }}</div>
      <component :is="activeComp" />
    </div>

    <!-- Todo panel — slides in from the right -->
    <aside class="todo-aside" :class="{ open: todoOpen }">
      <TodoPanel @navigate="(id) => { console.log('[App.vue] @navigate event received with id:', id); select(id); }" />
    </aside>
  </div>
</template>

<style scoped>
.shell {
  display: flex;
  width: 100%;
  height: 100%;
  font-family: monospace;
  overflow: hidden;
  background: #111;
}

.toggle-btn {
  position: fixed;
  top: 8px;
  left: 8px;
  z-index: 100;
  width: 24px;
  height: 24px;
  background: #2a2a2a;
  border: 1px solid #444;
  color: #aaa;
  border-radius: 3px;
  cursor: pointer;
  font-size: 10px;
  line-height: 1;
  padding: 0;
}

.panel {
  width: 180px;
  min-width: 180px;
  background: #161616;
  border-right: 1px solid #2a2a2a;
  display: flex;
  flex-direction: column;
  overflow-y: auto;
  transition: width 0.15s, min-width 0.15s, opacity 0.15s;
  padding-top: 36px;
}
.panel.closed {
  width: 0;
  min-width: 0;
  opacity: 0;
  overflow: hidden;
}

.panel-header {
  font-size: 10px;
  color: #555;
  padding: 0 10px 8px;
  border-bottom: 1px solid #222;
  margin-bottom: 6px;
}

.panel-nav { padding: 4px 6px; }

.group { margin-bottom: 12px; }
.group-label {
  font-size: 9px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: #444;
  padding: 2px 4px 4px;
}

.panel-nav button {
  display: block;
  width: 100%;
  text-align: left;
  padding: 4px 8px;
  background: transparent;
  border: none;
  border-radius: 3px;
  color: #666;
  cursor: pointer;
  font-family: monospace;
  font-size: 11px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.panel-nav button:hover { background: #222; color: #aaa; }
.panel-nav button.active { background: #0070e0; color: #fff; }

.canvas-area {
  flex: 1;
  overflow: hidden;
  position: relative;
  display: flex;
  flex-direction: column;
}

.tab-title {
  font-size: 11px;
  color: #333;
  padding: 4px 10px;
  background: #131313;
  border-bottom: 1px solid #1e1e1e;
  flex-shrink: 0;
}

.todo-toggle-btn {
  position: fixed;
  top: 8px;
  right: 8px;
  z-index: 100;
  width: 24px;
  height: 24px;
  background: #2a2a2a;
  border: 1px solid #444;
  color: #666;
  border-radius: 3px;
  cursor: pointer;
  font-size: 13px;
  line-height: 1;
  padding: 0;
}
.todo-toggle-btn:hover { color: #aaa; }
.todo-toggle-btn.active { color: #0070e0; border-color: #0070e0; }

.todo-aside {
  width: 0;
  min-width: 0;
  overflow: hidden;
  opacity: 0;
  transition: width 0.15s, min-width 0.15s, opacity 0.15s;
  flex-shrink: 0;
}
.todo-aside.open {
  width: 380px;
  min-width: 380px;
  opacity: 1;
}

.canvas-area > :not(.tab-title) {
  flex: 1;
  overflow: hidden;
}
</style>
