import { getValueByPathParts, isValidJsonPath, parsePathToParts } from './jsonPath';
import { getFieldSortComparisonValues, resolveFieldSortTargets } from './jsonSortScope';

export interface PathSuggestion {
    value: string;
    type?: string;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === 'object' && !Array.isArray(value);
const isPathKey = (key: string): boolean => key.length > 0 && !/[.\[\]]/.test(key);

const collectSuggestions = (
    values: Iterable<unknown>,
    query: string,
    fields: boolean,
    valueFallback = false,
): PathSuggestion[] => {
    const input = (query || '').trim();
    const openBracket = input.lastIndexOf('[');
    const hasOpenBracket = openBracket > input.lastIndexOf(']');
    const lastDot = input.lastIndexOf('.');
    const path = hasOpenBracket ? input.slice(0, openBracket)
        : input.endsWith(']') ? input
        : lastDot >= 0 ? input.slice(0, lastDot) : '';
    const partial = hasOpenBracket ? input.slice(openBracket + 1)
        : input.endsWith(']') ? '' : input.slice(lastDot + 1);
    if (!isValidJsonPath(path) || (hasOpenBracket && !/^(?:\d*|\*)$/.test(partial))) return [];

    const parts = parsePathToParts(path);
    const fallbackParts = valueFallback && path !== 'value' && !path.startsWith('value.')
        ? parsePathToParts(path ? `value${path.startsWith('[') ? '' : '.'}${path}` : 'value') : null;
    const suggestions = new Map<string, PathSuggestion>();
    const add = (value: string, type: string) => {
        // Execution trims the complete path. Do not suggest a different key.
        if (value === value.trim()) suggestions.set(value, { value, type });
    };
    const prefix = path ? `${path}.` : '';
    const search = partial.toLowerCase();

    const collect = (target: unknown) => {
        if (hasOpenBracket) {
            if (!Array.isArray(target)) return;
            if (/^\d+$/.test(partial) && Object.hasOwn(target, Number(partial))) {
                add(`${path}[${partial}]`, 'array-index');
            }
            add(`${path}[*]`, 'array-wildcard');
            return;
        }
        if (Array.isArray(target)) {
            if (!path && !partial) add('[*]', 'array-wildcard');
            return;
        }
        if (!isObject(target)) return;
        for (const key of Object.keys(target)) {
            if (!isPathKey(key)) continue;
            const matches = fields ? key.toLowerCase().includes(search) : key.toLowerCase().startsWith(search);
            if (!matches) continue;
            const value = target[key];
            if (!fields && (value === null || typeof value !== 'object')) continue;
            const fullPath = prefix + key;
            add(fullPath, fields ? 'key' : 'exact');
            if (Array.isArray(value)) add(`${fullPath}[*]`, 'array-wildcard');
        }
    };

    for (const value of values) {
        collect(getValueByPathParts(value, parts));
        if (fallbackParts) collect(getValueByPathParts(value, fallbackParts));
    }
    return rankSuggestions([...suggestions.values()], query);
};

const rankSuggestions = (suggestions: PathSuggestion[], query: string): PathSuggestion[] => {
    const input = query.trim();
    const sorted = suggestions.sort((a, b) => a.value.localeCompare(b.value));
    // Native autocomplete Enter selects the first candidate. Keep a complete
    // match ahead of substring matches, preserving the JSON key's actual case.
    const exactIndex = sorted.findIndex(({ value }) => value === input);
    const matchIndex = exactIndex >= 0 ? exactIndex
        : sorted.findIndex(({ value }) => value.toLowerCase() === input.toLowerCase());
    if (matchIndex > 0) sorted.unshift(...sorted.splice(matchIndex, 1));
    return sorted;
};

/** Root navigation intentionally follows the first element of a wildcard. */
export const getRootPathSuggestions = (data: unknown, query: string): PathSuggestion[] =>
    collectSuggestions([data], query, false);

/** Field suggestions and sorting resolve exactly the same target containers. */
export const getFieldPathSuggestions = (data: unknown, scopePath: string, query: string): PathSuggestion[] => {
    const suggestions = new Map<string, PathSuggestion>();
    for (const target of resolveFieldSortTargets(data, scopePath || '')) {
        const { values, valueFallback } = getFieldSortComparisonValues(target.value);
        for (const item of collectSuggestions(values, query, true, valueFallback)) suggestions.set(item.value, item);
    }
    return rankSuggestions([...suggestions.values()], query);
};
