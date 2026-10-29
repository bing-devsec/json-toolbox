import { parseJsonInput, stringifyJsonValue } from './jsonEngine/service';
import { JsonPlusFormatter } from './jsonEngine/formatter';
import { normalizeRepairValues } from './repairValueTokens';
import { JsonInputParseError, type JsonFormatterOptions } from './jsonEngine/types';
import { hasLeadingLogTimestamp, selectRepairRoots } from './repairRoots';
import type { RepairEdit } from './contextualRepair/types';

export { normalizeRepairValues } from './repairValueTokens';
export type FormatStage = 'parsing' | 'repairing' | 'formatting' | 'saving';
export interface RepairFormatResult {
    formatted: string;
    repaired?: string;
    repairEngine?: 'contextual' | 'legacy';
    /** Available only when edit offsets refer directly to the original input. */
    repairEdits?: RepairEdit[];
}

/** Decode pasted HTML quote delimiters while leaving already quoted business text intact. */
function normalizeHtmlQuoteDelimiters(input: string): string {
    if (!/&(?:quot|#34|#x22);/i.test(input)) return input;
    const parts: string[] = [];
    let index = 0, start = 0;
    while (index < input.length) {
        const char = input[index];
        if (char === '#' || input.startsWith('//', index)) {
            while (index < input.length && !/[\r\n\u2028\u2029]/.test(input[index])) index++;
            continue;
        }
        if (input.startsWith('/*', index)) {
            const close = input.indexOf('*/', index + 2);
            index = close < 0 ? input.length : close + 2;
            continue;
        }
        if (char === '"' || char === "'" || char === '“' || char === '‘') {
            const quote = char === '“' ? '”' : char === '‘' ? '’' : char;
            index++;
            while (index < input.length) {
                if (input[index] === '\\') { index += 2; continue; }
                if (input[index++] === quote) break;
            }
            continue;
        }
        const entity = input[index] === '&' ? /^&(?:quot|#34|#x22);/i.exec(input.slice(index, index + 8))?.[0] : undefined;
        if (entity) {
            parts.push(input.slice(start, index), '"');
            index += entity.length;
            start = index;
        } else index++;
    }
    if (!parts.length) return input;
    parts.push(input.slice(start));
    return parts.join('');
}

/** Deterministic refusal: a compatibility fallback must not invent the missing data. */
export class JsonRepairSafetyError extends Error {
    constructor(message: string) {
        super('JSON repair needs review: ' + message);
        this.name = 'JsonRepairSafetyError';
    }
}

export async function formatWithOptionalRepair(
    input: string, options: JsonFormatterOptions, repairEnabled: boolean,
    onStage: (stage: FormatStage) => void = () => {},
): Promise<RepairFormatResult> {
    onStage('parsing');
    let parsed;
    try {
        parsed = parseJsonInput(input, options);
    } catch (error) {
        // Keep the existing successful JSON/JSON5 path and never retry a resource/formatting failure.
        if (!repairEnabled || !(error instanceof JsonInputParseError)) throw error;
        onStage('repairing');
        const { repairJsonWithContext } = await import('./contextualRepair/parser');
        const { repairEscapedRoot } = await import('./contextualRepair/escapedRoot');
        const root = repairEscapedRoot(input);
        if (root.text !== undefined) {
            // Transport decoding changes source offsets; preserve the full
            // repaired text for Diff without exposing decoded edit offsets.
            onStage('parsing');
            parsed = parseJsonInput(root.text, options);
            onStage('formatting');
            return {
                repaired: root.text,
                formatted: stringifyJsonValue(parsed.data, parsed.escapeMap, options),
                repairEngine: 'contextual',
            };
        }
        if (root.recognized) throw new JsonRepairSafetyError(root.reason ?? 'Escaped root boundary cannot be determined reliably');
        let source = normalizeHtmlQuoteDelimiters(input);
        let candidate = repairJsonWithContext(source);
        if ((candidate.status === 'unsupported' || (candidate.status === 'unsafe' && hasLeadingLogTimestamp(source))) && candidate.text === undefined) {
            // Classify primary content and peer records only after complete container checks.
            // Source edits are never advertised as original offsets after root extraction.
            const roots = selectRepairRoots(source, (text, start) => {
                const framed = repairJsonWithContext(text.slice(start), {}, { stopAfterRoot: true });
                if (framed.status === 'unsafe' || framed.status === 'limit') {
                    throw new JsonRepairSafetyError(framed.reason ?? 'The JSON root has an uncertain boundary');
                }
                if (framed.status === 'unsupported' && !framed.legacyCompatible) {
                    throw new JsonRepairSafetyError('An extension has an uncertain container boundary');
                }
                return framed.rootEnd === undefined ? undefined : { end: start + framed.rootEnd, profileText: framed.text };
            });
            if (roots !== source) {
                source = roots;
                candidate = repairJsonWithContext(source);
            }
        }
        if (candidate.status === 'unsafe' || candidate.status === 'limit') {
            throw new JsonRepairSafetyError(candidate.reason ?? 'The input cannot be repaired reliably');
        }
        if (candidate.text !== undefined) {
            // A second heuristic repair can corrupt an already valid outer
            // document merely because a legitimate string contains a JSON fragment.
            // Validate without building an AST; visitor values are never used to
            // regenerate text, so exact numbers, duplicate keys and strings survive.
            const { visit } = await import('jsonc-parser/lib/esm/main.js');
            let strict = true;
            visit(candidate.text, { onError: () => { strict = false; } }, {
                disallowComments: true, allowTrailingComma: false, allowEmptyContent: false,
            });
            if (strict) {
                onStage('parsing');
                parsed = parseJsonInput(candidate.text, options);
                onStage('formatting');
                return {
                    repaired: candidate.text,
                    formatted: stringifyJsonValue(parsed.data, parsed.escapeMap, options),
                    repairEngine: 'contextual',
                    repairEdits: source === input ? candidate.edits : undefined,
                };
            }
            // Context recovery resolves structure first. Reuse the existing lexical compatibility
            // conversion for JSON5 comments, quotes and literal escapes; never stringify numeric data.
            const { jsonrepair } = await import('jsonrepair');
            const protector = new JsonPlusFormatter(false, options.indentSize, options.arrayNewLine, true);
            const protectedInput = protector.prepareRepairInput(normalizeRepairValues(candidate.text));
            let repaired: string;
            try {
                repaired = protector.restoreRepairEscapes(jsonrepair(protectedInput.text), protectedInput.escapeMap);
            } catch (conversionError) {
                const message = conversionError instanceof Error ? conversionError.message : String(conversionError);
                // Converted-text offsets do not refer to the original editor source.
                throw new Error('JSON repair failed: ' + message.replace(/ at position \d+/, ''));
            }
            // Validate the complete output before any result or partial edit is exposed.
            onStage('parsing');
            parsed = parseJsonInput(repaired, options);
            onStage('formatting');
            return {
                repaired,
                formatted: stringifyJsonValue(parsed.data, parsed.escapeMap, options),
                repairEngine: 'contextual',
                repairEdits: source === input && repaired === candidate.text ? candidate.edits : undefined,
            };
        }
        // Do not turn prose into a successful JSON string merely by adding quotes around it.
        // Root extraction above still accepts pasted logs/JSONP that contain a JSON container.
        if (source === input && !/^[\s;]*(?:[\[{｛［]|\/)/.test(input)) {
            throw new JsonRepairSafetyError('No recognizable JSON container was found');
        }
        // Compatibility is allowed only after a complete structural scan. A partial
        // unsupported parse must not let the old engine invent unseen field values.
        const completeRootRegex = /^\s*\/(?:\\.|[^/\\\r\n])+\/[a-z]*\s*$/i.test(input);
        if (!candidate.legacyCompatible && !completeRootRegex) {
            // The previous embedded-string recognizer validates the ENTIRE outer
            // document and never fills missing values. Retain that narrow,
            // bounded compatibility path, rather than unrestricted legacy repair.
            if (source.length <= 32768) {
                const { findEmbeddedJsonStringRepair } = await import('./repairEmbeddedJsonStrings');
                const embedded = findEmbeddedJsonStringRepair(source);
                if (embedded !== undefined) {
                    onStage('parsing');
                    parsed = parseJsonInput(embedded, options);
                    onStage('formatting');
                    return { repaired: embedded, formatted: stringifyJsonValue(parsed.data, parsed.escapeMap, options), repairEngine: 'legacy' };
                }
            }
            throw new JsonRepairSafetyError('An unsupported extension has an uncertain structural boundary');
        }
        // Extension syntaxes (JSONP, Mongo wrappers, etc.) retain their established behavior.
        // This fallback is deliberately unavailable after an unsafe/budget-limited decision.
        const legacy = await import('./legacyJsonRepair');
        const result = await legacy.formatWithOptionalRepair(input, options, true, onStage);
        return { ...result, repairEngine: 'legacy' };
    }
    onStage('formatting');
    return { formatted: stringifyJsonValue(parsed.data, parsed.escapeMap, options) };
}
