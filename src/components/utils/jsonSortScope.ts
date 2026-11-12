import { isValidJsonPath, parsePathToParts } from './jsonPath';

const isRecord = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === 'object' && !Array.isArray(value);
const isObjectMap = (value: Record<string, unknown>): boolean => Object.values(value).every(isRecord);

export interface FieldSortTarget {
    value: Record<string, unknown> | unknown[];
    parent: Record<string, unknown> | unknown[] | null;
    key: string | number | null;
}

/** Enumerate the same containers for execution and field suggestions. */
export function* resolveFieldSortTargets(data: unknown, scope: string): Generator<FieldSortTarget> {
    const path = scope.trim();
    if (!isValidJsonPath(path)) return;
    const parts = parsePathToParts(path);
    const endsInTraversal = path.endsWith('[*]');
    function* walk(value: any, parent: FieldSortTarget['parent'], key: FieldSortTarget['key'], index: number): Generator<FieldSortTarget> {
        if (index === parts.length) {
            if (!Array.isArray(value) && !isRecord(value)) return;
            // A terminal wildcard visits elements. An ordinary record must not
            // become a primitive-value Map or trigger sorting of its child arrays.
            if (endsInTraversal && isRecord(value) && !isObjectMap(value)) return;
            yield { value, parent, key };
            return;
        }
        const part = parts[index];
        if (part.key) {
            if (value === null || typeof value !== 'object' || !Object.hasOwn(value, part.key)) return;
            parent = value;
            key = part.key;
            value = value[part.key];
        }
        if (!part.isArray) {
            yield* walk(value, parent, key, index + 1);
            return;
        }
        if (!Array.isArray(value)) return;
        if (part.arrayIndex === '*') {
            for (let i = 0; i < value.length; i++) {
                if (Object.hasOwn(value, i)) yield* walk(value[i], value, i, index + 1);
            }
        } else if (typeof part.arrayIndex === 'number' && Object.hasOwn(value, part.arrayIndex)) {
            yield* walk(value[part.arrayIndex], value, part.arrayIndex, index + 1);
        }
    }
    yield* walk(data, null, null, 0);
}

function* arrayComparisonValues(array: unknown[]): Generator<unknown> {
    // Preserve the established array-of-arrays sort branch.
    if (Array.isArray(array[0])) {
        for (const item of array) if (Array.isArray(item)) yield* item;
    } else yield* array;
}

/** Values compared by the existing Array / Map / mixed-object sort branches. */
export const getFieldSortComparisonValues = (target: FieldSortTarget['value']): { values: Iterable<unknown>; valueFallback: boolean } => {
    if (Array.isArray(target)) return { values: arrayComparisonValues(target), valueFallback: false };
    if (isObjectMap(target)) return { values: Object.values(target), valueFallback: true };
    function* mixedArrayValues(): Generator<unknown> {
        for (const value of Object.values(target)) if (Array.isArray(value)) yield* value;
    }
    return { values: mixedArrayValues(), valueFallback: false };
};
