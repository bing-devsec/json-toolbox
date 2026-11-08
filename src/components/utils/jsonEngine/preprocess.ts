import { getNextSignificantChar, isIdentifierChar } from './scanner';
import { ChunkedStringBuilder } from './stringBuilder';

type ReplacementScanner = (input: string, index: number, previousSignificantChar: string) => { replacement: string; nextIndex: number } | null;

const scanOutsideStringsAndComments = (input: string, scanner: ReplacementScanner): string => {
    const result = new ChunkedStringBuilder();
    let unchangedStart = 0;
    let i = 0;
    let inString = false;
    let stringChar = '';
    let inLineComment = false;
    let inBlockComment = false;
    let previousSignificantChar = '';

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
                previousSignificantChar = char;
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

        const replacement = scanner(input, i, previousSignificantChar);
        if (replacement) {
            result.append(input.slice(unchangedStart, i));
            result.append(replacement.replacement);
            i = replacement.nextIndex;
            unchangedStart = i;
            previousSignificantChar = replacement.replacement.at(-1) ?? previousSignificantChar;
            continue;
        }

        if (!/\s/.test(char)) previousSignificantChar = char;
        i++;
    }

    if (unchangedStart === 0) return input;
    result.append(input.slice(unchangedStart));
    return result.toString();
};

export const replaceUndefinedValuesWithNull = (input: string): string => {
    const keyword = 'undefined';
    return scanOutsideStringsAndComments(input, (source, index, previousSignificantChar) => {
        if (!source.startsWith(keyword, index)) return null;
        if (isIdentifierChar(source[index - 1] || '') || isIdentifierChar(source[index + keyword.length] || '')) return null;
        // The outer scanner already knows the preceding syntax character.
        // Rescanning from the line start for each token is quadratic on minified arrays.
        const next = getNextSignificantChar(source, index + keyword.length);
        if (next === ':') return null;
        if (previousSignificantChar !== '' && !':[,'.includes(previousSignificantChar)) return null;
        if (next !== '' && !',]}'.includes(next)) return null;
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
