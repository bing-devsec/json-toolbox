import type * as monaco from 'monaco-editor/esm/vs/editor/editor.api';

export const register = (monacoApi: typeof monaco) => {
    monacoApi.languages.register({ id: 'css' });
    monacoApi.languages.setMonarchTokensProvider('css', {
        tokenizer: {
            root: [
                [/\s+/, 'white'],
                [/\/\*/, 'comment', '@comment'],
                [/@[a-z-]+/i, 'keyword'],
                [/[.#]?[a-zA-Z_][\w-]*(?=\s*[\{,])/, 'tag'],
                [/\{/, 'delimiter.bracket', '@rulebody'],
            ],
            comment: [
                [/\*\//, 'comment', '@pop'],
                [/[^*]+/, 'comment'],
                [/\*/, 'comment'],
            ],
            rulebody: [
                [/\s+/, 'white'],
                [/\/\*/, 'comment', '@comment'],
                [/[a-z-]+(?=\s*:)/i, 'attribute.name'],
                [/:/, 'delimiter'],
                [/"[^"]*"/, 'string'],
                [/'[^']*'/, 'string'],
                [/#{0,1}[0-9a-fA-F]{3,8}\b/, 'number.hex'],
                [/-?\d+(\.\d+)?(px|em|rem|%|vh|vw|s|ms|deg)?\b/, 'number'],
                [/[a-z-]+\(/i, 'keyword'],
                [/;/, 'delimiter'],
                [/\}/, 'delimiter.bracket', '@pop'],
            ],
        },
    });
};
