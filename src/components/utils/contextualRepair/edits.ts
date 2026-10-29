import { ChunkedStringBuilder } from '../jsonEngine/stringBuilder';
import type { RepairEdit } from './types';

/** Apply non-overlapping source edits once, preserving every untouched code unit. */
export function applyRepairEdits(input: string, edits: readonly RepairEdit[]): string {
    if (!edits.length) return input;
    const ordered = edits.map((edit, index) => ({ edit, index }))
        .sort((a, b) => a.edit.start - b.edit.start || a.edit.end - b.edit.end || a.index - b.index);
    const output = new ChunkedStringBuilder();
    let cursor = 0;
    for (const { edit } of ordered) {
        if (!Number.isSafeInteger(edit.start) || !Number.isSafeInteger(edit.end)
            || edit.start < cursor || edit.end < edit.start || edit.end > input.length) {
            throw new RangeError('Overlapping or invalid JSON repair source edits');
        }
        output.append(input.slice(cursor, edit.start));
        output.append(edit.text);
        cursor = edit.end;
    }
    output.append(input.slice(cursor));
    return output.toString();
}
