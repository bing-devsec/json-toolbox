import { applyRepairEdits } from './edits';
import { createRepairLimits } from './limits';
import { scanRepairString } from './strings';
import type { ContextRepairResult, RepairEdit, RepairLimits } from './types';

type Container = 'object' | 'array' | 'call';
type Frame = {
    kind: Container;
    closer: '}' | ']' | ')';
    state: 'key' | 'colon' | 'value' | 'separator';
    valueEnd: number;
    keyEnd: number;
};

const punctuation: Record<string, string> = { '｛': '{', '｝': '}', '［': '[', '］': ']', '：': ':', '，': ',' };
const canonical = (char: string): string => punctuation[char] ?? char;
const isQuote = (char: string): boolean => char === '"' || char === "'" || char === '“' || char === '‘';
const isWhitespace = (char: string): boolean => char !== undefined && /\s/.test(char);
const identifierStart = /[$_\p{ID_Start}]/u;
const identifierContinue = /[$_\u200c\u200d\p{ID_Continue}]/u;
const completeNumber = /^[+-]?(?:0[xX][\da-fA-F]+|(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?|Infinity|NaN)$/;
const numericStart = /^[+\-.\d]/;

/** A bounded container parser: edits refer to the source and never synthesize data values. */
export function repairJsonWithContext(
    input: string, overrides: Partial<RepairLimits> = {}, options: { stopAfterRoot?: boolean } = {},
): ContextRepairResult {
    const limits = createRepairLimits(input.length, overrides);
    const started = Date.now();
    const edits: RepairEdit[] = [];
    const stack: Frame[] = [];
    let index = 0, work = 0, nextClockCheck = 0, finished = false;
    let unsupportedReason: string | undefined;
    let rootClose: { frame: Frame; offset: number } | undefined;
    let failure: ContextRepairResult | undefined;
    const result = (status: ContextRepairResult['status'], reason?: string): ContextRepairResult =>
        ({ status, edits: status === 'repaired' || status === 'unchanged' ? edits : [], reason, work });
    const fail = (status: 'unsupported' | 'unsafe' | 'limit', reason: string): false => {
        failure = result(status, reason);
        return false;
    };
    const budget = (cost = 1, forceClock = false): boolean => {
        work += cost;
        if (work > limits.maxWork) return fail('limit', 'JSON repair work limit reached');
        if (forceClock || work >= nextClockCheck) {
            nextClockCheck = work + 1024;
            if (Date.now() - started >= limits.maxDurationMs) return fail('limit', 'JSON repair time limit reached');
        }
        return true;
    };
    const addEdit = (start: number, end: number, text: string, reason: string, risk: RepairEdit['risk'] = 'syntax'): boolean => {
        if (edits.length >= limits.maxEdits) return fail('limit', 'JSON repair edit limit reached');
        edits.push({ start, end, text, reason, risk });
        return true;
    };
    const normalizePunctuation = (): boolean => {
        const replacement = punctuation[input[index]];
        return replacement === undefined || addEdit(index, index + 1, replacement, 'Normalize structural punctuation');
    };
    const skipTrivia = (): boolean => {
        while (index < input.length) {
            if (!budget()) return false;
            if (input[index] === '\u200b') {
                if (!addEdit(index, index + 1, '', 'Remove an invisible character outside strings')) return false;
                index++;
                continue;
            }
            if (isWhitespace(input[index])) { index++; continue; }
            if (input[index] === '#' || input.startsWith('//', index)) {
                while (index < input.length && !/[\r\n\u2028\u2029]/.test(input[index])) {
                    index++;
                    if (!budget()) return false;
                }
                continue;
            }
            if (input.startsWith('/*', index)) {
                index += 2;
                while (index < input.length && !input.startsWith('*/', index)) {
                    index++;
                    if (!budget()) return false;
                }
                if (index === input.length) return fail('unsafe', 'Unclosed block comment has an uncertain boundary');
                index += 2;
                continue;
            }
            break;
        }
        return true;
    };
    const finishValue = (end: number): void => {
        const parent = stack[stack.length - 1];
        if (parent) { parent.state = 'separator'; parent.valueEnd = end; }
        else finished = true;
    };
    const readString = (role: 'key' | 'value'): number | undefined => {
        if (!budget(1, true)) return undefined;
        const kind = stack[stack.length - 1]?.kind;
        const scan = scanRepairString(input, index, {
            role,
            consumeBudget: cost => budget(cost),
            container: kind === 'call' ? 'array' : kind ?? 'root',
            depth: stack.length,
            expectedClosers: stack.map(frame => frame.closer),
            maxLookahead: Math.min(limits.maxLookahead, Math.max(0, limits.maxWork - work)),
            maxDepth: limits.maxDepth,
            maxEdits: Math.max(0, limits.maxEdits - edits.length),
        });
        if (failure || !budget(0, true)) return undefined;
        if (!scan) {
            fail('unsupported', 'String syntax is not supported by contextual repair');
            return undefined;
        }
        if (scan.ambiguous || !scan.closed || scan.end <= index || scan.end > input.length) {
            fail('unsafe', 'String boundary cannot be determined without changing data');
            return undefined;
        }
        for (const edit of scan.edits) {
            if (!addEdit(edit.start, edit.end, edit.text, edit.reason, edit.risk)) return undefined;
        }
        return scan.end;
    };
    const identifierEnd = (start: number): number => {
        let point = input.codePointAt(start);
        if (point === undefined) return start;
        let char = String.fromCodePoint(point);
        if (!identifierStart.test(char)) return start;
        let end = start + char.length;
        while ((point = input.codePointAt(end)) !== undefined) {
            char = String.fromCodePoint(point);
            if (!identifierContinue.test(char)) break;
            if (!budget(char.length)) return end;
            end += char.length;
        }
        return end;
    };
    const isBoundary = (char: string | undefined): boolean => char === undefined || isWhitespace(char)
        || '{}[],:()'.includes(canonical(char)) || isQuote(char) || char === '#' || char === '/';
    const nextLooksLikeKey = (): boolean => {
        // A quoted token followed by ':' is a sibling field, not a missing value.
        if (!isQuote(input[index])) return false;
        const quote = input[index] === '“' ? '”' : input[index] === '‘' ? '’' : input[index];
        let end = index + 1;
        while (end < input.length && end - index <= limits.maxLookahead) {
            if (!budget()) return false;
            if (input[end] === '\\') { end += 2; continue; }
            if (input[end++] === quote) {
                while (isWhitespace(input[end])) { if (!budget()) return false; end++; }
                return canonical(input[end]) === ':';
            }
        }
        return false;
    };
    const readOpaqueValue = (start: number): boolean => {
        let cursor = start;
        if (input[start] === '/' && input[start + 1] !== '/' && input[start + 1] !== '*') {
            let inClass = false, closed = false;
            cursor++;
            while (cursor < input.length) {
                if (!budget()) return false;
                const char = input[cursor++];
                if (char === '\\') { cursor++; continue; }
                if (char === '\n' || char === '\r') break;
                if (char === '[') inClass = true;
                else if (char === ']') inClass = false;
                else if (char === '/' && !inClass) { closed = true; break; }
            }
            if (!closed) return fail('unsupported', 'A regex value has no definite end');
            while (/[a-z]/i.test(input[cursor] || '')) { cursor++; if (!budget()) return false; }
            const end = cursor;
            index = cursor;
            if (!skipTrivia()) return false;
            if ((!',}])'.includes(canonical(input[index]) || '') && !nextLooksLikeKey()) || index === input.length) {
                return fail('unsupported', 'A regex value has an uncertain separator');
            }
            unsupportedReason ??= 'A regex value requires the extension repair engine';
            finishValue(end);
            return true;
        }
        while (cursor < input.length) {
            if (!budget()) return false;
            const char = canonical(input[cursor]);
            if (',}])'.includes(char)) break;
            if ('{[('.includes(char)) return fail('unsupported', 'An extension value has an uncertain container boundary');
            if (isQuote(input[cursor])) {
                const saved = index;
                index = cursor;
                const sibling = nextLooksLikeKey();
                index = saved;
                if (failure) return false;
                if (cursor > start && sibling) break;
                const quote = input[cursor] === '“' ? '”' : input[cursor] === '‘' ? '’' : input[cursor];
                cursor++;
                let closed = false;
                while (cursor < input.length) {
                    if (!budget()) return false;
                    if (input[cursor] === '\\') { cursor += 2; continue; }
                    if (input[cursor++] === quote) { closed = true; break; }
                }
                if (!closed) return fail('unsafe', 'An extension string has no definite end');
                continue;
            }
            cursor++;
        }
        if (cursor === start) return fail('unsupported', 'An extension value has no definite boundary');
        unsupportedReason ??= 'An opaque value requires the extension repair engine';
        index = cursor;
        finishValue(cursor);
        return true;
    };
    const readValue = (): boolean => {
        const char = canonical(input[index]);
        if (char === '{' || char === '[') {
            if (stack.length >= limits.maxDepth) return fail('limit', 'JSON nesting depth limit reached');
            if (!normalizePunctuation()) return false;
            stack.push({ kind: char === '{' ? 'object' : 'array', closer: char === '{' ? '}' : ']',
                state: char === '{' ? 'key' : 'value', valueEnd: -1, keyEnd: -1 });
            index++;
            return true;
        }
        if (isQuote(input[index])) {
            const end = readString('value');
            if (end === undefined) return false;
            index = end;
            finishValue(end);
            return true;
        }
        if (char === ',' || char === '}' || char === ']' || char === ')') return fail('unsafe', 'A JSON value is missing');
        for (const literal of ['true', 'false', 'null', 'undefined', 'NaN', 'Infinity']) {
            if (input.startsWith(literal, index) && isBoundary(input[index + literal.length])) {
                index += literal.length;
                finishValue(index);
                return true;
            }
        }
        if (input.startsWith('...', index) || input[index] === '…') {
            const length = input[index] === '…' ? 1 : 3;
            if (isBoundary(input[index + length])) {
                unsupportedReason ??= 'An ellipsis placeholder requires the extension repair engine';
                index += length;
                finishValue(index);
                return true;
            }
        }
        if (numericStart.test(input[index])) {
            const start = index;
            while (index < input.length && !isBoundary(input[index])) {
                index++;
                if (!budget()) return false;
            }
            const token = input.slice(start, index);
            if (!completeNumber.test(token) || /^[+-]?0\d/.test(token) || (index === input.length && token.endsWith('.'))) {
                return fail('unsafe', 'Incomplete or ambiguous number must not be guessed');
            }
            finishValue(index);
            return true;
        }
        const start = index;
        const end = identifierEnd(start);
        if (failure) return false;
        if (end > start) {
            index = end;
            if (!skipTrivia()) return false;
            const next = canonical(input[index]);
            if (next === '(') {
                if (stack.length >= limits.maxDepth) return fail('limit', 'JSON nesting depth limit reached');
                unsupportedReason ??= 'A wrapper value requires the extension repair engine';
                stack.push({ kind: 'call', closer: ')', state: 'value', valueEnd: -1, keyEnd: -1 });
                index++;
                return true;
            }
            if (next === ',' || next === '}' || next === ']' || next === ')' || nextLooksLikeKey()) {
                if (failure) return false;
                unsupportedReason ??= 'A bare value requires the extension repair engine';
                finishValue(end);
                return true;
            }
        }
        return readOpaqueValue(start);
    };

    if (Object.values(limits).some(limit => !Number.isFinite(limit) || limit < 0)) {
        return result('limit', 'Invalid JSON repair limits');
    }
    if (!skipTrivia()) return failure!;
    if (canonical(input[index]) !== '{' && canonical(input[index]) !== '[') {
        return result('unsupported', 'Contextual repair expects an object or array root');
    }
    if (!readValue()) return failure!;
    while (!failure) {
        if (finished && options.stopAfterRoot) {
            // A quoted key + colon cannot be a separate root or discarded prose.
            // Inspect it before exposing a root boundary to the extraction layer.
            const end = index;
            if (!skipTrivia()) break;
            if (canonical(input[index]) === ',') {
                index++;
                if (!skipTrivia()) break;
            }
            const orphanedKey = nextLooksLikeKey();
            index = end;
            if (failure || !orphanedKey) break;
        }
        if (!budget() || !skipTrivia()) break;
        if (index === input.length) {
            while (stack.length) {
                const frame = stack[stack.length - 1];
                if (frame.state === 'colon' || (frame.kind === 'object' && frame.state === 'value')) {
                    fail('unsafe', 'A JSON field has no complete value');
                    break;
                }
                if (frame.kind === 'call') { fail('unsupported', 'An incomplete wrapper requires the extension repair engine'); break; }
                if (!addEdit(index, index, frame.closer, 'Close an unfinished container')) break;
                stack.pop();
                finishValue(index);
            }
            break;
        }
        if (finished || !stack.length) {
            const trailing = canonical(input[index]);
            if (trailing === '}' || trailing === ']') {
                if (!addEdit(index, index + 1, '', 'Remove an extra root closing bracket')) break;
                index++;
                continue;
            }
            if (trailing === ',' && rootClose?.frame.kind === 'object') {
                index++;
                if (!skipTrivia()) break;
                if (nextLooksLikeKey()) {
                    // A standalone quoted key cannot be another JSON root. Keep it
                    // with its preceding object rather than dropping the field.
                    if (!addEdit(rootClose.offset, rootClose.offset + 1, '', 'Keep a following field inside the root object', 'inferred')) break;
                    stack.push({ ...rootClose.frame, state: 'key' });
                    rootClose = undefined;
                    finished = false;
                    continue;
                }
                if (failure) break;
            }
            if (nextLooksLikeKey()) {
                fail('unsafe', 'A field outside the completed root must not be discarded as prose');
                break;
            }
            if (failure) break;
            fail('unsupported', 'Input contains content outside the root container');
            break;
        }
        const frame = stack[stack.length - 1];
        const char = canonical(input[index]);
        if (char === '}' || char === ']' || char === ')') {
            if (frame.state === 'colon' || (frame.kind === 'object' && frame.state === 'value')) {
                fail('unsafe', 'A JSON field has no complete value');
                break;
            }
            if (frame.kind === 'call' && frame.valueEnd < 0) {
                fail('unsafe', 'A wrapper value has no argument');
                break;
            }
            if (char !== frame.closer) {
                const parentMatches = stack.slice(0, -1).some(parent => parent.closer === char);
                if (parentMatches) {
                    if (!addEdit(index, index, frame.closer, 'Close a container before its parent')) break;
                    stack.pop();
                    finishValue(index);
                    continue;
                }
                if (!addEdit(index, index + 1, frame.closer, 'Correct a mismatched closing bracket', 'inferred')) break;
            } else if (!normalizePunctuation()) break;
            if (stack.length === 1 && input[index] === frame.closer) rootClose = { frame: { ...frame }, offset: index };
            index++;
            stack.pop();
            finishValue(index);
            continue;
        }
        if (frame.state === 'separator') {
            if (char === ',') {
                if (!normalizePunctuation()) break;
                frame.state = frame.kind === 'object' ? 'key' : 'value';
                index++;
            } else {
                if (char === ':') { fail('unsafe', 'Unexpected colon after a complete value'); break; }
                if (char === '+') { if (!readOpaqueValue(index)) break; continue; }
                if (!addEdit(frame.valueEnd, frame.valueEnd, ',', 'Separate adjacent values')) break;
                frame.state = frame.kind === 'object' ? 'key' : 'value';
            }
            continue;
        }
        if (frame.state === 'key') {
            if (char === ',') { fail('unsafe', 'An object field name is missing'); break; }
            let end: number | undefined;
            if (isQuote(input[index])) end = readString('key');
            else end = identifierEnd(index);
            if (failure) break;
            if (end === undefined || end === index) {
                fail('unsupported', 'Object key syntax requires an unsupported extension grammar');
                break;
            }
            index = end;
            frame.keyEnd = end;
            frame.state = 'colon';
            continue;
        }
        if (frame.state === 'colon') {
            if (char === ':') {
                if (!normalizePunctuation()) break;
                index++;
            } else {
                const sibling = nextLooksLikeKey();
                if (failure) break;
                if (char === ',' || sibling) { fail('unsafe', 'A JSON field has no complete value'); break; }
                if (!addEdit(frame.keyEnd, frame.keyEnd, ':', 'Separate a key from its value')) break;
            }
            frame.state = 'value';
            continue;
        }
        if (!readValue()) break;
    }
    if (failure) return failure;
    if (!finished) return result('unsupported', 'The root JSON container was not completed');
    if (!budget(0, true)) return failure!;
    const source = options.stopAfterRoot ? input.slice(0, index) : input;
    // A fully scanned extension may need lexical compatibility conversion, but
    // must retain all contextual edits (not rerun repair on the broken source).
    if (unsupportedReason) return { ...result('unsupported', unsupportedReason), legacyCompatible: true,
        text: applyRepairEdits(source, edits), edits,
        ...(options.stopAfterRoot ? { rootEnd: index } : {}) };
    return { ...result(edits.length ? 'repaired' : 'unchanged'), text: applyRepairEdits(source, edits),
        ...(options.stopAfterRoot ? { rootEnd: index } : {}) };
}
