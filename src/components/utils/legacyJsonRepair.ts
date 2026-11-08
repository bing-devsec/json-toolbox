import { JsonPlusFormatter } from './jsonEngine/formatter';
import { parseJsonInput, stringifyJsonValue } from './jsonEngine/service';
import { JsonInputParseError, type JsonFormatterOptions } from './jsonEngine/types';
import { selectRepairRoots } from './repairRoots';
import { findStringBoundaryRepair, insertMissingObjectCommas } from './repairStringBoundaries';
import { findEmbeddedJsonStringRepair } from './repairEmbeddedJsonStrings';

export type FormatStage = 'parsing' | 'repairing' | 'formatting' | 'saving';
export interface RepairFormatResult { formatted: string; repaired?: string }

// Keep the compatibility pipeline, but share the precision-safe lexical normalizer.
import { normalizeRepairValues } from './repairValueTokens';
export { normalizeRepairValues } from './repairValueTokens';

export async function formatWithOptionalRepair(
    input: string, options: JsonFormatterOptions, repairEnabled: boolean,
    onStage: (stage: FormatStage) => void = () => {},
): Promise<RepairFormatResult> {
    onStage('parsing');
    let parsed;
    try {
        parsed = parseJsonInput(input, options);
    } catch (error) {
        // A formatter/stack/memory error is not a syntax error and must not trigger another expensive parse.
        if (!repairEnabled || !(error instanceof JsonInputParseError)) throw error;
        onStage('repairing');
        const boundaryCandidate = findStringBoundaryRepair(input);
        if (boundaryCandidate !== undefined) {
            // A second syntax error must not discard an otherwise clear string boundary.
            // Complete only definite object separators, then validate the combined edit once.
            const boundaryRepair = insertMissingObjectCommas(boundaryCandidate);
            let boundaryParsed;
            try {
                // Validate before root selection: surrounding text must not hide a real closing quote.
                boundaryParsed = parseJsonInput(boundaryRepair, options);
            } catch (candidateError) {
                if (!(candidateError instanceof JsonInputParseError)) throw candidateError;
            }
            if (boundaryParsed) {
                onStage('formatting');
                return { repaired: boundaryRepair, formatted: stringifyJsonValue(boundaryParsed.data, boundaryParsed.escapeMap, options) };
            }
        }
        const embeddedRepair = findEmbeddedJsonStringRepair(input);
        if (embeddedRepair !== undefined) {
            const embeddedParsed = parseJsonInput(embeddedRepair, options);
            onStage('formatting');
            return { repaired: embeddedRepair, formatted: stringifyJsonValue(embeddedParsed.data, embeddedParsed.escapeMap, options) };
        }
        const { jsonrepair } = await import('jsonrepair');
        const protector = new JsonPlusFormatter(false, options.indentSize, options.arrayNewLine, true);
        const protectedInput = protector.prepareRepairInput(normalizeRepairValues(selectRepairRoots(input)));
        let repaired: string;
        try { repaired = jsonrepair(protectedInput.text); }
        catch (error) {
            // Offsets in protected text do not refer to the original editor. Do not expose them as original locations.
            const message = error instanceof Error ? error.message : String(error);
            throw new Error('JSON repair failed: ' + message.replace(/ at position \d+/, ''));
        }
        repaired = protector.restoreRepairEscapes(repaired, protectedInput.escapeMap);
        onStage('parsing');
        parsed = parseJsonInput(repaired, options);
        onStage('formatting');
        return { repaired, formatted: stringifyJsonValue(parsed.data, parsed.escapeMap, options) };
    }
    onStage('formatting');
    return { formatted: stringifyJsonValue(parsed.data, parsed.escapeMap, options) };
}
