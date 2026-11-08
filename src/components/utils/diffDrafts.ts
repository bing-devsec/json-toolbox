import type * as monaco from 'monaco-editor/esm/vs/editor/editor.api';
import type { Ref } from 'vue';
import { calculateByteSize } from './byteUtils';
import { IDB_STORE_DIFF_DRAFTS, MAX_DIFF_SIDE_SIZE, MAX_DIFF_TAB_COUNT, idbCount, idbGet, idbPut } from './idb';
import type { DiffEditorState } from './diffEditorState';

interface DiffDraftRecord {
    tabId: string;
    leftText: string;
    rightText: string;
    updatedAt: number;
    version: number;
}

type Editor = monaco.editor.IStandaloneCodeEditor;
interface Options {
    tabId: Ref<string>;
    exactComparison?: Ref<boolean>;
    onError: (message: string) => void;
    getEditors: () => readonly [Editor | null, Editor | null];
}

/** Draft IO remains available in normal mode without downloading Diff rendering. */
export const createDiffDrafts = (state: DiffEditorState, opts: Options) => {
    let generation = 0;
    let readRequest = 0;
    let disposed = false;
    const invalidate = () => { generation++; readRequest++; };
    const enabled = () => !disposed && !opts.exactComparison?.value && typeof window !== 'undefined' && Boolean(opts.tabId.value);
    const captureDiffDraftFromEditors = () => {
        const [left, right] = opts.getEditors();
        if (!left || !right) return;
        state.diffDraftLeftText.value = left.getValue() ?? '';
        state.diffDraftRightText.value = right.getValue() ?? '';
    };
    const saveDiffDraft = async (reason: string) => {
        if (!enabled()) return;
        captureDiffDraftFromEditors();
        const tabId = opts.tabId.value;
        const left = state.diffDraftLeftText.value ?? '';
        const right = state.diffDraftRightText.value ?? '';
        const leftSize = calculateByteSize(left), rightSize = calculateByteSize(right);
        if (leftSize > MAX_DIFF_SIDE_SIZE || rightSize > MAX_DIFF_SIDE_SIZE) {
            opts.onError(`diff 草稿保存失败：左右任一侧内容大小不能超过 30MB（当前左 ${Math.round(leftSize / (1024 * 1024))}MB，右 ${Math.round(rightSize / (1024 * 1024))}MB）`);
            return;
        }
        try {
            const existing = await idbGet<DiffDraftRecord>(IDB_STORE_DIFF_DRAFTS, tabId);
            if (!existing && await idbCount(IDB_STORE_DIFF_DRAFTS) >= MAX_DIFF_TAB_COUNT) {
                opts.onError(`diff 草稿保存失败：已达到标签页数量上限（${MAX_DIFF_TAB_COUNT}个）`);
                return;
            }
            await idbPut(IDB_STORE_DIFF_DRAFTS, { tabId, leftText: left, rightText: right, updatedAt: Date.now(), version: 1 });
        } catch (error: any) {
            if (!disposed) opts.onError(`diff 草稿保存失败（${reason}）：${error?.message ?? String(error)}`);
        }
    };
    const readSnapshot = async (restore: boolean) => {
        if (!enabled()) return;
        const currentGeneration = generation;
        const request = ++readRequest;
        const tabId = opts.tabId.value;
        const leftText = state.diffDraftLeftText.value, rightText = state.diffDraftRightText.value;
        const [left, right] = opts.getEditors();
        if (restore && (!left || !right)) return;
        const leftModel = left?.getModel(), rightModel = right?.getModel();
        const leftVersion = leftModel?.getVersionId(), rightVersion = rightModel?.getVersionId();
        const current = () => enabled() && generation === currentGeneration && readRequest === request && opts.tabId.value === tabId
            && state.diffDraftLeftText.value === leftText && state.diffDraftRightText.value === rightText;
        try {
            const record = await idbGet<DiffDraftRecord>(IDB_STORE_DIFF_DRAFTS, tabId);
            if (!current()) return;
            if (restore) {
                const [nextLeft, nextRight] = opts.getEditors();
                if (!record || nextLeft !== left || nextRight !== right || left?.getModel() !== leftModel || right?.getModel() !== rightModel
                    || leftModel?.isDisposed() || rightModel?.isDisposed()
                    || leftModel?.getVersionId() !== leftVersion || rightModel?.getVersionId() !== rightVersion) return;
            }
            state.diffDraftLeftText.value = record?.leftText ?? '';
            state.diffDraftRightText.value = record?.rightText ?? '';
            if (restore) {
                leftModel?.setValue(state.diffDraftLeftText.value);
                rightModel?.setValue(state.diffDraftRightText.value);
            }
        } catch (error: any) {
            if (current()) opts.onError(`diff 草稿${restore ? '恢复' : '加载'}失败：${error?.message ?? String(error)}`);
        }
    };
    return {
        captureDiffDraftFromEditors, saveDiffDraft,
        loadDiffDraftSnapshot: () => readSnapshot(false),
        restoreDiffDraftIntoEditors: () => readSnapshot(true),
        invalidate,
        dispose: () => { disposed = true; invalidate(); },
    };
};
