<template>
    <el-dialog
        :model-value="visible"
        class="json-tool-welcome-dialog"
        :title="en ? 'Take a quick tour?' : '是否进入使用引导？'"
        width="420px"
        align-center
        :close-on-click-modal="false"
        @update:model-value="onVisibilityChange">
        <p class="welcome-description">{{ en ? 'Explore editor settings, formatting and a useful context-menu action.' : '了解编辑器设置、格式化，以及实用的右键菜单操作。' }}</p>
        <template #footer>
            <el-button @click="emit('skip')">{{ en ? 'Cancel' : '取消' }}</el-button>
            <el-button type="primary" @click="emit('start')">{{ en ? 'Start guide' : '进入引导' }}</el-button>
        </template>
    </el-dialog>
</template>
<script setup lang="ts">
import { computed } from 'vue';
import { ElButton, ElDialog } from 'element-plus';
import 'element-plus/es/components/button/style/css';
import 'element-plus/es/components/dialog/style/css';
const props = defineProps<{ visible: boolean; locale?: 'zh' | 'en' }>();
const emit = defineEmits<{ start: []; skip: [] }>();
const en = computed(() => props.locale === 'en');
const onVisibilityChange = (visible: boolean) => { if (!visible) emit('skip'); };
</script>
<style scoped>
.welcome-description { margin: 0; line-height: 1.8; color: var(--el-text-color-regular); }
:global(.el-dialog.json-tool-welcome-dialog) { max-width: calc(100vw - 32px); }
:global(.el-dialog.json-tool-welcome-dialog > .el-dialog__header) {
    display: flex;
    align-items: center;
    gap: 12px;
    margin: 0;
    padding: 0;
    border-bottom: 0;
}
:global(.el-dialog.json-tool-welcome-dialog .el-dialog__title) {
    flex: 1;
    min-width: 0;
}
:global(.el-dialog.json-tool-welcome-dialog .el-dialog__headerbtn) {
    position: static;
    transform: none;
    display: flex;
    align-items: center;
    justify-content: center;
    flex: 0 0 32px;
    width: 32px;
    height: 32px;
    margin: 0;
    padding: 0;
}
:global(.el-dialog.json-tool-welcome-dialog > .el-dialog__body) {
    padding: var(--el-dialog-padding-primary) 0 0;
}
:global(.el-dialog.json-tool-welcome-dialog > .el-dialog__footer) {
    padding: var(--el-dialog-padding-primary) 0 0;
    border-top: 0;
}
</style>
