import type * as monaco from 'monaco-editor/esm/vs/editor/editor.api';

const FOLDING_ID = 'editor.contrib.folding';
const MAX_TRANSFER_REGIONS = 1_000_000;
type Editor = monaco.editor.IStandaloneCodeEditor;
type ViewState = monaco.editor.ICodeEditorViewState;
type FoldRange = { startLineNumber: number; endLineNumber: number; isCollapsed?: boolean; source?: number; checksum?: number };
type FoldStamp = { version: number; language: string; controller: any; promise: any; folding: any; regions: any };
const currentFolding = new WeakMap<object, FoldStamp>();

const getController = (editor: Editor): any => editor.getContribution(FOLDING_ID);
const hasRegionsShape = (regions: any): boolean => Boolean(regions && Number.isInteger(regions.length)
    && regions.length >= 0 && regions.length <= MAX_TRANSFER_REGIONS
    && ['getStartLineNumber', 'getEndLineNumber', 'getType', 'hasTypes', 'isCollapsed', 'setCollapsed', 'getSource', 'setSource']
        .every(key => typeof regions[key] === 'function')
    && typeof regions.constructor?.fromFoldRanges === 'function' && typeof regions.constructor?.sanitizeAndMerge === 'function');

/** Record only folding that was awaited and checked against the current model version.
 * A later native region replacement or text change invalidates this stamp automatically.
 */
export const rememberCurrentTransferFolding = (editor: Editor, folding: any): void => {
    const model = editor.getModel();
    if (!model || model.isDisposed() || folding?.textModel !== model || !hasRegionsShape(folding.regions)
        || getController(editor)?.foldingModel !== folding) return;
    const controller = getController(editor);
    currentFolding.set(model, { version: model.getVersionId(), language: model.getLanguageId(), controller,
        promise: controller.getFoldingModel?.(), folding, regions: folding.regions });
};

const cloneRegions = (regions: any): any => {
    const starts = new Uint32Array(regions.length), ends = new Uint32Array(regions.length);
    const types = regions.hasTypes() ? new Array(regions.length) : undefined;
    for (let i = 0; i < regions.length; i++) {
        starts[i] = regions.getStartLineNumber(i);
        ends[i] = regions.getEndLineNumber(i);
        if (types) types[i] = regions.getType(i);
    }
    // Use the already loaded, source-guarded Monaco constructor. Importing folding runtime
    // here would move Monaco evaluation into the workbench's startup dependency graph.
    const copy = new regions.constructor(starts, ends, types);
    for (let i = 0; i < regions.length; i++) {
        copy.setCollapsed(i, regions.isCollapsed(i));
        copy.setSource(i, regions.getSource(i));
    }
    return copy;
};

export interface TransferFoldingSnapshot {
    readonly lineCount: number;
    readonly language: string;
    readonly ranges: readonly FoldRange[];
    readonly topology: any | null;
}

/** The view state must have just been saved from this editor, before its content changes. */
export const captureTransferFolding = (editor: Editor, viewState: ViewState | null, unchangedText = true): TransferFoldingSnapshot | null => {
    const model = editor.getModel(), state = viewState?.contributionsState?.[FOLDING_ID];
    if (!model || model.isDisposed() || !state || state.lineCount !== model.getLineCount()) return null;
    const ranges = state.collapsedRegions ?? [];
    if (!Array.isArray(ranges) || ranges.length > MAX_TRANSFER_REGIONS || ranges.some((range: FoldRange) =>
        !range || !Number.isInteger(range.startLineNumber) || !Number.isInteger(range.endLineNumber)
        || range.startLineNumber < 1 || range.endLineNumber <= range.startLineNumber || range.endLineNumber > state.lineCount
        || (range.source !== undefined && ![0, 1, 2].includes(range.source))
        || (range.checksum !== undefined && !Number.isFinite(range.checksum)))) return null;
    const stamp = currentFolding.get(model), controller = getController(editor), folding = controller?.foldingModel;
    let topology = null;
    if (unchangedText && stamp && stamp.version === model.getVersionId() && stamp.language === model.getLanguageId()
        && stamp.controller === controller && stamp.promise === controller.getFoldingModel?.() && stamp.folding === folding
        && stamp.regions === folding?.regions && hasRegionsShape(stamp.regions)) {
        try { topology = cloneRegions(stamp.regions); } catch { /* Unsupported runtime stays on the native memento path. */ }
    }
    return { lineCount: state.lineCount, language: model.getLanguageId(), ranges, topology };
};

const getTargetFolding = (editor: Editor, snapshot: TransferFoldingSnapshot | null): any => {
    const model = editor.getModel(), controller = getController(editor), folding = controller?.foldingModel;
    return snapshot && model && !model.isDisposed() && model.getLineCount() === snapshot.lineCount
        && folding?.textModel === model && controller.hiddenRangeModel?._foldingModel === folding && typeof folding.updatePost === 'function'
        && typeof folding._getLinesChecksum === 'function' && hasRegionsShape(folding.regions) ? folding : null;
};

const getRestoredRanges = (snapshot: TransferFoldingSnapshot, folding: any, unchangedText: boolean): FoldRange[] => {
    const ranges: FoldRange[] = [];
    for (const range of snapshot.ranges) {
        const checksum = folding._getLinesChecksum(range.startLineNumber + 1, range.endLineNumber);
        // A trusted indentation-only transformation preserves logical line numbers. Rebase
        // its endpoint checksum; unchanged text retains Monaco's original validation.
        if (!unchangedText || !range.checksum || range.checksum === checksum) ranges.push({ ...range, checksum });
    }
    return ranges;
};

/** Replace stale destination folds in one event, without an intermediate unfoldAll.
 * The caller proves that the transfer is current and its transform preserves line numbers.
 * Native provider computation is deliberately left running.
 */
export const restoreTransferFolding = (editor: Editor, snapshot: TransferFoldingSnapshot | null,
    viewState: ViewState, unchangedText: boolean, isCurrent: () => boolean): boolean => {
    if (!isCurrent()) return false;
    const folding = getTargetFolding(editor, snapshot);
    if (!folding || !snapshot) return false;
    const Regions = folding.regions.constructor;
    const regions = unchangedText && snapshot.topology && snapshot.topology.constructor === Regions
        && editor.getModel()?.getLanguageId() === snapshot.language
        ? snapshot.topology
        : Regions.fromFoldRanges(Regions.sanitizeAndMerge([], getRestoredRanges(snapshot, folding, unchangedText), snapshot.lineCount));
    if (!isCurrent() || getTargetFolding(editor, snapshot) !== folding) return false;
    folding.updatePost(regions);
    if (!isCurrent()) return true;
    const contributionsState = { ...viewState.contributionsState };
    delete contributionsState[FOLDING_ID];
    editor.restoreViewState({ ...viewState, contributionsState });
    return true;
};

/** Small models may recreate their folding controller on nextTick. An unknown adapter
 * stays on native restoration, but no old completion may affect a newer editor/model.
 */
export const restoreTransferFoldingWhenReady = async (editor: Editor, snapshot: TransferFoldingSnapshot | null,
    viewState: ViewState, unchangedText: boolean, isCurrent: () => boolean): Promise<void> => {
    if (!isCurrent()) return;
    const controller = getController(editor);
    const folding = await controller?.getFoldingModel?.();
    if (!isCurrent() || getController(editor) !== controller || (folding && controller.foldingModel !== folding)) return;
    if (restoreTransferFolding(editor, snapshot, viewState, unchangedText, isCurrent)) return;
    // setValue destroys the old fold decorations. The native update awaited above therefore
    // already discarded those old collapsed ranges; an extra asynchronous unfold is unsafe.
    let restoredState = viewState;
    const model = editor.getModel();
    if (!unchangedText && snapshot && model?.getLineCount() === snapshot.lineCount
        && controller?.foldingModel?.textModel === model && typeof controller.foldingModel._getLinesChecksum === 'function') {
        restoredState = { ...viewState, contributionsState: { ...viewState.contributionsState,
            [FOLDING_ID]: { ...viewState.contributionsState[FOLDING_ID], collapsedRegions: getRestoredRanges(snapshot, controller.foldingModel, false) } } };
    }
    if (isCurrent()) editor.restoreViewState(restoredState);
};
