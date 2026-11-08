import {
    parseJsonInput,
    getNextSignificantChar,
    stringifyJsonValue,
    tryParseHighPrecisionWrapper,
    tryReadHighPrecisionWrapperObject,
    type JsonFormatterOptions,
} from './jsonEngine';
import { detectIllegalEscapes, detectInconsistentEscapeLevels } from './jsonStructure';
import { ChunkedStringBuilder } from './jsonEngine/stringBuilder';

const DEFAULT_MAX_PARSE_ITERATIONS = 30;
const DEFAULT_MAX_DEPTH = 100;
const ESCAPE_PLACEHOLDER_START = '\uE000';
const ESCAPE_PLACEHOLDER_LENGTH = 14;

export type JsonUnescapeMessageKind = 'success' | 'shallow-success' | 'double-success' | 'not-detected';

export type JsonUnescapeErrorCode = 'illegal-escape' | 'invalid-json';

export interface JsonUnescapeOptions {
    recursive: boolean;
    indentSize: number;
    arrayNewLine: boolean;
    preserveNumberLiterals?: boolean;
    maxParseIterations?: number;
    maxDepth?: number;
}

export type JsonUnescapeResult =
    | {
          ok: true;
          text: string;
          messageKind: JsonUnescapeMessageKind;
          hasInconsistentEscape: boolean;
      }
    | {
          ok: false;
          code: JsonUnescapeErrorCode;
          hasInconsistentEscape: boolean;
      };

type ParseFailureReason = JsonUnescapeErrorCode;

type ParseLayerResult =
    | {
          ok: true;
          value: any;
      }
    | {
          ok: false;
          reason: ParseFailureReason;
      };

type StringExpandResult =
    | {
          expanded: true;
          value: any;
          layers: number;
      }
    | {
          expanded: false;
      };

interface JsonUnescapeContext {
    formatterOptions: JsonFormatterOptions;
    escapeMap: Map<string, string>;
    nextEscapePlaceholderId: number;
    literalEscapePlaceholders?: Set<string>;
    maxParseIterations: number;
    maxDepth: number;
}

const createFormatterOptions = (options: JsonUnescapeOptions): JsonFormatterOptions => ({
    indentSize: options.indentSize,
    arrayNewLine: options.arrayNewLine,
    preserveNumberLiterals: options.preserveNumberLiterals ?? true,
    encodingMode: false,
});

const createContext = (options: JsonUnescapeOptions, input: string): JsonUnescapeContext => ({
    formatterOptions: createFormatterOptions(options),
    escapeMap: new Map<string, string>(),
    nextEscapePlaceholderId: 0,
    literalEscapePlaceholders: collectLiteralEscapePlaceholders(input),
    maxParseIterations: options.maxParseIterations ?? DEFAULT_MAX_PARSE_ITERATIONS,
    maxDepth: options.maxDepth ?? DEFAULT_MAX_DEPTH,
});

// 生成与 formatter 兼容的 14 字符 escape placeholder，仅用于跨层 key 冲突兜底。
const createContextEscapePlaceholder = (ctx: JsonUnescapeContext): string => {
    let value = ctx.nextEscapePlaceholderId++;
    let placeholder = ESCAPE_PLACEHOLDER_START;
    for (let i = 1; i < ESCAPE_PLACEHOLDER_LENGTH; i++) {
        placeholder += String.fromCharCode(0xe001 + (value & 0x7ff));
        value = value >>> 11;
    }
    return placeholder;
};

const allocateEscapePlaceholder = (ctx: JsonUnescapeContext, originalEscape: string, occupiedPlaceholders: Set<string>): string => {
    let placeholder = createContextEscapePlaceholder(ctx);
    while (ctx.escapeMap.has(placeholder) || occupiedPlaceholders.has(placeholder)) {
        placeholder = createContextEscapePlaceholder(ctx);
    }
    ctx.escapeMap.set(placeholder, originalEscape);
    return placeholder;
};

const collectStringEscapePlaceholders = (text: string, occupied: Set<string>, start: number): void => {
    let index = start;
    while (index !== -1 && index + ESCAPE_PLACEHOLDER_LENGTH <= text.length) {
        occupied.add(text.slice(index, index + ESCAPE_PLACEHOLDER_LENGTH));
        index = text.indexOf(ESCAPE_PLACEHOLDER_START, index + 1);
    }
};

// Later parsers only see their own layer. Keep raw user tokens from the original
// document reserved across every layer so they can never become registered escapes.
const collectLiteralEscapePlaceholders = (input: string): Set<string> | undefined => {
    const first = input.indexOf(ESCAPE_PLACEHOLDER_START);
    if (first === -1) return undefined;
    const occupied = new Set<string>();
    collectStringEscapePlaceholders(input, occupied, first);
    return occupied;
};

// Only collision handling needs the occupied tree tokens. Avoid serializing the
// whole tree, and make candidate allocation a Set lookup rather than a text scan.
const collectOccupiedEscapePlaceholders = (value: any, sourceEscapeMap: Map<string, string>, literals?: Set<string>): Set<string> => {
    const occupied = new Set(sourceEscapeMap.keys());
    if (literals) for (const token of literals) occupied.add(token);
    const collectString = (text: string): void => collectStringEscapePlaceholders(text, occupied, text.indexOf(ESCAPE_PLACEHOLDER_START));
    const pending = [value];
    while (pending.length > 0) {
        const current = pending.pop();
        if (typeof current === 'string') {
            collectString(current);
        } else if (Array.isArray(current)) {
            for (const item of current) pending.push(item);
        } else if (current && typeof current === 'object') {
            for (const key of Object.keys(current)) {
                collectString(key);
                pending.push(current[key]);
            }
        }
    }
    return occupied;
};

const replaceEscapePlaceholdersInString = (value: string, placeholderMap: Map<string, string>): string => {
    const output = new ChunkedStringBuilder();
    let unchangedStart = 0;
    let index = value.indexOf(ESCAPE_PLACEHOLDER_START);
    while (index !== -1 && index + ESCAPE_PLACEHOLDER_LENGTH <= value.length) {
        const replacement = placeholderMap.get(value.slice(index, index + ESCAPE_PLACEHOLDER_LENGTH));
        if (replacement !== undefined) {
            output.append(value.slice(unchangedStart, index));
            output.append(replacement);
            unchangedStart = index + ESCAPE_PLACEHOLDER_LENGTH;
            index = value.indexOf(ESCAPE_PLACEHOLDER_START, unchangedStart);
        } else {
            index = value.indexOf(ESCAPE_PLACEHOLDER_START, index + 1);
        }
    }
    if (unchangedStart === 0) return value;
    output.append(value.slice(unchangedStart));
    return output.toString();
};

const replaceEscapePlaceholdersInValue = (value: any, placeholderMap: Map<string, string>): any => {
    if (typeof value === 'string') {
        return replaceEscapePlaceholdersInString(value, placeholderMap);
    }
    if (Array.isArray(value)) {
        return value.map((item) => replaceEscapePlaceholdersInValue(item, placeholderMap));
    }
    if (value && typeof value === 'object') {
        const output: Record<string, any> = Object.create(null);
        for (const key of Object.keys(value)) {
            output[replaceEscapePlaceholdersInString(key, placeholderMap)] = replaceEscapePlaceholdersInValue(value[key], placeholderMap);
        }
        return output;
    }
    return value;
};

// 复用 parser 返回的完整 placeholder，避免去除转义阶段泄漏内部私有区字符。
const registerParsedEscapes = (ctx: JsonUnescapeContext, value: any, sourceEscapeMap: Map<string, string>): any => {
    if (sourceEscapeMap.size === 0) return value;

    let occupiedPlaceholders: Set<string> | undefined;
    let placeholderMap: Map<string, string> | undefined;
    for (const [sourcePlaceholder, originalEscape] of sourceEscapeMap) {
        const existingEscape = ctx.escapeMap.get(sourcePlaceholder);
        if ((existingEscape === undefined || existingEscape === originalEscape) && !ctx.literalEscapePlaceholders?.has(sourcePlaceholder)) {
            ctx.escapeMap.set(sourcePlaceholder, originalEscape);
        } else {
            occupiedPlaceholders ??= collectOccupiedEscapePlaceholders(value, sourceEscapeMap, ctx.literalEscapePlaceholders);
            placeholderMap ??= new Map<string, string>();
            placeholderMap.set(sourcePlaceholder, allocateEscapePlaceholder(ctx, originalEscape, occupiedPlaceholders));
        }
    }

    return placeholderMap ? replaceEscapePlaceholdersInValue(value, placeholderMap) : value;
};

const parseJsonLayer = (ctx: JsonUnescapeContext, source: string, rejectIllegalEscapes: boolean): ParseLayerResult => {
    if (rejectIllegalEscapes && detectIllegalEscapes(source, 'json').hasIllegal) {
        return { ok: false, reason: 'illegal-escape' };
    }

    try {
        const parsed = parseJsonInput(source, ctx.formatterOptions);
        return {
            ok: true,
            value: registerParsedEscapes(ctx, parsed.data, parsed.escapeMap),
        };
    } catch {
        return { ok: false, reason: 'invalid-json' };
    }
};

const decodeJsonStringLiteral = (ctx: JsonUnescapeContext, source: string): ParseLayerResult => {
    if (detectIllegalEscapes(source).hasIllegal) {
        return { ok: false, reason: 'illegal-escape' };
    }

    const parsed = parseJsonLayer(ctx, `"${source}"`, true);
    if (!parsed.ok || typeof parsed.value !== 'string') {
        return parsed.ok ? { ok: false, reason: 'invalid-json' } : parsed;
    }
    return parsed;
};

// Match the compatibility parser's comment handling without rewriting input.
// Bare scalar text such as "123", "true" and "null" must remain text.
const isExpandableJsonDocument = (value: string): boolean => {
    const first = getNextSignificantChar(value, 0);
    return first === '{' || first === '[' || first === '"';
};

const looksLikeEscapedJsonContainer = (value: string): boolean => value.includes('\\"');

const isHighPrecisionValue = (value: any): boolean => {
    if (typeof value === 'string') {
        return tryParseHighPrecisionWrapper(value) !== null;
    }
    return tryReadHighPrecisionWrapperObject(value) !== null;
};

const tryExpandStringOnce = (ctx: JsonUnescapeContext, source: string, maxTransportDecodes: number): StringExpandResult => {
    if (!source.trim() || isHighPrecisionValue(source)) {
        return { expanded: false };
    }

    const trimmed = source.trim();
    if (isExpandableJsonDocument(trimmed)) {
        const direct = parseJsonLayer(ctx, trimmed, true);
        if (direct.ok) {
            return { expanded: true, value: direct.value, layers: 1 };
        }
        if (direct.reason === 'illegal-escape') {
            return { expanded: false };
        }
    }

    // Transport text can remain escaped after one pass. Keep intermediate
    // candidates local and publish nothing until a complete JSON value parses.
    let candidate = trimmed;
    for (let decodedLayers = 1; decodedLayers <= maxTransportDecodes; decodedLayers++) {
        if (!looksLikeEscapedJsonContainer(candidate)) break;

        const decoded = decodeJsonStringLiteral(ctx, candidate);
        if (!decoded.ok || decoded.value === candidate) break;
        candidate = decoded.value.trim();
        if (!isExpandableJsonDocument(candidate)) continue;

        const parsedDecoded = parseJsonLayer(ctx, candidate, true);
        if (parsedDecoded.ok) {
            return { expanded: true, value: parsedDecoded.value, layers: decodedLayers + 1 };
        }
        if (parsedDecoded.reason === 'illegal-escape') break;
    }

    return { expanded: false };
};

const expandTopLevelString = (ctx: JsonUnescapeContext, source: string, recursive: boolean): { value: any; layers: number } => {
    let current: any = source;
    let layers = 0;
    let remainingIterations = recursive ? ctx.maxParseIterations : 1;

    while (remainingIterations > 0 && typeof current === 'string') {
        const expanded = tryExpandStringOnce(ctx, current, remainingIterations);
        if (!expanded.expanded || expanded.value === current) break;
        current = expanded.value;
        layers += expanded.layers;
        // Charge speculative transport passes to this same per-string budget.
        remainingIterations -= Math.max(1, expanded.layers - 1);
    }

    return { value: current, layers };
};

const expandNestedString = (ctx: JsonUnescapeContext, source: string, recursive: boolean, depth: number): { value: any; layers: number } => {
    let current: any = source;
    let layers = 0;
    let remainingIterations = recursive ? ctx.maxParseIterations : 1;

    while (remainingIterations > 0 && typeof current === 'string') {
        const expanded = tryExpandStringOnce(ctx, current, remainingIterations);
        if (!expanded.expanded || expanded.value === current) break;
        current = expanded.value;
        layers += expanded.layers;
        // Charge speculative transport passes to this same per-string budget.
        remainingIterations -= Math.max(1, expanded.layers - 1);

        if (!recursive) break;
        if (current && typeof current === 'object') {
            current = processValue(ctx, current, true, depth + 1);
            break;
        }
    }

    return { value: current, layers };
};

const processValue = (ctx: JsonUnescapeContext, value: any, recursive: boolean, depth: number): any => {
    if (depth > ctx.maxDepth || value === null || value === undefined || isHighPrecisionValue(value)) {
        return value;
    }

    if (typeof value === 'string') {
        return expandNestedString(ctx, value, recursive, depth).value;
    }

    if (Array.isArray(value)) {
        return value.map((item) => processValue(ctx, item, recursive, depth + 1));
    }

    if (typeof value === 'object') {
        const output: Record<string, any> = Object.create(null);
        for (const key of Object.keys(value)) {
            output[key] = processValue(ctx, value[key], recursive, depth + 1);
        }
        return output;
    }

    return value;
};

const resolveMessageKind = (recursive: boolean, topLevelLayers: number): JsonUnescapeMessageKind => {
    if (!recursive) return 'shallow-success';
    if (topLevelLayers >= 2) return 'double-success';
    return 'success';
};

export const unescapeJsonText = (input: string, options: JsonUnescapeOptions): JsonUnescapeResult => {
    const hasInconsistentEscape = detectInconsistentEscapeLevels(input);

    if (detectIllegalEscapes(input, 'json').hasIllegal) {
        return {
            ok: false,
            code: 'illegal-escape',
            hasInconsistentEscape,
        };
    }

    const ctx = createContext(options, input);
    const parsedInput = parseJsonLayer(ctx, input, false);
    if (!parsedInput.ok) {
        return {
            ok: false,
            code: 'invalid-json',
            hasInconsistentEscape,
        };
    }

    let processed = parsedInput.value;
    let topLevelLayers = 0;

    if (typeof processed === 'string') {
        const expanded = expandTopLevelString(ctx, processed, options.recursive);
        processed = expanded.value;
        topLevelLayers = expanded.layers;

        if (options.recursive && processed && typeof processed === 'object') {
            processed = processValue(ctx, processed, true, 0);
        }
    } else if (processed && typeof processed === 'object') {
        processed = processValue(ctx, processed, options.recursive, 0);
    }

    return {
        ok: true,
        text: stringifyJsonValue(processed, ctx.escapeMap, ctx.formatterOptions),
        messageKind: resolveMessageKind(options.recursive, topLevelLayers),
        hasInconsistentEscape,
    };
};
