import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { runInNewContext } from 'node:vm';
import { api, createModel } from './helpers/selectionTextModel.mjs';
import { vueDeclarations } from './helpers/vueDeclarations.mjs';
import { detectIndentSize } from '../src/components/utils/indentUtils.ts';

const bundled = await build({ entryPoints: ['src/components/utils/modelIndentSize.ts'], bundle: true, platform: 'node', format: 'cjs', write: false });
const module = { exports: {} };
runInNewContext(bundled.outputFiles[0].text, { module, exports: module.exports });
const { getModelDisplayIndentSize: detect } = module.exports;

function countedModel(text) {
    const model = createModel(text);
    const getValue = model.getValue.bind(model);
    let reads = 0;
    model.getValue = (...args) => { reads++; return getValue(...args); };
    return { model, getValue, reads: () => reads, resetReads: () => { reads = 0; } };
}

test('real Monaco model results preserve the existing detector and normalize EOLs identically', () => {
    const cases = ['', 'plain', '  a\n    b', '\tfield\n \tfield', '         a', '                 a\n       b',
        '  中文\r\n    🙂', '  \u2028field\n   value', '  \u00a0field', '  \ud800', '  a\rb\r   c'];
    for (const text of cases) {
        const f = countedModel(text);
        try {
            for (const fallback of [0, 1, 4, 6, 16]) {
                assert.equal(detect(f.model, 'json', fallback), detectIndentSize(f.getValue(), fallback), JSON.stringify([text, fallback]));
            }
            assert.equal(f.reads(), 1, 'fallback changes reuse the content-only detection');
        } finally { f.model.dispose(); }
    }
});

test('non-JSON and detached model paths use the current fallback without any model reads', () => {
    const unreadable = new Proxy({}, { get() { assert.fail('non-JSON language must not inspect model text or version'); } });
    for (const language of ['yaml', 'xml', 'html', 'css', 'toml', 'plaintext', 'text', 'JSON']) {
        assert.equal(detect(unreadable, language, 6), 6);
    }
    assert.equal(detect(null, 'json', 7), 7);
});

test('edit, undo, redo, EOL and setValue invalidate by actual Monaco version, not alternative version', async () => {
    const f = countedModel('{\n    "x": 1\n}');
    try {
        const check = expectedReads => {
            assert.equal(detect(f.model, 'json', 6), detectIndentSize(f.getValue(), 6));
            assert.equal(detect(f.model, 'json', 2), detectIndentSize(f.getValue(), 2));
            assert.equal(f.reads(), expectedReads);
        };
        check(1);
        f.model.pushEditOperations(null, [{ range: new api.Range(2, 1, 2, 5), text: '  ' }], null);
        check(2);
        await f.model.undo(); check(3);
        await f.model.redo(); check(4);
        // Monaco itself also reads the new text when constructing EOL/flush events.
        f.model.setEOL(1); check(6);
        f.model.setValue('none'); check(8);
        assert.equal(detect(f.model, 'json', 7), 7, 'zero sentinel does not cache the previous caller fallback');
        assert.equal(f.reads(), 8);
    } finally { f.model.dispose(); }
    assert.throws(() => detect(f.model, 'json', 6), /disposed/i, 'disposed models cannot reuse a cached value');
});

test('identical version numbers on different models never share a cached detection', () => {
    const a = countedModel('  a'), b = countedModel('      b');
    try {
        assert.equal(a.model.getVersionId(), b.model.getVersionId());
        assert.equal(detect(a.model, 'json', 4), 2);
        assert.equal(detect(b.model, 'json', 4), 6);
        assert.equal(detect(a.model, 'json', 4), 2);
        assert.equal(a.reads(), 1); assert.equal(b.reads(), 1);
    } finally { a.model.dispose(); b.model.dispose(); }
});

test('actual body-edit events reuse detection across multi-edits, undo, redo and EOL changes', async () => {
    const f = countedModel('{\n        "field": "value",\n    "second": "value"\n}');
    const events = [];
    assert.equal(detect(f.model, 'json', 6), 4);
    const subscription = f.model.onDidChangeContent(event => {
        const before = f.reads();
        assert.equal(detect(f.model, 'json', 6, event), detectIndentSize(f.getValue(), 6));
        assert.equal(detect(f.model, 'json', 2, event), detectIndentSize(f.getValue(), 2));
        events.push({ event, reads: f.reads() - before });
    });
    try {
        f.model.pushStackElement();
        f.model.pushEditOperations(null, [
            { range: new api.Range(2, 10, 2, 11), text: 'F' },
            { range: new api.Range(3, 14, 3, 15), text: 'V' },
        ], null);
        f.model.pushStackElement();
        await f.model.undo(); await f.model.redo();
        assert.equal(f.reads(), 1, 'body edits and their undo/redo never materialize the model');
        assert.equal(events[1].event.isUndoing, true);
        assert.equal(events[2].event.isRedoing, true);
        f.model.setEOL(1); f.model.setEOL(0);
        assert.equal(f.reads(), 3, 'only Monaco itself reads the text to create each EOL event');
        assert.ok(events.every(({ reads }) => reads === 0));

        f.model.applyEdits([{ range: new api.Range(3, 1, 3, 5), text: '  ' }]);
        f.model.applyEdits([{ range: new api.Range(2, 12, 2, 12), text: '\n x' }]);
        f.model.applyEdits([{ range: new api.Range(2, 12, 2, 12), text: '\r  x' }]);
        f.model.applyEdits([{ range: new api.Range(2, 12, 3, 2), text: '' }]);
        f.model.setValue('none');
        assert.ok(events.slice(5).every(({ reads }) => reads === 1), 'prefix, structural and flush edits each rescan once');
        assert.equal(detect(f.model, 'json', 7), 7, 'changing the fallback does not reuse a previous fallback');
        assert.equal(detect(f.model, 'yaml', 3, events.at(-1).event), 3);
    } finally { subscription.dispose(); f.model.dispose(); }
    assert.throws(() => detect(f.model, 'json', 6, events.at(-1).event), /disposed/i);
});

test('prefix boundaries preserve ASCII-space and non-whitespace semantics with real edit ranges', () => {
    for (const indent of [0, 1, 2, 7, 8, 9, 16, 17]) {
        for (const column of [8, 9, 10, 11]) {
            for (const inserted of ['x', ' ', '\t', '\u00a0', '\u2028', '😀', '\ud800', '\n', '\r', '\r\n']) {
                const f = countedModel(' '.repeat(indent) + 'x'.repeat(30) + '\n' + ' '.repeat(indent) + 'x');
                assert.equal(detect(f.model, 'json', 0), detectIndentSize(f.getValue(), 0));
                const subscription = f.model.onDidChangeContent(event => {
                    assert.equal(detect(f.model, 'json', 6, event), detectIndentSize(f.getValue(), 6), JSON.stringify([indent, column, inserted]));
                });
                try {
                    f.model.applyEdits([{ range: new api.Range(1, column, 1, column + 1), text: inserted }]);
                    assert.equal(f.reads(), column >= 10 && !/[\r\n]/.test(inserted) ? 1 : 2);
                } finally { subscription.dispose(); f.model.dispose(); }
            }
        }
    }
});

test('missed versions, stale events and absent events keep the existing full-scan fallback', () => {
    const f = countedModel('    field0123456789');
    const events = [];
    const subscription = f.model.onDidChangeContent(event => events.push(event));
    const edit = () => f.model.applyEdits([{ range: new api.Range(1, 12, 1, 13), text: 'x' }]);
    try {
        detect(f.model, 'json', 6);
        edit(); edit();
        assert.equal(detect(f.model, 'json', 6, events.at(-1)), 4);
        assert.equal(f.reads(), 2, 'a missed intermediate version cannot be inferred from the latest event');
        edit();
        assert.equal(detect(f.model, 'json', 6, events.at(-2)), 4);
        assert.equal(f.reads(), 3, 'an event for an earlier version cannot validate the current model');
        edit();
        assert.equal(detect(f.model, 'json', 6), 4);
        assert.equal(f.reads(), 4, 'callers without events retain version-based invalidation');
        edit();
        assert.equal(detect(f.model, 'yaml', 7, events.at(-1)), 7);
        assert.equal(detect(f.model, 'json', 6), 4);
        assert.equal(f.reads(), 5, 'non-JSON calls do not advance the JSON cache');
    } finally { subscription.dispose(); f.model.dispose(); }
});

test('large minified and indented long lines avoid body-edit materialization and add no listeners', () => {
    for (const prefix of ['{"value":"', '        "']) {
        const f = countedModel(prefix + 'x'.repeat(1_000_000) + '"}');
        const onDidChangeContent = f.model.onDidChangeContent.bind(f.model);
        let registrations = 0;
        f.model.onDidChangeContent = (...args) => { registrations++; return onDidChangeContent(...args); };
        const subscription = f.model.onDidChangeContent(event => {
            assert.equal(detect(f.model, 'json', 6, event), detectIndentSize(f.getValue(), 6));
        });
        try {
            detect(f.model, 'json', 6);
            for (let i = 0; i < 5; i++) f.model.applyEdits([{ range: new api.Range(1, 500_000, 1, 500_001), text: 'y' }]);
            assert.equal(f.reads(), 1);
            assert.equal(registrations, 1, 'the cache uses the caller event without registering any listener');
        } finally { subscription.dispose(); f.model.dispose(); }
    }
});

async function workbenchFixture() {
    const input = countedModel(''), output = countedModel('');
    const editors = [input, output].map(f => {
        let model = f.model;
        const updates = [];
        return { updates, getModel: () => model, getValue: () => model.getValue(), hasWidgetFocus: () => false,
            updateOptions: options => updates.push({ ...options }), setValue: text => model.setValue(text),
            replaceModel: next => { model = next; } };
    });
    const settings = { value: 4 };
    const context = {
        inputEditor: editors[0], outputEditor: editors[1], indentSize: settings,
        detectIndentSizeRaw: detectIndentSize, getModelDisplayIndentSize: detect,
        inputContentLanguage: { value: 'json' }, inputEditorErrors: { value: [] }, currentErrorIndex: { value: -1 },
        currentInputLineCount: { value: 1 }, inputHasContent: { value: false }, inputEditorStatus: { value: '' }, outputEditorStatus: { value: '' },
        themeMode: { value: 'light' }, applyingFormatResult: true,
        ensureModelLanguage: () => {}, getJsonToolThemeForLanguage: () => '',
        monacoApi: { editor: { setTheme() {}, setModelMarkers() {} } },
        getEditorOptions: (size, readOnly, language) => ({ tabSize: size, indentSize: size, readOnly, language }),
        getEditorLineCount: editor => editor.getModel().getLineCount(),
        configureJsonSchemaSupport() {}, forceJsonModelTokenization() {}, refreshInputEditorErrors() {},
        updateLineNumberWidth() {}, updateEditorHeight() {}, refreshMaxFoldableLevel: async () => {},
        shouldUsePreparedJsonModel: () => false, scheduleInputLevelAnalysis() {}, refreshEditorStatus() {},
    };
    const functions = await vueDeclarations('src/components/JsonToolWorkbench.vue', [
        'detectIndentSizeWrapper', 'getDisplayIndentSizeForContent', 'updateModelDisplayOptions',
        'updateEditorDisplayIndentOptions', 'syncEditorDisplayOptions', 'updateInputEditorConfig', 'updateOutputEditorConfig',
        'syncInputEditorIndentFromContent', 'syncOutputEditorIndentFromContent', 'setInputEditorValue', 'setOutputEditorValue',
    ], context);
    return { input, output, editors, settings, ...functions, dispose: () => { input.model.dispose(); output.model.dispose(); } };
}

test('actual normal setter and config functions share one scan with the content-change indentation callback', async () => {
    const f = await workbenchFixture();
    f.input.model.onDidChangeContent(f.syncInputEditorIndentFromContent);
    f.output.model.onDidChangeContent(f.syncOutputEditorIndentFromContent);
    try {
        f.setInputEditorValue('[\n  "a",\n  "b"\n]', 'json');
        f.setOutputEditorValue('[\n      "a",\n      "b"\n]', 'json', true);
        assert.equal(f.input.reads(), 2, 'one Monaco flush-event read plus one shared indentation read');
        assert.equal(f.output.reads(), 2, 'one Monaco flush-event read plus one shared indentation read');
        assert.equal(f.input.model.getOptions().tabSize, 2);
        assert.equal(f.output.model.getOptions().tabSize, 6);
        assert.deepEqual(f.editors[0].updates.map(options => options.tabSize), [2, 2, 2, 2]);
        assert.deepEqual(f.editors[1].updates.map(options => options.tabSize), [6, 6, 6]);
        f.updateInputEditorConfig('json'); f.updateOutputEditorConfig('json', true, 8);
        assert.equal(f.input.reads(), 2); assert.equal(f.output.reads(), 2);
        assert.equal(f.output.model.getOptions().tabSize, 6, 'detected indentation still overrides custom fallback');
    } finally { f.dispose(); }
});

test('actual workbench preserves supplied-text precedence, option updates and model replacement', async () => {
    const f = await workbenchFixture(), replacement = countedModel('        field');
    try {
        f.input.model.setValue('  field');
        f.input.resetReads();
        assert.equal(f.syncEditorDisplayOptions(f.editors[0], 'json', 4), 2);
        assert.equal(f.syncEditorDisplayOptions(f.editors[0], 'json', 7, ''), 7);
        assert.equal(f.syncEditorDisplayOptions(f.editors[0], 'json', 4, '      supplied'), 6);
        assert.equal(f.input.reads(), 1, 'explicit supplied text is neither replaced by nor inserted in the model cache');
        assert.equal(f.syncEditorDisplayOptions(f.editors[0], 'json', 4), 2);
        f.updateInputEditorConfig('yaml');
        assert.equal(f.input.model.getOptions().tabSize, 4);
        assert.equal(f.input.reads(), 1);
        f.updateInputEditorConfig('json');
        assert.equal(f.input.model.getOptions().tabSize, 2);
        f.editors[0].replaceModel(replacement.model);
        f.syncInputEditorIndentFromContent();
        assert.equal(replacement.model.getOptions().tabSize, 8);
        assert.equal(replacement.reads(), 1);
        f.output.model.setValue('no indentation');
        f.output.resetReads();
        f.updateOutputEditorConfig('json', true, 6);
        f.updateOutputEditorConfig('json', true, 3);
        assert.equal(f.output.model.getOptions().tabSize, 3);
        assert.equal(f.output.reads(), 1, 'custom fallback updates still apply without a second content scan');
        f.updateOutputEditorConfig('toml', false, 7);
        assert.equal(f.output.model.getOptions().tabSize, 7);
        assert.equal(f.output.reads(), 1);
    } finally { replacement.model.dispose(); f.dispose(); }
});
