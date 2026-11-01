<template>
    <main class="extension-shell" :aria-busy="viewportEligible && (loadStatus === 'loading' || loadStatus === 'slow')">
        <SmallScreenNotice v-if="!viewportEligible" :locale="locale" />
        <div v-if="viewportEligible && captureId && captureNoticeVisible" class="capture-notice" :class="{ 'is-error': captureState.phase === 'error' }" :role="captureState.phase === 'error' ? 'alert' : 'status'">
            <span class="capture-notice-copy">
                <span>{{ captureNotice }}</span>
                <span v-if="captureState.sourceDisplayUrl" class="capture-source" :title="captureState.sourceDisplayUrl">{{ captureState.sourceDisplayUrl }}</span>
            </span>
            <button v-if="captureState.phase === 'error'" type="button" @click="captureSession?.load()">{{ retryLabel }}</button>
            <button v-if="captureState.phase !== 'reading'" type="button" :disabled="returningToSource" @click="viewOriginal">{{ locale === 'en' ? 'Return to response URL' : '返回响应页面' }}</button>
            <button v-if="captureState.phase === 'imported'" type="button" :aria-label="locale === 'en' ? 'Dismiss import notice' : '关闭导入提示'" @click="captureNoticeVisible = false">×</button>
        </div>
        <component v-if="workbench && captureReadSettled" v-show="viewportEligible" :is="workbench" class="extension-workbench" :locale="locale" :external-import="captureState.request"
            @switch-locale="switchLocale" @external-imported="onExternalImported" @external-import-failed="onExternalImportFailed"
            @successful-use="onSuccessfulUse" @review-blocked="workbenchReviewBlocked = $event" />
        <template v-else-if="viewportEligible">
            <JsonToolEditorSkeleton :label="loadingLabel" />
            <div v-if="loadStatus === 'error'" class="extension-load-state is-error" role="alert">
                <p>{{ errorLabel }}</p>
                <button type="button" @click="reloadPage">{{ retryLabel }}</button>
            </div>
        </template>
        <ExtensionReviewInvitation v-if="reviewUsage" :locale="locale" :usage="reviewUsage" :blocked="reviewBlocked" />
    </main>
</template>

<script setup lang="ts">
import { computed, defineAsyncComponent, markRaw, onBeforeUnmount, ref, shallowRef, watch } from 'vue';
import JsonToolEditorSkeleton from './components/JsonToolEditorSkeleton.vue';
import SmallScreenNotice from './components/SmallScreenNotice.vue';
import { observeWorkbenchViewport } from './components/utils/workbenchViewport';
import { createJsonToolLoadController, type JsonToolLoadStatus } from './components/utils/jsonToolLoadController';
import { loadJsonToolWorkbench } from './components/utils/loadJsonToolWorkbench';
import { readImport, ackImport, returnToSource, captureErrorMessage } from './extension/captureClient';
import { createCaptureImportSession, emptyCaptureImportState, type ImportFormatWarning } from './extension/importSession';
import type { ReviewUsageKind, ReviewUsageSignal } from './extension/reviewClient';

const ExtensionReviewInvitation = defineAsyncComponent(() => import('./components/ExtensionReviewInvitation.vue'));

const LOCALE_KEY = 'json-tool-locale';
const readLocale = (): 'zh' | 'en' => {
    try {
        return localStorage.getItem(LOCALE_KEY) === 'en' ? 'en' : 'zh';
    } catch {
        return 'zh';
    }
};
const locale = ref<'zh' | 'en'>(readLocale());
const captureId = new URL(window.location.href).searchParams.get('capture') ?? '';
const captureState = shallowRef(emptyCaptureImportState());
const captureNoticeVisible = ref(true);
const captureReadSettled = ref(!captureId);
const returningToSource = ref(false);
const sourceReturnError = shallowRef<unknown>(null);
const captureSession = captureId ? createCaptureImportSession({
    id: captureId, read: readImport, acknowledge: ackImport,
    onChange: state => {
        captureState.value = state;
        // Once shown, keep the workbench mounted during retries so existing edits survive.
        if (state.phase !== 'reading') captureReadSettled.value = true;
    },
    onAcknowledged: () => {
        // Refresh follows the normal workbench lifecycle instead of re-reading a consumed ticket.
        const url = new URL(window.location.href);
        url.searchParams.delete('capture');
        window.history.replaceState(window.history.state, '', url);
    },
}) : null;
const captureNotice = computed(() => {
    if (sourceReturnError.value) return captureErrorMessage(sourceReturnError.value, locale.value);
    const state = captureState.value;
    if (state.phase === 'error') {
        if (state.error === 'EDITOR_HAS_CONTENT') return locale.value === 'en'
            ? 'The editor already contains text. Your content was kept; the response was not imported.'
            : '编辑区已有内容，已保留你的内容，未覆盖导入。';
        if (state.error === 'EDITOR_IMPORT_FAILED') return locale.value === 'en'
            ? 'The response could not be loaded into the editor. You can retry or reopen its URL.'
            : '响应未能载入编辑器，可以重试或返回响应页面。';
        if (state.error === 'EDITOR_CHANGED') return locale.value === 'en'
            ? 'Your editor changed while formatting. Automatic import was cancelled; you can retry.'
            : '格式化期间编辑区发生了修改，已取消自动导入。可以重试。';
        return captureErrorMessage(state.error, locale.value);
    }
    if (state.phase === 'imported') {
        let notice = locale.value === 'en' ? 'JSON response formatted and imported' : 'JSON 响应已格式化并导入';
        if (state.formatWarning === 'FORMAT_FAILED') notice = locale.value === 'en'
            ? 'Formatting failed. The original response was imported without changes.'
            : '自动格式化未完成，已保留并导入响应原文。';
        if (state.formatWarning === 'FORMAT_TOO_LARGE') notice = locale.value === 'en'
            ? 'The formatted result would be too large. The original response was imported.'
            : '格式化结果预计过大，已保留并导入响应原文。';
        if (state.cleanupError) notice += locale.value === 'en'
            ? ' Temporary data cleanup is pending.' : ' 临时数据将按过期策略清理。';
        return notice;
    }
    if (state.phase === 'ready') return locale.value === 'en' ? 'Formatting JSON response…' : '正在格式化 JSON 响应…';
    return locale.value === 'en' ? 'Loading JSON response…' : '正在载入 JSON 响应…';
});
const onExternalImported = (id: string, warning?: ImportFormatWarning) => {
    const successfulImport = !warning && captureState.value.phase === 'ready' && captureState.value.request?.id === id;
    void captureSession?.confirmImported(id, warning);
    if (successfulImport && document.visibilityState === 'visible' && document.hasFocus()) onSuccessfulUse('import');
};
const onExternalImportFailed = (id: string, reason: string) => captureSession?.rejectImport(id, reason);
const viewOriginal = async () => {
    const warning = locale.value === 'en'
        ? 'Reopen the response URL? Its content may change and unsaved editor changes will be lost.'
        : '将重新打开接口地址，返回内容可能变化，当前编辑器中未保存的修改不会保留。是否继续？';
    if (returningToSource.value || !window.confirm(warning)) return;
    returningToSource.value = true; sourceReturnError.value = null;
    try { await returnToSource(captureId); }
    catch (error) { sourceReturnError.value = error; }
    finally { returningToSource.value = false; }
};
onBeforeUnmount(() => captureSession?.dispose());
const workbench = shallowRef<Awaited<ReturnType<typeof loadJsonToolWorkbench>> | null>(null);
const loadStatus = ref<JsonToolLoadStatus>('loading');
const viewportEligible = ref(false);
const reviewUsage = shallowRef<ReviewUsageSignal | null>(null);
const workbenchReviewBlocked = ref(true);
let reviewSequence = 0;
const onSuccessfulUse = (kind: ReviewUsageKind) => {
    reviewUsage.value = { sequence: ++reviewSequence, kind };
};
const reviewBlocked = computed(() => workbenchReviewBlocked.value || loadStatus.value !== 'ready'
    || captureState.value.phase === 'reading' || captureState.value.phase === 'ready');
const loadingLabel = computed(() => locale.value === 'en' ? 'Loading JSON editor' : '正在加载 JSON 编辑器');
const retryLabel = computed(() => locale.value === 'en' ? 'Reload page' : '刷新重试');
const errorLabel = computed(() => locale.value === 'en'
    ? 'The editor could not load. Please reload the page to try again.'
    : '编辑器加载失败，请刷新重试。');
const loader = createJsonToolLoadController({
    load: loadJsonToolWorkbench,
    onChange: state => {
        loadStatus.value = state.status;
        workbench.value = state.component ? markRaw(state.component) : null;
    },
});
// A new document also clears the browser's failed module-import graph.
const reloadPage = () => window.location.reload();
const stopViewport = observeWorkbenchViewport(window, {
    onChange: wide => { viewportEligible.value = wide; },
    onFirstWide: () => {
        void loader.start();
        void captureSession?.load();
    },
});
onBeforeUnmount(() => { stopViewport(); loader.dispose(); });

const switchLocale = () => {
    locale.value = locale.value === 'zh' ? 'en' : 'zh';
};
watch(locale, (value) => {
    document.documentElement.lang = value === 'en' ? 'en' : 'zh-CN';
    document.title = value === 'en' ? 'JSON Toolbox' : 'JSON 工具箱';
    document.querySelector('meta[name="description"]')?.setAttribute('content', value === 'en'
        ? 'Format, edit, compare and convert JSON locally. JSON Toolbox keeps your data on your device and supports large JSON files.'
        : 'JSON 工具箱：在本地格式化、编辑、对比、转换和脱敏 JSON，支持大型 JSON 文件，数据在设备上处理。');
    try {
        localStorage.setItem(LOCALE_KEY, value);
    } catch {
        // Language switching remains usable if storage is unavailable.
    }
}, { immediate: true });
</script>


<style scoped>
.extension-shell { position: relative; display: flex; flex-direction: column; width: 100%; height: 100%; }
.extension-workbench { flex: 1; min-height: 0; }
.capture-notice { display: flex; flex: 0 0 auto; align-items: center; gap: 10px; min-height: 32px; padding: 4px 12px; border-bottom: 1px solid var(--el-border-color, #dcdfe6); background: var(--el-fill-color-light, #f5f7fa); color: var(--el-text-color-regular, #606266); font-size: 12px; }
.capture-notice-copy { display: flex; flex: 1; min-width: 0; align-items: center; gap: 10px; }
.capture-source { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; opacity: .8; }
.capture-notice.is-error { color: var(--el-color-danger, #f56c6c); }
.capture-notice button { flex-shrink: 0; padding: 2px 6px; border: 1px solid var(--el-border-color, #dcdfe6); border-radius: 4px; color: inherit; background: var(--el-bg-color, #fff); font-size: 12px; }
.capture-notice button:focus-visible { outline: 2px solid var(--el-color-primary, #409eff); outline-offset: 2px; }
@media (max-width: 1000px) { .capture-notice-copy { align-items: flex-start; flex-direction: column; gap: 0; } .capture-source { max-width: 100%; } }
.extension-shell :deep(.editor-skeleton) { min-height: 0; border: 0; border-radius: 0; }
.extension-load-state {
    position: absolute;
    top: 68px;
    left: 50%;
    transform: translateX(-50%);
    max-width: calc(100% - 32px);
    padding: 12px 16px;
    color: var(--el-text-color-regular, #606266);
    background: var(--el-bg-color, #fff);
    border: 1px solid var(--el-border-color-lighter, #ebeef5);
    border-radius: 4px;
    text-align: center;
    font-size: 13px;
    line-height: 1.6;
}
.extension-load-state p { margin: 0; }
.extension-load-state.is-error { border-color: var(--el-color-danger-light-5, #f9c5c5); }
.extension-load-state button {
    margin-top: 10px;
    padding: 5px 14px;
    color: var(--el-color-primary, #409eff);
    background: var(--el-bg-color, #fff);
    border: 1px solid currentColor;
    border-radius: 4px;
    font: inherit;
}
.extension-load-state button:focus-visible { outline: 2px solid currentColor; outline-offset: 3px; }
</style>
