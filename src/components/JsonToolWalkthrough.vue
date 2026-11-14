<template>
    <!-- Visual cues live outside modal focus traps; controls remain in the real dialog footer. -->
    <Teleport v-if="active" :to="overlayTarget">
        <div class="walkthrough-visuals" aria-hidden="true">
            <svg v-if="geometry && visibleRect" class="walkthrough-arrow-layer" :viewBox="`0 0 ${viewport.width} ${viewport.height}`">
                <defs>
                    <mask :id="maskId"><rect width="100%" height="100%" fill="white" /><rect v-if="controlRect" :x="controlRect.x - 6" :y="controlRect.y - 6" :width="controlRect.width + 12" :height="controlRect.height + 12" rx="3" fill="black" /><rect :x="visibleRect.x - 5" :y="visibleRect.y - 5" :width="visibleRect.width + 10" :height="visibleRect.height + 10" rx="4" fill="black" /></mask>
                    <marker :id="markerId" markerUnits="userSpaceOnUse" viewBox="0 0 12 12" markerWidth="12" markerHeight="12" refX="10" refY="6" orient="auto"><path d="M3 1 L10 6 L3 11" fill="none" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" /></marker>
                </defs>
                <rect width="100%" height="100%" fill="rgba(9, 16, 28, .62)" :mask="`url(#${maskId})`" />
                <path :d="arrowPath" fill="none" stroke="white" stroke-width="2" stroke-linecap="round" :marker-end="`url(#${markerId})`" />
            </svg>
            <div v-if="geometry" ref="note" class="walkthrough-annotation" :style="{ left: geometry.note.x + 'px', top: geometry.note.y + 'px', width: geometry.note.width + 'px' }">
                <strong>{{ topic.title }}</strong><p>{{ explanation }}</p>
            </div>
            <div v-if="pointer?.visible" class="walkthrough-demo-pointer" :class="{ 'is-pressing': pointer.pressing }" :style="{ transform: `translate(${pointer.x}px, ${pointer.y}px)` }">
                <span class="walkthrough-click-ring" />
                <svg class="walkthrough-pointer-icon" width="24" height="30" viewBox="0 0 24 30"><path d="M2 2 V23 L7.8 17.8 L12.2 28 L16 26.3 L11.6 16.2 H21 Z" fill="white" stroke="#17202e" stroke-width="1.5" stroke-linejoin="round" /></svg>
                <span class="walkthrough-pointer-label">{{ en ? 'Demo' : '演示' }}</span>
            </div>
        </div>
    </Teleport>
    <Teleport :to="overlayTarget" :disabled="embedded">
        <div v-if="active" ref="controls" class="walkthrough-controls" :class="{ 'is-embedded': embedded }" role="group" :aria-label="copy.guide" :aria-describedby="descriptionId" :aria-busy="busy" :data-walkthrough-topic="topic.id" data-testid="json-tool-walkthrough">
            <span :id="descriptionId" class="walkthrough-sr-only" role="status">{{ topic.title }}。{{ explanation }}</span>
            <span class="walkthrough-counter">{{ step + 1 }} / {{ topics.length }}</span>
            <div class="walkthrough-dots">
                <button v-for="(item, index) in topics" :key="item.id" type="button" :class="{ 'is-current': index === step }" :aria-label="item.title" :aria-current="index === step ? 'step' : undefined" :disabled="busy" :data-guide-step="item.id" @click="emit('select', index)" />
            </div>
            <button v-if="step > 0" type="button" class="walkthrough-text-button" :disabled="busy" @click="emit('back')">{{ copy.back }}</button>
            <button v-if="topic.action !== 'settings' && !awaitingContinue" type="button" class="walkthrough-play" :disabled="busy" data-testid="walkthrough-action" @click="emit('action')">{{ busy ? copy.playing : done ? copy.replay : topic.actionLabel }}</button>
            <button v-if="!isLastStep || !busy" type="button" class="walkthrough-next" :disabled="busy" data-testid="walkthrough-next" @click="awaitingContinue ? emit('action') : emit('next')">{{ awaitingContinue ? (busy ? copy.playing : copy.continue) : isLastStep ? copy.finish : copy.next }}</button>
            <button v-if="!isLastStep || busy" type="button" class="walkthrough-text-button walkthrough-exit" :aria-label="copy.close" @click="emit('close')">{{ copy.exit }}</button>
            <span v-if="error" class="walkthrough-error" role="alert">{{ error }}</span>
        </div>
    </Teleport>
</template>
<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useId, watch } from 'vue';
import { getWalkthroughTopics } from './utils/jsonToolWalkthroughContent';
import { calculateWalkthroughGeometry, type WalkthroughGeometry } from './utils/walkthroughGeometry';
import type { DemoPointer } from './utils/walkthroughPlayback';
const props = withDefaults(defineProps<{ locale?: 'zh' | 'en'; active: boolean; step: number; busy: boolean; done: boolean; error?: string; target?: HTMLElement | null; embedded?: boolean; extension?: boolean; pointer?: DemoPointer; caption?: string; awaitingContinue?: boolean }>(), { locale: 'zh', error: '', target: null, embedded: false, extension: false, caption: '' });
const emit = defineEmits<{ action: []; select: [index: number]; next: []; back: []; close: [] }>();
const overlayTarget = 'body';
const en = computed(() => props.locale === 'en');
const topics = computed(() => getWalkthroughTopics(props.locale, props.extension));
const topic = computed(() => topics.value[Math.min(props.step, topics.value.length - 1)]!);
const isLastStep = computed(() => props.step === topics.value.length - 1);
const explanation = computed(() => props.caption || (props.done && topic.value.success ? topic.value.success : topic.value.description));
const copy = computed(() => en.value ? { guide: 'Quick tour', back: 'Back', next: 'Next', finish: 'Finish', exit: 'Exit', close: 'Exit guide', replay: 'Replay', playing: 'Playing…', continue: 'Continue: fold and transfer' } : { guide: '快速引导', back: '上一步', next: '下一步', finish: '完成', exit: '退出', close: '退出引导', replay: '再看一次', playing: '正在演示…', continue: '继续：折叠与转移' });
const maskId = useId().replace(/:/g, '') + '-spotlight';
const markerId = useId().replace(/:/g, '') + '-arrow';
const descriptionId = useId();
const note = ref<HTMLElement | null>(null);
const controls = ref<HTMLElement | null>(null);
const controlRect = ref<{ x: number; y: number; width: number; height: number } | null>(null);
const viewport = ref({ width: 1440, height: 960 });
const visibleRect = ref<{ x: number; y: number; width: number; height: number } | null>(null);
const geometry = ref<WalkthroughGeometry | null>(null);
const arrowPath = computed(() => { const a = geometry.value?.arrow; return a ? `M${a.start.x},${a.start.y} Q${a.control.x},${a.control.y} ${a.end.x},${a.end.y}` : ''; });
let disposed = false;
let observer: ResizeObserver | undefined;
let frame: number | undefined;
const measure = () => {
    frame = undefined;
    viewport.value = { width: document.documentElement.clientWidth, height: window.innerHeight };
    const toolbar = controls.value?.getBoundingClientRect();
    controlRect.value = toolbar ? { x: toolbar.x, y: toolbar.y, width: toolbar.width, height: toolbar.height } : null;
    const target = props.target;
    if (!props.active || !target?.isConnected) { geometry.value = null; visibleRect.value = null; return; }
    const bounds = target.getBoundingClientRect();
    let left = Math.max(0, bounds.left), top = Math.max(0, bounds.top), right = Math.min(viewport.value.width, bounds.right), bottom = Math.min(viewport.value.height - 80, bounds.bottom);
    for (let parent = target.parentElement; parent; parent = parent.parentElement) {
        const style = getComputedStyle(parent), rect = parent.getBoundingClientRect();
        if (/^(auto|scroll|hidden|clip)$/.test(style.overflowX)) { left = Math.max(left, rect.left + parent.clientLeft); right = Math.min(right, rect.left + parent.clientLeft + parent.clientWidth); }
        if (/^(auto|scroll|hidden|clip)$/.test(style.overflowY)) { top = Math.max(top, rect.top + parent.clientTop); bottom = Math.min(bottom, rect.top + parent.clientTop + parent.clientHeight); }
    }
    if (right <= left || bottom <= top) { geometry.value = null; visibleRect.value = null; return; }
    visibleRect.value = { x: left, y: top, width: right - left, height: bottom - top };
    geometry.value = calculateWalkthroughGeometry({ target: visibleRect.value, viewport: viewport.value, note: { width: 270, height: note.value?.offsetHeight || 116 } });
};
const schedule = () => { if (disposed) return; if (frame === undefined) frame = requestAnimationFrame(measure); };
const track = async () => {
    observer?.disconnect();
    await nextTick();
    if (disposed || !props.active) return;
    if (props.target) observer?.observe(props.target);
    if (note.value) observer?.observe(note.value);
    if (controls.value) observer?.observe(controls.value);
    schedule();
};
const escape = (event: KeyboardEvent) => {
    if (!props.active || !event.isTrusted || event.key !== 'Escape') return;
    event.preventDefault(); event.stopImmediatePropagation(); emit('close');
};
onMounted(() => {
    observer = new ResizeObserver(schedule);
    window.addEventListener('resize', schedule, { passive: true });
    window.addEventListener('scroll', schedule, { capture: true, passive: true });
    window.addEventListener('keydown', escape, true);
    window.addEventListener('transitionend', schedule, true);
    window.addEventListener('animationend', schedule, true);
    void track();
});
watch(() => [props.active, props.target, props.step, props.caption, props.done], track, { flush: 'post' });
watch([note, controls], elements => { for (const element of elements) if (element) observer?.observe(element); schedule(); }, { flush: 'post' });
onBeforeUnmount(() => {
    disposed = true;
    observer?.disconnect(); if (frame !== undefined) cancelAnimationFrame(frame);
    window.removeEventListener('resize', schedule); window.removeEventListener('scroll', schedule, true); window.removeEventListener('keydown', escape, true);
    window.removeEventListener('transitionend', schedule, true);
    window.removeEventListener('animationend', schedule, true);
});
</script>
<style scoped>
.walkthrough-visuals { position: fixed; inset: 0; z-index: 4500; pointer-events: none; }
.walkthrough-arrow-layer { position: absolute; inset: 0; width: 100%; height: 100%; overflow: visible; }
.walkthrough-arrow-layer > path { filter: drop-shadow(0 1px 2px rgb(0 0 0 / 30%)); }
.walkthrough-annotation { position: absolute; color: #fff; text-align: left; font-family: var(--json-tool-font-ui, system-ui, sans-serif); text-shadow: 0 1px 4px rgb(0 0 0 / 65%); }
.walkthrough-annotation strong { font-size: 19px; line-height: 1.5; font-weight: 650; }
.walkthrough-annotation p { margin: 8px 0 0; font-size: 14px; line-height: 1.8; overflow-wrap: anywhere; }
.walkthrough-controls { position: fixed; z-index: 4600; left: 50%; bottom: 22px; transform: translateX(-50%); display: flex; align-items: center; justify-content: center; flex-wrap: wrap; gap: 12px; width: max-content; max-width: calc(100vw - 32px); padding: 10px 16px; box-sizing: border-box; border: 1px solid var(--json-tool-border, var(--el-border-color)); background: var(--glass-popover, var(--json-tool-surface-raised, var(--el-bg-color-overlay))); color: var(--json-tool-text, var(--el-text-color-primary)); box-shadow: 0 4px 20px rgb(0 0 0 / 12%); font: 13px/1.5 var(--json-tool-font-ui, system-ui, sans-serif); }
.walkthrough-controls.is-embedded { position: relative; inset: auto; transform: none; z-index: auto; width: 100%; max-width: none; padding: 0; border: 0; background: transparent; box-shadow: none; }
.walkthrough-counter { white-space: nowrap; font-variant-numeric: tabular-nums; }
.walkthrough-dots { display: flex; align-items: center; gap: 3px; }
.walkthrough-dots button { width: 18px; height: 26px; padding: 6px; border: 0; background: none; cursor: pointer; }
.walkthrough-dots button::after { content: ''; display: block; width: 6px; height: 6px; border: 1px solid currentColor; border-radius: 50%; box-sizing: border-box; }
.walkthrough-dots button.is-current::after { background: currentColor; transform: scale(1.35); }
.walkthrough-controls button { color: inherit; font: inherit; }
.walkthrough-text-button { padding: 6px 2px; border: 0; background: transparent; cursor: pointer; white-space: nowrap; }
.walkthrough-play, .walkthrough-next { padding: 6px 12px; border: 1px solid var(--json-tool-border-strong, var(--el-border-color)); border-radius: 3px; background: var(--json-tool-surface, var(--el-fill-color-blank)); cursor: pointer; white-space: nowrap; }
.walkthrough-play { font-weight: 600; border-color: currentColor; }
.walkthrough-controls button:disabled { opacity: .55; cursor: default; }
.walkthrough-controls button:focus-visible { outline: 2px solid currentColor; outline-offset: 2px; }
.walkthrough-exit { margin-left: 4px; }
.walkthrough-error { flex-basis: 100%; text-align: center; color: var(--json-tool-text, var(--el-text-color-primary)); }
.walkthrough-sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0,0,0,0); white-space: nowrap; border: 0; }
.walkthrough-demo-pointer { position: absolute; top: 0; left: 0; width: 24px; height: 30px; line-height: 0; transition: transform 500ms cubic-bezier(.2,.65,.3,1); }
/* The SVG tip at (2, 2) and the click ring share the playback hotspot. */
.walkthrough-pointer-icon { position: absolute; display: block; left: -2px; top: -2px; overflow: visible; filter: drop-shadow(0 1px 2px rgb(0 0 0 / 20%)); }
.walkthrough-pointer-label { position: absolute; top: 27px; left: 18px; color: #fff; background: #17202e; padding: 1px 5px; font: 11px/1.5 system-ui,sans-serif; white-space: nowrap; border-radius: 2px; }
.walkthrough-click-ring { position: absolute; left: -10px; top: -10px; width: 20px; height: 20px; box-sizing: border-box; border: 1.5px solid white; border-radius: 50%; opacity: 0; transform: scale(.4); transition: opacity 120ms, transform 250ms; }
.walkthrough-demo-pointer.is-pressing .walkthrough-click-ring { opacity: .7; transform: scale(1.25); }
@media(prefers-reduced-motion: reduce) { .walkthrough-demo-pointer, .walkthrough-click-ring { transition: none; } }
</style>
