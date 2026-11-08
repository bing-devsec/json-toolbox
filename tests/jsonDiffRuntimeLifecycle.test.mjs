import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { runInNewContext } from 'node:vm';
import { api, createModel } from './helpers/selectionTextModel.mjs';

const bundled = await build({
    stdin: { contents: `export { createDiffEditorRuntime } from './src/components/composables/diffEditorRuntime';`, resolveDir: process.cwd(), loader: 'ts' },
    bundle: true, write: false, format: 'cjs', platform: 'node',
    plugins: [{ name: 'runtime-fixtures', setup(build) {
        build.onResolve({ filter: /(?:monacoRuntime|monacoThemes|monacoTextareaAttrs|diffMonaco|diffEngine)$/ }, args => ({ path: args.path, namespace: 'fixture' }));
        build.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => ({ contents:
            path.endsWith('monacoRuntime') ? 'export const monacoApi = fixture.monaco;' :
            path.endsWith('monacoThemes') ? "export const getJsonToolThemeForLanguage = () => 'theme';" :
            path.endsWith('monacoTextareaAttrs') ? 'export const ensureMonacoTextareaAttrs = () => ({ disconnect() { fixture.disconnections++; } });' :
            path.endsWith('diffEngine') ? 'fixture.engineLoads++; export const computeLineDiff = () => fixture.changes; export const computeInlineDiff = () => null;' : `
                export const buildDiffViewZoneSpecs = () => ({ leftSpecs: [], rightSpecs: [] });
                export const replaceDiffViewZones = () => [];
                export const getDiffChangeTop = () => 0;
                export const layoutOneDiffEditor = editor => editor?.layout();
            ` }));
    } }],
});
const noop = () => {};
const disposable = () => ({ dispose: noop });
function setup(localeState, overrides = {}) {
    const frames = new Map(); let frameId = 0;
    const fixture = { editors: [], models: [], changes: [], engineLoads: 0, disconnections: 0, errors: [], workers: [] };
    const makeModel = text => {
        const callbacks = new Set();
        const model = overrides.realModels ? createModel(text) : { text, version: 1, disposed: false,
            getValue() { return this.text; }, getLinesContent() { return this.text.split('\n'); },
            getLineCount() { return this.getLinesContent().length; }, getVersionId() { return this.version; },
            setValue(value) { this.text = value; this.version++; callbacks.forEach(callback => callback()); },
            isDisposed() { return this.disposed; }, dispose() { this.disposed = true; }, updateOptions: noop,
            onDidChangeContent(callback) { callbacks.add(callback); return { dispose: () => callbacks.delete(callback) }; },
        };
        const getValue = model.getValue.bind(model), updateOptions = model.updateOptions.bind(model);
        model.valueReads = 0; model.optionUpdates = [];
        model.getValue = (...args) => { model.valueReads++; return getValue(...args); };
        model.updateOptions = options => { model.optionUpdates.push({ ...options }); updateOptions(options); };
        fixture.models.push(model); return model;
    };
    const makeEditor = (_, options) => {
        const editor = { constructionOptions: { ...options }, model: options.model, disposed: false, layouts: 0, decorations: 0, restored: null, optionUpdates: [],
            getModel() { return this.model; }, getValue() { return this.model.getValue(); },
            dispose() { this.disposed = true; }, layout() { this.layouts++; },
            deltaDecorations() { this.decorations++; return []; },
            getScrollTop: () => 0, getScrollLeft: () => 0, setScrollPosition: noop,
            getLayoutInfo: () => ({ height: 400, contentWidth: 400, horizontalScrollbarHeight: 0, decorationsLeft: 0, decorationsWidth: 4 }),
            getOption: () => 16, getTopForLineNumber: line => (line - 1) * 16, getBottomForLineNumber: line => line * 16,
            getVisibleRanges: () => [{ startLineNumber: 1, endLineNumber: 10 }],
            restoreViewState(value) { this.restored = value; },
            updateOptions(options) { this.optionUpdates.push({ ...options }); }, addOverlayWidget: noop, layoutOverlayWidget: noop,
            onDidScrollChange: disposable, onDidLayoutChange: disposable,
        };
        fixture.editors.push(editor); return editor;
    };
    fixture.monaco = { editor: { createModel: makeModel, create: makeEditor, EditorOption: { lineHeight: 1 } }, Range: class {} };
    fixture.Worker = class {
        constructor() { fixture.workers.push(this); }
        postMessage(value) { this.message = value; }
        terminate() { this.terminated = true; }
    };
    const makeNode = () => ({ className: '', dataset: {}, style: {}, setAttribute: noop, appendChild: noop, animate: () => ({ cancel: noop }) });
    const module = { exports: {} };
    runInNewContext(bundled.outputFiles[0].text, { module, exports: module.exports, fixture,
        Worker: fixture.Worker, URL, console,
        window: { matchMedia: () => ({ matches: true }) },
        document: { documentElement: { lang: 'en' }, createElement: makeNode },
        requestAnimationFrame: callback => { frames.set(++frameId, callback); return frameId; },
        cancelAnimationFrame: id => frames.delete(id),
    });
    const ref = value => ({ value });
    const state = { comparisonBusy: ref(false), diffCount: ref(0), activeDiffIndex: ref(-1), diffSyncButtons: ref([]), diffDraftLeftText: ref(localeState?.left.text ?? ''), diffDraftRightText: ref(localeState?.right.text ?? '') };
    const opts = { localeState, leftContainerRef: ref({}), rightContainerRef: ref({}), leftStatusRef: ref(''), rightStatusRef: ref(''), tabId: ref('tab'), onError: message => fixture.errors.push(message), showMinimap: ref(false), fontSize: ref(12), wordWrap: ref(true), themeMode: ref('light'), exactComparison: ref(false), trackEditorFocus: noop, setupDoubleClickSelectString: noop, registerClipboardActions: noop, registerEncodingActions: noop, filterBuiltinContextMenuActions: noop, setupSelectionListener: () => [], updateLineNumberWidth: noop, detectIndentSize: () => 2 };
    if (overrides.detectIndentSize) opts.detectIndentSize = overrides.detectIndentSize;
    if (overrides.getBuiltinIndentFallback) opts.getBuiltinIndentFallback = overrides.getBuiltinIndentFallback;
    const drafts = { restores: 0, saveDiffDraft: async () => {}, loadDiffDraftSnapshot: async () => {}, async restoreDiffDraftIntoEditors() { this.restores++; } };
    const runtime = module.exports.createDiffEditorRuntime(opts, state, drafts);
    return { fixture, state, opts, drafts, runtime, frames,
        flushFrame() { const next = frames.entries().next().value; if (next) { frames.delete(next[0]); next[1](); } },
    };
}
const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

test('runtime creates one editor pair, cancels nested layout frames and disposes every model', () => {
    const { runtime, fixture, frames, flushFrame } = setup();
    runtime.createDiffEditor(); runtime.createDiffEditor();
    assert.equal(fixture.editors.length, 2);
    flushFrame();
    assert.ok(frames.size >= 1);
    runtime.destroyDiffEditor();
    assert.equal(frames.size, 0);
    assert.ok(fixture.models.every(model => model.disposed)); assert.ok(fixture.editors.every(editor => editor.disposed));
    runtime.createDiffEditor();
    assert.equal(fixture.editors.length, 4);
    runtime.destroyDiffEditor();
    assert.ok(fixture.models.every(model => model.disposed));
});

test('runtime restores locale content and view state once without loading an older IDB draft', async () => {
    const locale = { left: { text: '中文', viewState: { top: 10 } }, right: { text: 'English', viewState: { top: 20 } }, activeDiffIndex: 0 };
    const { runtime, fixture, drafts, state } = setup(locale);
    fixture.changes = [{ originalStartLineNumber: 1, originalEndLineNumber: 1, modifiedStartLineNumber: 1, modifiedEndLineNumber: 1 }];
    runtime.createDiffEditor(); await runtime.restoreDiffDraftIntoEditors();
    assert.equal(drafts.restores, 0);
    assert.equal(fixture.models[0].text, '中文'); assert.equal(fixture.models[1].text, 'English');
    runtime.recomputeDiff(); await settle();
    assert.equal(fixture.editors[0].restored, locale.left.viewState); assert.equal(fixture.editors[1].restored, locale.right.viewState);
    assert.equal(state.activeDiffIndex.value, 0); assert.equal(state.diffCount.value, 1);
    runtime.destroyDiffEditor(); runtime.createDiffEditor(); await runtime.restoreDiffDraftIntoEditors();
    assert.equal(drafts.restores, 1);
});

test('a content edit during engine import invalidates the old computation before its scheduled successor runs', async () => {
    const { runtime, fixture, state } = setup(); runtime.createDiffEditor();
    fixture.changes = [{ originalStartLineNumber: 1, originalEndLineNumber: 1, modifiedStartLineNumber: 1, modifiedEndLineNumber: 1 }];
    runtime.recomputeDiff(); fixture.models[0].setValue('new content'); await settle();
    assert.equal(state.diffCount.value, 0);
    assert.equal(fixture.editors[0].decorations, 0);
    runtime.recomputeDiff(); await settle();
    assert.equal(state.diffCount.value, 1);
    runtime.destroyDiffEditor();
});

test('built-in Diff detection preserves real-model option updates, fallback changes and editor re-entry', async () => {
    let fallback = 4;
    const locale = { left: { text: '  "field": "value"' }, right: { text: 'plain0123456789' } };
    const { runtime, fixture } = setup(locale, { realModels: true, getBuiltinIndentFallback: () => fallback,
        detectIndentSize: () => assert.fail('the explicit built-in opt-in does not call a custom detector') });
    runtime.createDiffEditor();
    const [left, right] = fixture.models;
    const sizes = editor => editor.optionUpdates.map(options => [options.tabSize, options.indentSize]);
    try {
        assert.equal(left.valueReads, 1); assert.equal(right.valueReads, 1);
        assert.deepEqual(left.optionUpdates, [
            { tabSize: 4, indentSize: 4, insertSpaces: true },
            { tabSize: 2, indentSize: 2, insertSpaces: true },
        ]);
        left.pushStackElement();
        left.pushEditOperations(null, [{ range: new api.Range(1, 13, 1, 14), text: 'V' }], null);
        left.pushStackElement();
        await left.undo(); await left.redo();
        assert.equal(left.valueReads, 1);
        left.setEOL(1);
        assert.equal(left.valueReads, 2, 'only Monaco reads the EOL event payload');
        left.applyEdits([{ range: new api.Range(1, 1, 1, 3), text: '      ' }]);
        assert.equal(left.valueReads, 3);
        assert.deepEqual(sizes(fixture.editors[0]), [[2, 2], [2, 2], [2, 2], [2, 2], [2, 2], [6, 6]]);
        fallback = 7;
        right.applyEdits([{ range: new api.Range(1, 12, 1, 13), text: 'x' }]);
        assert.equal(right.valueReads, 1, 'the latest fallback applies without rescanning unchanged prefixes');
        right.setValue('        x');
        assert.equal(right.valueReads, 3, 'flush keeps the Monaco payload read and one detector read');
        assert.deepEqual(sizes(fixture.editors[1]), [[4, 4], [7, 7], [8, 8]]);
        assert.equal(right.getOptions().tabSize, 8);
        runtime.destroyDiffEditor();
        assert.ok(left.isDisposed()); assert.ok(right.isDisposed());
        runtime.createDiffEditor();
        assert.deepEqual(sizes(fixture.editors[2]), [[7, 7]]);
        assert.deepEqual(sizes(fixture.editors[3]), [[7, 7]]);
        assert.equal(fixture.models[2].valueReads, 1);
        assert.equal(fixture.models[3].valueReads, 1);
    } finally { runtime.destroyDiffEditor(); }
    assert.ok(fixture.models.every(model => model.isDisposed()));
});

test('an event from a replaced Diff model cannot validate the current editor model cache', () => {
    const { runtime, fixture } = setup(undefined, { realModels: true, getBuiltinIndentFallback: () => 4 });
    runtime.createDiffEditor();
    const original = fixture.models[0], replacement = createModel('  field0123456789');
    replacement.applyEdits([{ range: new api.Range(1, 12, 1, 13), text: 'x' }]);
    fixture.editors[0].model = replacement;
    try {
        original.setValue('plain0123456789');
        assert.equal(replacement.getOptions().tabSize, 2);
        replacement.applyEdits([{ range: new api.Range(1, 1, 1, 3), text: '      ' }]);
        original.applyEdits([{ range: new api.Range(1, 12, 1, 13), text: 'x' }]);
        assert.equal(original.getVersionId(), replacement.getVersionId(), 'model identity matters even when the event versions match');
        assert.equal(replacement.getOptions().tabSize, 6, 'the original body-edit event must not hide a replacement prefix change');
    } finally {
        fixture.editors[0].model = original;
        replacement.dispose(); runtime.destroyDiffEditor();
    }
});

test('custom Diff detectors retain their full-content callback contract without the built-in opt-in', () => {
    const calls = [];
    const detector = text => { calls.push(text); return text.includes('SPECIAL') ? 3 : 5; };
    const locale = { left: { text: 'plain0123456789' }, right: { text: 'SPECIAL0123456789' } };
    const { runtime, fixture } = setup(locale, { realModels: true, detectIndentSize: detector });
    runtime.createDiffEditor();
    try {
        assert.deepEqual(calls, ['', locale.left.text, locale.right.text]);
        fixture.models[0].applyEdits([{ range: new api.Range(1, 12, 1, 13), text: 'SPECIAL' }]);
        assert.equal(calls.at(-1), 'plain012345SPECIAL789');
        assert.deepEqual(fixture.editors[0].optionUpdates.map(options => options.tabSize), [5, 3]);
        assert.deepEqual(fixture.editors[1].optionUpdates.map(options => options.tabSize), [3]);
        assert.equal(fixture.models[0].valueReads, 2, 'custom detectors still receive full text on every content event');
    } finally { runtime.destroyDiffEditor(); }
});


test('DOM read-only follows repair comparison only and resets when returning to editable Diff', () => {
    const { runtime, fixture, opts } = setup();
    for (const readOnly of [false, true, false]) {
        opts.exactComparison.value = readOnly;
        runtime.createDiffEditor();
        for (const editor of fixture.editors.slice(-2)) {
            assert.equal(editor.constructionOptions.readOnly, readOnly);
            assert.equal(editor.constructionOptions.domReadOnly, readOnly);
        }
        runtime.destroyDiffEditor();
    }
});
