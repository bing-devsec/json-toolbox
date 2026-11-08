import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { build, transform } from 'esbuild';
import { patchMonacoFoldingRanges, monacoLargeFoldingPlugin } from '../scripts/vite/monaco-large-folding.mjs';
import { assertMonacoTransferFoldingSource, verifyMonacoTransferFoldingContract } from '../scripts/vite/monaco-transfer-folding-contract.mjs';
import { captureEditorSnapshot } from '../src/components/utils/editorSnapshot.ts';
import { reformatJsonIndentation } from '../src/components/utils/indentUtils.ts';

const bundled = await build({ stdin: { contents: `
    export * from './src/components/utils/editorTransferFolding';
    export { useJsonFoldingLevels } from './src/components/composables/useJsonFoldingLevels';
    export { TextModel } from 'monaco-editor/esm/vs/editor/common/model/textModel.js';
    export { UndoRedoService } from 'monaco-editor/esm/vs/platform/undoRedo/common/undoRedoService.js';
    export { FoldingModel } from 'monaco-editor/esm/vs/editor/contrib/folding/browser/foldingModel.js';
    export { FoldingRegions } from 'monaco-editor/esm/vs/editor/contrib/folding/browser/foldingRanges.js';
    export { HiddenRangeModel } from 'monaco-editor/esm/vs/editor/contrib/folding/browser/hiddenRangeModel.js';
    export { FoldingDecorationProvider } from 'monaco-editor/esm/vs/editor/contrib/folding/browser/foldingDecorations.js';`, resolveDir: process.cwd() },
    bundle: true, platform: 'node', format: 'cjs', write: false,
    plugins: [{ name: 'native-folding-ranges-patch', setup(build) {
        build.onLoad({ filter: /\/foldingRanges\.js$/ }, args => ({ contents: patchMonacoFoldingRanges(readFileSync(args.path, 'utf8')), loader: 'js' }));
    } }],
});
const module = { exports: {} };
new Function('module', 'exports', bundled.outputFiles[0].text)(module, module.exports);
const api = module.exports;
const controllerSource = readFileSync('node_modules/monaco-editor/esm/vs/editor/contrib/folding/browser/folding.js', 'utf8');
const nativeMethod = (start, end, name) => new Function(`return ({${controllerSource.slice(controllerSource.indexOf(start), controllerSource.indexOf(end, controllerSource.indexOf(start)))}})` )()[name];
const nativeSave = nativeMethod('saveViewState() {', '    /**\n     * Restore view state.', 'saveViewState');
const nativeRestore = nativeMethod('restoreViewState(state) {', '    onModelChanged() {', 'restoreViewState');
const nativeHidden = nativeMethod('onHiddenRangesChanges(hiddenRanges) {', '    onCursorPositionChanged() {', 'onHiddenRangesChanges');
const subscribe = () => ({ dispose() {} });
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const text = ['{', '  "orders": [', '    {', '      "id": 1,', '      "detail": {', '        "enabled": true', '      }', '    },', '    {', '      "id": 2', '    }', '  ]', '}'].join('\n');
const fullRanges = [
    { startLineNumber: 1, endLineNumber: 13 }, { startLineNumber: 2, endLineNumber: 12 },
    { startLineNumber: 3, endLineNumber: 8, isCollapsed: true },
    { startLineNumber: 5, endLineNumber: 7, isCollapsed: true }, { startLineNumber: 9, endLineNumber: 11, isCollapsed: true },
];
const hiddenLines = hidden => hidden.hiddenRanges.map(range => [range.startLineNumber, range.endLineNumber]);
function fixture(value = text, ranges = fullRanges) {
    let language = 'json';
    const model = new api.TextModel('', 'json', { ...api.TextModel.DEFAULT_CREATION_OPTIONS,
        bracketPairColorizationOptions: { enabled: false, independentColorPoolPerBracketType: false } }, null,
    new api.UndoRedoService({}, {}), { requestRichLanguageFeatures() {} }, { onDidChange: subscribe }, { createInstance: () => ({
        onDidChangeLanguage: subscribe, onDidChangeLanguageConfiguration: subscribe, onDidChangeTokens: subscribe,
        getLanguageId: () => language, setLanguageId: next => { language = next; }, handleDidChangeContent() {}, dispose() {},
    }) });
    model.setValue(value);
    const provider = new api.FoldingDecorationProvider({ changeDecorations: callback => model.changeDecorations(callback), removeDecorations: ids => { if (!model.isDisposed()) model.deltaDecorations(ids, []); } });
    const folding = new api.FoldingModel(model, provider), hidden = new api.HiddenRangeModel(folding), events = [], restored = [];
    let currentModel = model, currentController;
    const editor = { getModel: () => currentModel, getValue: () => currentModel.getValue(), getContribution: () => currentController,
        getSelections: () => [], setSelections() {}, setHiddenAreas: ranges => events.push(ranges.map(range => [range.startLineNumber, range.endLineNumber])),
        saveViewState: () => ({ cursorState: [], viewState: { scrollLeft: 0, firstPosition: { lineNumber: 1, column: 1 }, firstPositionDeltaTop: 0 }, contributionsState: { 'editor.contrib.folding': nativeSave.call(currentController) } }),
        restoreViewState(state) { restored.push(state); nativeRestore.call(currentController, state.contributionsState['editor.contrib.folding']); },
        getAction() { assert.fail('transfer must not invoke an asynchronous unfold action'); },
    };
    const controller = currentController = { editor, foldingModel: folding, hiddenRangeModel: hidden, _isEnabled: true,
        _restoringViewState: false, _currentModelHasFoldedImports: false, rangeProvider: { id: 'syntax' },
        foldingModelPromise: Promise.resolve(folding), getFoldingModel() { return this.foldingModelPromise; } };
    const listeners = [hidden.onDidChange(ranges => nativeHidden.call(currentController, ranges)), model.onDidChangeContent(e => hidden.notifyChangeModelContent(e))];
    folding.updatePost(api.FoldingRegions.fromFoldRanges(ranges));
    events.length = 0;
    return { editor, model, folding, hidden, controller, events, restored,
        replaceController: value => { currentController = value; }, replaceModel: value => { currentModel = value; },
        dispose() { for (const listener of listeners) listener.dispose(); hidden.dispose(); folding.dispose(); model.dispose(); } };
}
const capture = (source, unchanged = true) => { const state = source.editor.saveViewState(); return { state, snapshot: api.captureTransferFolding(source.editor, state, unchanged) }; };

test('installed folding source contract fails closed and runs in the existing build plugin', () => {
    verifyMonacoTransferFoldingContract();
    monacoLargeFoldingPlugin().buildStart();
    assert.throws(() => assertMonacoTransferFoldingSource('folding.js', controllerSource + '\n'), /Review the installed Monaco/);
    assert.throws(() => assertMonacoTransferFoldingSource('unknown.js', controllerSource), /Review the installed Monaco/);
    const helper = readFileSync('src/components/utils/editorTransferFolding.ts', 'utf8');
    assert.equal(/^import (?!type).*monaco/m.test(helper), false, 'no eager Monaco runtime dependency');
});

test('actual level-fold composable stamps current topology and copies every nested state independently', async () => {
    const source = fixture(), target = fixture();
    try {
        const levels = api.useJsonFoldingLevels({ selectedLevel: { value: 3 }, maxFoldableLevel: { value: null }, getOutputEditor: () => source.editor });
        await levels.foldByIndentation();
        const { state, snapshot } = capture(source);
        assert.ok(snapshot.topology);
        assert.notEqual(snapshot.topology, source.folding.regions);
        snapshot.topology.setCollapsed(3, false);
        assert.equal(source.folding.regions.isCollapsed(3), true);
        snapshot.topology.setCollapsed(3, true);
        target.model.setValue(text);
        target.folding._getLinesChecksum = () => assert.fail('trusted complete topology does not rehash each collapsed endpoint');
        assert.equal(api.restoreTransferFolding(target.editor, snapshot, state, true, () => true), true);
        assert.deepEqual(target.events, [[[4, 8], [10, 11]]]);
        assert.equal(target.folding.regions.length, 5);
        assert.equal(target.folding.regions.isCollapsed(3), true);
        assert.equal(Object.hasOwn(target.restored[0].contributionsState, 'editor.contrib.folding'), false);
        assert.ok(state.contributionsState['editor.contrib.folding'], 'the saved source state is never mutated');
    } finally { source.dispose(); target.dispose(); }
});

test('atomic memento replacement fixes changed indentation and survives later native provider recomputation', () => {
    for (const indent of [2, 4]) {
        const source = fixture(), target = fixture(text, [{ startLineNumber: 2, endLineNumber: 12, isCollapsed: true }]);
        try {
            const { state, snapshot } = capture(source, indent === 2);
            assert.equal(snapshot.topology, null);
            target.model.setValue(reformatJsonIndentation(text, indent));
            assert.equal(api.restoreTransferFolding(target.editor, snapshot, state, indent === 2, () => true), true);
            assert.deepEqual(target.events, [[[4, 8], [10, 11]]], 'no intermediate empty hidden-area event');
            assert.equal(target.folding.regions.length, 3);
            target.folding.update(api.FoldingRegions.fromFoldRanges(fullRanges.map(range => ({ ...range, isCollapsed: false }))), { startsInside: () => false });
            assert.equal(target.folding.regions.length, 5);
            assert.equal(target.folding.regions.isCollapsed(3), true);
            assert.deepEqual(hiddenLines(target.hidden), [[4, 8], [10, 11]]);
            assert.equal(target.events.length, 1);
        } finally { source.dispose(); target.dispose(); }
    }
});

test('the unchanged native memento reproduces indentation loss while old clear-then-restore emits an expanded event', () => {
    const source = fixture(), changed = fixture(reformatJsonIndentation(text, 4), []), old = fixture();
    try {
        const state = source.editor.saveViewState();
        changed.editor.restoreViewState(state);
        assert.deepEqual(hiddenLines(changed.hidden), []);
        old.model.setValue(text);
        old.folding.updatePost(api.FoldingRegions.fromFoldRanges([]));
        old.editor.restoreViewState(state);
        assert.deepEqual(old.events, [[], [[4, 8], [10, 11]]]);
    } finally { source.dispose(); changed.dispose(); old.dispose(); }
});

test('expanded source, manually expanded descendants and manual/recovered folds retain their actual state', () => {
    for (const ranges of [fullRanges.map(range => ({ ...range, isCollapsed: false })),
        fullRanges.map((range, i) => ({ ...range, isCollapsed: i === 3 ? false : range.isCollapsed, source: i === 3 ? 1 : i === 4 ? 2 : 0 }))]) {
        const source = fixture(text, ranges), target = fixture();
        try {
            const { state, snapshot } = capture(source);
            target.model.setValue(text);
            assert.equal(api.restoreTransferFolding(target.editor, snapshot, state, true, () => true), true);
            assert.deepEqual(hiddenLines(target.hidden), hiddenLines(source.hidden));
            if (ranges[3].source === 1) {
                const manual = Array.from({ length: target.folding.regions.length }, (_, i) => target.folding.regions.toFoldRange(i)).find(range => range.startLineNumber === 5);
                assert.equal(manual.source, 1); assert.equal(manual.isCollapsed, false);
            }
        } finally { source.dispose(); target.dispose(); }
    }
});

test('text, language, pending recompute, controller and region changes invalidate full-topology stamps', () => {
    for (const mutate of [f => f.model.setValue(text), f => f.model.setLanguage('yaml'),
        f => { f.controller.foldingModelPromise = Promise.resolve(f.folding); }, f => f.replaceController({ ...f.controller }),
        f => f.folding.updatePost(api.FoldingRegions.fromFoldRanges(fullRanges))]) {
        const source = fixture();
        try {
            api.rememberCurrentTransferFolding(source.editor, source.folding);
            assert.ok(capture(source).snapshot.topology);
            mutate(source);
            assert.equal(capture(source).snapshot.topology, null);
        } finally { source.dispose(); }
    }
});

test('line count, stale target and mismatched hidden/folding ownership fail before mutation', () => {
    for (const mutate of [f => f.model.setValue('short'), f => { f.controller.hiddenRangeModel = { _foldingModel: {} }; },
        f => { f.folding.regions.constructor = {}; }]) {
        const source = fixture(), target = fixture();
        try {
            const { state, snapshot } = capture(source); mutate(target); target.events.length = 0;
            assert.equal(api.restoreTransferFolding(target.editor, snapshot, state, true, () => true), false);
            assert.deepEqual(target.events, []);
            assert.equal(api.restoreTransferFolding(target.editor, snapshot, state, true, () => false), false);
            assert.equal(target.restored.length, 0);
        } finally { source.dispose(); target.dispose(); }
    }
});

test('native fallback waits for fresh calculation, rebases indentation and rejects newer controller/model work', async () => {
    for (const scenario of ['success', 'edited', 'controller', 'folding', 'disposed', 'rejected']) {
        const source = fixture(), target = fixture();
        try {
            const { state, snapshot } = capture(source, false), pending = deferred();
            target.model.setValue(reformatJsonIndentation(text, 4));
            target.controller.foldingModelPromise = pending.promise;
            const current = captureEditorSnapshot(() => target.editor);
            const restore = api.restoreTransferFoldingWhenReady(target.editor, snapshot, state, false, current);
            if (scenario === 'edited') target.model.setValue('new input');
            if (scenario === 'controller') target.replaceController({ ...target.controller });
            if (scenario === 'folding') target.controller.foldingModel = {};
            if (scenario === 'disposed') target.model.dispose();
            if (scenario === 'rejected') { pending.reject(new Error('provider failed')); await assert.rejects(restore, /provider failed/); }
            else { pending.resolve(target.folding); await restore; }
            assert.equal(target.restored.length, scenario === 'success' ? 1 : 0);
        } finally { source.dispose(); target.dispose(); }
    }
    const source = fixture(), target = fixture();
    try {
        const { state, snapshot } = capture(source, false);
        target.model.setValue(reformatJsonIndentation(text, 4));
        target.folding.update(api.FoldingRegions.fromFoldRanges(fullRanges.map(range => ({ ...range, isCollapsed: false }))));
        target.folding.regions.constructor = {}; // Unsupported adapter shape, but native persistence remains usable.
        await api.restoreTransferFoldingWhenReady(target.editor, snapshot, state, false, () => true);
        assert.deepEqual(hiddenLines(target.hidden), [[4, 8], [10, 11]]);
    } finally { source.dispose(); target.dispose(); }
});

test('a million-line native model gets one folded update without creating an ineligible large model', () => {
    const big = '{\n  "items": [\n' + '    0,\n'.repeat(1_000_000) + '    0\n  ]\n}';
    const ranges = [{ startLineNumber: 2, endLineNumber: 1_000_004, isCollapsed: true }];
    const source = fixture(big, ranges), target = fixture();
    try {
        api.rememberCurrentTransferFolding(source.editor, source.folding);
        const { state, snapshot } = capture(source);
        target.model.setValue(big);
        assert.equal(target.model.isTooLargeForTokenization(), false);
        assert.equal(api.restoreTransferFolding(target.editor, snapshot, state, true, () => true), true);
        assert.deepEqual(target.events, [[[3, 1_000_004]]]);
    } finally { source.dispose(); target.dispose(); }
});

test('patched native constructor transfers more than 65535 regions and independent packed parents', () => {
    const count = 66_000, value = '  0,\n'.repeat(count * 2) + '0';
    const ranges = Array.from({ length: count }, (_, i) => ({ startLineNumber: i * 2 + 1, endLineNumber: i * 2 + 2, isCollapsed: i % 2 === 0 }));
    const source = fixture(value, ranges), target = fixture();
    try {
        source.folding.regions.ensureParentIndices();
        api.rememberCurrentTransferFolding(source.editor, source.folding);
        const { state, snapshot } = capture(source);
        assert.equal(snapshot.topology.length, count);
        target.model.setValue(value);
        assert.equal(api.restoreTransferFolding(target.editor, snapshot, state, true, () => true), true);
        assert.equal(target.folding.regions.getParentIndex(count - 1), -1);
        assert.equal(target.folding.regions.getStartLineNumber(count - 1), count * 2 - 1);
        assert.equal(target.hidden.hiddenRanges.length, count / 2);
        assert.equal(target.events.length, 1);
    } finally { source.dispose(); target.dispose(); }
});

test('malformed source mementos cannot cross the snapshot trust boundary', () => {
    const source = fixture();
    try {
        for (const change of [state => { state.lineCount++; }, state => { state.collapsedRegions = {}; },
            state => { state.collapsedRegions[0].startLineNumber = 0; }, state => { state.collapsedRegions[0].endLineNumber = 99; },
            state => { state.collapsedRegions[0].source = 9; }, state => { state.collapsedRegions[0].checksum = NaN; }]) {
            const state = source.editor.saveViewState(); change(state.contributionsState['editor.contrib.folding']);
            assert.equal(api.captureTransferFolding(source.editor, state), null);
        }
    } finally { source.dispose(); }
});

const workbench = readFileSync('src/components/JsonToolWorkbench.vue', 'utf8');
const handlerCode = (await transform(workbench.slice(workbench.indexOf('let transferRequestSequence ='), workbench.indexOf('</script>', workbench.indexOf('let transferRequestSequence ='))), { loader: 'ts', format: 'cjs' })).code;
function handlerFixture() {
    const ticks = [], unmount = [], messages = [], pending = deferred();
    const editor = (value = '{}') => {
        const model = { version: 1, language: 'json', disposed: false, getVersionId() { return this.version; }, isDisposed() { return this.disposed; }, getLanguageId() { return this.language; } };
        const controller = { getFoldingModel: () => pending.promise };
        return { model, value, restored: 0, getModel() { return this.model; }, getValue() { return this.value; }, getContribution: () => controller,
            saveViewState: () => ({ cursorState: [], viewState: {}, contributionsState: {} }), restoreViewState() { this.restored++; },
            getAction: () => assert.fail('must never call unfoldAll') };
    };
    const ctx = { inputEditor: editor(), outputEditor: editor(text), inputContentLanguage: { value: 'json' }, outputType: { value: 'json' }, indentSize: { value: 2 },
        isTabPageClosing: { value: false }, normalEditorsDisposed: false, diffMode: { isDiffMode: { value: false } }, comparisonMode: { value: false },
        captureEditorSnapshot, reformatJsonIndentation, ...api, detectInputLanguage: () => 'yaml',
        nextTick: fn => ticks.push(fn), onBeforeUnmount: fn => unmount.push(fn),
        syncEditorDisplayOptions() {}, refreshEditorStatus() {}, inputEditorStatus: {}, clearOutputFoldingInfo() {},
        settingsTxt: { value: { msgTransferOutputEmpty: 'empty', msgTransferSuccess: 'success', msgTransferFail: message => message } },
        showMessageWarning: message => messages.push(message), showMessageSuccess: message => messages.push(message), showMessageError: message => messages.push(message),
        setInputEditorValue(value, language, beforeWrite) { const model = this.inputEditor.model; beforeWrite(model, model.version + 1); this.inputEditor.value = value; model.version++; this.inputContentLanguage.value = language; this.afterWrite?.(); return true; },
        setOutputEditorValue(value) { this.outputEditor.value = value; this.outputEditor.model.version++; },
    };
    const run = new Function('ctx', `with(ctx){${handlerCode};return transferToInput;}`)(ctx);
    return { ctx, run: () => run({ stopPropagation() {} }), ticks, unmount, pending, messages };
}

test('actual transfer handler permits its own preview clear and guards every delayed restore', async () => {
    for (const scenario of ['success', 'edit', 'replace', 'language', 'mode', 'close', 'unmount', 'empty-second', 'new-transfer', 'reject']) {
        const f = handlerFixture(); f.run(); assert.equal(f.ctx.outputEditor.value, '');
        f.ticks.shift()(); await Promise.resolve();
        if (scenario === 'edit') f.ctx.inputEditor.model.version++;
        if (scenario === 'replace') f.ctx.inputEditor = { ...f.ctx.inputEditor };
        if (scenario === 'language') f.ctx.inputContentLanguage.value = 'xml';
        if (scenario === 'mode') f.ctx.diffMode.isDiffMode.value = true;
        if (scenario === 'close') f.ctx.isTabPageClosing.value = true;
        if (scenario === 'unmount') f.unmount.forEach(dispose => dispose());
        if (scenario === 'empty-second') f.run();
        if (scenario === 'new-transfer') { f.ctx.outputEditor.value = '{"new":1}'; f.ctx.outputEditor.model.version++; f.run(); }
        if (scenario === 'reject') f.pending.reject(new Error('folding rejected')); else f.pending.resolve();
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(f.ctx.inputEditor.restored, scenario === 'success' ? 1 : 0, scenario);
        if (scenario === 'reject') assert.ok(f.messages.includes('folding rejected'));
    }
});

test('actual transfer handler rejects reentrant text/model replacements and preserves preview', () => {
    for (const mutate of [ctx => ctx.inputEditor.model.version++, ctx => { ctx.inputEditor.model = { ...ctx.inputEditor.model, version: 1 }; }]) {
        const f = handlerFixture(); f.ctx.afterWrite = () => mutate(f.ctx); f.run();
        assert.equal(f.ctx.outputEditor.value, text);
        assert.equal(f.ticks.length, 0);
        assert.equal(f.messages.includes('success'), false);
    }
});

test('first-use optional language may still be loading after committed text without aborting transfer', async () => {
    const f = handlerFixture(); f.ctx.outputType.value = 'text'; f.ctx.outputEditor.value = 'items:\n  - one';
    f.run();
    assert.equal(f.ctx.inputContentLanguage.value, 'yaml');
    assert.equal(f.ctx.inputEditor.model.getLanguageId(), 'json', 'the optional tokenizer has not loaded yet');
    assert.equal(f.ctx.outputEditor.value, ''); assert.ok(f.messages.includes('success'));
    f.ticks.shift()(); f.pending.resolve(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.ctx.inputEditor.restored, 1);
});
