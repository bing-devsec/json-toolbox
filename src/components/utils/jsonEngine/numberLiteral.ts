const HPN_WRAPPER_KEY = '__jsonToolHighPrecisionNumber';
const HPN_WRAPPER_SECRET_KEY = '__jsonToolHighPrecisionNumberSecret';
const HPN_WRAPPER_SECRET = createRuntimeSecret();

const PROTECTED_NUMBER_LITERAL_RE = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;
const STRICT_JSON_NUMBER_LITERAL_RE = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;

function createRuntimeSecret(): string {
    const cryptoObj = globalThis.crypto;
    if (cryptoObj?.getRandomValues) {
        const bytes = new Uint32Array(4);
        cryptoObj.getRandomValues(bytes);
        return Array.from(bytes, (n) => n.toString(36)).join('-');
    }
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

export const normalizeJsonNumberLiteral = (literal: string): string | null => {
    let normalized = literal.trim();
    if (!PROTECTED_NUMBER_LITERAL_RE.test(normalized)) return null;

    let sign = '';
    if (normalized[0] === '+') {
        normalized = normalized.slice(1);
    } else if (normalized[0] === '-') {
        sign = '-';
        normalized = normalized.slice(1);
    }

    const exponentMatch = normalized.match(/[eE][+-]?\d+$/);
    const exponent = exponentMatch?.[0] ?? '';
    let mantissa = exponent ? normalized.slice(0, -exponent.length) : normalized;

    if (mantissa.startsWith('.')) {
        mantissa = '0' + mantissa;
    }
    if (mantissa.endsWith('.')) {
        mantissa += '0';
    }

    const dotIndex = mantissa.indexOf('.');
    if (dotIndex === -1) {
        mantissa = mantissa.replace(/^0+(?=\d)/, '') || '0';
    } else {
        const integerPart = mantissa.slice(0, dotIndex).replace(/^0+(?=\d)/, '') || '0';
        mantissa = integerPart + mantissa.slice(dotIndex);
    }

    const jsonNumber = sign + mantissa + exponent;
    return STRICT_JSON_NUMBER_LITERAL_RE.test(jsonNumber) ? jsonNumber : null;
};

export const createHighPrecisionNumberWrapper = (literal: string): string => {
    return JSON.stringify({
        [HPN_WRAPPER_KEY]: true,
        [HPN_WRAPPER_SECRET_KEY]: HPN_WRAPPER_SECRET,
        originalString: literal,
    });
};

export const tryReadHighPrecisionWrapperObject = (value: any): string | null => {
    if (
        value &&
        typeof value === 'object' &&
        value[HPN_WRAPPER_KEY] === true &&
        value[HPN_WRAPPER_SECRET_KEY] === HPN_WRAPPER_SECRET &&
        typeof value.originalString === 'string' &&
        normalizeJsonNumberLiteral(value.originalString) !== null
    ) {
        return value.originalString;
    }
    return null;
};

export const tryParseHighPrecisionWrapper = (str: string): string | null => {
    // 轻量检查，避免对无关字符串执行 JSON.parse
    if (typeof str !== 'string' || str.length < 10 || str.indexOf(HPN_WRAPPER_KEY) === -1) {
        return null;
    }
    try {
        const parsed = JSON.parse(str);
        return tryReadHighPrecisionWrapperObject(parsed);
    } catch {
        // 忽略
    }
    return null;
};

const CONVERSION_NUMBER_TOKEN = /__JSON_TOOL_NUM@\d+_\d+__/g;
let conversionSequence = 0;

/** 每次转换独立记录真实数字占位，跳过原始键和值中已经存在的标记。 */
export const prepareHighPrecisionConversion = (data: any): { data: any; restoreOutput: (output: string) => string } => {
    const reservedTokens = new Set<string>();
    const collectStringTokens = (text: string) => {
        for (const match of text.matchAll(CONVERSION_NUMBER_TOKEN)) reservedTokens.add(match[0]);
    };
    const collect = (node: any): void => {
        if (typeof node === 'string') {
            collectStringTokens(node);
        } else if (Array.isArray(node)) {
            for (const child of node) collect(child);
        } else if (node && typeof node === 'object') {
            for (const key of Object.keys(node)) {
                collectStringTokens(key);
                collect(node[key]);
            }
        }
    };
    collect(data);

    const literals = new Map<string, string>();
    const sequence = conversionSequence++;
    let nextToken = 0;
    const protectLiteral = (literal: string): string => {
        let token: string;
        do {
            // @ 不会由 XML 标签或 TypeScript 名称清理规则生成，避免改写转换后的字段名。
            token = `__JSON_TOOL_NUM@${sequence}_${nextToken++}__`;
        } while (reservedTokens.has(token));
        literals.set(token, literal);
        return token;
    };
    const walk = (node: any): any => {
        if (node === null || node === undefined) return node;
        if (typeof node === 'string') {
            const literal = tryParseHighPrecisionWrapper(node);
            if (literal !== null) {
                const normalizedLiteral = normalizeJsonNumberLiteral(literal);
                if (normalizedLiteral === null) return node;
                const num = Number(normalizedLiteral);
                if (Number.isFinite(num)) {
                    const isInteger = !/[.eE]/.test(normalizedLiteral);
                    if (isInteger && Number.isSafeInteger(num) && String(num) === normalizedLiteral) return num;
                    if (!isInteger && String(num) === normalizedLiteral) return num;
                }
                return protectLiteral(normalizedLiteral);
            }
            return node;
        }
        if (Array.isArray(node)) return node.map(walk);
        if (typeof node === 'object') {
            const result: Record<string, any> = {};
            for (const key of Object.keys(node)) {
                Object.defineProperty(result, key, {
                    value: walk(node[key]), enumerable: true, configurable: true, writable: true,
                });
            }
            return result;
        }
        return node;
    };
    return {
        data: walk(data),
        restoreOutput(output: string): string {
            if (literals.size === 0) return output;
            const quoted = output.replace(/(["'])(__JSON_TOOL_NUM@\d+_\d+__)\1/g,
                (match, _quote, token) => literals.get(token) ?? match);
            return quoted.replace(CONVERSION_NUMBER_TOKEN, token => literals.get(token) ?? token);
        },
    };
};
