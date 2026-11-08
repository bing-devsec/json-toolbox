import { ref } from 'vue';
import type { DiffLocaleState } from './jsonToolLocaleTransition';

/** State used before the Diff view exists: context menus, drafts and locale handoff. */
export const createDiffEditorState = (localeState?: DiffLocaleState) => ({
    comparisonBusy: ref(false),
    diffCount: ref(0),
    activeDiffIndex: ref(-1),
    diffSyncButtons: ref<Array<{ top: number; changeIndex: number }>>([]),
    diffDraftLeftText: ref(localeState?.left.text ?? ''),
    diffDraftRightText: ref(localeState?.right.text ?? ''),
});
export type DiffEditorState = ReturnType<typeof createDiffEditorState>;
