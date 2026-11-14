import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { effectScope, nextTick, ref } from 'vue';
import { SETTINGS_TXT_ZH, SETTINGS_TXT_EN } from '../src/components/utils/i18n.ts';

const bundled = await build({
    stdin: { contents: "export { useJsonSort } from './src/components/composables/useJsonSort'; export { createEditorDemoSession } from './src/components/utils/editorDemoSession';", resolveDir: process.cwd(), loader: 'ts' },
    bundle: true, write: false, platform: 'node', format: 'cjs', external: ['vue'],
    plugins: [{ name: 'editor-adapters', setup(builder) {
        builder.onResolve({ filter: /^monaco-editor(?:\/|$)|\/diffMonaco$/ }, args => ({ path: args.path, namespace: 'fixture' }));
        builder.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => ({ contents: path.endsWith('/diffMonaco')
            ? 'export const replaceEditorValuePreservingUndo = (editor, value) => editor.setValue(value);'
            : 'export const editor = { createModel: (...args) => createDemoModel(...args) };' }));
    } }],
});

function model(initialValue, language = 'json') {
    let text = initialValue, disposed = false;
    return { language, history: [initialValue], options: { tabSize: 4 },
        getValue: () => text, getLanguageId: () => language,
        setValue(value) { text = value; this.history = [value]; },
        isDisposed: () => disposed, dispose() { disposed = true; },
    };
}
function editor(initialValue, language, readOnly = false) {
    let current = model(initialValue, language), options = { readOnly }, view = { scrollTop: 400, selection: [8, 3] };
    return { getModel: () => current, setModel(value) { current = value; view = { scrollTop: 0, selection: [1, 1] }; },
        getValue: () => current.getValue(), setValue(value) { current.setValue(value); },
        getRawOptions: () => options, updateOptions(value) { options = { ...options, ...value }; },
        saveViewState: () => view, restoreViewState(value) { view = value; },
    };
}
function node() {
    const classes = new Set();
    return { classes, classList: { add: value => classes.add(value), remove: value => classes.delete(value) },
        scrollIntoView() {}, getBoundingClientRect: () => ({ left: 0, right: 600, top: 0, bottom: 500 }),
    };
}
function fixture(t, { diff = false, exitDiffMode } = {}) {
    const createdModels = [], inputNode = node(), outputNode = node();
    const module = { exports: {} };
    new Function('require', 'module', 'exports', 'createDemoModel', 'window', 'document', bundled.outputFiles[0].text)(
        createRequire(import.meta.url), module, module.exports,
        (value, language) => { const next = model(value, language); createdModels.push(next); return next; },
        { innerWidth: 1400, innerHeight: 1000 },
        { querySelector: selector => selector === '.editor-panel-input' ? inputNode : outputNode, body: outputNode },
    );
    const scope = effectScope();
    const input = editor('{"original":"input"}', 'json'), output = editor('original: output', 'yaml', true);
    const sortOrder = ref('desc'), sortMethod = ref('field'), isDiffMode = ref(diff);
    const errors = [], events = [];
    const settingsTxt = ref(SETTINGS_TXT_ZH);
    const sort = scope.run(() => module.exports.useJsonSort({
        settingsTxt, sortOrder, sortMethod, getInputEditor: () => input, getOutputEditor: () => output,
        getDiffSideEditor: () => null, isDiffMode,
        enterDiffMode() { events.push('enter diff'); isDiffMode.value = true; },
        async exitDiffMode() { events.push('exit diff'); await exitDiffMode?.(); isDiffMode.value = false; },
        ensureProcessingFeatureAvailable: () => true,
        showMessageSuccess() {}, showMessageError: value => errors.push(value),
        preprocessJSON: value => ({ data: JSON.parse(value), escapeMap: new Map() }),
        formatJsonResult: value => JSON.stringify(value), formatDemoResult: value => JSON.stringify(value),
        writeOutputJson: value => output.setValue(value), setOutputTypeJson() {},
        clearOutputEditor: () => output.setValue(''), updateEditorHeight() {}, updateLineNumberWidth() {},
        onDemoSessionStart: () => events.push('start session'), onDemoSessionRestore: () => events.push('restore session'),
    }));
    t.after(() => scope.stop());
    return { sort, input, output, sortOrder, sortMethod, settingsTxt, isDiffMode, errors, events, createdModels, inputNode, outputNode, scope,
        sessionFactory: module.exports.createEditorDemoSession,
        next() { sort.currentDemoStepData.value.buttons.at(-1).action(); },
        select(index) { sort.currentDemoStepData.value.examples[index].action(); },
    };
}

test('ending a sorting demo restores original models, output, undo history, view states and sort options', async t => {
    const f = fixture(t), originalInput = f.input.getModel(), originalOutput = f.output.getModel();
    const inputView = f.input.saveViewState(), outputView = f.output.saveViewState();
    originalInput.history.push('prior input edit'); originalOutput.history.push('prior output edit');
    f.sort.sortRootPath.value = 'users'; f.sort.sortFieldName.value = 'profile.id';
    await f.sort.showFieldSortDemo();
    assert.notEqual(f.input.getModel(), originalInput);
    assert.equal(f.input.getRawOptions().readOnly, true);
    f.sortOrder.value = 'asc'; f.sortMethod.value = 'length';
    f.next();
    assert.deepEqual(JSON.parse(f.output.getValue()).map(item => item.id), [1, 2, 3]);
    f.sort.endDemoMode(); await nextTick();
    assert.equal(f.input.getModel(), originalInput); assert.equal(f.output.getModel(), originalOutput);
    assert.equal(f.input.getValue(), '{"original":"input"}'); assert.equal(f.output.getValue(), 'original: output');
    assert.deepEqual(originalInput.history, ['{"original":"input"}', 'prior input edit']);
    assert.deepEqual(originalOutput.history, ['original: output', 'prior output edit']);
    assert.equal(f.input.saveViewState(), inputView); assert.equal(f.output.saveViewState(), outputView);
    assert.equal(originalOutput.getLanguageId(), 'yaml'); assert.deepEqual(originalOutput.options, { tabSize: 4 });
    assert.equal(f.input.getRawOptions().readOnly, false); assert.equal(f.output.getRawOptions().readOnly, true);
    assert.equal(f.sort.sortRootPath.value, 'users'); assert.equal(f.sort.sortFieldName.value, 'profile.id');
    assert.equal(f.sortOrder.value, 'desc'); assert.equal(f.sortMethod.value, 'field');
    assert(f.createdModels.every(item => item.isDisposed()));
    assert(!originalInput.isDisposed()); assert(!originalOutput.isDisposed());
});

test('all four examples can be selected directly and execute once with their own data and parameters', async t => {
    const f = fixture(t); f.sortOrder.value = 'asc'; await f.sort.showFieldSortDemo();
    assert.equal(f.sort.currentDemoStepData.value.examples.length, 4);
    assert.equal(f.sort.currentDemoStepData.value.examples.length, 4);
    f.select(3); // The last example must be accessible without completing others.
    assert.equal(f.sort.sortRootPath.value, ''); assert.equal(f.sort.sortFieldName.value, 'value.score');
    assert.equal(f.output.getValue(), ''); f.next();
    assert.deepEqual(Object.keys(JSON.parse(f.output.getValue())), ['D', 'E', 'A', 'C', 'B']);
    assert.equal(f.sort.currentDemoStepData.value.completed, true);
    f.select(0); assert.equal(f.sort.currentDemoStep.value, 0);
    assert.equal(f.sort.currentDemoStepData.value.completed, false); assert.equal(f.output.getValue(), '');
    assert.equal(f.sort.sortRootPath.value, ''); assert.equal(f.sort.sortFieldName.value, 'id');
    f.next(); assert.deepEqual(JSON.parse(f.output.getValue()).map(item => item.id), [1, 2, 3]);
    f.select(1); assert(Array.isArray(JSON.parse(f.input.getValue())));
    assert.equal(f.sort.sortRootPath.value, '[*].education'); assert.equal(f.sort.sortFieldName.value, 'graduationYear');
    f.next(); assert.deepEqual(JSON.parse(f.output.getValue())[1].education.map(item => item.graduationYear), [1983, 2003]);
    f.select(2); assert(!Array.isArray(JSON.parse(f.input.getValue())));
    assert.equal(f.sort.sortRootPath.value, ''); assert.equal(f.sort.sortFieldName.value, 'id');
    f.next(); assert.deepEqual(Object.keys(JSON.parse(f.output.getValue())), ['A', 'B', 'C', 'D', 'E']);
});

test('each example exposes localized goals, reasons and reuse hints beside its actual sort parameters', async t => {
    const f = fixture(t); await f.sort.showFieldSortDemo();
    const examples = [
        { key: 'ArrayId', root: '', field: 'id' },
        { key: 'ArrayEducation', root: '[*].education', field: 'graduationYear' },
        { key: 'MapId', root: '', field: 'id' },
        { key: 'MapScore', root: '', field: 'value.score' },
    ];
    for (const txt of [SETTINGS_TXT_ZH, SETTINGS_TXT_EN]) {
        f.settingsTxt.value = txt; await nextTick();
        for (const [index, example] of examples.entries()) {
            f.select(index);
            const step = f.sort.currentDemoStepData.value;
            assert.equal(step.goal, txt['demo' + example.key + 'Goal']);
            assert.equal(step.reason, txt['demo' + example.key + 'Reason']);
            assert.equal(step.transferHint, txt['demo' + example.key + 'TransferHint']);
            for (const value of [step.goal, step.reason, step.transferHint]) assert(value.trim().length > 0);
            assert.equal(f.sort.sortRootPath.value, example.root);
            assert.equal(f.sort.sortFieldName.value, example.field);
            assert(step.reason.includes(example.field), 'the explanation names the field that will actually be read');
            f.next();
            assert.equal(f.sort.currentDemoStepData.value.goal, step.goal);
            assert.equal(f.sort.currentDemoStepData.value.reason, step.reason);
        }
    }
    assert.notEqual(SETTINGS_TXT_ZH.demoArrayIdGoal, SETTINGS_TXT_EN.demoArrayIdGoal);
    f.select(3); f.next(); const result = f.output.getValue();
    f.settingsTxt.value = SETTINGS_TXT_ZH; await nextTick();
    assert.equal(f.sort.currentDemoStepData.value.reason, SETTINGS_TXT_ZH.demoMapScoreReason);
    assert.equal(f.sort.currentDemoStepData.value.transferHint, SETTINGS_TXT_ZH.demoMapScoreTransferHint);
    assert.equal(f.sort.currentDemoStepData.value.completed, true);
    assert.equal(f.output.getValue(), result, 'switching explanatory copy keeps the demonstrated result');
});

test('reselecting examples preserves the first snapshot and language changes keep the current result', async t => {
    const f = fixture(t), original = f.input.getModel(); await f.sort.showFieldSortDemo();
    f.select(2); f.next(); const result = f.output.getValue();
    f.settingsTxt.value = { ...f.settingsTxt.value, demoExamplesTitle: 'Field sorting examples' }; await nextTick();
    assert.equal(f.sort.currentDemoStepData.value.title, 'Field sorting examples');
    assert.equal(f.sort.currentDemoStep.value, 2); assert.equal(f.sort.currentDemoStepData.value.completed, true);
    assert.equal(f.output.getValue(), result);
    f.select(0); assert.equal(f.createdModels.length, 2);
    f.sort.endDemoMode(); assert.equal(f.input.getModel(), original);
});

test('close and scope disposal remove highlights and pending nextTick cannot resurrect them', async t => {
    const f = fixture(t); await f.sort.showFieldSortDemo(); await nextTick();
    assert(f.inputNode.classes.has('demo-highlight-target'));
    f.next(); f.scope.stop(); await nextTick();
    assert(!f.inputNode.classes.has('demo-highlight-target')); assert(!f.outputNode.classes.has('demo-highlight-target'));
    assert.equal(f.sort.demoGuideVisible.value, false); assert.equal(f.sort.demoPopoverAnchor.value, null);
    assert(f.createdModels.every(item => item.isDisposed()));
});

test('Diff demo returns to Diff only after the original normal-pane models and target are restored', async t => {
    const f = fixture(t, { diff: true }), original = f.output.getModel();
    f.sort.fieldSortTarget.value = 'diff-right'; await f.sort.showFieldSortDemo();
    assert.equal(f.isDiffMode.value, false); assert.equal(f.sort.fieldSortTarget.value, 'input');
    f.sort.endDemoMode();
    assert.equal(f.output.getModel(), original); assert.equal(f.sort.fieldSortTarget.value, 'diff-right');
    assert.equal(f.isDiffMode.value, true);
    assert.deepEqual(f.events, ['exit diff', 'start session', 'restore session', 'enter diff']);
});

test('disposing while exiting Diff prevents late demo startup or navigation', async t => {
    let resume; const exit = new Promise(resolve => { resume = resolve; });
    const f = fixture(t, { diff: true, exitDiffMode: () => exit });
    const pending = f.sort.showFieldSortDemo(); f.sort.dispose(); resume(); await pending; await nextTick();
    assert.equal(f.sort.isDemoMode.value, false); assert.equal(f.createdModels.length, 0);
    assert.deepEqual(f.events, ['exit diff']);
});

test('demo session disposes replacement models without disposing either retained user model', t => {
    const f = fixture(t), originalInput = f.input.getModel(), originalOutput = f.output.getModel();
    const temporary = [];
    const session = f.sessionFactory({ getInputEditor: () => f.input, getOutputEditor: () => f.output,
        createModel: (value, language) => { const next = model(value, language); temporary.push(next); return next; } });
    assert.equal(session.begin({ readOnly: false }), true);
    const replacement = model('new demo operation');
    f.input.getModel().dispose(); f.input.setModel(replacement);
    session.restore(); session.restore();
    assert.equal(f.input.getModel(), originalInput); assert.equal(f.output.getModel(), originalOutput);
    assert(temporary.every(item => item.isDisposed())); assert(replacement.isDisposed());
    assert(!originalInput.isDisposed()); assert(!originalOutput.isDisposed());
});

test('partially failed session creation releases temporary models and preserves originals', t => {
    const f = fixture(t), originals = [f.input.getModel(), f.output.getModel()], temporary = [];
    const session = f.sessionFactory({ getInputEditor: () => f.input, getOutputEditor: () => f.output,
        createModel: (value, language) => {
            if (temporary.length) throw new Error('model creation failed');
            const next = model(value, language); temporary.push(next); return next;
        } });
    assert.throws(() => session.begin(), /model creation failed/); assert.equal(session.active, false);
    assert(temporary.every(item => item.isDisposed()));
    assert.equal(f.input.getModel(), originals[0]); assert.equal(f.output.getModel(), originals[1]);
    assert(originals.every(item => !item.isDisposed()));
});

// Monaco disposes an implicitly-created model on the first setModel call.
// Workbench editors must supply an explicit model; this models that contract.
test('editor-owned model disposal rejects the demo and recovers the text instead of leaving an empty pane', t => {
    const f = fixture(t), initialInput = f.input.getModel(), initialOutput = f.output.getModel();
    const setModel = f.input.setModel;
    let owned = true;
    f.input.setModel = next => { const previous = f.input.getModel(); setModel(next); if (owned) { owned = false; previous.dispose(); } };
    const session = f.sessionFactory({ getInputEditor: () => f.input, getOutputEditor: () => f.output, createModel: model });
    assert.throws(() => session.begin(), /caller-owned editor models/);
    assert.equal(session.active, false);
    assert(initialInput.isDisposed());
    assert.equal(f.input.getValue(), '{"original":"input"}');
    assert.equal(f.input.getModel().isDisposed(), false);
    assert.equal(f.input.getRawOptions().readOnly, false);
    assert.equal(f.output.getModel(), initialOutput);
    assert.equal(f.output.getValue(), 'original: output');
    assert(!initialOutput.isDisposed());
});
