import { onBeforeUnmount } from 'vue';
import JsonFoldingInfoWorker from '../workers/jsonFoldingInfo.worker?worker';
import { buildJsonFoldingSummaryIndex, createEmptyJsonFoldingSummaryIndex, type JsonFoldingSummaryIndex } from '../utils/foldingInfo';

const FOLDING_PRECOMPUTE_MAX_CHARS = 256 * 1024 * 1024;
const FOLDING_INFO_WORKER_MIN_CHARS = 10 * 1024 * 1024;

interface FoldingInfoModel {
    getVersionId: () => number;
    getValueLength: () => number;
    getValue: () => string;
    isDisposed: () => boolean;
}

interface FoldingInfoSnapshot {
    model: FoldingInfoModel;
    version: number;
}

interface FoldingInfoRequest {
    id: number;
    snapshot: FoldingInfoSnapshot | null;
    cacheable: boolean;
    promise: Promise<boolean>;
    resolve: (result: boolean) => void;
}

interface FoldingInfoEditorHooks {
    getModel?: () => FoldingInfoModel | null;
    __clearFoldingInfoElements?: () => void;
    __enableFoldingInfoUpdateAndRefresh?: () => void;
}

interface UseJsonFoldingSummaryPrecomputeOptions {
    getOutputEditor: () => FoldingInfoEditorHooks | null | undefined;
}

export const shouldPrecomputeJsonFoldingInfo = (charCount: number) => charCount <= FOLDING_PRECOMPUTE_MAX_CHARS;

export const getJsonFoldingInfoPrecomputeDelay = (charCount: number) => {
    if (charCount >= 128 * 1024 * 1024) return 1200;
    if (charCount >= 64 * 1024 * 1024) return 800;
    if (charCount >= FOLDING_INFO_WORKER_MIN_CHARS) return 300;
    return 0;
};

export const useJsonFoldingSummaryPrecompute = (options: UseJsonFoldingSummaryPrecomputeOptions) => {
    let disposed = false;
    let scheduledTimer: ReturnType<typeof setTimeout> | null = null;
    let foldingInfoWorker: Worker | null = null;
    let resolveFoldingInfoWorker: ((result: JsonFoldingSummaryIndex | null) => void) | null = null;
    let precomputedFoldingInfoIndex = createEmptyJsonFoldingSummaryIndex();
    let foldingInfoBuildRequestId = 0;
    let pendingRequest: FoldingInfoRequest | null = null;
    let precomputedSnapshot: FoldingInfoSnapshot | null = null;
    let precomputedIsReusable = false;
    const emptyIndex = createEmptyJsonFoldingSummaryIndex();

    const captureSnapshot = (): FoldingInfoSnapshot | null => {
        const model = options.getOutputEditor()?.getModel?.();
        return model && !model.isDisposed() ? { model, version: model.getVersionId() } : null;
    };
    const isSnapshotCurrent = (snapshot: FoldingInfoSnapshot | null) => {
        const model = options.getOutputEditor()?.getModel?.() ?? null;
        return snapshot ? model === snapshot.model && !model.isDisposed() && model.getVersionId() === snapshot.version : model === null;
    };
    const sameSnapshot = (a: FoldingInfoSnapshot | null, b: FoldingInfoSnapshot | null) =>
        a !== null && b !== null && a.model === b.model && a.version === b.version;
    const getFoldingSummaryIndex = () => isSnapshotCurrent(precomputedSnapshot) ? precomputedFoldingInfoIndex : emptyIndex;

    const stopWorker = () => {
        if (foldingInfoWorker) {
            foldingInfoWorker.terminate();
            foldingInfoWorker = null;
        }
        if (resolveFoldingInfoWorker) {
            resolveFoldingInfoWorker(null);
            resolveFoldingInfoWorker = null;
        }
    };

    const cancelFoldingInfoWorker = () => {
        foldingInfoBuildRequestId++;
        if (scheduledTimer !== null) clearTimeout(scheduledTimer);
        scheduledTimer = null;
        pendingRequest?.resolve(false);
        pendingRequest = null;
        stopWorker();
    };
    onBeforeUnmount(() => {
        disposed = true;
        resetPrecomputedFoldingInfo();
    });

    const resetPrecomputedFoldingInfo = () => {
        cancelFoldingInfoWorker();
        precomputedFoldingInfoIndex = emptyIndex;
        precomputedSnapshot = null;
        precomputedIsReusable = false;
    };

    const clearOutputFoldingInfo = () => {
        resetPrecomputedFoldingInfo();
        options.getOutputEditor()?.__clearFoldingInfoElements?.();
    };

    const buildFoldingInfoInWorker = (formattedText: string, requestId: number): Promise<JsonFoldingSummaryIndex | null> => {
        stopWorker();

        return new Promise((resolve) => {
            resolveFoldingInfoWorker = resolve;
            let worker: Worker;
            try {
                worker = new JsonFoldingInfoWorker();
                foldingInfoWorker = worker;
            } catch {
                resolveFoldingInfoWorker = null;
                resolve(null);
                return;
            }

            const cleanup = () => {
                if (foldingInfoWorker === worker) {
                    worker.terminate();
                    foldingInfoWorker = null;
                }
                if (resolveFoldingInfoWorker === resolve) {
                    resolveFoldingInfoWorker = null;
                }
            };

            worker.onmessage = (event: MessageEvent<{ id: number; startLines?: Uint32Array; counts?: Uint32Array; types?: Uint8Array; error?: string }>) => {
                const { id, startLines, counts, types, error } = event.data;
                cleanup();

                if (id !== requestId || error || !startLines || !counts || !types) {
                    resolve(null);
                    return;
                }

                resolve({
                    startLines,
                    counts,
                    types,
                });
            };

            const fail = () => { cleanup(); resolve(null); };
            worker.onerror = fail;
            worker.onmessageerror = fail;
            try { worker.postMessage({ id: requestId, input: formattedText }); }
            catch { fail(); }
        });
    };

    const isRequestCurrent = (request: FoldingInfoRequest) => !disposed && request.id === foldingInfoBuildRequestId
        && isSnapshotCurrent(request.snapshot);

    const refreshFoldingInfo = () => {
        // A detached display hook must not leave a completed Worker promise unsettled.
        try { options.getOutputEditor()?.__enableFoldingInfoUpdateAndRefresh?.(); } catch {}
    };

    const finishRequest = (request: FoldingInfoRequest, result: JsonFoldingSummaryIndex | null) => {
        const accepted = result !== null && isRequestCurrent(request);
        if (accepted) {
            precomputedFoldingInfoIndex = result;
            // Only model-sourced requests are reusable. A raw string need not be the model's value.
            precomputedSnapshot = request.snapshot;
            precomputedIsReusable = request.cacheable;
            refreshFoldingInfo();
        }
        if (pendingRequest === request) pendingRequest = null;
        request.resolve(accepted);
    };

    const runRequest = (request: FoldingInfoRequest, formattedText?: string) => {
        if (!isRequestCurrent(request)) { finishRequest(request, null); return; }
        const charCount = formattedText?.length ?? request.snapshot?.model.getValueLength();
        if (charCount === undefined || !shouldPrecomputeJsonFoldingInfo(charCount)) {
            finishRequest(request, null);
            return;
        }
        try {
            // Do not read or retain a full model string in timers, cache keys, or pending requests.
            const text = formattedText ?? request.snapshot!.model.getValue();
            if (text.length >= FOLDING_INFO_WORKER_MIN_CHARS) {
                buildFoldingInfoInWorker(text, request.id).then(result => finishRequest(request, result), () => finishRequest(request, null));
            } else {
                finishRequest(request, buildJsonFoldingSummaryIndex(text));
            }
        } catch {
            finishRequest(request, null);
        }
    };

    const requestPrecompute = (formattedText: string | undefined, delay: number | null): Promise<boolean> => {
        if (disposed) return Promise.resolve(false);
        const snapshot = captureSnapshot();
        const cacheable = formattedText === undefined && snapshot !== null;
        if (cacheable && precomputedIsReusable && sameSnapshot(precomputedSnapshot, snapshot)) {
            refreshFoldingInfo();
            return Promise.resolve(true);
        }
        if (cacheable && pendingRequest?.cacheable && sameSnapshot(pendingRequest.snapshot, snapshot)) {
            return pendingRequest.promise;
        }
        // Stop obsolete work now, rather than keeping its full Worker input alive during the debounce.
        cancelFoldingInfoWorker();
        precomputedFoldingInfoIndex = emptyIndex;
        precomputedSnapshot = null;
        precomputedIsReusable = false;
        let resolve!: (result: boolean) => void;
        const promise = new Promise<boolean>(done => { resolve = done; });
        const request: FoldingInfoRequest = { id: foldingInfoBuildRequestId, snapshot, cacheable, promise, resolve };
        pendingRequest = request;
        if (delay === null) {
            runRequest(request, formattedText);
        } else {
            scheduledTimer = setTimeout(() => {
                scheduledTimer = null;
                runRequest(request, formattedText);
            }, delay);
        }
        return promise;
    };

    const precomputeFoldingInfo = (formattedText?: string) => requestPrecompute(formattedText, null);
    const schedulePrecomputeFoldingInfo = (formattedText?: string, delay: number = 0) => requestPrecompute(formattedText, delay);

    return {
        getFoldingSummaryIndex,
        cancelFoldingInfoWorker,
        resetPrecomputedFoldingInfo,
        clearOutputFoldingInfo,
        precomputeFoldingInfo,
        schedulePrecomputeFoldingInfo,
        shouldPrecomputeFoldingInfo: shouldPrecomputeJsonFoldingInfo,
        getFoldingInfoPrecomputeDelay: getJsonFoldingInfoPrecomputeDelay,
    };
};
