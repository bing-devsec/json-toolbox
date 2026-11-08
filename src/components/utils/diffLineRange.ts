import type { DiffLineChange } from './diffEngine';

// Empty sides are represented by an end line before the start line.
export const getDiffLineRangeInfo = (change: DiffLineChange) => {
    const hasLeft = change.originalEndLineNumber >= change.originalStartLineNumber;
    const hasRight = change.modifiedEndLineNumber >= change.modifiedStartLineNumber;
    const leftLineCount = hasLeft ? change.originalEndLineNumber - change.originalStartLineNumber + 1 : 0;
    const rightLineCount = hasRight ? change.modifiedEndLineNumber - change.modifiedStartLineNumber + 1 : 0;
    return { hasLeft, hasRight, leftLineCount, rightLineCount };
};
