import { ChunkedStringBuilder } from '../jsonEngine/stringBuilder';
import { createRepairLimits } from './limits';
import { repairJsonWithContext } from './parser';
import type { ContextRepairResult, RepairLimits } from './types';

type EscapedRootResult = ContextRepairResult & { recognized: boolean };

const escapes: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };

/**
 * Read one transport layer with missing escapes on structural quote delimiters.
 * Existing inner string escapes remain opaque to the outer decoder. A raw quote
 * cannot stand in for a business quote inside an inner escape sequence.
 * The container parser must then accept the ENTIRE decoded root without edits;
 * do not combine this recognition with guesses about strings or missing values.
 */
export function repairMixedEscapedRoot(input: string, overrides: Partial<RepairLimits> = {}): EscapedRootResult {
    const limits = createRepairLimits(input.length, overrides);
    const started = Date.now();
    let work = 0, nextClockCheck = 0;
    // A transport-escaped first token cannot be an ordinary JSON string. A
    // raw first token stays a probe until the complete decoded root validates.
    const recognized = /^[\s[{]*\\"/.test(input);
    const refuse = (status: 'unsupported' | 'unsafe' | 'limit', reason: string): EscapedRootResult =>
        ({ status, recognized, edits: [], reason, work });
    if (Object.values(limits).some(limit => !Number.isFinite(limit) || limit < 0)) {
        return refuse('limit', 'Invalid JSON repair limits');
    }
    const source = input.trim();
    if (!((source.startsWith('{') && source.endsWith('}')) || (source.startsWith('[') && source.endsWith(']')))
        || !source.includes('\\"')) return refuse('unsupported', 'No escaped object or array root was found');
    const output = new ChunkedStringBuilder();
    let index = 0, inString = false, innerEscape = false, missingEscapes = 0, encodedDelimiters = 0;
    while (index < source.length) {
        const start = index;
        let char = source[index++];
        const rawQuote = char === '"';
        if (char === '\\') {
            const escaped = source[index++];
            if (Object.hasOwn(escapes, escaped)) char = escapes[escaped];
            else if (escaped === 'u' && /^[\da-fA-F]{4}$/.test(source.slice(index, index + 4))) {
                char = String.fromCharCode(parseInt(source.slice(index, index + 4), 16));
                index += 4;
            } else return refuse('unsafe', 'An outer escape is incomplete or has more than one interpretation');
        }
        work += index - start;
        if (work > limits.maxWork) return refuse('limit', 'JSON repair work limit reached');
        if (work >= nextClockCheck) {
            nextClockCheck = work + 1024;
            if (Date.now() - started >= limits.maxDurationMs) return refuse('limit', 'JSON repair time limit reached');
        }
        if (rawQuote && innerEscape) {
            return refuse('unsafe', 'A business quote needs a separate escape-layer decision');
        }
        if (inString && innerEscape) innerEscape = false;
        else if (inString && char === '\\') innerEscape = true;
        else if (char === '"') {
            inString = !inString;
            if (rawQuote) {
                if (++missingEscapes > limits.maxEdits) return refuse('limit', 'JSON repair edit limit reached');
            } else if (source[start + 1] === '"') encodedDelimiters++;
        }
        output.append(char);
    }
    if (!missingEscapes || !encodedDelimiters || inString || innerEscape) {
        return refuse('unsupported', 'No complete mixed-escape root boundary was established');
    }
    const remainingTime = limits.maxDurationMs - (Date.now() - started);
    if (remainingTime <= 0) return refuse('limit', 'JSON repair time limit reached');
    const candidate = repairJsonWithContext(output.toString(), {
        ...limits,
        maxWork: limits.maxWork - work,
        maxDurationMs: remainingTime,
        maxEdits: limits.maxEdits - missingEscapes,
    });
    const totalWork = work + (candidate.work ?? 0);
    if (candidate.status === 'limit') return { ...candidate, recognized, work: totalWork };
    if (candidate.status !== 'unchanged') {
        return { status: 'unsafe', recognized, edits: [], reason: 'Decoded mixed escapes require additional structural guesses', work: totalWork };
    }
    // Removing a transport layer changes all source offsets. Expose only the full
    // validated text; do not publish decoded offsets as original editor edits.
    return { status: 'repaired', recognized: true, text: candidate.text, edits: [], work: totalWork };
}


/**
 * Peel complete ROOT transport layers until the whole root validates. Stop at
 * that first valid object/array: strings inside it keep their own escape layers.
 * At most one mixed quote layer can finish the recovery, using the same bounded
 * contextual validation as the single-layer path above.
 */
export function repairEscapedRoot(input: string, overrides: Partial<RepairLimits> = {}, maxLayers = 4): EscapedRootResult {
    const limits = createRepairLimits(input.length, overrides);
    const started = Date.now();
    let source = input.trim(), work = 0, recognized = false;
    const refuse = (status: 'unsupported' | 'unsafe' | 'limit', reason: string): EscapedRootResult =>
        ({ status, recognized, edits: [], reason, work });
    if (!Number.isInteger(maxLayers) || maxLayers < 1 || maxLayers > 4
        || Object.values(limits).some(limit => !Number.isFinite(limit) || limit < 0)) {
        return refuse('limit', 'Invalid JSON root escape repair limits');
    }
    const isContainer = (text: string): boolean => (text.startsWith('{') && text.endsWith('}'))
        || (text.startsWith('[') && text.endsWith(']'));
    if (!isContainer(source) || !source.includes('\\"')) {
        return refuse('unsupported', 'No escaped object or array root was found');
    }
    const remaining = (): RepairLimits => ({ ...limits,
        maxWork: Math.max(0, limits.maxWork - work),
        maxDurationMs: Math.max(0, limits.maxDurationMs - (Date.now() - started)),
    });
    for (let layer = 0; layer < maxLayers; layer++) {
        // Native decoding returns TEXT only, so number spelling and precision
        // never pass through Number. Charge failed attempts to the same budget.
        work += source.length;
        if (work > limits.maxWork) return refuse('limit', 'JSON repair work limit reached');
        if (Date.now() - started >= limits.maxDurationMs) return refuse('limit', 'JSON repair time limit reached');
        let decoded: string;
        try {
            decoded = JSON.parse('"' + source + '"') as string;
        } catch (error) {
            if (!(error instanceof SyntaxError)) throw error;
            const mixed = repairMixedEscapedRoot(source, remaining());
            work += mixed.work ?? 0;
            recognized ||= mixed.recognized;
            return { ...mixed, recognized, work };
        }
        recognized = true;
        if (!isContainer(decoded.trim())) return refuse('unsafe', 'Decoded root is not a complete object or array');
        const candidate = repairJsonWithContext(decoded, remaining());
        work += candidate.work ?? 0;
        if (candidate.status === 'limit') return refuse('limit', candidate.reason ?? 'JSON repair budget reached');
        if (candidate.status === 'unchanged') {
            return { status: 'repaired', text: decoded, recognized, edits: [], work };
        }
        if (!decoded.includes('\\"')) return refuse('unsafe', 'Decoded root requires additional structural guesses');
        source = decoded.trim();
    }
    return refuse('limit', 'JSON root escape layer limit reached');
}
