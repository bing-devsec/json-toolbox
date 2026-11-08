import assert from 'node:assert/strict';
import test from 'node:test';
import { getModelUtf8ByteLength as count } from '../src/components/utils/modelUtf8ByteLength.ts';
import { api, createModel } from './helpers/selectionTextModel.mjs';
import { vueDeclarations } from './helpers/vueDeclarations.mjs';

const chunkModel = chunks => ({
    isDisposed: () => false,
    getVersionId: () => 1,
    createSnapshot: preserveBOM => {
        assert.equal(preserveBOM, false);
        let index = 0;
        return { read: () => index < chunks.length ? chunks[index++] : null };
    },
});
const expected = model => new Blob([model.getValueInRange(model.getFullModelRange())]).size;

test('UTF-8 count matches Blob for every split of mixed Unicode, including lone surrogates and empty chunks', () => {
    const inputs = ['', 'ascii\0', 'é中😀', '\ud800', '\udc00', '\ud800\ud800\udc00\udc00',
        'x😀\r\n中\ufeffz', '😀😀😀', '\ud800a\udc00', '\udc00\ud800', '\ufeff'];
    for (const text of inputs) {
        for (let split = 0; split <= text.length; split++) {
            assert.equal(count(chunkModel([text.slice(0, split), '', text.slice(split)])), new Blob([text]).size,
                JSON.stringify([text, split]));
        }
        assert.equal(count(chunkModel(text.split('').flatMap(unit => ['', unit, '']))), new Blob([text]).size);
    }
    assert.equal(count(chunkModel([])), 0);
});

test('output buffer and snapshot boundaries do not split Unicode scalars or require a document-sized encoding', () => {
    for (const prefix of [65533, 65534, 65535, 65536]) {
        for (const value of ['é', '中', '😀', '\ud800', '\udc00']) {
            const text = 'a'.repeat(prefix) + value + '中'.repeat(40000) + '😀';
            assert.equal(count(chunkModel([text])), new Blob([text]).size);
            assert.equal(count(chunkModel([text.slice(0, prefix + 1), '', text.slice(prefix + 1)])), new Blob([text]).size);
        }
    }
});

test('native Monaco BOM, mixed EOL normalization, Unicode and edited pieces preserve selectable-text bytes', () => {
    for (const text of ['', '\ufeff', '\ufeffa\r\n中😀\r\n', '\ufeff\ufeffa', 'a\rb\rc', 'a\r\nb\nc\r', '\ud800a\udc00']) {
        const model = createModel(text);
        try {
            assert.equal(count(model), expected(model));
            model.applyEdits([{ range: new api.Range(1, 1, 1, 1), text: '\ud800😀中\n' }]);
            assert.equal(count(model), expected(model));
            model.setEOL(1);
            assert.equal(count(model), expected(model));
            model.setEOL(0);
            assert.equal(count(model), expected(model));
        } finally { model.dispose(); }
    }
});

test('numeric per-model cache invalidates on edit, undo, redo, EOL and setValue, and rejects disposed models', async () => {
    const model = createModel('a\n中😀'), other = createModel('a\n中😀');
    const snapshot = model.createSnapshot.bind(model);
    let snapshots = 0;
    model.createSnapshot = (...args) => { snapshots++; return snapshot(...args); };
    try {
        assert.equal(count(model), expected(model));
        assert.equal(count(model), expected(model));
        assert.equal(snapshots, 1);
        assert.equal(count(other), expected(other));
        model.pushEditOperations(null, [{ range: new api.Range(1, 1, 1, 2), text: 'é' }], null);
        assert.equal(count(model), expected(model));
        await model.undo(); assert.equal(count(model), expected(model));
        await model.redo(); assert.equal(count(model), expected(model));
        model.setEOL(1); assert.equal(count(model), expected(model));
        model.setValue(''); assert.equal(count(model), 0);
        assert.equal(snapshots, 6);
        assert.equal(count(model), 0);
        assert.equal(snapshots, 6);
    } finally { model.dispose(); other.dispose(); }
    assert.throws(() => count(model), /disposed/);
});

test('Workbench full-selection status avoids text extraction and Blob, including repeated and edited selections', async () => {
    const txt = new Proxy({}, { get: (_, name) => (...args) => `${name}:${args.join(',')}` });
    const { updateEditorStatus } = await vueDeclarations('src/components/JsonToolWorkbench.vue', ['updateEditorStatus'], {
        getModelUtf8ByteLength: count, settingsTxt: { value: txt }, formatFileSize: value => `${value}bytes`,
        countSelectionMatches: () => assert.fail('full selection must not search'),
        Blob: class { constructor() { assert.fail('full selection must not encode a Blob'); } },
    });
    const model = createModel('\ufeffa\r\n中😀'), state = { value: '' };
    let focused = true;
    const editor = { getModel: () => model, hasWidgetFocus: () => focused,
        getSelection: () => new api.Selection(1, 1, model.getLineCount(), model.getLineMaxColumn(model.getLineCount())) };
    const snapshot = model.createSnapshot.bind(model);
    let snapshots = 0;
    model.createSnapshot = (...args) => { snapshots++; return snapshot(...args); };
    const nativeGetValue = model.getValue, nativeGetValueInRange = model.getValueInRange;
    model.getValueInRange = () => assert.fail('full selection must not extract the document');
    model.getValue = () => assert.fail('full selection must not extract the document');
    try {
        updateEditorStatus(editor, state);
        assert.equal(state.value, 'statusSelectedAll:2,6,10bytes');
        updateEditorStatus(editor, state);
        assert.equal(state.value, 'statusSelectedAll:2,6,10bytes');
        assert.equal(snapshots, 1);
        model.applyEdits([{ range: new api.Range(1, 1, 1, 2), text: 'é' }]);
        updateEditorStatus(editor, state);
        assert.equal(state.value, 'statusSelectedAll:2,6,11bytes');
        assert.equal(snapshots, 2);
        // Monaco itself reads text while changing EOL; only status must avoid it.
        model.getValue = nativeGetValue; model.getValueInRange = nativeGetValueInRange;
        model.setEOL(0);
        model.getValueInRange = () => assert.fail('full selection must not extract the document');
        model.getValue = () => assert.fail('full selection must not extract the document');
        updateEditorStatus(editor, state);
        assert.equal(state.value, 'statusSelectedAll:2,5,10bytes');
        assert.equal(snapshots, 3);
        focused = false;
        updateEditorStatus(editor, state);
        assert.equal(state.value, 'statusCursor:1,1,2');
        assert.equal(snapshots, 3);
    } finally { model.dispose(); }
});
