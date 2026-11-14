export const isIdentifierChar = (ch: string): boolean => /[A-Za-z0-9_$]/.test(ch);

export const getNextSignificantChar = (input: string, index: number): string => {
    let inLineComment = false;
    let inBlockComment = false;

    for (let i = index; i < input.length; i++) {
        const char = input[i];
        const next = input[i + 1] || '';

        if (inLineComment) {
            if (char === '\n') inLineComment = false;
            continue;
        }

        if (inBlockComment) {
            if (char === '*' && next === '/') {
                i++;
                inBlockComment = false;
            }
            continue;
        }

        if (/\s/.test(char)) continue;

        if (char === '/' && next === '/') {
            i++;
            inLineComment = true;
            continue;
        }

        if (char === '/' && next === '*') {
            i++;
            inBlockComment = true;
            continue;
        }

        if (char === '#') {
            inLineComment = true;
            continue;
        }

        return char;
    }
    return '';
};
