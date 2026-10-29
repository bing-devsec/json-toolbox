<template>
    <aside v-if="visible" ref="card" class="review-invitation" :aria-labelledby="`${id}-title`" :aria-describedby="`${id}-description`" :aria-busy="busy">
        <button type="button" class="review-close" :aria-label="txt.close" :title="txt.close" :disabled="busy" @click="choose('later')">
            <svg viewBox="0 0 20 20" aria-hidden="true"><path d="m5 5 10 10M15 5 5 15" /></svg>
        </button>
        <div class="review-heading">
            <svg class="review-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 4h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9l-5 3v-3H3V6a2 2 0 0 1 2-2Z" /><path d="M7 9h10M7 13h7" /></svg>
            <h2 :id="`${id}-title`">{{ txt.title }}</h2>
        </div>
        <p :id="`${id}-description`" role="status">{{ txt.description }}</p>
        <div class="review-actions">
            <button type="button" class="review-primary" :disabled="busy" @click="choose('rate')">{{ txt.rate }}</button>
            <button type="button" :disabled="busy" @click="choose('later')">{{ txt.later }}</button>
            <button type="button" class="review-never" :disabled="busy" @click="choose('never')">{{ txt.never }}</button>
        </div>
        <p v-if="error" class="review-error" role="alert">{{ txt.error }}</p>
    </aside>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, useId, watch } from 'vue';
import { createReviewClient, type ReviewChoice, type ReviewUsageSignal } from '../extension/reviewClient';
import { createReviewInvitationScheduler, type ReviewEnvironment } from '../extension/reviewInvitationScheduler';

const props = withDefaults(defineProps<{ locale?: 'zh' | 'en'; usage?: ReviewUsageSignal | null; blocked?: boolean }>(), { locale: 'zh', usage: null, blocked: false });
const id = useId();
const card = ref<HTMLElement>();
const visible = ref(false);
const busy = ref(false);
const error = ref(false);
const client = createReviewClient();
const lifetime = new AbortController();
let alive = true;
let composing = false;
let observer: MutationObserver | undefined;
let refreshFrame: number | undefined;
const txt = computed(() => props.locale === 'en' ? {
    title: 'Would you share your experience?',
    description: 'Leave a review on the Chrome Web Store to help us understand your experience with JSON Toolbox.',
    rate: 'Leave a review', later: 'Maybe later', never: 'Don’t ask again', close: 'Close; maybe later',
    error: 'Your choice could not be saved. Please try again.',
} : {
    title: '愿意分享你的使用体验吗？',
    description: '欢迎到 Chrome 应用商店留下评价，帮助我们了解你使用 JSON 工具箱的感受。',
    rate: '去评价', later: '稍后再说', never: '不再提示', close: '关闭，稍后再说',
    error: '未能保存你的选择，请重试。',
});
const showing = (element: Element): boolean => {
    if (!(element instanceof HTMLElement) || element.hidden || element.getAttribute('aria-hidden') === 'true' || element.hasAttribute('inert')) return false;
    const style = window.getComputedStyle(element);
    return style.visibility !== 'hidden' && style.display !== 'none' && element.getClientRects().length > 0;
};
const environment = (): ReviewEnvironment => ({
    visible: document.visibilityState === 'visible', focused: document.hasFocus(),
    blocked: props.blocked || composing || Array.from(document.querySelectorAll(
        '.first-use-guide, .el-overlay, [aria-modal="true"], dialog[open], .floating-actions.is-open, .floating-actions.is-dragging, .monaco-editor .find-widget.visible, .monaco-editor .suggest-widget.visible, .context-view, .el-dropdown__popper',
    )).some(showing),
});
const setVisible = (token: string | null) => {
    if (!alive) return;
    if (!token && document.activeElement instanceof HTMLElement && card.value?.contains(document.activeElement)) document.activeElement.blur();
    visible.value = Boolean(token);
    if (token) error.value = false;
};
const scheduler = createReviewInvitationScheduler({ client, environment, onVisible: setVisible });
const choose = async (choice: ReviewChoice) => {
    if (busy.value || !visible.value) return;
    busy.value = true; error.value = false;
    try { await scheduler.decide(choice); }
    catch { if (alive) error.value = true; }
    finally { if (alive) busy.value = false; }
};
const activity = () => scheduler.activity();
const keydown = (event: KeyboardEvent) => {
    if (event.key === 'Escape' && visible.value && !busy.value) void choose('later');
    activity();
};
const compositionStart = () => { composing = true; activity(); scheduler.refresh(); };
const compositionEnd = () => { composing = false; activity(); scheduler.refresh(); };
const refresh = () => scheduler.refresh();
const blockerObserverOptions: MutationObserverInit = { subtree: true, attributes: true, childList: true, attributeFilter: ['class', 'style', 'hidden', 'aria-hidden', 'aria-modal', 'open'] };
watch(visible, value => {
    observer?.disconnect();
    if (value) observer?.observe(document.body, blockerObserverOptions);
});
const observeBlockers = () => {
    if (refreshFrame !== undefined || !visible.value) return;
    refreshFrame = requestAnimationFrame(() => { refreshFrame = undefined; if (alive && visible.value) scheduler.refresh(); });
};
watch(() => props.usage, usage => { if (usage && client.available) void scheduler.recordUse(usage); }, { immediate: true });
watch(() => props.blocked, refresh, { flush: 'sync' });
onMounted(() => {
    if (!client.available) return;
    void client.initialize({ signal: lifetime.signal }).catch(() => {});
    document.addEventListener('pointerdown', activity, true);
    document.addEventListener('input', activity, true);
    document.addEventListener('wheel', activity, { passive: true, capture: true });
    document.addEventListener('keydown', keydown, true);
    document.addEventListener('compositionstart', compositionStart, true);
    document.addEventListener('compositionend', compositionEnd, true);
    document.addEventListener('visibilitychange', refresh);
    window.addEventListener('focus', refresh);
    window.addEventListener('blur', refresh);
    // While shown, a newly opened modal must hide the card even if it has no Vue prop.
    observer = new MutationObserver(observeBlockers);
    if (visible.value) observer.observe(document.body, blockerObserverOptions);
});
onBeforeUnmount(() => {
    alive = false; lifetime.abort(); scheduler.dispose(); observer?.disconnect();
    if (refreshFrame !== undefined) cancelAnimationFrame(refreshFrame);
    document.removeEventListener('pointerdown', activity, true);
    document.removeEventListener('input', activity, true);
    document.removeEventListener('wheel', activity, true);
    document.removeEventListener('keydown', keydown, true);
    document.removeEventListener('compositionstart', compositionStart, true);
    document.removeEventListener('compositionend', compositionEnd, true);
    document.removeEventListener('visibilitychange', refresh);
    window.removeEventListener('focus', refresh);
    window.removeEventListener('blur', refresh);
});
</script>

<style scoped>
.review-invitation { position: fixed; right: 16px; bottom: 44px; z-index: 1800; width: min(370px, calc(100vw - 32px)); box-sizing: border-box; padding: 18px; border: 1px solid var(--el-border-color, #dcdfe6); border-radius: 5px; background: var(--el-bg-color, #fff); color: var(--el-text-color-primary, #303133); box-shadow: 0 5px 22px rgb(0 0 0 / 13%); font-size: 13px; line-height: 1.6; }
.review-heading { display: flex; align-items: center; gap: 9px; padding-right: 20px; }
.review-heading h2 { font-size: 14px; line-height: 1.5; margin: 0; font-weight: 600; }
.review-icon { flex: 0 0 21px; width: 21px; height: 21px; fill: none; stroke: var(--el-color-primary, #409eff); stroke-width: 1.6; stroke-linecap: round; stroke-linejoin: round; }
.review-invitation p { margin: 11px 0 15px; color: var(--el-text-color-regular, #606266); }
.review-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.review-invitation button { font: inherit; cursor: pointer; border: 1px solid var(--el-border-color, #dcdfe6); border-radius: 4px; background: var(--el-bg-color, #fff); color: var(--el-text-color-regular, #606266); padding: 5px 10px; }
.review-invitation button:hover { color: var(--el-color-primary, #409eff); border-color: var(--el-color-primary, #409eff); }
.review-invitation button:focus-visible { outline: 2px solid var(--el-color-primary, #409eff); outline-offset: 2px; }
.review-invitation button:disabled { cursor: default; opacity: .6; }
.review-invitation .review-primary { background: var(--el-color-primary, #409eff); border-color: var(--el-color-primary, #409eff); color: #fff; }
.review-invitation .review-never { margin-left: auto; border-color: transparent; padding-right: 0; }
.review-invitation .review-close { position: absolute; top: 10px; right: 10px; display: grid; place-items: center; border: 0; padding: 3px; background: transparent; }
.review-close svg { width: 17px; height: 17px; fill: none; stroke: currentColor; stroke-width: 1.6; stroke-linecap: round; }
.review-invitation p.review-error { margin: 10px 0 0; color: var(--el-color-danger, #f56c6c); font-size: 12px; }
@media (max-height: 400px) { .review-invitation { bottom: 12px; padding: 12px; } }
</style>
