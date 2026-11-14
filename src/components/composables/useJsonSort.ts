import { getRootPathSuggestions, getFieldPathSuggestions, type PathSuggestion } from '../utils/jsonSortSuggestions';
export type { PathSuggestion } from '../utils/jsonSortSuggestions';
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api';
import { getCurrentScope, nextTick, onScopeDispose, ref, watch, type Ref } from 'vue';
import { createEditorDemoSession } from '../utils/editorDemoSession';

import { replaceEditorValuePreservingUndo } from '../utils/diffMonaco';
import type { SettingsTxt } from '../utils/i18n';
import { isValidJsonPath } from '../utils/jsonPath';
import { resolveFieldSortTargets } from '../utils/jsonSortScope';
import { sortJsonByField, sortJsonObject, type SortMethod, type SortOrder } from '../utils/jsonSort';

export type FieldSortTarget = 'input' | 'diff-left' | 'diff-right';
export type DemoPopoverPlacement = 'right-start' | 'left-start' | 'bottom-start' | 'top-start';

export interface SortDemoStep {
    title: string;
    goal: string;
    reason: string;
    transferHint?: string;
    highlight: string | null;
    buttons: Array<{ text: string; action: () => void; type?: 'primary' | 'default' }>;
    examples: Array<{ text: string; action: () => void }>;
    completed: boolean;
}

export interface UseJsonSortSharedState {
    fieldSortDialogVisible: Ref<boolean>;
    sortRootPath: Ref<string>;
    sortFieldName: Ref<string>;
    fieldSortTarget: Ref<FieldSortTarget>;
    isDemoMode: Ref<boolean>;
    demoGuideVisible: Ref<boolean>;
    currentDemoStepData: Ref<SortDemoStep | null>;
    demoPopoverAnchor: Ref<HTMLElement | null>;
    demoPopoverPlacement: Ref<DemoPopoverPlacement>;
    currentDemoStep: Ref<number>;
}

interface PreprocessResult {
    data: any;
    escapeMap: any;
}

export interface UseJsonSortCtx {
    settingsTxt: Ref<SettingsTxt>;
    sortMethod: Ref<SortMethod>;
    sortOrder: Ref<SortOrder>;

    getInputEditor: () => monaco.editor.IStandaloneCodeEditor | null;
    getOutputEditor: () => monaco.editor.IStandaloneCodeEditor | null;
    getDiffSideEditor: (side: 'left' | 'right') => monaco.editor.IStandaloneCodeEditor | null;
    isDiffMode: Ref<boolean>;
    enterDiffMode: () => void;
    exitDiffMode: () => Promise<void>;

    ensureProcessingFeatureAvailable: () => boolean;
    showMessageSuccess: (msg: string) => void;
    showMessageError: (msg: string) => void;

    preprocessJSON: (input: string, options?: { preserveNumberLiterals?: boolean; encodingMode?: boolean }) => PreprocessResult;
    formatJsonResult: (data: any, escapeMap: any) => string;
    formatDemoResult: (data: any, originalData: any) => string;
    writeOutputJson: (content: string) => void;
    setOutputTypeJson: () => void;
    clearOutputEditor: () => void;
    updateEditorHeight: (editor: monaco.editor.IStandaloneCodeEditor) => void;
    updateLineNumberWidth: (editor: monaco.editor.IStandaloneCodeEditor) => void;
    onDemoSessionStart?: () => void;
    onDemoSessionRestore?: () => void;
    state?: Partial<UseJsonSortSharedState>;
}

export const useJsonSort = (ctx: UseJsonSortCtx) => {
    // 字段排序对话框相关状态
    const fieldSortDialogVisible = ctx.state?.fieldSortDialogVisible ?? ref(false);
    const sortRootPath = ctx.state?.sortRootPath ?? ref<string>('');
    const sortFieldName = ctx.state?.sortFieldName ?? ref<string>('');
    const fieldSortTarget = ctx.state?.fieldSortTarget ?? ref<FieldSortTarget>('input');

    // 字段排序演示相关状态
    const isDemoMode = ctx.state?.isDemoMode ?? ref(false);
    const demoGuideVisible = ctx.state?.demoGuideVisible ?? ref(false);
    const currentDemoStepData = ctx.state?.currentDemoStepData ?? ref<SortDemoStep | null>(null);
    const currentDemoStep = ctx.state?.currentDemoStep ?? ref(0);
    const demoStartedFromDiff = ref(false);
    let demoGeneration = 0;
    let demoStarting = false;
    let demoResultVisible = false;
    let disposed = false;
    let hasExternalDemoSnapshot = false;
    let savedSortState: { root: string; field: string; order: SortOrder; method: SortMethod; target: FieldSortTarget } | null = null;
    const editorDemoSession = createEditorDemoSession({
        getInputEditor: ctx.getInputEditor,
        getOutputEditor: ctx.getOutputEditor,
        createModel: (value, language) => monaco.editor.createModel(value, language),
    });
    const demoData = ref(
        JSON.parse(
            '[{"id":3,"name":"Emma Davis","education":[{"university":"Stanford University","graduationYear":2010},{"university":"Columbia University","graduationYear":2015}]},{"id":1,"name":"Dylan Mullins","education":[{"university":"MIT","graduationYear":2003},{"university":"Harvard University","graduationYear":1983}]},{"id":2,"name":"Logan Boyle","education":[{"university":"Yale University","graduationYear":2000},{"university":"University of Pennsylvania","graduationYear":2020}]}]',
        ),
    );
    const demoMapData = ref(
        JSON.parse(
            '{"B":{"id":102,"key":"task-B","value":{"score":100}},"A":{"id":101,"key":"task-A","value":{"score":70}},"C":{"id":103,"key":"task-C","value":{"score":80}},"E":{"id":105,"key":"task-E","value":{"score":60}},"D":{"id":104,"key":"task-D","value":{"score":null}}}',
        ),
    );

    // 演示 Popover 锚点与定位相关状态
    const demoPopoverAnchor = ctx.state?.demoPopoverAnchor ?? ref<HTMLElement | null>(null);
    const demoPopoverPlacement = ctx.state?.demoPopoverPlacement ?? ref<DemoPopoverPlacement>('right-start');
    const demoHighlightedEl = ref<HTMLElement | null>(null);

    const resolveDemoAnchor = (selector: string | null): HTMLElement | null => {
        if (typeof window === 'undefined') return null;
        const fallback = '.editor-panel-output';
        const sel = selector || fallback;
        try {
            const el = document.querySelector<HTMLElement>(sel);
            if (el) return el;
        } catch {
            // ignore invalid selector
        }
        return document.querySelector<HTMLElement>('.json-tool-container') || document.body;
    };

    const pickPlacementForEl = (el: HTMLElement): DemoPopoverPlacement => {
        if (typeof window === 'undefined') return 'right-start';
        const rect = el.getBoundingClientRect();
        const POPOVER_WIDTH = 420;
        const POPOVER_HEIGHT_EST = 260;
        const rightSpace = window.innerWidth - rect.right;
        const leftSpace = rect.left;
        if (rightSpace >= POPOVER_WIDTH + 24) return 'right-start';
        if (leftSpace >= POPOVER_WIDTH + 24) return 'left-start';
        const bottomSpace = window.innerHeight - rect.bottom;
        if (bottomSpace >= POPOVER_HEIGHT_EST + 24) return 'bottom-start';
        return 'top-start';
    };

    const applyDemoHighlight = (el: HTMLElement | null) => {
        if (demoHighlightedEl.value && demoHighlightedEl.value !== el) {
            demoHighlightedEl.value.classList.remove('demo-highlight-target');
        }
        if (el) {
            el.classList.add('demo-highlight-target');
            demoHighlightedEl.value = el;
            try {
                el.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });
            } catch {
                // ignore
            }
        } else {
            demoHighlightedEl.value = null;
        }
    };

    const updateDemoPopoverAnchor = (selector: string | null) => {
        const el = resolveDemoAnchor(selector);
        demoPopoverAnchor.value = el;
        if (el) {
            demoPopoverPlacement.value = pickPlacementForEl(el);
        }
        if (isDemoMode.value) {
            applyDemoHighlight(el);
        }
    };

    // 演示数据与用户数据的行数位数可能相差很大。setValue 后必须同步刷新
    // lineNumbersMinChars，再执行容器布局；只调用 layout() 不会重新计算
    // 已由业务代码显式设置的行号栏最小字符数。
    const refreshEditorAfterDemoContentChange = (editor: monaco.editor.IStandaloneCodeEditor) => {
        ctx.updateLineNumberWidth(editor);
        ctx.updateEditorHeight(editor);
    };

    // Suggestions and execution must read the same editor and compatible JSON parser.
    const getSortSourceEditor = () => fieldSortTarget.value === 'diff-left'
        ? ctx.getDiffSideEditor('left')
        : fieldSortTarget.value === 'diff-right' ? ctx.getDiffSideEditor('right') : ctx.getInputEditor();

    const queryPaths = (kind: 'root' | 'field', query: string, cb: (suggestions: PathSuggestion[]) => void) => {
        let suggestions: PathSuggestion[] = [];
        try {
            const raw = getSortSourceEditor()?.getValue() || '';
            if (raw.trim()) {
                const { data, escapeMap } = ctx.preprocessJSON(raw, { preserveNumberLiterals: true });
                suggestions = kind === 'root'
                    ? getRootPathSuggestions(data, query)
                    : getFieldPathSuggestions(data, sortRootPath.value, query);
                // Protected escape placeholders are internal and change on each parse.
                // Never offer them as user-editable paths; keep the sort/escape contract intact.
                const tokens = Array.from(escapeMap.keys()) as string[];
                if (tokens.length) suggestions = suggestions.filter(item => !tokens.some(token => item.value.includes(token)));
            }
        } catch {
            // Invalid/incomplete JSON has no suggestions. Execution reports parse errors.
        }
        cb(suggestions);
    };

    const queryRootPaths = (query: string, cb: (suggestions: PathSuggestion[]) => void) => queryPaths('root', query, cb);
    const queryFieldPathsFromScope = (query: string, cb: (suggestions: PathSuggestion[]) => void) => queryPaths('field', query, cb);

    const getTypeLabel = (type: string): string => {
        const typeMap: Record<string, string> = {
            exact: ctx.settingsTxt.value.sortTypeExact,
            'array-wildcard': ctx.settingsTxt.value.sortTypeArrayWildcard,
            'array-index': ctx.settingsTxt.value.sortTypeArrayIndex,
            wildcard: ctx.settingsTxt.value.sortTypeWildcard,
            key: ctx.settingsTxt.value.sortTypeKey,
        };
        return typeMap[type] || type;
    };

    const performFieldSort = (data: any, rootPath: string, fieldName: string) => {
        const path = rootPath.trim();
        const field = fieldName.trim();
        if (!isValidJsonPath(path)) throw new Error(ctx.settingsTxt.value.msgFieldSortInvalidPath(path));
        if (!isValidJsonPath(field)) throw new Error(ctx.settingsTxt.value.msgFieldSortInvalidField(field));
        let result = JSON.parse(JSON.stringify(data));
        const targets = [...resolveFieldSortTargets(result, path)];
        if (path && !path.includes('[*]') && targets.length === 0) {
            throw new Error(ctx.settingsTxt.value.msgFieldSortPathNotSortable(path));
        }
        for (const target of targets) {
            const sorted = sortJsonByField(target.value, field, ctx.sortOrder.value);
            if (target.parent === null) result = sorted;
            else Object.defineProperty(target.parent, target.key!, { value: sorted, enumerable: true, configurable: true, writable: true });
        }
        return result;
    };

    const showFieldSortDemo = async () => {
        if (disposed || demoStarting || isDemoMode.value || !ctx.ensureProcessingFeatureAvailable()) return;
        demoStarting = true;
        const generation = ++demoGeneration;
        fieldSortDialogVisible.value = false;
        savedSortState = {
            root: sortRootPath.value, field: sortFieldName.value,
            order: ctx.sortOrder.value, method: ctx.sortMethod.value, target: fieldSortTarget.value,
        };
        demoStartedFromDiff.value = ctx.isDiffMode.value;
        try {
            if (ctx.isDiffMode.value) await ctx.exitDiffMode();
            if (disposed || generation !== demoGeneration) return;
            fieldSortTarget.value = 'input';
            hasExternalDemoSnapshot = true;
            ctx.onDemoSessionStart?.();
            if (!editorDemoSession.begin({ language: 'json' })) {
                endDemoMode();
                ctx.showMessageError(ctx.settingsTxt.value.msgNoAvailableEditor);
                return;
            }
            startDemoMode();
        } catch (error) {
            if (!disposed && generation === demoGeneration) {
                endDemoMode();
                ctx.showMessageError(ctx.settingsTxt.value.msgSortFail(error instanceof Error ? error.message : String(error)));
            }
        } finally {
            demoStarting = false;
        }
    };

    const startDemoMode = () => {
        if (disposed || !editorDemoSession.active) return;
        isDemoMode.value = true;
        showDemoStep(0);
    };

    // The four foundational usages are independent examples. Selecting one
    // prepares its real input and parameters; one click performs the real sort.
    const showDemoStep = (example: number, completed = false) => {
        if (disposed || !isDemoMode.value || example < 0 || example > 3) return;
        currentDemoStep.value = example;
        demoResultVisible = completed;
        const txt = ctx.settingsTxt.value;
        const examples = [
            {
                text: txt.demoTabArrayId,
                goal: txt.demoArrayIdGoal, reason: txt.demoArrayIdReason, transferHint: txt.demoArrayIdTransferHint,
                root: '', field: 'id', data: demoData.value,
            },
            {
                text: txt.demoTabArrayNested,
                goal: txt.demoArrayEducationGoal, reason: txt.demoArrayEducationReason, transferHint: txt.demoArrayEducationTransferHint,
                root: '[*].education', field: 'graduationYear', data: demoData.value,
            },
            {
                text: txt.demoTabMapId,
                goal: txt.demoMapIdGoal, reason: txt.demoMapIdReason, transferHint: txt.demoMapIdTransferHint,
                root: '', field: 'id', data: demoMapData.value,
            },
            {
                text: txt.demoTabMapNested,
                goal: txt.demoMapScoreGoal, reason: txt.demoMapScoreReason, transferHint: txt.demoMapScoreTransferHint,
                root: '', field: 'value.score', data: demoMapData.value,
            },
        ];
        const selected = examples[example];
        sortRootPath.value = selected.root;
        sortFieldName.value = selected.field;
        const inputEditor = ctx.getInputEditor();
        if (inputEditor) {
            const content = JSON.stringify(selected.data, null, 2);
            if (inputEditor.getValue() !== content) inputEditor.setValue(content);
            refreshEditorAfterDemoContentChange(inputEditor);
        }
        if (completed) {
            const result = performFieldSort(selected.data, selected.root, selected.field);
            const outputEditor = ctx.getOutputEditor();
            if (outputEditor) {
                const content = ctx.formatDemoResult(result, selected.data);
                if (outputEditor.getValue() !== content) outputEditor.setValue(content);
                refreshEditorAfterDemoContentChange(outputEditor);
            }
        } else {
            ctx.clearOutputEditor();
        }
        currentDemoStepData.value = {
            title: txt.demoExamplesTitle,
            goal: selected.goal,
            reason: selected.reason,
            transferHint: selected.transferHint,
            highlight: completed ? '.editor-panel-output' : '.editor-panel-input',
            examples: examples.map((item, index) => ({ text: item.text, action: () => showDemoStep(index) })),
            completed,
            buttons: [
                { text: txt.demoEnd, action: () => endDemoMode() },
                { text: txt.demoExecuteSort, type: 'primary', action: () => showDemoStep(example, true) },
            ],
        };
        demoGuideVisible.value = true;
        const generation = demoGeneration;
        nextTick(() => {
            if (disposed || !isDemoMode.value || generation !== demoGeneration || currentDemoStep.value !== example || demoResultVisible !== completed) return;
            updateDemoPopoverAnchor(currentDemoStepData.value?.highlight ?? null);
        });
    };

    const finishDemo = (returnToDiff: boolean) => {
        ++demoGeneration;
        const shouldReturnToDiff = returnToDiff && demoStartedFromDiff.value;
        demoStartedFromDiff.value = false;
        isDemoMode.value = false;
        demoGuideVisible.value = false;
        currentDemoStepData.value = null;
        demoPopoverAnchor.value = null;
        applyDemoHighlight(null);
        editorDemoSession.restore();
        if (hasExternalDemoSnapshot) {
            hasExternalDemoSnapshot = false;
            ctx.onDemoSessionRestore?.();
        }
        if (savedSortState) {
            sortRootPath.value = savedSortState.root;
            sortFieldName.value = savedSortState.field;
            ctx.sortOrder.value = savedSortState.order;
            ctx.sortMethod.value = savedSortState.method;
            fieldSortTarget.value = savedSortState.target;
            savedSortState = null;
        }
        if (!disposed) {
            for (const editor of [ctx.getInputEditor(), ctx.getOutputEditor()]) {
                if (editor) refreshEditorAfterDemoContentChange(editor);
            }
            if (shouldReturnToDiff) ctx.enterDiffMode();
        }
    };

    const endDemoMode = () => finishDemo(true);
    const stopDemoTextWatch = watch([ctx.settingsTxt, ctx.sortOrder], () => {
        if (isDemoMode.value) showDemoStep(currentDemoStep.value, demoResultVisible);
    });
    const dispose = () => {
        if (disposed) return;
        disposed = true;
        stopDemoTextWatch();
        finishDemo(false);
    };
    // The workbench lazy-loads this composable after setup; it also calls dispose
    // explicitly. Scope cleanup covers synchronous consumers and test fixtures.
    if (getCurrentScope()) onScopeDispose(dispose);

    const executeFieldSort = () => {
        if (!ctx.ensureProcessingFeatureAvailable()) return;
        fieldSortDialogVisible.value = false;

        const target = fieldSortTarget.value;
        const sourceEditor = getSortSourceEditor();

        if (!sourceEditor) {
            ctx.showMessageError(ctx.settingsTxt.value.msgNoAvailableEditor);
            return;
        }

        const writeResult = (finalOutput: string) => {
            if (target === 'input') {
                ctx.writeOutputJson(finalOutput);
            } else {
                const side = target === 'diff-left' ? 'left' : 'right';
                replaceEditorValuePreservingUndo(sourceEditor, finalOutput, `diff-field-sort-${side}`);
            }
        };

        try {
            const value = sourceEditor.getValue() || '';
            const result = ctx.preprocessJSON(value, { preserveNumberLiterals: true });

            const rootPathTrim = sortRootPath.value.trim();
            const fieldTrim = sortFieldName.value.trim();

            let finalResult;
            try {
                finalResult = performFieldSort(result.data, rootPathTrim, fieldTrim);
            } catch (e: any) {
                ctx.showMessageError(ctx.settingsTxt.value.msgSortFail(e.message));
                return;
            }

            const finalOutput = ctx.formatJsonResult(finalResult, result.escapeMap);
            writeResult(finalOutput);

            const rootDesc = rootPathTrim ? ctx.settingsTxt.value.fieldSortPathData(rootPathTrim) : ctx.settingsTxt.value.fieldSortRootData;
            ctx.showMessageSuccess(ctx.settingsTxt.value.msgFieldSortSuccess(fieldTrim, rootDesc));
        } catch (error: any) {
            ctx.showMessageError(ctx.settingsTxt.value.msgSortFail(error.message));
        }
    };

    const applySort = () => {
        if (!ctx.ensureProcessingFeatureAvailable()) return;
        try {
            const value = ctx.getInputEditor()?.getValue() || '';

            if (!value.trim()) {
                ctx.showMessageError(ctx.settingsTxt.value.msgSortDataRequired);
                return;
            }

            if (ctx.sortMethod.value === 'field') {
                fieldSortTarget.value = 'input';
                sortRootPath.value = '';
                sortFieldName.value = '';
                fieldSortDialogVisible.value = true;
                return;
            }

            ctx.setOutputTypeJson();
            const result = ctx.preprocessJSON(value, { preserveNumberLiterals: true });
            const sorted = sortJsonObject(result.data, ctx.sortMethod.value, ctx.sortOrder.value, '');
            const outputResult = ctx.formatJsonResult(sorted, result.escapeMap);
            ctx.writeOutputJson(outputResult);

            ctx.showMessageSuccess(ctx.settingsTxt.value.msgSortFormatSuccess(ctx.settingsTxt.value.sortFormatJson));
        } catch (error: any) {
            ctx.showMessageError(ctx.settingsTxt.value.msgSortFail(error.message));
        }
    };

    const openFieldSortDialogForDiff = (side: 'left' | 'right') => {
        fieldSortTarget.value = side === 'left' ? 'diff-left' : 'diff-right';
        sortRootPath.value = '';
        sortFieldName.value = '';
        fieldSortDialogVisible.value = true;
    };

    return {
        fieldSortDialogVisible,
        sortRootPath,
        sortFieldName,
        fieldSortTarget,
        isDemoMode,
        demoGuideVisible,
        currentDemoStepData,
        demoPopoverAnchor,
        demoPopoverPlacement,
        currentDemoStep,
        queryRootPaths,
        queryFieldPathsFromScope,
        getTypeLabel,
        showFieldSortDemo,
        executeFieldSort,
        endDemoMode,
        applySort,
        openFieldSortDialogForDiff,
        dispose,
    };
};

export type UseJsonSortReturn = ReturnType<typeof useJsonSort>;
