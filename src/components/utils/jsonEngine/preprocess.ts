import { isIdentifierChar, isValuePosition } from './scanner';
import { ChunkedStringBuilder } from './stringBuilder';

type ReplacementScanner = (input: string, index: number) => { replacement: string; nextIndex: number } | null;

const scanOutsideStringsAndComments = (input: string, scanner: ReplacementScanner): string => {
    const result = new ChunkedStringBuilder();
    let unchangedStart = 0;
    let i = 0;
    let inString = false;
    let stringChar = '';
    let inLineComment = false;
    let inBlockComment = false;

    while (i < input.length) {
        const char = input[i];
        const next = input[i + 1] || '';

        if (inLineComment) {
            if (char === '\n') inLineComment = false;
            i++;
            continue;
        }

        if (inBlockComment) {
            if (char === '*' && next === '/') {
                i += 2;
                inBlockComment = false;
                continue;
            }
            i++;
            continue;
        }

        if (inString) {
            if (char === '\\' && next) {
                i += 2;
                continue;
            }
            if (char === stringChar) {
                inString = false;
                stringChar = '';
            }
            i++;
            continue;
        }

        if (char === '/' && next === '/') {
            i += 2;
            inLineComment = true;
            continue;
        }

        if (char === '/' && next === '*') {
            i += 2;
            inBlockComment = true;
            continue;
        }

        if (char === '#') {
            i++;
            inLineComment = true;
            continue;
        }

        if (char === '"' || char === "'") {
            inString = true;
            stringChar = char;
            i++;
            continue;
        }

        const replacement = scanner(input, i);
        if (replacement) {
            result.append(input.slice(unchangedStart, i));
            result.append(replacement.replacement);
            i = replacement.nextIndex;
            unchangedStart = i;
            continue;
        }

        i++;
    }

    if (unchangedStart === 0) return input;
    result.append(input.slice(unchangedStart));
    return result.toString();
};

export const replaceUndefinedValuesWithNull = (input: string): string => {
    const keyword = 'undefined';
    return scanOutsideStringsAndComments(input, (source, index) => {
        if (!source.startsWith(keyword, index)) return null;
        if (isIdentifierChar(source[index - 1] || '') || isIdentifierChar(source[index + keyword.length] || '')) return null;
        if (!isValuePosition(source, index, index + keyword.length)) return null;
        return { replacement: 'null', nextIndex: index + keyword.length };
    });
};

export const preprocessSpecialJsonValues = (input: string): string => {
    let result = input;
    if (result.includes('undefined')) {
        result = replaceUndefinedValuesWithNull(result);
    }
    return result;
};
