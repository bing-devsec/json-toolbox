import type * as monaco from 'monaco-editor/esm/vs/editor/editor.api';

export const register = (monacoApi: typeof monaco) => {
    monacoApi.languages.register({ id: 'html' });
    monacoApi.languages.setMonarchTokensProvider('html', {
        tokenizer: {
            root: [
                [/<!--/, 'comment', '@comment'],
                [/<\!DOCTYPE/, 'metatag', '@doctype'],
                [/<\/?[\w:-]+/, 'tag', '@tag'],
                [/[^<]+/, ''],
            ],
            comment: [
                [/-->/, 'comment', '@pop'],
                [/[^-]+/, 'comment'],
                [/-/, 'comment'],
            ],
            doctype: [
                [/>/, 'metatag', '@pop'],
                [/[^>]+/, 'metatag'],
            ],
            tag: [
                [/\s+/, 'white'],
                [/[\w:-]+(?=\s*=)/, 'attribute.name'],
                [/=/, 'delimiter'],
                [/"[^"]*"/, 'attribute.value'],
                [/'[^']*'/, 'attribute.value'],
                [/\/?>/, 'tag', '@pop'],
            ],
        },
    });
};
