import type * as monaco from 'monaco-editor/esm/vs/editor/editor.api';

export const register = (monacoApi: typeof monaco) => {
    monacoApi.languages.register({ id: 'toml' });
    monacoApi.languages.setMonarchTokensProvider('toml', {
        tokenizer: {
            root: [
                [/#.*$/, 'comment'],
                [/^\s*\[.+?\]\s*$/, 'type.identifier'],
                [/^\s*\[\[.+?\]\]\s*$/, 'type.identifier'],
                [/\b(true|false)\b/, 'keyword'],
                [/\b\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})?)?\b/, 'string.date'],
                [/\[/, { token: 'delimiter.bracket', next: '@inline_array' }],
                [/^[a-zA-Z_][a-zA-Z0-9_\-]*/, 'variable'],
                [/=/, 'delimiter'],
                [/"[^"\\]*(?:\\.[^"\\]*)*"/, 'string'],
                [/-?\d+\.?\d*([eE][+-]?\d+)?/, 'number'],
            ],
            inline_array: [
                [/\]/, { token: 'delimiter.bracket', next: '@pop' }],
                [/,/, 'delimiter'],
                [/"[^"\\]*(?:\\.[^"\\]*)*"/, 'string'],
                [/-?\d+\.?\d*([eE][+-]?\d+)?/, 'number'],
                [/\b(true|false)\b/, 'keyword'],
                [/\s+/, 'white'],
            ],
        },
    });
};
