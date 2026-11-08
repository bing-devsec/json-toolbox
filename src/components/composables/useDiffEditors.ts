import { onBeforeUnmount } from 'vue';
import { createDiffEditorState } from '../utils/diffEditorState';
import { createDiffDrafts } from '../utils/diffDrafts';
import type { UseDiffEditorsOptions, UseDiffEditorsReturn } from './diffEditorRuntime';

export type { UseDiffEditorsOptions, UseDiffEditorsReturn } from './diffEditorRuntime';

type RuntimeModule = typeof import('./diffEditorRuntime');
const loadRuntime = () => import('./diffEditorRuntime');

/** Synchronous state/lifecycle facade; Monaco rendering is only loaded by the Diff pane. */
export const useDiffEditors = (
    opts: UseDiffEditorsOptions,
    load: () => Promise<RuntimeModule> = loadRuntime,
): UseDiffEditorsReturn => {
    const state = createDiffEditorState(opts.localeState);
    let runtime: UseDiffEditorsReturn | undefined;
    let loading: Promise<RuntimeModule> | undefined;
    let generation = 0;
    let disposed = false;
    const getDiffLeftEditor = () => runtime?.getDiffLeftEditor() ?? null;
    const getDiffRightEditor = () => runtime?.getDiffRightEditor() ?? null;
    const getDiffSideEditor: UseDiffEditorsReturn['getDiffSideEditor'] = side => runtime?.getDiffSideEditor(side) ?? null;
    const drafts = createDiffDrafts(state, { ...opts, getEditors: () => [getDiffLeftEditor(), getDiffRightEditor()] });
    const createDiffEditor = async () => {
        if (disposed) return;
        const request = generation;
        if (!runtime) {
            loading ??= load().catch(error => { loading = undefined; throw error; });
            let module: RuntimeModule;
            try { module = await loading; }
            catch (error) {
                if (disposed || generation !== request) return;
                throw error;
            }
            if (disposed || generation !== request) return;
            runtime ??= module.createDiffEditorRuntime(opts, state, drafts);
        }
        if (!disposed && generation === request) await runtime.createDiffEditor();
    };
    const destroyDiffEditor = () => {
        generation++;
        drafts.invalidate();
        opts.localeState = undefined;
        runtime?.destroyDiffEditor();
    };
    onBeforeUnmount(() => {
        disposed = true;
        destroyDiffEditor();
        drafts.dispose();
    });
    return {
        ...state,
        createDiffEditor, destroyDiffEditor,
        getDiffLeftEditor, getDiffRightEditor, getDiffSideEditor,
        isDiffEditorReady: () => runtime?.isDiffEditorReady() ?? false,
        captureDiffDraftFromEditors: drafts.captureDiffDraftFromEditors,
        saveDiffDraft: drafts.saveDiffDraft,
        loadDiffDraftSnapshot: drafts.loadDiffDraftSnapshot,
        restoreDiffDraftIntoEditors: async () => { await runtime?.restoreDiffDraftIntoEditors(); },
        cancelComparison: () => runtime?.cancelComparison(),
        scheduleDiffEditorLayout: () => runtime?.scheduleDiffEditorLayout(),
        scheduleDiffRecompute: () => runtime?.scheduleDiffRecompute(),
        recomputeDiff: () => runtime?.recomputeDiff(),
        updateDiffSyncButtons: () => runtime?.updateDiffSyncButtons(),
        goToNextDiff: () => runtime?.goToNextDiff(),
        goToPrevDiff: () => runtime?.goToPrevDiff(),
        revealDiffChange: index => runtime?.revealDiffChange(index),
        handleDiffSync: (index, direction) => runtime?.handleDiffSync(index, direction),
        updateDiffEditorOptions: options => runtime?.updateDiffEditorOptions(options),
        layoutDiffEditors: () => runtime?.layoutDiffEditors(),
    };
};
