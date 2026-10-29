// Only rewrite complete value tokens, outside strings/comments. Never coerce keys or string contents.
export function normalizeRepairValues(input: string): string {
    if (!/(?:NaN|Infinity|undefined|0[xX][\da-fA-F]|\+(?:\d|\.\d))/.test(input)) return input;
    const parts: string[] = [];
    let start = 0, i = 0;
    let previousTokenStart = 0, previousTokenEnd = 0;
    const valueToken = /(?:[+-]?Infinity|[+-]?NaN|undefined|[+-]?0[xX][\da-fA-F]+|\+(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)/y;
    const canStartPositiveNumber = (): boolean => {
        if (!previousTokenEnd) return true;
        const previousChar = input[previousTokenEnd - 1];
        if (/[:\[,\]}"'”’]/.test(previousChar)) return true;
        // A preceding complete value may be an array item whose comma is missing.
        // Do not remove '+' from the middle of an unquoted phrase such as `hello +99`.
        return /^(?:true|false|null|undefined|[+-]?(?:NaN|Infinity|0[xX][\da-fA-F]+|(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?))$/.test(input.slice(previousTokenStart, previousTokenEnd));
    };
    while (i < input.length) {
        const ch = input[i];
        if (ch === '"' || ch === "'" || ch === '“' || ch === '‘') {
            const endQuote = ch === '“' ? '”' : ch === '‘' ? '’' : ch;
            previousTokenStart = i;
            i++;
            while (i < input.length) {
                if (input[i] === '\\') { i += 2; continue; }
                if (input[i++] === endQuote) break;
            }
            previousTokenEnd = i;
            continue;
        }
        if (ch === '#' || (ch === '/' && input[i + 1] === '/' && input[i - 1] !== ':')) {
            while (i < input.length && input[i] !== '\n') i++;
            continue;
        }
        if (ch === '/' && input[i + 1] === '*') {
            const end = input.indexOf('*/', i + 2); i = end < 0 ? input.length : end + 2; continue;
        }
        if (!/[\w$]/.test(input[i - 1] || '') && /[+\-NIu0]/.test(ch)) {
            valueToken.lastIndex = i;
            const token = valueToken.exec(input)?.[0];
            const isPositiveNumber = token !== undefined && /^\+(?:\d|\.)/.test(token);
            if (token && !/[\w$.]/.test(input[i + token.length] || '') && (!isPositiveNumber || canStartPositiveNumber())) {
                let end = i + token.length;
                while (/\s/.test(input[end] || '') && end < input.length) end++;
                if (input[end] !== ':') {
                    // Strip a JSON5 leading plus without passing through Number, which loses precision.
                    const value = token.includes('0x') || token.includes('0X')
                        ? BigInt(token.replace(/^\+/, '').replace(/^-/, '')).toString()
                        : isPositiveNumber ? token.slice(1) : 'null';
                    const replacement = token.startsWith('-') && value !== 'null' ? '-' + value : value;
                    parts.push(input.slice(start, i), replacement);
                    previousTokenStart = i; i += token.length; previousTokenEnd = i;
                    start = i; continue;
                }
            }
        }
        if (!/\s/.test(ch)) {
            if (previousTokenEnd !== i || /[{}\[\]:,]/.test(ch) || /[{}\[\]:,]/.test(input[i - 1] || '')) previousTokenStart = i;
            previousTokenEnd = i + 1;
        }
        i++;
    }
    parts.push(input.slice(start));
    return parts.join('');
}
