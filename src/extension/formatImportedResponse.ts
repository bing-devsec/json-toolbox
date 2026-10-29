import { startFormatTask, type FormatTask } from '../components/utils/formatWorkerClient';
import type { JsonFormatterOptions } from '../components/utils/jsonEngine/types';
import type { ImportFormatWarning } from './importSession';
import type { ExternalJsonImport, ImportApplyResult } from './externalImport';

export interface PreparedResponse { text: string; warning?: ImportFormatWarning }
export interface ResponseFormatTask { promise: Promise<PreparedResponse>; cancel: () => void }
const MAX_FORMATTED_CHARS = 64 * 1024 * 1024;
const FORMAT_TIMEOUT_MS = 30_000;
const abortError = () => Object.assign(new Error('Cancelled'), { name: 'AbortError' });

/** Conservative output budget, without parsing/copying the body on the UI thread.
 * Six output characters per input character covers escaped string/code units;
 * each structural token additionally reserves a line and its indentation.
 * Quotes and comments must be skipped so string contents cannot invent nesting.
 */
export function fitsResponseFormatBudget(input: string, indentSize: number, maxChars = MAX_FORMATTED_CHARS): boolean {
    let estimate = input.length * 6 + 2;
    if (estimate > maxChars) return false;
    let depth = 0;
    let quote = '';
    let comment: 'line' | 'block' | '' = '';
    for (let i = 0; i < input.length; i++) {
        const ch = input[i];
        if (comment === 'line') { if (ch === '\n' || ch === '\r') comment = ''; continue; }
        if (comment === 'block') { if (ch === '*' && input[i + 1] === '/') { comment = ''; i++; } continue; }
        if (quote) {
            if (ch === '\\') i++;
            else if (ch === quote) quote = '';
            continue;
        }
        if (ch === '"' || ch === "'") { quote = ch; continue; }
        if (ch === '/' && input[i + 1] === '/') { comment = 'line'; i++; continue; }
        if (ch === '/' && input[i + 1] === '*') { comment = 'block'; i++; continue; }
        if (ch === '{' || ch === '[') depth++;
        if (ch === '}' || ch === ']') depth = Math.max(0, depth - 1);
        if (depth > 100) return false;
        if ('{}[],:'.includes(ch)) estimate += (depth + 1) * indentSize + 4;
        if (estimate > maxChars) return false;
    }
    return true;
}

/** Independent from manual Format/Repair: imported responses never trigger repair. */
export function startImportedResponseFormat(
    input: string,
    settings: JsonFormatterOptions,
    dependencies: { start?: typeof startFormatTask; maxChars?: number; timeoutMs?: number } = {},
): ResponseFormatTask {
    let cancelled = false;
    let timedOut = false;
    let workerTask: FormatTask | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const options = { ...settings, preserveNumberLiterals: true };
    const maxChars = dependencies.maxChars ?? MAX_FORMATTED_CHARS;
    // Defer starting so cancellation also works before worker creation/preflight.
    const promise = Promise.resolve().then(async (): Promise<PreparedResponse> => {
        if (cancelled) throw abortError();
        if (!fitsResponseFormatBudget(input, options.indentSize, maxChars)) {
            return { text: input, warning: 'FORMAT_TOO_LARGE' };
        }
        try {
            workerTask = (dependencies.start ?? startFormatTask)(input, options, false, () => {});
            timer = setTimeout(() => { timedOut = true; workerTask?.cancel(); }, dependencies.timeoutMs ?? FORMAT_TIMEOUT_MS);
            const result = await workerTask.promise;
            if (cancelled) throw abortError();
            if (result.formatted.length > maxChars) return { text: input, warning: 'FORMAT_TOO_LARGE' };
            return { text: result.formatted };
        } catch (error) {
            if (cancelled || (!timedOut && error instanceof Error && error.name === 'AbortError')) throw error;
            return { text: input, warning: 'FORMAT_FAILED' };
        } finally {
            if (timer !== undefined) clearTimeout(timer);
            workerTask = undefined;
        }
    });
    return { promise, cancel: () => { cancelled = true; workerTask?.cancel(); } };
}

interface EditorSnapshot { model: object | null; version: number; ready: boolean; hasContent: boolean }
/** Keeps asynchronous formatting outside Monaco and commits only to the untouched model. */
export function createFormattedImportController(options: {
    readEditor: () => EditorSnapshot;
    settings: () => JsonFormatterOptions;
    write: (request: ExternalJsonImport) => ImportApplyResult;
    imported: (id: string, warning?: ImportFormatWarning) => void;
    failed: (id: string, reason: string) => void;
    format?: (text: string, options: JsonFormatterOptions) => ResponseFormatTask;
}) {
    let disposed = false;
    let active: { id: string; task: ResponseFormatTask } | undefined;
    const completed = new Map<string, ImportFormatWarning | undefined>();
    const cancel = () => { const previous = active; active = undefined; previous?.task.cancel(); };
    return {
        async apply(request: ExternalJsonImport | null | undefined): Promise<void> {
            if (disposed) return;
            if (request && active?.id === request.id) return;
            cancel();
            if (!request) return;
            if (completed.has(request.id)) { options.imported(request.id, completed.get(request.id)); return; }
            const before = options.readEditor();
            if (!before.ready || !before.model) return;
            if (before.hasContent) { options.failed(request.id, 'EDITOR_HAS_CONTENT'); return; }
            let run: typeof active;
            let committing = false;
            try {
                const task = (options.format ?? startImportedResponseFormat)(request.text, options.settings());
                run = { id: request.id, task }; active = run;
                const prepared = await task.promise;
                if (disposed || active !== run) return;
                active = undefined;
                committing = true;
                const after = options.readEditor();
                if (!after.ready || after.model !== before.model || after.version !== before.version) {
                    options.failed(request.id, 'EDITOR_CHANGED'); return;
                }
                const result = options.write({ id: request.id, text: prepared.text });
                if (result === 'applied' || result === 'already-applied') {
                    completed.set(request.id, prepared.warning);
                    options.imported(request.id, prepared.warning);
                } else options.failed(request.id, result === 'occupied' ? 'EDITOR_HAS_CONTENT' : 'EDITOR_IMPORT_FAILED');
            } catch {
                if (!disposed && (!run || active === run || committing)) {
                    active = undefined;
                    options.failed(request.id, 'EDITOR_IMPORT_FAILED');
                }
            }
        },
        editorChanged(): void {
            const id = active?.id;
            cancel();
            if (id && !disposed) options.failed(id, 'EDITOR_CHANGED');
        },
        cancel,
        dispose(): void { disposed = true; cancel(); completed.clear(); },
    };
}
