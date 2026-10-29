import { selectRepairRootCandidates, type RepairRootCandidate } from './repairRootPriority';

// A raw date-time in brackets is a log marker, not a repairable JSON array.
// Only probe a short root-level slice; quoted strings and nested containers are skipped first.
const logTimestamp = /^\[[ \t]*\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])[ T](?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,9})?(?:Z|[+-](?:[01]\d|2[0-3]):?[0-5]\d)?[ \t]*\]/;

const primitiveValue = /^(?:true|false|null|undefined|[+-]?(?:NaN|Infinity|0[xX][\da-fA-F]+|(?:(?:0|[1-9]\d*)(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?))$/;

const quoteEnd = (char: string): string | undefined =>
    char === '"' || char === "'" ? char : char === '“' ? '”' : char === '‘' ? '’' : undefined;

const skipString = (input: string, start: number): number => {
    const endQuote = quoteEnd(input[start]);
    let index = start + 1;
    while (index < input.length) {
        if (input[index] === '\\') { index = Math.min(index + 2, input.length); continue; }
        if (input[index++] === endQuote) break;
    }
    return index;
};

const skipComment = (input: string, index: number): number => {
    if (input[index] === '#' || (input[index] === '/' && input[index + 1] === '/' && input[index - 1] !== ':')) {
        const end = input.indexOf('\n', index + 1);
        return end < 0 ? input.length : end;
    }
    if (input[index] === '/' && input[index + 1] === '*') {
        const end = input.indexOf('*/', index + 2);
        return end < 0 ? input.length : end + 2;
    }
    return index;
};

const skipRegex = (input: string, start: number): number => {
    if (input[start] !== '/' || input[start + 1] === '/' || input[start + 1] === '*') return start;
    // A URL path or the second slash in https:// is not a regex opening delimiter.
    if (/[\p{L}\p{N}_$/]/u.test(input[start - 1] || '')) return start;
    let inCharacterClass = false;
    for (let index = start + 1; index < input.length; index++) {
        const char = input[index];
        if (char === '\n' || char === '\r') return index;
        if (char === '\\') { index++; continue; }
        if (char === '[') inCharacterClass = true;
        else if (char === ']') inCharacterClass = false;
        else if (char === '/' && !inCharacterClass) {
            index++;
            while (/[a-z]/i.test(input[index] || '') && index < input.length) index++;
            return index;
        }
    }
    // Keep malformed regex text together, too; avoid repeatedly rescanning an unterminated class.
    return input.length;
};

const containerEnd = (input: string, start: number): number => {
    let depth = 0, index = start;
    while (index < input.length) {
        const char = input[index];
        if (quoteEnd(char)) { index = skipString(input, index); continue; }
        const commentEnd = skipComment(input, index);
        if (commentEnd !== index) { index = commentEnd; continue; }
        const regexEnd = skipRegex(input, index);
        if (regexEnd !== index) { index = regexEnd; continue; }
        if (char === '{' || char === '[') depth++;
        else if (char === '}' || char === ']') {
            if (--depth === 0) return index + 1;
        }
        index++;
    }
    // Preserve a truncated container in full. The repair parser supplies missing closers.
    return input.length;
};

/** Recognize only an explicit raw date-time log marker at the beginning of the input. */
export function hasLeadingLogTimestamp(input: string): boolean {
    const start = input.search(/\S/);
    return start >= 0 && logTimestamp.test(input.slice(start, start + 64));
}

export interface RepairRootBoundary { end: number; profileText?: string }

/** Preserve peer records in order; a clear main document may exclude shallow auxiliary roots. */
export function selectRepairRoots(
    input: string,
    readContainerEnd?: (input: string, start: number) => number | RepairRootBoundary | undefined,
): string {
    const values: RepairRootCandidate[] = [];
    let hasContainer = false, ignoredLogTimestamp = false, index = 0;
    while (index < input.length) {
        const char = input[index];
        if (/\s/.test(char) || char === ',' || char === ';') { index++; continue; }
        const commentEnd = skipComment(input, index);
        if (commentEnd !== index) { index = commentEnd; continue; }
        if (quoteEnd(char)) {
            const end = skipString(input, index);
            // Root selection must not turn a following orphaned field into prose.
            if (hasContainer || ignoredLogTimestamp) {
                let next = end;
                while (next < input.length) {
                    if (/\s/.test(input[next])) { next++; continue; }
                    const afterComment = skipComment(input, next);
                    if (afterComment === next) break;
                    next = afterComment;
                }
                if (input[next] === ':' || input[next] === '：') return input;
            }
            index = end;
            continue;
        }
        const regexEnd = skipRegex(input, index);
        if (regexEnd !== index) { index = regexEnd; continue; }
        const timestamp = char === '[' ? logTimestamp.exec(input.slice(index, index + 64))?.[0] : undefined;
        if (timestamp) {
            index += timestamp.length;
            ignoredLogTimestamp = true;
            continue;
        }
        if (char === '{' || char === '[' || (readContainerEnd && (char === '｛' || char === '［'))) {
            const boundary = readContainerEnd?.(input, index);
            const end = typeof boundary === 'number' ? boundary : boundary?.end ?? containerEnd(input, index);
            values.push({ text: input.slice(index, end), start: index,
                end, profileText: typeof boundary === 'object' ? boundary.profileText : undefined });
            hasContainer = true;
            index = end;
            continue;
        }
        const start = index++;
        while (index < input.length) {
            const char = input[index];
            if (char === '\n' || char === '\r' || char === ',' || char === ';' || char === '{' || char === '[' || (readContainerEnd && (char === '｛' || char === '［'))) break;
            if (skipComment(input, index) !== index) break;
            if (skipRegex(input, index) !== index) break;
            // An apostrophe inside a word (don't / it's) is part of the surrounding prose.
            if (quoteEnd(char) && (char !== "'" || !/[\p{L}\p{N}_]/u.test(input[index - 1]))) break;
            index++;
        }
        const text = input.slice(start, index);
        // A stray closer may be caused by an unescaped quote inside the container.
        // Let the repair parser handle the entire input instead of silently cutting off fields.
        if (/[}\]]/.test(text)) return input;
        // Unquoted keys and incomplete values outside a root also stay reviewable.
        if (hasContainer || ignoredLogTimestamp) {
            const identifier = /^[$_\p{ID_Start}][$_\u200c\u200d\p{ID_Continue}]*/u.exec(text.trim())?.[0];
            if (identifier) {
                const rest = text.trim().slice(identifier.length);
                if (/^\s*[:：]/.test(rest)) return input;
                if (!rest.trim()) {
                    let next = index;
                    while (next < input.length) {
                        if (/\s/.test(input[next])) { next++; continue; }
                        const afterComment = skipComment(input, next);
                        if (afterComment === next) break;
                        next = afterComment;
                    }
                    if (input[next] === ':' || input[next] === '：') return input;
                }
            }
        }
        const tokens = [...text.matchAll(/\S+/g)];
        if (tokens.every(token => primitiveValue.test(token[0]))) {
            for (const token of tokens) values.push({ text: token[0], start: start + token.index, end: start + token.index + token[0].length });
        }
    }
    if (!hasContainer) return input;
    const selected = selectRepairRootCandidates(input, values).roots;
    return selected.length === 1 ? selected[0].text : '[\n' + selected.map(value => value.text).join(',\n') + '\n]';
}
