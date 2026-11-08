import type * as monaco from 'monaco-editor/esm/vs/editor/editor.api';

// Cache only numeric results, never a snapshot, selected string or model text.
// Versions change on edits, undo/redo and EOL changes; weak keys do not keep a
// replaced model alive, and no disposal/content listeners are needed.
const byteLengths = new WeakMap<monaco.editor.ITextModel, { version: number; bytes: number }>();
const encoder = new TextEncoder();
const encodingBuffer = new Uint8Array(64 * 1024);

/** UTF-8 size of the model's selectable text, matching new Blob([text]).size. */
export function getModelUtf8ByteLength(model: monaco.editor.ITextModel): number {
    if (model.isDisposed()) throw new Error('Cannot count bytes of a disposed text model');
    const version = model.getVersionId();
    const cached = byteLengths.get(model);
    if (cached?.version === version) return cached.bytes;

    // The status previously used getValueInRange, which excludes a file BOM.
    // Preserve the current EOL without getValue/getValueInRange or retaining
    // snapshot chunks. Monaco itself may join edited pieces within a chunk.
    const snapshot = model.createSnapshot(false);
    let bytes = 0;
    let trailingHighSurrogate = false;
    for (let chunk = snapshot.read(); chunk !== null; chunk = snapshot.read()) {
        if (chunk.length === 0) continue;
        const first = chunk.charCodeAt(0);
        // encodeInto replaces an isolated surrogate with U+FFFD (3 bytes), as
        // Blob does. A pair split between chunks was counted as two isolated
        // surrogates (6), but is one scalar in the whole text (4).
        if (trailingHighSurrogate && first >= 0xdc00 && first <= 0xdfff) bytes -= 2;
        const last = chunk.charCodeAt(chunk.length - 1);
        trailingHighSurrogate = last >= 0xd800 && last <= 0xdbff;

        // A Monaco snapshot chunk can be much larger than 64 KiB. Reuse one
        // bounded output buffer; encodeInto never splits a surrogate pair.
        let offset = 0;
        while (offset < chunk.length) {
            const { read, written } = encoder.encodeInto(offset === 0 ? chunk : chunk.slice(offset), encodingBuffer);
            offset += read;
            bytes += written;
        }
    }
    byteLengths.set(model, { version, bytes });
    return bytes;
}
