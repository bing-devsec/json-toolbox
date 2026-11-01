<template>
    <div class="editor-skeleton" :aria-label="label">
        <div class="sk-toolbar">
            <span class="sk-btn sk-btn--wide"></span>
            <span class="sk-btn"></span>
            <span class="sk-btn"></span>
            <span class="sk-btn"></span>
            <span class="sk-btn"></span>
            <span class="sk-btn sk-btn--wide"></span>
            <span class="sk-spacer"></span>
            <span class="sk-btn"></span>
        </div>
        <div class="sk-panes">
            <div class="sk-pane">
                <div class="sk-gutter">
                    <span v-for="n in 18" :key="'l' + n" class="sk-lineno"></span>
                </div>
                <div class="sk-code">
                    <span v-for="n in 18" :key="'cl' + n" class="sk-codeline" :style="{ width: lineWidths[n % lineWidths.length] }"></span>
                </div>
            </div>
            <div class="sk-divider"></div>
            <div class="sk-pane">
                <div class="sk-gutter">
                    <span v-for="n in 18" :key="'r' + n" class="sk-lineno"></span>
                </div>
                <div class="sk-code">
                    <span v-for="n in 18" :key="'cr' + n" class="sk-codeline" :style="{ width: lineWidths[(n + 3) % lineWidths.length] }"></span>
                </div>
            </div>
        </div>
    </div>
</template>

<script setup lang="ts">
defineProps<{
    label: string;
}>();

const lineWidths = ['38%', '72%', '55%', '85%', '46%', '63%', '30%', '78%'];
</script>

<style scoped>
.editor-skeleton {
    width: 100%;
    height: 100%;
    min-height: 480px;
    background: var(--json-tool-surface, #fff);
    border: 1px solid var(--json-tool-border, var(--el-border-color-lighter, #ebeef5));
    border-radius: var(--theme-radius, 6px);
    display: flex;
    flex-direction: column;
    overflow: hidden;
}

.sk-toolbar {
    flex: 0 0 auto;
    height: 48px;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 0 14px;
    border-bottom: 1px solid var(--json-tool-border, var(--el-border-color-lighter, #ebeef5));
    background: var(--json-tool-surface-soft, var(--el-fill-color-light, #f5f7fa));
}

.sk-btn {
    width: 30px;
    height: 22px;
    border-radius: 4px;
    background: linear-gradient(90deg, var(--json-tool-border, #e8eaed) 25%, var(--json-tool-surface-soft, #f2f4f6) 50%, var(--json-tool-border, #e8eaed) 75%);
    background-size: 200% 100%;
    animation: skeleton-loading 1.4s infinite;
}

.sk-btn--wide {
    width: 64px;
}

.sk-spacer {
    flex: 1;
}

.sk-panes {
    flex: 1;
    display: flex;
    min-height: 0;
}

.sk-pane {
    flex: 1;
    display: flex;
    min-width: 0;
    overflow: hidden;
}

.sk-divider {
    width: 1px;
    background: var(--json-tool-border, var(--el-border-color-lighter, #ebeef5));
}

.sk-gutter {
    flex: 0 0 44px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 12px 8px;
    background: var(--json-tool-surface-soft, var(--el-fill-color-lighter, #fafafa));
    align-items: flex-end;
}

.sk-lineno {
    width: 16px;
    height: 12px;
    border-radius: 2px;
    background: var(--json-tool-border, #eef0f2);
}

.sk-code {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 12px 14px;
    min-width: 0;
}

.sk-codeline {
    height: 12px;
    border-radius: 2px;
    background: linear-gradient(90deg, var(--json-tool-border, #eef0f2) 25%, var(--json-tool-surface-soft, #f6f8fa) 50%, var(--json-tool-border, #eef0f2) 75%);
    background-size: 200% 100%;
    animation: skeleton-loading 1.6s infinite;
}

@keyframes skeleton-loading {
    0% {
        background-position: 200% 0;
    }
    100% {
        background-position: -200% 0;
    }
}
body[data-interface-style="default"].json-tool-theme-dark .editor-skeleton { background: #1f1f1f; border-color: #2b2b2b; }
body[data-interface-style="default"].json-tool-theme-dark .sk-toolbar { background: #181818; border-bottom-color: #2b2b2b; }
body[data-interface-style="default"].json-tool-theme-dark .sk-btn { background: linear-gradient(90deg, #2b2b2b 25%, #333333 50%, #2b2b2b 75%); }
body[data-interface-style="default"].json-tool-theme-dark .sk-divider { background: #2b2b2b; }
body[data-interface-style="default"].json-tool-theme-dark .sk-gutter { background: #181818; }
body[data-interface-style="default"].json-tool-theme-dark .sk-lineno { background: #2b2b2b; }
body[data-interface-style="default"].json-tool-theme-dark .sk-codeline { background: linear-gradient(90deg, #2b2b2b 25%, #333333 50%, #2b2b2b 75%); }
</style>
