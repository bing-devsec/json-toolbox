import type { ExternalJsonImport } from './externalImport';
import type { CapturedImport, ReadImportOptions } from './captureClient';

export type ImportFormatWarning = 'FORMAT_FAILED' | 'FORMAT_TOO_LARGE';

export interface CaptureImportState {
    phase: 'idle' | 'reading' | 'ready' | 'imported' | 'error';
    request: ExternalJsonImport | null;
    sourceDisplayUrl: string;
    error: unknown;
    cleanupError: unknown;
    formatWarning: ImportFormatWarning | null;
}
export const emptyCaptureImportState = (): CaptureImportState => ({
    phase: 'idle', request: null, sourceDisplayUrl: '', error: null, cleanupError: null, formatWarning: null,
});

/** Hand off a local ticket only once; acknowledge after the editor has accepted its prepared text. */
export const createCaptureImportSession = (options: {
    id: string;
    read: (id: string, options: ReadImportOptions) => Promise<CapturedImport>;
    acknowledge: (id: string) => Promise<void>;
    onChange: (state: CaptureImportState) => void;
    onAcknowledged?: () => void;
}) => {
    let state = emptyCaptureImportState();
    let revision = 0;
    let disposed = false;
    let abort: AbortController | undefined;
    const publish = (next: CaptureImportState) => { state = next; if (!disposed) options.onChange(next); };
    return {
        async load(): Promise<void> {
            if (disposed || state.phase === 'imported') return;
            abort?.abort();
            abort = new AbortController();
            const current = ++revision;
            publish({ ...state, phase: 'reading', request: null, error: null, cleanupError: null, formatWarning: null });
            try {
                const record = await options.read(options.id, { signal: abort.signal });
                if (disposed || current !== revision) return;
                publish({ ...state, phase: 'ready', sourceDisplayUrl: record.sourceDisplayUrl,
                    request: { id: options.id, text: record.text } });
            } catch (error) {
                if (!disposed && current === revision) publish({ ...state, phase: 'error', request: null, error });
            }
        },
        async confirmImported(id: string, warning?: ImportFormatWarning): Promise<void> {
            if (disposed || state.phase !== 'ready' || state.request?.id !== id) return;
            // Release the temporary body immediately; the editor now owns its model.
            publish({ ...state, phase: 'imported', request: null, formatWarning: warning ?? null });
            try {
                await options.acknowledge(id);
                if (!disposed) options.onAcknowledged?.();
            } catch (cleanupError) {
                if (!disposed) publish({ ...state, cleanupError });
            }
        },
        rejectImport(id: string, reason: unknown): void {
            if (!disposed && state.phase === 'ready' && state.request?.id === id) {
                publish({ ...state, phase: 'error', request: null, error: reason });
            }
        },
        dispose(): void { disposed = true; revision++; abort?.abort(); state = emptyCaptureImportState(); },
    };
};
