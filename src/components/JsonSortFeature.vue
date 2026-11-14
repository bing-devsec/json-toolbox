<template>
    <el-dialog class="field-sort-dialog-wrapper" v-model="fieldSortDialogVisibleModel" width="600px" :close-on-click-modal="false" :show-close="false">
        <template #header>
            <div class="dialog-header-with-close">
                <span class="dialog-title-with-close">{{ settingsTxt.fieldSortTitle }}</span>
                <button class="demo-close-btn" @click="fieldSortDialogVisibleModel = false" :aria-label="settingsTxt.fieldSortCloseAria">✕</button>
            </div>
        </template>
        <div class="form-item form-value-quote--compact sort-direction-control">
            <span id="sort-direction-label" class="sort-direction-label">{{ settingsTxt.sortOrderLabel }}</span>
            <el-radio-group v-model="sortOrderModel" class="switch-card-radio-group sort-direction-options" aria-labelledby="sort-direction-label">
                <el-radio value="asc" border>{{ settingsTxt.sortOrderAsc }}</el-radio>
                <el-radio value="desc" border>{{ settingsTxt.sortOrderDesc }}</el-radio>
            </el-radio-group>
        </div>

        <div class="form-item">
            <div id="sort-root-path-label" class="form-label">{{ settingsTxt.fieldSortRootPathLabel }}</div>
            <el-autocomplete
                id="sort-root-path-input"
                aria-labelledby="sort-root-path-label"
                v-model="sortRootPathModel"
                :fetch-suggestions="queryRootPaths"
                popper-class="sort-path-autocomplete"
                fit-input-width
                :placeholder="settingsTxt.fieldSortRootPathPlaceholder"
                clearable
                highlight-first-item>
                <template #default="{ item }">
                    <div class="autocomplete-item">
                        <span class="path-text" :title="item.value">{{ item.value }}</span>
                        <span v-if="item.type" class="path-type">{{ getTypeLabel(item.type) }}</span>
                    </div>
                </template>
            </el-autocomplete>
            <div class="form-hint">{{ settingsTxt.fieldSortRootPathHint }}</div>
        </div>

        <div class="form-item">
            <div id="sort-field-name-label" class="form-label">{{ settingsTxt.fieldSortFieldLabel }}</div>
            <el-autocomplete
                id="sort-field-name-input"
                aria-labelledby="sort-field-name-label"
                v-model="sortFieldNameModel"
                :fetch-suggestions="queryFieldPathsFromScope"
                popper-class="sort-path-autocomplete"
                fit-input-width
                :trigger-on-focus="true"
                :placeholder="settingsTxt.fieldSortFieldPlaceholder"
                clearable
                highlight-first-item>
                <template #default="{ item }">
                    <div class="autocomplete-item">
                        <span class="path-text" :title="item.value">{{ item.value }}</span>
                        <span v-if="item.type" class="path-type">{{ getTypeLabel(item.type) }}</span>
                    </div>
                </template>
            </el-autocomplete>
            <div class="form-hint">{{ settingsTxt.fieldSortFieldHint }}</div>
        </div>

        <template #footer>
            <el-button @click="fieldSortDialogVisibleModel = false">{{ settingsTxt.btnCancel }}</el-button>
            <el-button type="warning" @click="showFieldSortDemo">{{ settingsTxt.btnDemoExample }}</el-button>
            <el-button type="primary" @click="executeFieldSort">{{ settingsTxt.btnStartSort }}</el-button>
        </template>
    </el-dialog>

    <!-- 演示模式：Popover 贴边引导，不使用遮罩层 -->
    <el-popover
        v-if="isDemoMode && demoGuideVisible && currentDemoStepData"
        :visible="true"
        :virtual-ref="demoPopoverAnchor"
        virtual-triggering
        :width="420"
        :placement="demoPopoverPlacement"
        :show-arrow="true"
        :teleported="true"
        popper-class="demo-guide-popover"
        :offset="12">
        <div class="demo-guide-inner" @keydown.esc.stop.prevent="endDemoMode">
            <div class="demo-guide-header">
                <h3>{{ currentDemoStepData.title }}</h3>
                <button class="demo-close-btn" @click="endDemoMode" :aria-label="settingsTxt.demoCloseAria">✕</button>
            </div>
            <div class="demo-guide-content">
                <p class="demo-guide-hint"><strong>{{ settingsTxt.demoExamplesHint }}</strong></p>
                <div class="demo-example-switcher" role="group" :aria-label="settingsTxt.demoExamplesTitle">
                    <button v-for="(example, index) in currentDemoStepData.examples" :key="index"
                        type="button" class="demo-example-button" :class="{ 'is-active': currentDemoStep === index }"
                        :aria-pressed="currentDemoStep === index" @click="example.action()">
                        {{ example.text }}
                    </button>
                </div>
                <section class="demo-section">
                    <h4>{{ settingsTxt.demoGoalLabel }}</h4>
                    <p>{{ currentDemoStepData.goal }}</p>
                </section>
                <section class="demo-section">
                    <h4>{{ settingsTxt.demoParametersLabel }}</h4>
                    <dl class="demo-parameters">
                        <div>
                            <dt>{{ settingsTxt.demoRootPathLabel }}</dt>
                            <dd><code>{{ sortRootPath || settingsTxt.demoEmptyValue }}</code></dd>
                        </div>
                        <div>
                            <dt>{{ settingsTxt.demoFieldLabel }}</dt>
                            <dd><code>{{ sortFieldName || settingsTxt.demoUnsetValue }}</code></dd>
                        </div>
                    </dl>
                </section>
                <section class="demo-section demo-reason">
                    <h4>{{ settingsTxt.demoReasonLabel }}</h4>
                    <p>{{ currentDemoStepData.reason }}</p>
                    <p v-if="currentDemoStepData.transferHint" class="demo-transfer-hint"><strong>{{ settingsTxt.demoTransferLabel }}</strong>{{ currentDemoStepData.transferHint }}</p>
                </section>
                <p v-if="currentDemoStepData.completed" class="demo-result-status" role="status">{{ settingsTxt.demoResultReady }}</p>
            </div>
            <div class="demo-guide-footer">
                <span class="demo-direction-summary">{{ settingsTxt.demoDirectionLabel }} {{ sortOrder === 'asc' ? settingsTxt.sortOrderAsc : settingsTxt.sortOrderDesc }}</span>
                <div class="demo-footer-actions">
                    <el-button
                        v-for="(btn, index) in currentDemoStepData.buttons"
                        :key="index"
                        size="small"
                        :type="btn.type ?? 'default'"
                        @click="btn.action()">
                        {{ btn.text }}
                    </el-button>
                </div>
            </div>
        </div>
    </el-popover>
</template>

<script setup lang="ts">
import { ElAutocomplete, ElButton, ElDialog, ElPopover, ElRadio, ElRadioGroup } from 'element-plus';
import 'element-plus/es/components/autocomplete/style/css';
import 'element-plus/es/components/button/style/css';
import 'element-plus/es/components/dialog/style/css';
import 'element-plus/es/components/popover/style/css';
import 'element-plus/es/components/radio/style/css';
import 'element-plus/es/components/radio-group/style/css';
import './styles/option-group.css';

import { computed } from 'vue';
import type { SettingsTxt } from './utils/i18n';
import type { SortOrder } from './composables/useToolSettings';
import type { SortDemoStep } from './composables/useJsonSort';

import type { PathSuggestion } from './utils/jsonSortSuggestions';

type SuggestionCallback = (suggestions: PathSuggestion[]) => void;

interface Props {
    fieldSortDialogVisible: boolean;
    sortRootPath: string;
    sortFieldName: string;
    sortOrder: SortOrder;
    settingsTxt: SettingsTxt;
    isDemoMode: boolean;
    demoGuideVisible: boolean;
    currentDemoStepData: SortDemoStep | null;
    demoPopoverAnchor: HTMLElement | null;
    demoPopoverPlacement: 'right-start' | 'left-start' | 'bottom-start' | 'top-start';
    currentDemoStep: number;
    queryRootPaths: (queryString: string, cb: SuggestionCallback) => void;
    queryFieldPathsFromScope: (queryString: string, cb: SuggestionCallback) => void;
    getTypeLabel: (type: string) => string;
    showFieldSortDemo: () => void;
    executeFieldSort: () => void;
    endDemoMode: () => void;
}

const props = defineProps<Props>();
const emit = defineEmits<{
    'update:fieldSortDialogVisible': [value: boolean];
    'update:sortRootPath': [value: string];
    'update:sortFieldName': [value: string];
    'update:sortOrder': [value: SortOrder];
}>();

const fieldSortDialogVisibleModel = computed({
    get: () => props.fieldSortDialogVisible,
    set: (value) => emit('update:fieldSortDialogVisible', value),
});

const sortOrderModel = computed({
    get: () => props.sortOrder,
    set: (value: SortOrder) => emit('update:sortOrder', value),
});

const sortRootPathModel = computed({
    get: () => props.sortRootPath,
    set: (value) => emit('update:sortRootPath', value),
});

const sortFieldNameModel = computed({
    get: () => props.sortFieldName,
    set: (value) => emit('update:sortFieldName', value),
});
</script>

<style scoped>
/* Keep teleported dialog spacing local, below the themed title-bar rules. */
:global(.el-dialog.field-sort-dialog-wrapper > :where(.el-dialog__header)) {
    padding: 16px 20px 12px;
}

:global(.el-dialog.field-sort-dialog-wrapper > :where(.el-dialog__body)) {
    padding: 20px;
}

:global(.el-dialog.field-sort-dialog-wrapper > :where(.el-dialog__footer)) {
    padding: 12px 20px 16px;
}

.dialog-header-with-close {
    display: flex;
    align-items: center;
    justify-content: space-between;
    width: 100%;
    gap: 16px;
}

.dialog-title-with-close {
    font-size: 18px;
    font-weight: 600;
    color: var(--json-tool-text, #303133);
    line-height: 1.5;
}

.demo-close-btn {
    background: none;
    border: none;
    /* 使用固定字号 + line-height:1 消除字符垂直基线偏移；
       字体栈强制走系统无衬线，避免某些中文字体中 '✕' 被渲染得偏大偏斜 */
    font-family:
        system-ui,
        -apple-system,
        'Segoe UI',
        Arial,
        sans-serif;
    font-size: 14px;
    font-weight: 600;
    line-height: 1;
    color: var(--json-tool-text-muted, #909399);
    cursor: pointer;
    padding: 0;
    width: 24px;
    height: 24px;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    transition:
        background-color 0.2s,
        color 0.2s,
        transform 0.15s;
    /* 消除按钮默认可能存在的 text-indent / vertical-align 偏移 */
    text-align: center;
    vertical-align: middle;
}

.demo-close-btn:hover {
    background: var(--json-tool-surface-soft, #f2f3f5);
    color: var(--json-tool-text, #303133);
    transform: scale(1.08);
}

.demo-close-btn:active {
    transform: scale(0.96);
}

.form-item {
    margin-bottom: 16px;
}

.form-item:last-child {
    margin-bottom: 0;
}

.form-label {
    display: block;
    font-weight: 500;
    color: var(--json-tool-text, #606266);
    margin-bottom: 6px;
}

.form-value-quote--compact {
    padding: 12px 16px;
    background: var(--json-tool-surface-soft, #f6f7f9);
    border: 1px solid var(--json-tool-border, rgba(20, 30, 40, 0.04));
    box-sizing: border-box;
}

.sort-direction-control {
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 12px;
}

.sort-direction-label {
    font-weight: 600;
    color: var(--json-tool-text, #303133);
}

.sort-direction-control .sort-direction-options {
    flex-wrap: wrap;
    justify-content: flex-end;
}

.form-hint {
    margin-top: 6px;
    color: var(--json-tool-text-muted, #606266);
    font-size: 12px;
    line-height: 1.5;
}

.autocomplete-item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    min-width: 0;
}

.path-text {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.path-type {
    flex-shrink: 0;
    color: var(--json-tool-text-muted, #606266);
    font-size: 12px;
}

/* 演示模式样式 - Popover 贴边版本 */
/* el-popover 会被 teleport 到 body，使用 popper-class 定位 */
:global(.demo-guide-popover.el-popover) {
    padding: 0 !important;
    max-width: calc(100vw - 24px);
    box-sizing: border-box;
    /* The native arrow extends beyond this shell. Only the inner content scrolls. */
    overflow: visible;
    box-shadow: var(--json-tool-shadow, 0 6px 28px rgba(0, 0, 0, 0.18)) !important;
    border: 1px solid var(--json-tool-border, #dcdfe6) !important;
}

:global(body[data-interface-style="default"].json-tool-theme-dark .demo-guide-popover.el-popover) {
    background: #1f1f1f !important;
    border-color: #2b2b2b !important;
    color: #cccccc !important;
}

:global(body[data-interface-style="default"].json-tool-theme-dark .demo-guide-popover .el-popper__arrow::before) {
    background: #1f1f1f !important;
    border-color: #2b2b2b !important;
}

/* Keep the demo shell square even when the theme rounds other floating panels. */
:global(body[data-interface-style] .demo-guide-popover.el-popover.el-popper) {
    border-radius: 0 !important;
}

.demo-guide-inner {
    display: flex;
    flex-direction: column;
    min-width: 0;
    max-height: calc(100dvh - 24px);
    animation: demoPopup 0.25s ease-out;
}

@keyframes demoPopup {
    from {
        opacity: 0;
        transform: scale(0.96);
    }

    to {
        opacity: 1;
        transform: scale(1);
    }
}

.demo-guide-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex: 0 0 auto;
    gap: 12px;
    padding: 10px 14px;
    border-bottom: 1px solid var(--json-tool-border, #f0f0f0);
    background: var(--json-tool-surface-header, transparent);
}

:global(body[data-interface-style="default"].json-tool-theme-dark .demo-guide-popover .demo-guide-header) {
    border-bottom-color: #2b2b2b !important;
    background: linear-gradient(to bottom, #232323, #1f1f1f) !important;
}

.demo-guide-header h3 {
    margin: 0;
    color: var(--json-tool-text, #303133);
    font-size: 14px;
    font-weight: 600;
}

:global(body[data-interface-style="default"].json-tool-theme-dark .demo-guide-popover .demo-guide-header h3) {
    color: #cccccc !important;
}

.demo-guide-content {
    min-height: 0;
    min-width: 0;
    padding: 12px 14px;
    overflow-y: auto;
    overflow-x: hidden;
    overflow-wrap: anywhere;
    overscroll-behavior: contain;
}

.demo-guide-content p {
    margin: 0;
    color: var(--json-tool-text-muted, var(--el-text-color-regular, #606266));
    font-size: 13px;
    line-height: 1.6;
}

.demo-guide-content .demo-guide-hint {
    margin-bottom: 12px;
    color: var(--json-tool-text, var(--el-text-color-primary, #303133));
}

.demo-guide-hint strong { font-weight: 600; }

.demo-section + .demo-section { margin-top: 14px; }
.demo-section h4 {
    margin: 0 0 6px;
    color: var(--json-tool-text, var(--el-text-color-primary, #303133));
    font-size: 13px;
    line-height: 1.5;
    font-weight: 600;
}

.demo-parameters {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 8px;
    margin: 0;
}
.demo-parameters > div {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 2px 4px;
    min-width: 0;
    padding: 6px 8px;
    border: 1px solid var(--json-tool-border, var(--el-border-color, #dcdfe6));
    background: var(--json-tool-surface-soft, var(--el-fill-color-light, #f5f7fa));
    font-size: 12px;
    line-height: 1.6;
}
.demo-parameters dt { color: var(--json-tool-text-muted, var(--el-text-color-regular, #606266)); }
.demo-parameters dd { min-width: 0; margin: 0; }
.demo-parameters code {
    color: var(--json-tool-text, var(--el-text-color-primary, #303133));
    font-family: var(--json-tool-font-code, monospace);
    font-size: 12px;
    font-weight: 600;
    white-space: normal;
    overflow-wrap: anywhere;
}
.demo-reason .demo-transfer-hint {
    margin-top: 8px;
    padding-left: 9px;
    border-left: 2px solid var(--json-tool-border, var(--el-border-color, #dcdfe6));
    font-size: 12px;
}
.demo-transfer-hint strong { font-weight: 600; }

.demo-guide-footer {
    flex: 0 0 auto;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 10px 14px;
    border-top: 1px solid var(--json-tool-border, var(--el-border-color, #dcdfe6));
}
.demo-direction-summary {
    color: var(--json-tool-text-muted, var(--el-text-color-regular, #606266));
    font-size: 12px;
    line-height: 1.5;
}
.demo-footer-actions { display: flex; flex-wrap: wrap; gap: 6px; margin-left: auto; }
.demo-guide-footer .el-button + .el-button { margin-left: 0; }

.demo-example-switcher {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 6px;
    margin-bottom: 12px;
}

.demo-example-button {
    min-height: 34px;
    padding: 6px 8px;
    border: 1px solid var(--json-tool-border, #dcdfe6);
    border-radius: var(--theme-radius, 4px);
    background: var(--json-tool-surface-soft, #f5f7fa);
    color: var(--json-tool-text, #303133);
    font: inherit;
    font-size: 12px;
    text-align: left;
    cursor: pointer;
}

.demo-example-button:hover {
    border-color: var(--theme-accent, #409eff);
}

.demo-example-button.is-active {
    border-color: var(--theme-accent, #409eff);
    background: color-mix(in srgb, var(--theme-accent, #409eff) 15%, var(--json-tool-surface-soft, #f5f7fa));
    font-weight: 600;
}

.demo-example-button:focus-visible {
    outline: 2px solid var(--theme-accent, #409eff);
    outline-offset: 2px;
}

.demo-guide-content .demo-result-status {
    margin-top: 12px;
    color: var(--json-tool-text, var(--el-text-color-primary, #303133));
    font-size: 12px;
    line-height: 1.6;
}

/* Animate only the frame, never scale or shift editor text. */
:global(.demo-highlight-target::after) {
    content: '';
    position: absolute;
    inset: 0;
    z-index: 5;
    pointer-events: none;
    animation: demoHighlightWave 1.8s ease-out infinite;
}
@keyframes demoHighlightWave {
    0% { box-shadow: inset 0 0 0 2px rgba(64, 158, 255, .5); }
    65%, 100% { box-shadow: inset 0 0 0 8px rgba(64, 158, 255, 0); }
}

@media (prefers-reduced-motion: reduce) {
    .demo-guide-inner { animation: none; }
    :global(.demo-highlight-target::after) { animation: none; }
}
</style>
