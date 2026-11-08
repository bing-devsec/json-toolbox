import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';
import { transform } from 'esbuild';
const source = fs.readFileSync('src/components/JsonToolWorkbench.vue', 'utf8');
const start = source.indexOf('const getEditorOptions = (');
const end = source.indexOf('\nconst syncEditorLargeFileOptions', start);
assert(start > 0 && end > start);
const { code } = await transform(source.slice(start, end) + '\nglobalThis.getOptions = getEditorOptions;', { loader: 'ts' });
const context = {
    isLargeEditorContent: (lines, bytes) => lines > 10000 || bytes > 1000000,
    getJsonToolThemeForLanguage: () => 'theme', themeMode: { value: 'light' }, props: { locale: 'en' },
    showMinimap: { value: true }, stickyScroll: { value: true }, effectiveWordWrap: { value: true }, fontSize: { value: 12 },
    getLineNumbersMinChars: () => 2, getFoldingStrategyForLanguage: () => 'auto',
    getLargeFileOptions: () => ({}), getJsonToolLongLineViewOptions: () => ({}),
    getJsonToolEditorTypography: () => ({}), getEditorGuideOptions: () => ({}),
    JSON_TOOL_EDITOR_SCROLLBAR_THICKNESS: 10, JSON_TOOL_EDITOR_HORIZONTAL_SCROLLBAR_THICKNESS: 10,
};
vm.runInNewContext(code, context);
test('normal input remains editable and preview uses native readonly across language, locale and size', () => {
    for (const locale of ['en', 'zh']) for (const language of ['json', 'yaml', 'xml', 'plaintext', 'typescript']) {
        context.props.locale = locale;
        for (const large of [false, true]) for (const readOnly of [false, true]) {
            const options = context.getOptions(2, readOnly, language, true, large ? 1000000 : 1, large ? 50000000 : 20);
            assert.equal(options.readOnly, readOnly);
            assert.equal(options.domReadOnly, readOnly);
            assert.equal(options.contextmenu, true);
            assert.equal(options.folding, true);
            assert.equal(options.formatOnPaste, false);
        }
    }
});
test('installed Monaco native readonly requires both flags and does not disable the textarea', () => {
    const native = fs.readFileSync('node_modules/monaco-editor/esm/vs/editor/browser/controller/textAreaHandler.js', 'utf8');
    const body = native.slice(native.indexOf('    _ensureReadOnlyAttribute() {'), native.indexOf('    prepareRender(ctx) {'));
    const object = vm.runInNewContext('({' + body + '})', { IME: { enabled: true } });
    for (const readOnly of [false, true]) for (const domReadOnly of [false, true]) {
        const attrs = new Map();
        object._context = { configuration: { options: { get: key => key === 34 ? domReadOnly : readOnly } } };
        object.textArea = { setAttribute: (key, value) => attrs.set(key, value), removeAttribute: key => attrs.delete(key) };
        object._ensureReadOnlyAttribute();
        assert.equal(attrs.has('readonly'), readOnly && domReadOnly);
        assert.equal(attrs.has('disabled'), false);
    }
});
