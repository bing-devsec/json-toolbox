<template>
    <div class="switch-card capture-switch" :aria-busy="busy">
        <div class="switch-card-head">
            <span :id="`${labelId}-title`" class="switch-card-title">{{ txt.title }}</span>
            <el-switch class="switch-card-toggle" :model-value="enabled" :disabled="!available || busy"
                :aria-labelledby="`${labelId}-title`" :aria-describedby="`${labelId}-description`" size="default" @change="change" />
        </div>
        <span :id="`${labelId}-description`" class="switch-card-desc">{{ available ? txt.description : txt.unavailable }}</span>
        <span v-if="errorMessage" class="capture-error" role="alert">{{ errorMessage }}</span>
    </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, useId } from 'vue';
import { ElSwitch } from 'element-plus';
import 'element-plus/es/components/switch/style/css';
import { captureErrorMessage, getCaptureStatus, isCaptureAvailable, setCaptureEnabled } from '../extension/captureClient';

const props = withDefaults(defineProps<{ locale?: 'zh' | 'en' }>(), { locale: 'zh' });
const labelId = useId();
const available = isCaptureAvailable();
const enabled = ref(true);
const confirmedEnabled = ref(true);
const loading = ref(available);
const saving = ref(false);
const busy = computed(() => loading.value || saving.value);
const error = ref<unknown>(null);
const errorMessage = computed(() => error.value ? captureErrorMessage(error.value, props.locale) : '');
const txt = computed(() => props.locale === 'en' ? {
    title: 'Automatically open JSON responses',
    description: 'Open JSON responses from HTTP and HTTPS websites in the toolbox. Processing stays local; browser site-access restrictions still apply.',
    unavailable: 'Available in the installed extension. Local editing remains available in this preview.',
} : {
    title: '自动打开 JSON 响应',
    description: '自动接收 HTTP 和 HTTPS 网站的 JSON 响应，数据仅在本地处理，仍受浏览器网站访问限制。',
    unavailable: '请在已安装的浏览器插件中使用此功能，此预览仍可正常进行本地编辑。',
});
let alive = true;
onBeforeUnmount(() => { alive = false; });
const setConfirmed = (value: boolean) => { enabled.value = value; confirmedEnabled.value = value; };
const change = async (next: string | number | boolean) => {
    if (!alive || !available || busy.value || typeof next !== 'boolean' || next === confirmedEnabled.value) return;
    saving.value = true; enabled.value = next; error.value = null;
    try {
        const status = await setCaptureEnabled(next);
        if (alive) setConfirmed(status.enabled);
    } catch (failure) {
        if (!alive) return;
        enabled.value = confirmedEnabled.value; error.value = failure;
        try {
            const status = await getCaptureStatus();
            if (alive) setConfirmed(status.enabled);
        } catch { /* Keep the last confirmed value and the actionable save error. */ }
    } finally { if (alive) saving.value = false; }
};
onMounted(async () => {
    if (!available) return;
    try {
        const status = await getCaptureStatus();
        if (alive) setConfirmed(status.enabled);
    } catch (failure) { if (alive) error.value = failure; }
    finally { if (alive) loading.value = false; }
});
</script>

<style scoped>
.switch-card-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; min-width: 0; }
.switch-card-toggle { flex-shrink: 0; }
.switch-card-title { font-size: 14px; font-weight: 600; color: #303133; line-height: 1.35; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex: 1; min-width: 0; }
.switch-card-desc { font-size: 12px; color: var(--json-tool-text-muted, #606266); line-height: 1.55; display: block; white-space: normal; overflow-wrap: anywhere; min-height: calc(12px * 1.55 * 2); }
.capture-error { font-size: 12px; line-height: 1.55; color: var(--el-color-danger, #f56c6c); overflow-wrap: anywhere; }
</style>
