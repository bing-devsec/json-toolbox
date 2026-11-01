<template>
    <div class="screen-size-notice" role="status">
        <svg class="warning-icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10" fill="currentColor"/><path d="M12 6v7m0 4v.1" stroke="var(--json-tool-surface, #fff)" stroke-width="2" stroke-linecap="round"/></svg>
        <div class="warning-text">
            <p>{{ locale === 'en' ? 'The current screen is too small for a comfortable editing experience.' : '当前屏幕尺寸过小，无法提供良好的使用体验' }}</p>
            <p>{{ locale === 'en' ? 'Please use a device with a screen wider than 900px.' : '请使用屏幕宽度大于 900px 的设备访问此工具' }}</p>
        </div>
    </div>
</template>
<script setup lang="ts">
defineProps<{ locale: 'zh' | 'en' }>();
</script>
<style scoped>
.screen-size-notice { flex: 1; min-height: 0; display: flex; align-items: center; justify-content: center; flex-direction: column; padding: 20px; text-align: center; background: var(--json-tool-bg, #f0f2f5); color: var(--json-tool-text-muted, #606266); }
.warning-icon { width: 48px; height: 48px; flex: 0 0 auto; color: var(--el-color-warning, #e6a23c); margin-bottom: 20px; }
.warning-text { max-width: 80%; font-size: 16px; line-height: 1.6; }
</style>
