import parseJSON5 from 'json5/lib/parse.js';
import { parseJsonInput, stringifyJsonValue } from './jsonEngine/service';
import { tryParseHighPrecisionWrapper } from './jsonEngine/numberLiteral';

/** Internal numeric values must have the engine's runtime seal, not a user-forgeable marker. */
export const isMarkedNumberString = (value: unknown): value is string =>
    typeof value === 'string' && tryParseHighPrecisionWrapper(value) !== null;

export const extractMarkedNumber = (value: string): string => {
    const literal = tryParseHighPrecisionWrapper(value);
    if (literal === null) throw new TypeError('Expected a protected JSON number');
    return literal;
};

/** Masking operates on semantic strings, never the formatter's multi-character tokens. */
export const parseMaskingInput = (input: string, indentSize = 2): { data: any; stringify: (value: any) => string } => {
    const options = { indentSize, arrayNewLine: true, preserveNumberLiterals: true, encodingMode: false };
    const parsed = parseJsonInput(input, options);
    const decodedEscapes = new Map<string, string>();
    const outputEscapes = new Map<string, string>();
    for (const [token, escape] of parsed.escapeMap) {
        // JSON5 escape semantics differ from the formatter's optional UTF-8 decoder.
        // Decode only registered source escapes, not literal backslash text in data.
        let decoded: string;
        try { decoded = parseJSON5('"' + escape + '"'); }
        catch { decoded = escape; }
        decodedEscapes.set(token, decoded);
        if (/^\\u[0-9a-fA-F]{4}$/.test(escape)) {
            outputEscapes.set(token, escape);
        }
    }
    const decodeString = (value: string): string => {
        // Registered escapes always start with U+E000; ordinary strings need no rebuild.
        if (decodedEscapes.size === 0 || !value.includes('\uE000')) return value;
        let result = '';
        for (let i = 0; i < value.length;) {
            const token = value[i] === '\uE000' ? value.slice(i, i + 14) : '';
            const decoded = decodedEscapes.get(token);
            if (decoded !== undefined) { result += decoded; i += token.length; }
            else { result += value[i++]; }
        }
        return result;
    };
    const encodeString = (value: string, original: unknown): string => {
        if (typeof original !== 'string' || outputEscapes.size === 0 || !original.includes('\uE000')) return value;
        const decoded = decodeString(original);
        let prefix = 0;
        while (prefix < value.length && prefix < decoded.length && value[prefix] === decoded[prefix]) prefix++;
        let suffix = 0;
        while (suffix < value.length - prefix && suffix < decoded.length - prefix &&
            value[value.length - 1 - suffix] === decoded[decoded.length - 1 - suffix]) suffix++;
        const spellings = new Map<number, string>();
        for (let i = 0, position = 0; i < original.length;) {
            const token = original[i] === '\uE000' ? original.slice(i, i + 14) : '';
            const text = decodedEscapes.get(token);
            if (text !== undefined) {
                if (outputEscapes.has(token)) spellings.set(position, token);
                position += text.length;
                i += token.length;
            } else { i++; position++; }
        }
        let result = '';
        for (let i = 0; i < value.length; i++) {
            const sourceIndex = i < prefix ? i : i >= value.length - suffix ? decoded.length - (value.length - i) : -1;
            result += spellings.get(sourceIndex) ?? value[i];
        }
        return result;
    };
    const mapStrings = (value: any, transform: (text: string) => string): any => {
        if (typeof value === 'string') return isMarkedNumberString(value) ? value : transform(value);
        if (Array.isArray(value)) return value.map(item => mapStrings(item, transform));
        if (value && typeof value === 'object') {
            const result = Object.create(null);
            for (const key of Object.keys(value)) {
                Object.defineProperty(result, transform(key), {
                    value: mapStrings(value[key], transform), enumerable: true, writable: true, configurable: true,
                });
            }
            return result;
        }
        return value;
    };
    const restoreSpellings = (value: any, original: any): any => {
        if (typeof value === 'string') return isMarkedNumberString(value) ? value : encodeString(value, original);
        if (Array.isArray(value)) return value.map((item, index) => restoreSpellings(item, Array.isArray(original) ? original[index] : undefined));
        if (value && typeof value === 'object') {
            const sourceKeys = new Map<string, string>();
            if (original && typeof original === 'object' && !Array.isArray(original)) {
                for (const key of Object.keys(original)) sourceKeys.set(decodeString(key), key);
            }
            const result = Object.create(null);
            for (const key of Object.keys(value)) {
                const sourceKey = sourceKeys.get(key);
                Object.defineProperty(result, encodeString(key, sourceKey), {
                    value: restoreSpellings(value[key], sourceKey === undefined ? undefined : original[sourceKey]),
                    enumerable: true, writable: true, configurable: true,
                });
            }
            return result;
        }
        return value;
    };
    return {
        data: mapStrings(parsed.data, decodeString),
        stringify: value => stringifyJsonValue(restoreSpellings(value, parsed.data), outputEscapes, options),
    };
};
