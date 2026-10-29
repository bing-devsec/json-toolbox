import JSON5 from 'json5';

/** Source slices remain authoritative; profiles describe relationships and never regenerate values. */
export interface RepairRootCandidate {
    text: string;
    start: number;
    end: number;
    /** Contextually repaired text is used for classification only. */
    profileText?: string;
}
type Role = 'record' | 'collection' | 'atomic-wrapper' | 'empty-object' | 'value-list' | 'value';
interface Profile {
    kind: 'object' | 'array' | 'primitive';
    role: Role;
    keys: Set<string>;
    primitiveKind?: string;
}
export interface RepairRootSelection {
    roots: readonly RepairRootCandidate[];
    reason: 'single-root' | 'primary-document' | 'peer-records' | 'no-document' | 'unknown-syntax';
}
const punctuation: Record<string, string> = { '｛': '{', '｝': '}', '［': '[', '］': ']', '：': ':', '，': ',' };
const canonical = (char: string): string => punctuation[char] ?? char;
const quoteEnd = (char: string): string | undefined => char === '"' || char === "'" ? char : char === '“' ? '”' : char === '‘' ? '’' : undefined;
const primitive = /^(?:true|false|null|undefined|[+-]?(?:NaN|Infinity|0[xX][\da-fA-F]+|(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?))$/;
function triviaEnd(input: string, start: number): number {
    let index = start;
    while (index < input.length) {
        if (/\s/.test(input[index])) { index++; continue; }
        if (input[index] === '#' || input.startsWith('//', index)) {
            while (index < input.length && !/[\r\n\u2028\u2029]/.test(input[index])) index++;
        } else if (input.startsWith('/*', index)) {
            const end = input.indexOf('*/', index + 2);
            if (end < 0) return input.length;
            index = end + 2;
        } else break;
    }
    return index;
}
function profile(input: string): Profile | undefined {
    let index = triviaEnd(input, 0), hasArrayChild = false, hasValue = false;
    let pendingKey: string | undefined;
    const first = canonical(input[index]);
    const kind = first === '{' ? 'object' : first === '[' ? 'array' : 'primitive';
    const stack: string[] = [], keys = new Set<string>();
    const fields = new Map<string, 'text' | 'container' | 'atom'>();
    while (index < input.length) {
        index = triviaEnd(input, index);
        if (index === input.length) break;
        const char = canonical(input[index]);
        if (char === '{' || char === '[') {
            if (stack.length === 1) {
                if (kind === 'array') hasArrayChild = true;
                else if (pendingKey !== undefined) { fields.set(pendingKey, 'container'); pendingKey = undefined; }
            }
            stack.push(char === '{' ? '}' : ']');
            hasValue = true; index++; continue;
        }
        if (char === '}' || char === ']') {
            if (stack.pop() !== char) return undefined;
            index++; continue;
        }
        if (char === ',' || char === ':') { index++; continue; }
        const start = index, quote = quoteEnd(input[index]);
        let key: string | undefined;
        if (quote) {
            let closed = false;
            index++;
            while (index < input.length) {
                if (input[index] === '\\') { index += 2; continue; }
                if (input[index++] === quote) { closed = true; break; }
            }
            if (!closed) return undefined;
            if (stack.length === 1 && kind === 'object') {
                if (canonical(input[triviaEnd(input, index)]) === ':') {
                    // Decode key identity only. Numeric values and encoded payload strings stay opaque.
                    try {
                        const decoded: unknown = JSON5.parse(input.slice(start, index));
                        if (typeof decoded !== 'string') return undefined;
                        key = decoded;
                    } catch { return undefined; }
                } else if (pendingKey !== undefined) { fields.set(pendingKey, 'text'); pendingKey = undefined; }
            }
        } else {
            while (index < input.length && !/[\s{}\[\]:,｛｝［］：，]/.test(input[index]) && input[index] !== '#' && !input.startsWith('//', index) && !input.startsWith('/*', index)) index++;
            if (index === start) return undefined;
            const token = input.slice(start, index);
            if (canonical(input[triviaEnd(input, index)]) === ':') {
                if (!/^[$_\p{ID_Start}][$_\u200c\u200d\p{ID_Continue}]*$/u.test(token)) return undefined;
                if (stack.length === 1 && kind === 'object') key = token;
            } else {
                if (!primitive.test(token)) return undefined;
                if (stack.length === 1 && kind === 'object' && pendingKey !== undefined) {
                    fields.set(pendingKey, 'atom'); pendingKey = undefined;
                }
            }
        }
        hasValue = true;
        if (key !== undefined) { keys.add(key); pendingKey = key; }
    }
    if (stack.length || pendingKey !== undefined || !hasValue) return undefined;
    const hasContextValue = [...fields.values()].some(type => type !== 'atom');
    // These are categorical shapes, not a size score. Repeated keys do not create extra attributes.
    const role: Role = kind === 'object'
        ? hasContextValue || keys.size > 1 ? 'record' : keys.size ? 'atomic-wrapper' : 'empty-object'
        : kind === 'array' ? hasArrayChild ? 'collection' : 'value-list' : 'value';
    return { kind, role, keys, primitiveKind: kind === 'primitive' ? /^(?:true|false)$/.test(input.trim()) ? 'boolean' : /^(?:null|undefined)$/.test(input.trim()) ? 'null' : 'number' : undefined };
}
function hasLogFrame(input: string, root: RepairRootCandidate, previousEnd: number): boolean {
    let start = root.start;
    while (start > previousEnd && !/[\r\n\u2028\u2029]/.test(input[start - 1])) start--;
    // A preceding JSON value on this same line cannot become a log prefix for its neighbour.
    if (start === previousEnd && previousEnd > 0 && !/[\r\n\u2028\u2029]/.test(input[start - 1])) return false;
    const prefix = input.slice(start, root.start).trimStart();
    return /^(?:TRACE|DEBUG|INFO|WARN|WARNING|ERROR|FATAL)\b/i.test(prefix)
        || /^\[?\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}/.test(prefix);
}
const isDocument = (item: Profile): boolean => item.role === 'record' || item.role === 'collection';
const signature = (item: Profile): string => JSON.stringify([...item.keys].sort());

/** Identify record relationships first, then omit only unassociated value fragments. */
export function selectRepairRootCandidates(input: string, roots: readonly RepairRootCandidate[]): RepairRootSelection {
    if (roots.length < 2) return { roots, reason: 'single-root' };
    // One linear lexical pass; long strings never add semantic weight or disable classification.
    const profiles = roots.map(root => profile(root.profileText ?? root.text));
    if (profiles.some(item => item === undefined)) return { roots, reason: 'unknown-syntax' };
    const known = profiles as Profile[];
    const framed = roots.map((root, index) => hasLogFrame(input, root, index ? roots[index - 1].end : 0));
    if (!known.some(isDocument) && !framed.some(Boolean)) return { roots, reason: 'no-document' };

    const fields = new Set<string>(), families = new Map<string, number>(), valueFamilies = new Map<string, number>();
    for (const item of known) {
        if (isDocument(item) && item.kind === 'object') for (const key of item.keys) fields.add(key);
        if (item.primitiveKind) valueFamilies.set(item.primitiveKind, (valueFamilies.get(item.primitiveKind) ?? 0) + 1);
        if (item.kind === 'object' && item.keys.size) {
            const shape = signature(item);
            families.set(shape, (families.get(shape) ?? 0) + 1);
        }
    }
    const selected = roots.filter((root, index) => {
        const item = known[index];
        if (framed[index] || isDocument(item)) return true;
        if (item.primitiveKind) return (valueFamilies.get(item.primitiveKind) ?? 0) > 1;
        if (item.kind !== 'object' || !item.keys.size) return false;
        // A repeated field family or a direct field relation is evidence of a parallel record.
        return (families.get(signature(item)) ?? 0) > 1 || [...item.keys].every(key => fields.has(key));
    });
    return { roots: selected, reason: selected.length === 1 ? 'primary-document' : 'peer-records' };
}
