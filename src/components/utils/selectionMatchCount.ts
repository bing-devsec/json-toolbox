import type * as monaco from 'monaco-editor/esm/vs/editor/editor.api';

const MAX_SEARCH_RESULTS = 1073741824;
const MAX_CACHED_NEEDLE_LENGTH = 8192;
const LARGE_QUERY_THRESHOLD = 1024 * 1024;
// A fixed window amortizes Monaco range/line-index lookups without growing with
// the selection or document. 64 KiB windows regressed whole-document scans.
const SEARCH_BLOCK_LENGTH = 1024 * 1024;

// One result per live model, never a document-wide match/range index. Version IDs
// change on edits, undo/redo and EOL changes, so stale counts cannot be reused.
const counts = new WeakMap<monaco.editor.ITextModel, { version: number; text: string; count: number }>();

const hasLoneSurrogate = (text: string) => {
    // Monaco uses Unicode regex search within pieces, but its line-boundary
    // fallback uses indexOf. Preserve its behavior for lone surrogate queries.
    for (let i = 0; i < text.length; i++) {
        const code = text.charCodeAt(i);
        if (code >= 0xd800 && code <= 0xdbff) {
            const next = text.charCodeAt(++i);
            if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
        } else if (code >= 0xdc00 && code <= 0xdfff) {
            return true;
        }
    }
    return false;
};

// Random access through one bounded range, including on fragmented models.
// Retaining every createSnapshot() chunk would not be bounded: Monaco joins
// edited pieces into fresh strings, so their aggregate can copy the document.
const indexedModel = (model: monaco.editor.ITextModel, normalizeEOL: boolean) => {
    const length = model.getValueLength(normalizeEOL ? 1 : 0);
    const crlf = normalizeEOL && model.getEOL() === '\r\n';
    const positionAt = (offset: number) => {
        if (!crlf) return model.getPositionAt(offset);
        // A CRLF model's LF-normalized line start is its native offset minus
        // the number of preceding CRs. Reuse Monaco's line index, not a second
        // document-sized newline index or a scan/copy of all snapshot chunks.
        let low = 1, high = model.getLineCount();
        while (low < high) {
            const mid = Math.floor((low + high + 1) / 2);
            const start = model.getOffsetAt({ lineNumber: mid, column: 1 }) - mid + 1;
            if (start <= offset) low = mid;
            else high = mid - 1;
        }
        return model.getPositionAt(offset + low - 1);
    };
    const read = (offset: number, size: number) => {
        // Guards keep the requested units inside the range when Monaco clamps
        // an EOL boundary or expands a surrogate-pair boundary.
        const start = positionAt(Math.max(0, offset - 2));
        const end = positionAt(Math.min(length, offset + size + 2));
        const range = model.validateRange({ startLineNumber: start.lineNumber, startColumn: start.column,
            endLineNumber: end.lineNumber, endColumn: end.column });
        const actualStart = model.getOffsetAt(range.getStartPosition()) - (crlf ? range.startLineNumber - 1 : 0);
        return model.getValueInRange(range, normalizeEOL ? 1 : 0).slice(offset - actualStart, offset - actualStart + size);
    };
    let cached = '', startOffset = 0;
    return {
        length,
        read,
        charCodeAt(offset: number): number {
            if (offset < 0 || offset >= length) return NaN;
            if (offset < startOffset || offset >= startOffset + cached.length) {
                startOffset = Math.floor(offset / SEARCH_BLOCK_LENGTH) * SEARCH_BLOCK_LENGTH;
                cached = read(startOffset, Math.min(SEARCH_BLOCK_LENGTH, length - startOffset));
            }
            return cached.charCodeAt(offset - startOffset);
        },
    };
};

// Use native string operations on bounded windows for ordinary selections.
// A rare prefix lets a huge query be verified block by block without factoring
// every query character in JS. Repetitive false candidates spend a work budget,
// then return null to restart with Two-Way instead of becoming quadratic.
const countWithAnchor = (haystack: ReturnType<typeof indexedModel>, needle: string, validBoundary: (offset: number) => boolean) => {
    const anchor = needle.slice(0, MAX_CACHED_NEEDLE_LENGTH);
    let offset = 0, count = 0, compared = 0, windowStart = 0, window = '';
    while (offset <= haystack.length - needle.length) {
        if (offset < windowStart || offset + anchor.length > windowStart + window.length) {
            windowStart = offset;
            window = haystack.read(offset, Math.min(SEARCH_BLOCK_LENGTH, haystack.length - offset));
        }
        const found = window.indexOf(anchor, offset - windowStart);
        if (found === -1) {
            offset = windowStart + window.length - anchor.length + 1;
            continue;
        }
        const candidate = windowStart + found;
        if (candidate > haystack.length - needle.length) break;
        compared += anchor.length;
        if (compared > haystack.length) return null;
        let matches = true;
        for (let i = anchor.length; i < needle.length; i += SEARCH_BLOCK_LENGTH) {
            const size = Math.min(SEARCH_BLOCK_LENGTH, needle.length - i);
            compared += size;
            if (compared > haystack.length) return null;
            if (haystack.read(candidate + i, size) !== needle.slice(i, i + size)) { matches = false; break; }
        }
        if (matches && validBoundary(candidate)) {
            count++;
            offset = candidate + needle.length;
        } else offset = candidate + 1;
    }
    return count;
};

// Critical factorization for Two-Way literal search. Unlike a KMP prefix table,
// this preprocessing has constant auxiliary space even for a huge selection.
const maximalSuffix = (text: string, reverse: boolean) => {
    let suffix = -1, candidate = 0, compared = 1, period = 1;
    while (candidate + compared < text.length) {
        const a = text.charCodeAt(candidate + compared), b = text.charCodeAt(suffix + compared);
        if (reverse ? a > b : a < b) {
            candidate += compared;
            compared = 1;
            period = candidate - suffix;
        } else if (a === b) {
            if (compared === period) {
                candidate += period;
                compared = 1;
            } else compared++;
        } else {
            suffix = candidate++;
            compared = period = 1;
        }
    }
    return { suffix, period };
};

const countLargeOrMultiline = (model: monaco.editor.ITextModel, needle: string, multiline: boolean): number => {
    // Native multiline search normalizes the model, not the query. In particular
    // an actual CRLF selection still has zero matches in that LF-only haystack.
    if (multiline && needle.indexOf('\r') !== -1) return 0;
    const haystack = indexedModel(model, multiline);
    if (needle.length > haystack.length) return 0;
    // With /u, a literal lone surrogate cannot match half a Unicode pair. Only
    // the query's outer boundaries need checking: internal units match literally.
    const first = needle.charCodeAt(0), last = needle.charCodeAt(needle.length - 1);
    const startsWithLow = multiline && first >= 0xdc00 && first <= 0xdfff;
    const endsWithHigh = multiline && last >= 0xd800 && last <= 0xdbff;
    const validBoundary = (offset: number) => {
        const before = startsWithLow ? haystack.charCodeAt(offset - 1) : NaN;
        const after = endsWithHigh ? haystack.charCodeAt(offset + needle.length) : NaN;
        return !(before >= 0xd800 && before <= 0xdbff) && !(after >= 0xdc00 && after <= 0xdfff);
    };
    const anchored = countWithAnchor(haystack, needle, validBoundary);
    if (anchored !== null) return anchored;

    const left = maximalSuffix(needle, false), right = maximalSuffix(needle, true);
    const factor = left.suffix > right.suffix ? left : right;
    const split = factor.suffix + 1;
    let period = factor.period;
    let periodic = true;
    for (let i = 0; i < split; i++) {
        if (needle.charCodeAt(i) !== needle.charCodeAt(i + period)) { periodic = false; break; }
    }
    const remembered = periodic ? needle.length - period : 0;
    if (!periodic) period = Math.max(split - 1, needle.length - split) + 1;

    let offset = 0, memory = 0, count = 0;
    while (offset <= haystack.length - needle.length) {
        let i = Math.max(split, memory);
        while (i < needle.length && needle.charCodeAt(i) === haystack.charCodeAt(offset + i)) i++;
        if (i < needle.length) {
            offset += i - split + 1;
            memory = 0;
            continue;
        }
        i = split;
        while (i > memory && needle.charCodeAt(i - 1) === haystack.charCodeAt(offset + i - 1)) i--;
        if (i <= memory) {
            if (validBoundary(offset)) {
                count++;
                offset += needle.length; // Same greedy, non-overlapping matches.
                memory = 0;
                continue;
            }
        }
        offset += period;
        memory = remembered;
    }
    return count;
};

// Exact, case-sensitive, non-overlapping literal matches, matching the status
// bar's findMatches(text, false, false, true, null, false, ...) request. Snapshot
// chunks avoid a whole-document getValue copy and allocating one Range per hit.
export const countSelectionMatches = (model: monaco.editor.ITextModel, text: string): number => {
    if (model.isDisposed()) throw new Error('Cannot search a disposed model');
    if (!text) return 0;
    const version = model.getVersionId();
    const cached = counts.get(model);
    if (cached?.version === version && cached.text === text) return cached.count;

    let count = 0;
    const multiline = text.indexOf('\n') !== -1;
    const needsNativeSingleLine = !multiline && (text.indexOf('\r') !== -1 || hasLoneSurrogate(text));
    if (!needsNativeSingleLine && !multiline && text.length <= MAX_CACHED_NEEDLE_LENGTH) {
        const snapshot = model.createSnapshot();
        let tail = '';
        let nextStart = 0;
        let chunk: string | null;
        while ((chunk = snapshot.read()) !== null) {
            const content = tail + chunk;
            let match: number;
            while ((match = content.indexOf(text, nextStart)) !== -1) {
                count++;
                nextStart = match + text.length;
            }
            // Keep only the unsearched boundary, never repeat an overlapping
            // match already consumed in a previous chunk.
            const tailStart = Math.max(nextStart, content.length - text.length + 1);
            tail = content.slice(tailStart);
            nextStart = 0;
        }
    } else if (needsNativeSingleLine || text.length <= LARGE_QUERY_THRESHOLD) {
        // Preserve the existing small-query path: bounded range lookups are
        // slower there. Large selections cause the demonstrated regex allocation
        // spike; selecting a different algorithm does not cap the match count.
        // Native single-line search mixes piece-level Unicode regex with a
        // line-boundary indexOf fallback. Preserve its exceptional CR/lone-
        // surrogate behavior instead of treating it as ordinary Unicode search.
        count = model.findMatches(text, false, false, true, null, false, MAX_SEARCH_RESULTS).length;
    } else {
        count = countLargeOrMultiline(model, text, multiline);
    }

    if (text.length <= MAX_CACHED_NEEDLE_LENGTH) {
        if (!cached) {
            // A short getValueInRange result can still retain a huge parent
            // string. Release it on content change even when no selection is
            // left and the status bar never requests another count.
            model.onDidChangeContent(() => {
                const previous = counts.get(model);
                if (previous && previous.version !== model.getVersionId()) previous.text = '';
            });
            model.onWillDispose(() => counts.delete(model));
        }
        counts.set(model, { version, text, count });
    } else if (cached) {
        // Release the previous short query without registering another model
        // listener on the next request. Never retain a large selection string.
        cached.text = '';
    }
    return count;
};
