// JSON 排序工具：包含字典序、长度、字段值比较与递归排序
import { getValueByPathParts, parsePathToParts } from './jsonPath';

export type SortMethod = 'dictionary' | 'length' | 'field';
export type SortOrder = 'asc' | 'desc';

// Constructing a collator for every comparison dominates large key/line sorts.
const dictionaryCollator = new Intl.Collator(undefined, { numeric: false, sensitivity: 'base' });

// Preserve JSON's own __proto__ key without invoking Object.prototype's setter.
const setOwnValue = (target: Record<string, any>, key: string, value: any): void => {
    Object.defineProperty(target, key, { value, enumerable: true, configurable: true, writable: true });
};

// 比较函数：字典序
export const compareDictionary = (a: string, b: string): number => {
    return dictionaryCollator.compare(a, b);
};

// 比较函数：按Key长度
export const compareLength = (a: string, b: string): number => {
    if (a.length !== b.length) {
        return a.length - b.length;
    }
    return compareDictionary(a, b);
};

// 比较两个值（用于字段排序）
export const compareFieldValues = (a: any, b: any): number => {
    // 处理null和undefined
    if (a == null && b == null) return 0;
    if (a == null) return -1;
    if (b == null) return 1;

    // 数字比较
    if (typeof a === 'number' && typeof b === 'number') {
        return a - b;
    }

    // 字符串比较
    if (typeof a === 'string' && typeof b === 'string') {
        return a.localeCompare(b);
    }

    // 布尔值比较
    if (typeof a === 'boolean' && typeof b === 'boolean') {
        return a === b ? 0 : a ? 1 : -1;
    }

    // 不同类型转换为字符串比较
    const strA = String(a);
    const strB = String(b);
    return strA.localeCompare(strB);
};

// A field path is constant during a sort. Keep getValueByPath's empty-path and
// falsy-root behavior while reusing the existing own-property traversal.
const createFieldReader = (fieldPath: string): ((value: any) => any) => {
    if (!fieldPath) return (value: any) => value;
    const parts = parsePathToParts(fieldPath);
    return (value: any) => value ? getValueByPathParts(value, parts) : value;
};

// 获取比较函数
export const getCompareFunction = (method: SortMethod, fieldPath?: string): ((a: any, b: any) => number) => {
    switch (method) {
        case 'dictionary':
            return (a: any, b: any) => compareDictionary(String(a), String(b));
        case 'length':
            return (a: any, b: any) => compareLength(String(a), String(b));
        case 'field': {
            if (!fieldPath) return () => 0;
            const readField = createFieldReader(fieldPath);
            return (a: any, b: any) => {
                // 对于字段排序，a和b应该是对象或数组元素
                const valueA = readField(a);
                const valueB = readField(b);

                return compareFieldValues(valueA, valueB);
            };
        }
        default:
            return (a: any, b: any) => compareDictionary(String(a), String(b));
    }
};

const sortArrayByField = (items: any[], fieldPath: string, order: SortOrder): any[] => {
    const readField = createFieldReader(fieldPath);
    return [...items].sort((a, b) => {
        const result = compareFieldValues(readField(a), readField(b));
        return order === 'asc' ? result : -result;
    });
};

// 递归排序JSON对象
export const sortJsonObject = (obj: any, method: SortMethod, order: SortOrder, fieldPath?: string): any => {
    if (obj === null || typeof obj !== 'object') {
        return obj;
    }

    if (Array.isArray(obj)) {
        if (method === 'field' && fieldPath) {
            return sortArrayByField(obj, fieldPath, order)
                .map((item) => sortJsonObject(item, method, order, fieldPath));
        } else {
            // 普通数组：递归处理每个元素
            return obj.map((item) => sortJsonObject(item, method, order, fieldPath));
        }
    }

    // 对象处理
    if (method === 'field' && fieldPath) {
        // 检查对象的值是否是数组，如果是则对数组进行排序
        const values = Object.values(obj);
        const hasArrayValues = values.some((val) => Array.isArray(val));

        if (hasArrayValues) {
            // 对象的值包含数组，对每个数组值进行排序
            const sortedObj: any = {};
            for (const [key, value] of Object.entries(obj)) {
                // Recursive array handling already performs the same field sort.
                setOwnValue(sortedObj, key, sortJsonObject(value, method, order, fieldPath));
            }
            return sortedObj;
        } else {
            // 对象的值不是数组，尝试对对象本身按字段排序
            // 这通常用于类似 {"1": {...}, "2": {...}} 的结构
            const entries = Object.entries(obj);
            const compareFn = getCompareFunction(method, fieldPath);

            const sortedEntries = entries.sort(([, valA], [, valB]) => {
                const result = compareFn(valA, valB);
                return order === 'asc' ? result : -result;
            });

            const sortedObj: any = {};
            for (const [key, value] of sortedEntries) {
                setOwnValue(sortedObj, key, sortJsonObject(value, method, order, fieldPath));
            }
            return sortedObj;
        }
    } else {
        // 普通对象：对Key进行排序
        const compareFn = getCompareFunction(method, fieldPath);
        const sortedKeys = Object.keys(obj).sort((a, b) => {
            const result = compareFn(a, b);
            return order === 'asc' ? result : -result;
        });

        const sortedObj: any = {};
        for (const key of sortedKeys) {
            // 递归处理值
            setOwnValue(sortedObj, key, sortJsonObject(obj[key], method, order, fieldPath));
        }

        return sortedObj;
    }
};

// 按字段值排序数据
export const sortJsonByField = (data: any, fieldPath: string, order: SortOrder = 'asc'): any => {
    if (!data) return data;

    // 如果是数组，检查数组元素是否也是数组（处理[*].path的情况）
    if (Array.isArray(data)) {
        // 检查第一个元素是否是数组
        if (data.length > 0 && Array.isArray(data[0])) {
            // 这是一个数组的数组，对每个子数组进行排序
            return data.map((subArray) => Array.isArray(subArray) ? sortArrayByField(subArray, fieldPath, order) : subArray);
        }
        return sortArrayByField(data, fieldPath, order);
    }

    // 如果是对象，检查对象的值是否是数组
    if (typeof data === 'object') {
        // 如果顶层是对象且其值不是数组（比如 map），支持按 value 的子字段对键进行排序
        const values = Object.values(data);
        const allValuesAreObjects = values.every((v) => typeof v === 'object' && v !== null && !Array.isArray(v));
        const allValuesArePrimitive = values.every((v) => (typeof v !== 'object' || v === null) && !Array.isArray(v));

        // 情况A：每个 value 是对象（例如 { id: 1 }），且用户填写了 fieldPath 或者可以自动回退到 value.<field>
        if (allValuesAreObjects && fieldPath) {
            const entries = Object.entries(data);
            // 支持直接写 value.id，也支持简写 id（尝试回退）。
            const readField = createFieldReader(fieldPath);
            const readFallback = fieldPath.startsWith('value.') ? null : createFieldReader('value.' + fieldPath);
            const extractValue = (obj: any) => {
                const value = readField(obj);
                return value == null && readFallback ? readFallback(obj) : value;
            };
            entries.sort((a, b) => {
                const valueA = extractValue(a[1]);
                const valueB = extractValue(b[1]);
                const cmp = compareFieldValues(valueA, valueB);
                return order === 'asc' ? cmp : -cmp;
            });
            const sortedObj: any = {};
            for (const [k, v] of entries) {
                setOwnValue(sortedObj, k, v);
            }
            return sortedObj;
        }
        // 情况B：每个 value 是原始类型（number/string/boolean/null），用户无需填写字段，直接按 value 排序
        if (allValuesArePrimitive) {
            const entries = Object.entries(data);
            entries.sort((a, b) => {
                const valueA = a[1];
                const valueB = b[1];
                const cmp = compareFieldValues(valueA, valueB);
                return order === 'asc' ? cmp : -cmp;
            });
            const sortedObj: any = {};
            for (const [k, v] of entries) {
                setOwnValue(sortedObj, k, v);
            }
            return sortedObj;
        }
        // Only the mixed/array branch needs this reconstruction. Map sorts above
        // already build their own ordered object, so do not copy it twice.
        const result: any = {};
        for (const [key, value] of Object.entries(data)) {
            setOwnValue(result, key, Array.isArray(value) ? sortArrayByField(value, fieldPath, order) : value);
        }
        return result;
    }

    return data;
};

// 排序字符串行（每行一个字符串，保持原始文本）
// method:
//   - 'dictionary' / 'length' 同名 JSON 排序逻辑；
//   - 'mixed'（用于"按字段排序"场景的文本行降级）：纯数字行作为数值比较，非数字行按字典序比较；
//     升序时"数字组在前 + 字符串组在后"，降序时整体反过来。
export const sortStringLines = (input: string, method: 'dictionary' | 'length' | 'mixed', order: SortOrder): string => {
    const lines = input
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0);

    if (method === 'mixed') {
        const isNumeric = (line: string) => /^-?\d+(\.\d+)?$/.test(line);
        const numericLines = lines.filter(isNumeric);
        const otherLines = lines.filter((line) => !isNumeric(line));

        numericLines.sort((a, b) => {
            const diff = parseFloat(a) - parseFloat(b);
            return order === 'asc' ? diff : -diff;
        });
        otherLines.sort((a, b) => {
            const diff = dictionaryCollator.compare(a, b);
            return order === 'asc' ? diff : -diff;
        });

        const ordered = order === 'asc' ? [...numericLines, ...otherLines] : [...otherLines, ...numericLines];
        return ordered.join('\n');
    }

    const sortedLines = lines.sort((a, b) => {
        let result: number;

        if (method === 'dictionary') {
            result = dictionaryCollator.compare(a, b);
        } else if (method === 'length') {
            if (a.length !== b.length) {
                result = a.length - b.length;
            } else {
                result = dictionaryCollator.compare(a, b);
            }
        } else {
            result = 0;
        }

        return order === 'asc' ? result : -result;
    });

    return sortedLines.join('\n');
};
