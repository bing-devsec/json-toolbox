import type * as monaco from 'monaco-editor/esm/vs/editor/editor.api';

export const register = (monacoApi: typeof monaco) => {
    monacoApi.languages.register({ id: 'xml' });
    monacoApi.languages.setMonarchTokensProvider('xml', {
        tokenizer: {
            root: [
                [/<!--/, 'comment', '@comment'],
                [/<\?xml/, 'metatag', '@processing'],
                [/<\/?[\w:\-.]+/, 'tag', '@tag'],
                [/[^<]+/, ''],
            ],
            comment: [
                [/-->/, 'comment', '@pop'],
                [/[^-]+/, 'comment'],
                [/-/, 'comment'],
            ],
            processing: [
                [/\?>/, 'metatag', '@pop'],
                [/[^\?]+/, 'metatag'],
                [/\?/, 'metatag'],
            ],
            tag: [
                [/\s+/, 'white'],
                [/[\w:\-.]+(?=\s*=)/, 'attribute.name'],
                [/=/, 'delimiter'],
                [/"[^"]*"/, 'attribute.value'],
                [/'[^']*'/, 'attribute.value'],
                [/\/?>/, 'tag', '@pop'],
            ],
        },
    });
};
