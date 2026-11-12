import { getRootPathSuggestions, getFieldPathSuggestions, type PathSuggestion } from '../utils/jsonSortSuggestions';
export type { PathSuggestion } from '../utils/jsonSortSuggestions';
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api';
import { nextTick, ref, watch, type Ref } from 'vue';

import { replaceEditorValuePreservingUndo } from '../utils/diffMonaco';
import type { SettingsTxt } from '../utils/i18n';
import { isValidJsonPath } from '../utils/jsonPath';
import { resolveFieldSortTargets } from '../utils/jsonSortScope';
import { sortJsonByField, sortJsonObject, type SortMethod, type SortOrder } from '../utils/jsonSort';

export type FieldSortTarget = 'input' | 'diff-left' | 'diff-right';
export type DemoPopoverPlacement = 'right-start' | 'left-start' | 'bottom-start' | 'top-start';

export interface SortDemoStep {
    title: string;
    content: string;
    highlight: string | null;
    buttons: Array<{ text: string; action: () => void; type?: 'primary' | 'default' }>;
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
    demoStepsCount: Ref<number>;
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
    updateDiffEditorOptions: (options: monaco.editor.IEditorOptions) => void;

    ensureProcessingFeatureAvailable: () => boolean;
    showMessageSuccess: (msg: string) => void;
    showMessageError: (msg: string) => void;

    preprocessJSON: (input: string, options?: { preserveNumberLiterals?: boolean; encodingMode?: boolean }) => PreprocessResult;
    formatJsonResult: (data: any, escapeMap: any) => string;
    formatDemoResult: (data: any, originalData: any) => string;
    writeOutputJson: (content: string) => void;
    setOutputTypeJson: () => void;
    clearOutputEditor: () => void;
    clearOutputFoldingInfo: () => void;
    updateEditorHeight: (editor: monaco.editor.IStandaloneCodeEditor) => void;
    updateLineNumberWidth: (editor: monaco.editor.IStandaloneCodeEditor) => void;
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
    const savedInputContent = ref<string | null>(null);
    const currentDemoStep = ctx.state?.currentDemoStep ?? ref(0);
    const demoStepsCount = ctx.state?.demoStepsCount ?? ref(0);
    const demoStartedFromDiff = ref(false);
    const demoFieldSortTargetBeforeStart = ref<FieldSortTarget>('input');
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

    watch(isDemoMode, (on) => {
        const readOnly = !!on;
        try {
            ctx.getInputEditor()?.updateOptions({ readOnly });
            ctx.getOutputEditor()?.updateOptions({ readOnly });
            ctx.updateDiffEditorOptions({ readOnly });
        } catch {
            // 编辑器尚未初始化也无妨，静默忽略
        }
    });

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
        fieldSortDialogVisible.value = false;
        demoFieldSortTargetBeforeStart.value = fieldSortTarget.value;
        demoStartedFromDiff.value = ctx.isDiffMode.value;

        if (ctx.isDiffMode.value) {
            await ctx.exitDiffMode();
            fieldSortTarget.value = 'input';
        }

        startDemoMode();
    };

    const startDemoMode = () => {
        isDemoMode.value = true;
        currentDemoStep.value = 0;

        const inputEditor = ctx.getInputEditor();
        if (inputEditor && savedInputContent.value === null) {
            try {
                savedInputContent.value = inputEditor.getValue() || '';
            } catch {
                savedInputContent.value = '';
            }
        }

        if (inputEditor) {
            try {
                const demoJson = JSON.stringify(demoData.value, null, 2);
                inputEditor.setValue(demoJson);
                refreshEditorAfterDemoContentChange(inputEditor);
            } catch {
                // ignore
            }
        }

        sortRootPath.value = '';
        sortFieldName.value = '';
        ctx.clearOutputEditor();


        showDemoStep(0);
    };

    const setDemoParams = (rootPath: string, fieldName: string) => {
        sortRootPath.value = rootPath;
        sortFieldName.value = fieldName;
    };

    const setAndNext = (rootPath: string, fieldName: string, nextStep: number) => {
        setDemoParams(rootPath, fieldName);
        showDemoStep(nextStep);
    };

    const execAndNext = (rootPath: string, fieldName: string, nextStep: number) => {
        const dataToUse = demoData.value;
        const result = performFieldSort(dataToUse, rootPath, fieldName);
        const finalOutput = ctx.formatDemoResult(result, dataToUse);
        const outputEditor = ctx.getOutputEditor();
        if (outputEditor) {
            outputEditor.setValue(finalOutput);
            refreshEditorAfterDemoContentChange(outputEditor);
        }
        showDemoStep(nextStep);
    };

    const execAndNextMap = (rootPath: string, fieldName: string, nextStep: number) => {
        const dataToUse = demoMapData.value;
        const result = performFieldSort(dataToUse, rootPath, fieldName);
        const finalOutput = ctx.formatDemoResult(result, dataToUse);
        const outputEditor = ctx.getOutputEditor();
        if (outputEditor) {
            outputEditor.setValue(finalOutput);
            refreshEditorAfterDemoContentChange(outputEditor);
        }
        showDemoStep(nextStep);
    };

    const loadDemoMapNoAdvance = () => {
        const inputEditor = ctx.getInputEditor();
        if (inputEditor) {
            const demoJson = JSON.stringify(demoMapData.value, null, 2);
            inputEditor.setValue(demoJson);
            refreshEditorAfterDemoContentChange(inputEditor);
        }
    };

    const showDemoStep: (step: number) => void = (step: number) => {
        currentDemoStep.value = step;

        const steps: SortDemoStep[] = [
            {
                title: ctx.settingsTxt.value.demoStartTitle,
                content: ctx.settingsTxt.value.demoStartContent,
                highlight: '.editor-panel-input',
                buttons: [{ text: ctx.settingsTxt.value.demoStartButton, type: 'primary', action: () => showDemoStep(1) }],
            },
            {
                title: ctx.settingsTxt.value.demoArrayIdTitle,
                content: ctx.settingsTxt.value.demoArrayIdContent,
                highlight: '.editor-panel-input',
                buttons: [
                    { text: ctx.settingsTxt.value.demoPrev, action: () => showDemoStep(0) },
                    { text: ctx.settingsTxt.value.demoSetParams, type: 'primary', action: () => setAndNext('', 'id', 2) },
                ],
            },
            {
                title: ctx.settingsTxt.value.demoExecuteTitle,
                content: ctx.settingsTxt.value.demoExecuteContent,
                highlight: '.editor-panel-input',
                buttons: [
                    { text: ctx.settingsTxt.value.demoPrev, action: () => showDemoStep(1) },
                    { text: ctx.settingsTxt.value.demoExecuteSort, type: 'primary', action: () => execAndNext('', 'id', 3) },
                ],
            },
            {
                title: ctx.settingsTxt.value.demoSortDoneTitle,
                content: ctx.settingsTxt.value.demoSortDoneContent,
                highlight: null,
                buttons: [
                    { text: ctx.settingsTxt.value.demoPrev, action: () => showDemoStep(2) },
                    { text: ctx.settingsTxt.value.demoNextExample, type: 'primary', action: () => showDemoStep(4) },
                ],
            },
            {
                title: ctx.settingsTxt.value.demoArrayEducationTitle,
                content: ctx.settingsTxt.value.demoArrayEducationContent,
                highlight: '.editor-panel-input',
                buttons: [
                    { text: ctx.settingsTxt.value.demoPrev, action: () => showDemoStep(3) },
                    {
                        text: ctx.settingsTxt.value.demoSetParams, type: 'primary',
                        action: () => setAndNext('[*].education', 'graduationYear', 5),
                    },
                ],
            },
            {
                title: ctx.settingsTxt.value.demoExecuteTitle,
                content: ctx.settingsTxt.value.demoExecuteContent,
                highlight: '.editor-panel-input',
                buttons: [
                    { text: ctx.settingsTxt.value.demoPrev, action: () => showDemoStep(4) },
                    {
                        text: ctx.settingsTxt.value.demoExecuteSort, type: 'primary',
                        action: () => execAndNext('[*].education', 'graduationYear', 6),
                    },
                ],
            },
            {
                title: ctx.settingsTxt.value.demoSortDoneEducationTitle,
                content: ctx.settingsTxt.value.demoSortDoneEducationContent,
                highlight: null,
                buttons: [
                    { text: ctx.settingsTxt.value.demoPrev, action: () => showDemoStep(5) },
                    { text: ctx.settingsTxt.value.demoNextExample, type: 'primary', action: () => showDemoStep(7) },
                ],
            },
            {
                title: ctx.settingsTxt.value.demoMapIdTitle,
                content: ctx.settingsTxt.value.demoMapIdContent,
                highlight: '.editor-panel-input',
                buttons: [
                    { text: ctx.settingsTxt.value.demoPrev, action: () => showDemoStep(6) },
                    { text: ctx.settingsTxt.value.demoSetParams, type: 'primary', action: () => setAndNext('', 'id', 8) },
                ],
            },
            {
                title: ctx.settingsTxt.value.demoExecuteTitle,
                content: ctx.settingsTxt.value.demoMapExecuteContent,
                highlight: '.editor-panel-input',
                buttons: [
                    { text: ctx.settingsTxt.value.demoPrev, action: () => showDemoStep(7) },
                    { text: ctx.settingsTxt.value.demoExecuteSort, type: 'primary', action: () => execAndNextMap('', 'id', 9) },
                ],
            },
            {
                title: ctx.settingsTxt.value.demoMapIdDoneTitle,
                content: ctx.settingsTxt.value.demoMapIdDoneContent,
                highlight: null,
                buttons: [
                    { text: ctx.settingsTxt.value.demoPrev, action: () => showDemoStep(8) },
                    { text: ctx.settingsTxt.value.demoNextExample, type: 'primary', action: () => showDemoStep(10) },
                ],
            },
            {
                title: ctx.settingsTxt.value.demoMapScoreTitle,
                content: ctx.settingsTxt.value.demoMapScoreContent,
                highlight: '.editor-panel-input',
                buttons: [
                    { text: ctx.settingsTxt.value.demoPrev, action: () => showDemoStep(9) },
                    { text: ctx.settingsTxt.value.demoSetParams, type: 'primary', action: () => setAndNext('', 'value.score', 11) },
                ],
            },
            {
                title: ctx.settingsTxt.value.demoExecuteTitle,
                content: ctx.settingsTxt.value.demoMapScoreExecuteContent,
                highlight: '.editor-panel-input',
                buttons: [
                    { text: ctx.settingsTxt.value.demoPrev, action: () => showDemoStep(10) },
                    {
                        text: ctx.settingsTxt.value.demoExecuteSort, type: 'primary',
                        action: () => execAndNextMap('', 'value.score', 12),
                    },
                ],
            },
            {
                title: ctx.settingsTxt.value.demoMapScoreDoneTitle,
                content: ctx.settingsTxt.value.demoMapScoreDoneContent,
                highlight: null,
                buttons: [
                    { text: ctx.settingsTxt.value.demoTryAgain, action: () => startDemoMode() },
                    { text: ctx.settingsTxt.value.demoEnd, type: 'primary', action: () => endDemoMode() },
                ],
            },
        ];
        demoStepsCount.value = steps.length;

        if (step < steps.length) {
            currentDemoStepData.value = steps[step];
            demoGuideVisible.value = true;
            nextTick(() => {
                updateDemoPopoverAnchor(steps[step].highlight);
            });
        }

        if ([1, 4, 7, 10].includes(step)) {
            sortRootPath.value = '';
            sortFieldName.value = '';
            ctx.clearOutputEditor();
        }
        if (step === 7 || step === 10) {
            loadDemoMapNoAdvance();
        }
    };

    const endDemoMode = () => {
        isDemoMode.value = false;
        demoGuideVisible.value = false;
        currentDemoStepData.value = null;
        demoPopoverAnchor.value = null;
        applyDemoHighlight(null);

        const inputEditor = ctx.getInputEditor();
        if (inputEditor) {
            const restored = savedInputContent.value !== null ? savedInputContent.value : '';
            inputEditor.setValue(restored);
            refreshEditorAfterDemoContentChange(inputEditor);
        }

        ctx.clearOutputEditor();
        savedInputContent.value = null;

        const shouldReturnToDiff = demoStartedFromDiff.value;
        fieldSortTarget.value = demoFieldSortTargetBeforeStart.value;
        demoStartedFromDiff.value = false;
        demoFieldSortTargetBeforeStart.value = 'input';

        if (shouldReturnToDiff) {
            ctx.enterDiffMode();
        }
    };

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
        demoStepsCount,
        currentDemoStep,
        queryRootPaths,
        queryFieldPathsFromScope,
        getTypeLabel,
        showFieldSortDemo,
        executeFieldSort,
        endDemoMode,
        applySort,
        openFieldSortDialogForDiff,
    };
};

export type UseJsonSortReturn = ReturnType<typeof useJsonSort>;
