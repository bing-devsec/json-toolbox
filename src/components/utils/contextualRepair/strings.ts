import type { RepairEdit, RepairStringContext, RepairStringScan } from './types';

const endQuote = (char: string): string | undefined =>
    char === '"' || char === "'" ? char : char === '“' ? '”' : char === '‘' ? '’' : undefined;
const space = (char: string | undefined): boolean => char !== undefined && /\s/u.test(char);
const identifierStart = /[$_\p{ID_Start}]/u;
const identifierPart = /[$_\u200c\u200d\p{ID_Continue}]/u;
const fullwidthPunctuation: Record<string, string> = { '，': ',', '：': ':', '｛': '{', '｝': '}', '［': '[', '］': ']' };
const punctuation = (char: string): string => fullwidthPunctuation[char] || char;
const number = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;
const escapes: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };

const budgetExceeded = Symbol('JSON string repair budget exhausted');
function charge(context: RepairStringContext, cost = 1): void {
    if (context.consumeBudget && !context.consumeBudget(cost)) throw budgetExceeded;
}

function trivia(input: string, start: number, limit: number, context: RepairStringContext): number {
    let index = start;
    while (index < input.length && index < limit) {
        charge(context);
        if (space(input[index])) { index++; continue; }
        if (input[index] === '#' || input.startsWith('//', index)) {
            while (index < input.length && index < limit && !/[\r\n\u2028\u2029]/u.test(input[index])) { charge(context); index++; }
        } else if (input.startsWith('/*', index)) {
            let close = index + 2;
            while (close + 1 < input.length && close + 1 < limit && !input.startsWith('*/', close)) { charge(context); close++; }
            if (close + 1 >= input.length || close + 1 >= limit) return limit;
            index = close + 2;
        } else break;
    }
    return index;
}

function escapedEnd(input: string, index: number, context: RepairStringContext): number {
    let next = index + 1;
    charge(context);
    while (input[next] === ' ' || input[next] === '\t') { charge(context); next++; }
    if (input[next] === '\r' || input[next] === '\n') return next + (input[next] === '\r' && input[next + 1] === '\n' ? 2 : 1);
    return Math.min(index + 2, input.length);
}

/** Probe a bounded next key; this never interprets strings as a JavaScript value. */
function objectKey(input: string, start: number, limit: number, context: RepairStringContext, allowMissingColon = false): boolean {
    let index = start;
    const quote = endQuote(input[index]);
    if (quote) {
        index++;
        while (index < input.length && index < limit && input[index] !== quote) {
            charge(context);
            if (input[index] === '\n' || input[index] === '\r') return false;
            index = input[index] === '\\' ? escapedEnd(input, index, context) : index + 1;
        }
        if (input[index] !== quote || index >= limit) return false;
        index++;
    } else {
        const first = input.codePointAt(index);
        if (first === undefined || !identifierStart.test(String.fromCodePoint(first))) return false;
        index += first > 0xffff ? 2 : 1;
        while (index < input.length && index < limit) {
            charge(context);
            const point = input.codePointAt(index)!;
            if (!identifierPart.test(String.fromCodePoint(point))) break;
            index += point > 0xffff ? 2 : 1;
        }
    }
    const next = trivia(input, index, limit, context);
    return punctuation(input[next]) === ':' || allowMissingColon && quote !== undefined && valueStart(input, next, context);
}

function valueStart(input: string, index: number, context: RepairStringContext): boolean {
    charge(context);
    return endQuote(input[index]) !== undefined || /[\[\{\d+\-]/u.test(input[index] || '')
        || (input[index] === '.' && /\d/u.test(input[index + 1] || ''))
        || /^(?:true|false|null|undefined|NaN|Infinity)\b/u.test(input.slice(index, index + 10));
}

function outerEnd(input: string, quote: number, context: RepairStringContext, hadInnerQuote = false): boolean {
    const limit = Math.min(input.length, quote + 1 + context.maxLookahead);
    const next = trivia(input, quote + 1, limit, context);
    if (next >= input.length || next >= limit) return true;
    const char = punctuation(input[next]);
    if (context.role === 'key') return char === ':' || char === ',' || char === '}' || char === ']';
    if (char === '}' || char === ']' || char === ')' || char === '+') return true;
    if (char === ',') {
        if (!hadInnerQuote) return true;
        const after = trivia(input, next + 1, limit, context);
        return after >= input.length || after >= limit || punctuation(input[after]) === '}' || punctuation(input[after]) === ']'
            || (context.container === 'object' ? objectKey(input, after, limit, context, true) : valueStart(input, after, context));
    }
    if (context.container === 'object' && objectKey(input, next, limit, context, true)) return true;
    if (context.container !== 'object' && valueStart(input, next, context)) return true;
    return false;
}

function insertion(index: number, text: string, reason: string, risk: RepairEdit['risk'] = 'syntax'): RepairEdit {
    return { start: index, end: index, text, reason, risk };
}

function uncertain(end: number): RepairStringScan {
    return { end, edits: [], closed: false, ambiguous: true };
}

/** A newline only suggests a close when actual outer container/key structure follows. */
function newlineBoundary(input: string, start: number, context: RepairStringContext): { boundary?: number; probed: number } {
    const limit = Math.min(input.length, start + context.maxLookahead);
    let index = trivia(input, start, limit, context);
    if (context.container === 'object' && objectKey(input, index, limit, context)) return { boundary: start, probed: index };
    let depth = context.expectedClosers.length, seen = false;
    while (index < limit) {
        charge(context);
        const char = punctuation(input[index]);
        if (char === '}' || char === ']') {
            if (context.expectedClosers[depth - 1] !== char) return { probed: index };
            seen = true;
            depth--;
            index++;
        } else if (seen && char === ',') index++;
        else {
            const next = trivia(input, index, limit, context);
            if (next === index) break;
            index = next;
        }
    }
    if (!seen || index >= limit && index < input.length) return { probed: index };
    if (index === input.length || depth > 0 && (context.expectedClosers[depth - 1] === '}'
        ? objectKey(input, index, limit, context) : valueStart(input, index, context))) return { boundary: start, probed: index };
    return { probed: index };
}

interface DecodedCharacter { char: string; end: number }
function decodeOuter(input: string, index: number, context: RepairStringContext): DecodedCharacter | undefined {
    charge(context);
    const char = input[index];
    if (char !== '\\') return { char, end: index + 1 };
    const escaped = input[index + 1];
    if (Object.prototype.hasOwnProperty.call(escapes, escaped)) { charge(context); return { char: escapes[escaped], end: index + 2 }; }
    if (escaped === 'u' && /^[\da-fA-F]{4}$/u.test(input.slice(index + 2, index + 6))) {
        charge(context, 5);
        return { char: String.fromCharCode(parseInt(input.slice(index + 2, index + 6), 16)), end: index + 6 };
    }
    return undefined;
}

function decodedTrivia(input: string, start: number, limit: number, context: RepairStringContext): number {
    let index = start;
    while (index < limit) {
        charge(context);
        const next = decodeOuter(input, index, context);
        if (!next || !space(next.char)) break;
        index = next.end;
    }
    return index;
}

interface InnerFrame { close: '}' | ']'; state: 'key' | 'colon' | 'value' | 'separator'; empty: boolean }

/**
 * Recognize an entire embedded container while retaining its original spelling.
 * Preserve existing token spelling while recovering quote escapes and separators.
 * A supplied outer boundary additionally permits closing complete inner frames;
 * no missing business value or unfinished business string is synthesized.
 */
function embeddedString(input: string, start: number, context: RepairStringContext, boundary?: number): RepairStringScan | undefined {
    if (input[start] !== '"' || context.role !== 'value' || context.container === 'root') return undefined;
    const limit = Math.min(input.length, start + Math.max(1, context.maxLookahead), boundary ?? input.length);
    let index = start + 1;
    while (index < limit && space(input[index])) { charge(context); index++; }
    if (input[index] !== '{' && input[index] !== '[') return undefined;
    const frames: InnerFrame[] = [];
    const edits: RepairEdit[] = [];
    let inString = false, innerEscape = false, unicode = 0, stringIsKey = false;
    let started = false, done = false;
    const append = (edit: RepairEdit): boolean => {
        if (edits.length >= context.maxEdits) return false;
        edits.push(edit);
        return true;
    };
    const finish = (): void => { const frame = frames[frames.length - 1]; if (frame) frame.state = 'separator'; else done = true; };
    while (index < input.length && index < limit) {
        charge(context);
        const decoded = decodeOuter(input, index, context);
        if (!decoded) return uncertain(index);
        const { char, end } = decoded;
        if (done) {
            if (space(char)) {
                if (input[index] === '\n' || input[index] === '\r') {
                    if (!append({ start: index, end, text: char === '\n' ? '\\n' : '\\r', reason: 'Escape a line break inside the encoded JSON string', risk: 'syntax' })) return uncertain(index);
                }
                index = end;
                continue;
            }
            if (input[index] !== '"' || !outerEnd(input, index, context)) return uncertain(index);
            return edits.length ? { end: index + 1, edits, closed: true } : undefined;
        }
        if (inString) {
            if (!innerEscape && !unicode && char === '"' && input[index] === '\\') {
                const next = decodedTrivia(input, end, limit, context);
                const separator = decodeOuter(input, next, context)?.char;
                const definiteEnd = stringIsKey ? separator === ':'
                    : boundary !== undefined && next === boundary
                        || separator === ',' || separator === '}' || separator === ']'
                        || frames[frames.length - 1]?.close === '}' && objectKey(input, next, limit, context);
                if (!definiteEnd) {
                    // At an established outer boundary, never repair a business
                    // quote by inventing its role as content versus delimiter.
                    if (boundary !== undefined) return uncertain(index);
                    if (!append(insertion(index, '\\\\', 'Restore the outer escape layer around an inner business quote', 'inferred'))) return uncertain(index);
                    index = end;
                    continue;
                }
            }
            if (input[index] === '"' && !append(insertion(index, '\\', 'Restore an outer escape around embedded JSON text'))) return uncertain(index);
            if (unicode) {
                if (!/[\da-fA-F]/u.test(char)) return uncertain(index);
                unicode--;
            } else if (innerEscape) {
                if (!'"\\/bfnrtu'.includes(char)) return uncertain(index);
                if (char === 'u') unicode = 4;
                innerEscape = false;
            } else if (char === '\\') innerEscape = true;
            else if (char === '"') {
                inString = false;
                if (stringIsKey) frames[frames.length - 1].state = 'colon';
                else finish();
            } else if (char.charCodeAt(0) < 0x20) return uncertain(index);
            index = end;
            continue;
        }
        if (space(char)) {
            if (input[index] === '\n' || input[index] === '\r' || input[index] === '\t') {
                if (!append({ start: index, end, text: char === '\n' ? '\\n' : char === '\r' ? '\\r' : '\\t', reason: 'Escape whitespace inside the encoded JSON string', risk: 'syntax' })) return uncertain(index);
            }
            index = end;
            continue;
        }
        const frame = frames[frames.length - 1];
        if (frame && char === frame.close) {
            if (frame.state !== 'separator' && !(frame.empty && frame.state === (frame.close === '}' ? 'key' : 'value'))) return uncertain(index);
            frames.pop();
            index = end;
            finish();
            continue;
        }
        if (frame?.state === 'separator') {
            if (char === ',') { frame.state = frame.close === '}' ? 'key' : 'value'; frame.empty = false; index = end; continue; }
            if (char !== '"' && !(frame.close === ']' && (char === '{' || char === '[' || /[\d\-tfn]/u.test(char)))) return uncertain(index);
            if (!append(insertion(index, ',', 'Restore a missing separator inside encoded JSON', 'inferred'))) return uncertain(index);
            frame.state = frame.close === '}' ? 'key' : 'value';
            frame.empty = false;
        }
        if (frame?.state === 'colon') {
            if (char === ':') { frame.state = 'value'; index = end; continue; }
            if (char !== '"' && char !== '{' && char !== '[' && !/[\d\-tfn]/u.test(char)) return uncertain(index);
            if (!append(insertion(index, ':', 'Restore a missing colon inside encoded JSON', 'inferred'))) return uncertain(index);
            frame.state = 'value';
        }
        if (char === '"') {
            if (!frame || frame.state !== 'key' && frame.state !== 'value') return uncertain(index);
            if (input[index] === '"' && !append(insertion(index, '\\', 'Restore an outer escape around embedded JSON text'))) return uncertain(index);
            stringIsKey = frame.state === 'key';
            inString = true;
            index = end;
            continue;
        }
        if (frame?.state === 'key') return uncertain(index);
        if (char === '{' || char === '[') {
            if (started && (!frame || frame.state !== 'value')) return uncertain(index);
            if (context.depth + frames.length + 1 > context.maxDepth) return uncertain(index);
            started = true;
            frames.push({ close: char === '{' ? '}' : ']', state: char === '{' ? 'key' : 'value', empty: true });
            index = end;
            continue;
        }
        if (!frame || frame.state !== 'value') return uncertain(index);
        // Numeric spelling is checked as text, never converted through Number.
        let token = '', tokenEnd = index;
        while (tokenEnd < limit) {
            const part = decodeOuter(input, tokenEnd, context);
            if (!part || space(part.char) || ',]}"'.includes(part.char)) break;
            if (!/[\da-zA-Z.+\-]/u.test(part.char)) return uncertain(tokenEnd);
            token += part.char;
            tokenEnd = part.end;
        }
        if (!number.test(token) && token !== 'true' && token !== 'false' && token !== 'null') return uncertain(index);
        index = tokenEnd;
        finish();
    }
    if (boundary !== undefined && index === boundary && !inString && !innerEscape && !unicode) {
        let suffix = '';
        while (frames.length) {
            charge(context);
            const frame = frames[frames.length - 1];
            const empty = frame.empty && frame.state === (frame.close === '}' ? 'key' : 'value');
            // A value, key or separator after a comma is still required. Closing
            // that frame would discard missing data rather than restore structure.
            if (frame.state !== 'separator' && !empty) return uncertain(index);
            suffix += frame.close;
            frames.pop();
            finish();
        }
        if (!done || !append(insertion(boundary, suffix + '"', 'Complete encoded JSON containers before the outer structure', 'inferred'))) return uncertain(index);
        return { end: boundary, edits, closed: true };
    }
    return uncertain(index);
}

/** Only JSON-shaped prefixes opt into structural recovery; ordinary fragments stay text. */
function embeddedBeforeBoundary(input: string, start: number, boundary: number, context: RepairStringContext): RepairStringScan | undefined {
    if (input[start] !== '"' || context.role !== 'value' || context.container === 'root') return undefined;
    // A raw following key establishes an OUTER comma, not an unfinished
    // trailing comma inside the encoded JSON. Keep it for the outer parser.
    if (context.container === 'object') {
        const outerLimit = Math.min(input.length, boundary + context.maxLookahead);
        const sibling = trivia(input, boundary, outerLimit, context);
        if (objectKey(input, sibling, outerLimit, context)) {
            let end = boundary;
            while (end > start + 1 && space(input[end - 1])) { charge(context); end--; }
            if (input[end - 1] === ',') boundary = end - 1;
        }
    }
    const limit = Math.min(boundary, start + context.maxLookahead);
    let index = start + 1;
    const next = (): DecodedCharacter | undefined => {
        while (index < limit) {
            const decoded = decodeOuter(input, index, context);
            if (!decoded || decoded.end > limit) return undefined;
            index = decoded.end;
            if (!space(decoded.char)) return decoded;
        }
        return undefined;
    };
    const open = next()?.char;
    if (open !== '{' && open !== '[') return undefined;
    const first = next()?.char;
    if (first === undefined || (open === '{' ? first !== '"' : !/["{[\d\-tfn]/u.test(first))) return undefined;
    return embeddedString(input, start, context, boundary);
}

/** Scan exactly one string and return only source-local edits with UTF-16 offsets. */
function scanRepairStringInternal(input: string, start: number, context: RepairStringContext): RepairStringScan | undefined {
    const quote = endQuote(input[start]);
    if (!quote) return undefined;
    let index = start + 1, boundary: number | undefined, nextBoundaryProbe = index;
    // The ordinary scan is linear and unbounded: a long, already closed string is
    // not invalid merely because contextual repair has a small lookahead budget.
    while (index < input.length) {
        charge(context);
        if (input[index] === '\\') { index = escapedEnd(input, index, context); continue; }
        if (input[index] === quote) break;
        if (context.role === 'value' && boundary === undefined && index >= nextBoundaryProbe && (input[index] === '\n' || input[index] === '\r')) {
            const found = newlineBoundary(input, index, context);
            boundary = found.boundary;
            nextBoundaryProbe = Math.max(index + 1, found.probed);
        }
        index++;
    }
    const quotedBracket = index < input.length && /[}\]]/u.test(input[index + 1] || '') && input[index + 2] === quote
        && !outerEnd(input, index + 2, context, true);
    const afterQuote = trivia(input, index + 1, Math.min(input.length, index + context.maxLookahead), context);
    const afterComma = input[afterQuote] === ',' ? trivia(input, afterQuote + 1, Math.min(input.length, index + context.maxLookahead), context) : afterQuote;
    // An escaped quote cannot begin an OUTER key/value. It proves that a quote
    // followed by a comma is still part of a damaged encoded container, unlike
    // a legitimate sibling such as , "admin": true, which must remain outside.
    const embeddedContinuation = input[start] === '"' && input[afterComma] === '\\' && input[afterComma + 1] === '"';
    // A lost final inner quote escape may be followed by the inner container's
    // closers and then the real outer quote. Verify the ENTIRE inner grammar
    // before treating that earlier quote as an ordinary outer string ending.
    if (input[start] === '"' && context.role === 'value' && /[}\]]/u.test(punctuation(input[afterQuote] || ''))
        && input.slice(start + 1, index).includes('\\"')) {
        const limit = Math.min(input.length, afterQuote + context.maxLookahead);
        let end = afterQuote;
        while (end < limit && /[}\]\s]/u.test(input[end])) { charge(context); end++; }
        if (input[end] === '"') {
            const inner = embeddedString(input, start, context);
            if (inner?.closed) return inner;
        }
    }

    if (index < input.length && (context.role === 'key' || !quotedBracket && !embeddedContinuation && outerEnd(input, index, context))) {
        const edits: RepairEdit[] = [];
        if (input[start] === '“' || input[start] === '‘') {
            const regular = input[start] === '“' ? '"' : "'";
            if (context.maxEdits < 2) return uncertain(index);
            edits.push({ start, end: start + 1, text: regular, reason: 'Normalize an opening smart quote', risk: 'syntax' });
            for (let inner = start + 1; inner < index; inner++) {
                charge(context);
                if (input[inner] === '\\') { inner = escapedEnd(input, inner, context) - 1; continue; }
                if (input[inner] === regular) {
                    if (edits.length + 1 >= context.maxEdits) return uncertain(inner);
                    edits.push(insertion(inner, '\\', 'Keep a business quote inside smart quote delimiters'));
                }
            }
            edits.push({ start: index, end: index + 1, text: regular, reason: 'Normalize a closing smart quote', risk: 'syntax' });
        }
        return edits.length <= context.maxEdits ? { end: index + 1, edits, closed: true } : uncertain(index);
    }
    if (context.role === 'value' && boundary !== undefined) {
        const structured = embeddedBeforeBoundary(input, start, boundary, context);
        if (structured) return structured;
        if (context.maxEdits < 1) return uncertain(boundary);
        return { end: boundary, edits: [insertion(boundary, quote, 'Close a string before the following JSON structure', 'inferred')], closed: true };
    }
    let trailingBoundary: number | undefined;
    if (index === input.length) {
        let suffix = input.length;
        while (suffix > start + 1 && space(input[suffix - 1])) { charge(context); suffix--; }
        let depth = context.expectedClosers.length;
        while (suffix > start + 1 && depth > 0 && punctuation(input[suffix - 1]) === context.expectedClosers[depth - 1]) { charge(context); suffix--; depth--; }
        if (depth !== context.expectedClosers.length && context.maxEdits >= 1 && input[suffix - 1] !== '\\') {
            trailingBoundary = suffix;
            const structured = embeddedBeforeBoundary(input, start, suffix, context);
            if (structured) return structured;
        }
    }
    const embedded = embeddedString(input, start, context);
    if (embedded) return embedded;
    if (index === input.length) {
        if (trailingBoundary === undefined) return uncertain(index);
        return { end: trailingBoundary, edits: [insertion(trailingBoundary, quote, 'Close a string before its trailing container delimiter', 'inferred')], closed: true };
    }
    if (context.role === 'key') return uncertain(index);
    const edits: RepairEdit[] = [];
    const limit = Math.min(input.length, index + context.maxLookahead);
    while (index < input.length && index < limit) {
        charge(context);
        if (input[index] === '\\') { index = escapedEnd(input, index, context); continue; }
        if (input[index] === quote) {
            if (!(edits.length === 0 && quotedBracket) && outerEnd(input, index, context, edits.length > 0)) return { end: index + 1, edits, closed: true };
            // Existing double quotes are escaped, while JSON5 quote styles keep
            // their delimiter and use the compatible parser's existing escapes.
            if (edits.length >= context.maxEdits) return uncertain(index);
            edits.push(insertion(index, '\\', 'Escape a quotation mark inside a string value'));
        }
        if (input[index] === '\n' || input[index] === '\r') {
            const found = newlineBoundary(input, index, context);
            if (found.boundary !== undefined) return uncertain(index);
        }
        index++;
    }
    return uncertain(index);
}

/** Budget cancellation never publishes partial edits; the caller retains its limit reason. */
export function scanRepairString(input: string, start: number, context: RepairStringContext): RepairStringScan | undefined {
    try { return scanRepairStringInternal(input, start, context); }
    catch (error) {
        if (error === budgetExceeded) return uncertain(start);
        throw error;
    }
}
