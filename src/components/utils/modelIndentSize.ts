import type * as monaco from 'monaco-editor/esm/vs/editor/editor.api';
import { detectIndentSize } from './indentUtils';

// Keep only numbers, never model text. The zero sentinel lets each caller apply
// its current fallback without rescanning an unchanged document.
const indents = new WeakMap<monaco.editor.ITextModel, { version: number; detected: number }>();

export const getModelDisplayIndentSize = (
    model: monaco.editor.ITextModel | null,
    language: string,
    fallback: number = 4,
    change?: monaco.editor.IModelContentChangedEvent,
): number => {
    if (language !== 'json' || !model) return fallback;
    const version = model.getVersionId();
    const cached = indents.get(model);
    if (!model.isDisposed() && cached) {
        // Only the first nine UTF-16 characters of a line can supply 1–8 ASCII
        // spaces followed by a non-whitespace character. Body-only edits and
        // EOL changes preserve that result. Callers must pass this model's event.
        if (change && cached.version + 1 === version && change.versionId === version && !change.isFlush
            && (change.isEolChange || change.changes.every(edit =>
                edit.range.startLineNumber === edit.range.endLineNumber
                && edit.range.startColumn >= 10 && !/[\r\n]/.test(edit.text)))) {
            cached.version = version;
        }
        if (cached.version === version) return cached.detected || fallback;
    }

    // Model accessors retain Monaco's disposed-model errors. Edits, undo/redo
    // and EOL changes bump the version before notifying content listeners.
    const detected = detectIndentSize(model.getValue(), 0);
    indents.set(model, { version, detected });
    return detected || fallback;
};
