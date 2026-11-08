import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { runInNewContext } from 'node:vm';

const bundled = await build({
    stdin: { contents: `
        export { useDiffEditors } from './src/components/composables/useDiffEditors';
        export { createDiffDrafts } from './src/components/utils/diffDrafts';
        export { createDiffEditorState } from './src/components/utils/diffEditorState';
        export { hooks } from 'vue';
        export { io } from './src/components/utils/idb';
    `, resolveDir: process.cwd(), loader: 'ts' },
    bundle: true, write: false, format: 'cjs', platform: 'node',
    plugins: [{ name: 'diff-fixtures', setup(build) {
        build.onResolve({ filter: /^vue$/ }, () => ({ path: 'vue', namespace: 'fixture' }));
        build.onResolve({ filter: /(?:^|\/)idb$/ }, () => ({ path: 'idb', namespace: 'fixture' }));
        build.onResolve({ filter: /diffEditorRuntime$/ }, () => ({ path: 'runtime', namespace: 'fixture' }));
        build.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => ({ contents: path === 'vue' ? `
            export const hooks = [];
            export const ref = value => ({ value });
            export const onBeforeUnmount = callback => hooks.push(callback);
        ` : path === 'idb' ? `
            export const io = { read: async () => undefined, writes: [], count: 0 };
            export const idbGet = (...args) => io.read(...args);
            export const idbPut = async (store, record) => { io.writes.push(record); };
            export const idbCount = async () => io.count;
            export const IDB_STORE_DIFF_DRAFTS = 'drafts', MAX_DIFF_SIDE_SIZE = 30 * 1024 * 1024, MAX_DIFF_TAB_COUNT = 10;
        ` : 'export const createDiffEditorRuntime = () => { throw Error("Unexpected default runtime load"); };' }));
    } }],
});
function fixture() {
    const module = { exports: {} };
    runInNewContext(bundled.outputFiles[0].text, { module, exports: module.exports, window: {}, TextEncoder, console });
    return module.exports;
}
const deferred = () => {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
};
const fakeRuntimeModule = (calls) => ({ createDiffEditorRuntime(opts, state, drafts) {
    calls.factories++;
    calls.locale = opts.localeState;
    let left = null, right = null;
    const noOp = () => {};
    return {
        ...state,
        createDiffEditor() { if (!left) { calls.creates++; left = {}; right = {}; } },
        destroyDiffEditor() { calls.destroys++; left = right = null; },
        getDiffLeftEditor: () => left, getDiffRightEditor: () => right,
        getDiffSideEditor: side => side === 'left' ? left : right,
        isDiffEditorReady: () => Boolean(left && right),
        restoreDiffDraftIntoEditors: async () => {},
        cancelComparison: noOp, scheduleDiffEditorLayout: noOp, scheduleDiffRecompute: noOp,
        recomputeDiff: noOp, updateDiffSyncButtons: noOp, goToNextDiff: noOp, goToPrevDiff: noOp,
        revealDiffChange: noOp, handleDiffSync: noOp, updateDiffEditorOptions: noOp, layoutDiffEditors: noOp,
    };
} });
const options = (extra = {}) => ({ tabId: { value: 'tab' }, onError: error => { throw Error(error); }, ...extra });
const counters = () => ({ loads: 0, factories: 0, creates: 0, destroys: 0 });

test('normal-mode state, context-menu drafts and settings do not load Diff rendering', async () => {
    const api = fixture(), calls = counters();
    const facade = api.useDiffEditors(options(), async () => { calls.loads++; return fakeRuntimeModule(calls); });
    const count = facade.diffCount, left = facade.diffDraftLeftText;
    facade.diffDraftLeftText.value = 'sent from normal editor';
    await facade.saveDiffDraft('normal send');
    facade.scheduleDiffEditorLayout(); facade.scheduleDiffRecompute(); facade.updateDiffEditorOptions({ fontSize: 14 });
    assert.equal(calls.loads, 0);
    assert.equal(api.io.writes[0].leftText, 'sent from normal editor');
    assert.equal(facade.getDiffLeftEditor(), null);
    await facade.createDiffEditor();
    assert.equal(calls.loads, 1);
    assert.equal(facade.diffCount, count); assert.equal(facade.diffDraftLeftText, left);
    facade.destroyDiffEditor();
    assert.equal(facade.getDiffLeftEditor(), null);
    await facade.createDiffEditor();
    assert.equal(calls.loads, 1); assert.equal(calls.creates, 2);
    api.hooks.forEach(hook => hook());
    assert.equal(facade.getDiffRightEditor(), null);
});

test('late runtime loads cannot create editors after exit or unmount; re-entry reuses download', async () => {
    for (const unmount of [false, true]) {
        const api = fixture(), waiting = deferred(), calls = counters();
        const facade = api.useDiffEditors(options(), () => { calls.loads++; return waiting.promise; });
        const first = facade.createDiffEditor();
        if (unmount) api.hooks.forEach(hook => hook()); else facade.destroyDiffEditor();
        waiting.resolve(fakeRuntimeModule(calls));
        await first;
        assert.equal(calls.creates, 0);
        await facade.createDiffEditor();
        assert.equal(calls.creates, unmount ? 0 : 1);
        assert.equal(calls.loads, 1);
    }
});

test('failed imports retry and failures from exited generations are ignored', async () => {
    const api = fixture(), calls = counters(), first = deferred();
    const facade = api.useDiffEditors(options(), () => ++calls.loads === 1 ? first.promise : Promise.resolve(fakeRuntimeModule(calls)));
    const obsolete = facade.createDiffEditor();
    facade.destroyDiffEditor();
    first.reject(Error('old network failure'));
    await obsolete;
    await facade.createDiffEditor();
    assert.equal(calls.loads, 2); assert.equal(calls.creates, 1);
    const fresh = api.useDiffEditors(options(), async () => { throw Error('current failure'); });
    await assert.rejects(fresh.createDiffEditor(), /current failure/);
});

test('locale handoff retains texts and view-state references across lazy initialization', async () => {
    const api = fixture(), calls = counters();
    const localeState = { left: { text: '中文', viewState: { top: 10 } }, right: { text: 'English', viewState: { top: 20 } }, activeDiffIndex: 3 };
    const facade = api.useDiffEditors(options({ localeState }), async () => fakeRuntimeModule(calls));
    assert.equal(facade.diffDraftLeftText.value, '中文'); assert.equal(facade.diffDraftRightText.value, 'English');
    await facade.createDiffEditor();
    assert.equal(calls.locale, localeState);
});

function model(text) {
    return { text, version: 1, disposed: false,
        getVersionId() { return this.version; }, isDisposed() { return this.disposed; },
        setValue(value) { this.text = value; this.version++; },
    };
}
function editor(text) {
    const m = model(text);
    return { model: m, getModel() { return this.model; }, getValue() { return this.model.text; } };
}

test('draft restore never overwrites edits, replaced editors, exited generations, new drafts or disposed views', async () => {
    for (const change of ['edit', 'replace', 'exit', 'draft', 'dispose', 'tab', 'model', 'model-disposed']) {
        const api = fixture(), waiting = deferred(); api.io.read = () => waiting.promise;
        const state = api.createDiffEditorState(); let editors = [editor('left'), editor('right')];
        const opts = options({ getEditors: () => editors });
        const drafts = api.createDiffDrafts(state, opts);
        const request = drafts.restoreDiffDraftIntoEditors();
        if (change === 'edit') editors[0].model.setValue('typed');
        if (change === 'replace') editors = [editor('replacement'), editor('replacement')];
        if (change === 'exit') drafts.invalidate();
        if (change === 'draft') state.diffDraftLeftText.value = 'new draft';
        if (change === 'dispose') drafts.dispose();
        if (change === 'tab') opts.tabId.value = 'other';
        if (change === 'model') editors[0].model = model('replacement');
        if (change === 'model-disposed') editors[0].model.disposed = true;
        waiting.resolve({ leftText: 'stale', rightText: 'stale' });
        await request;
        assert.notEqual(editors[0].model.text, 'stale', change);
        assert.notEqual(state.diffDraftLeftText.value, 'stale', change);
    }
});

test('valid restores apply both sides and stale snapshot reads preserve a new normal-mode send', async () => {
    const api = fixture(), state = api.createDiffEditorState(), editors = [editor(''), editor('')];
    const drafts = api.createDiffDrafts(state, options({ getEditors: () => editors }));
    api.io.read = async () => ({ leftText: 'saved left', rightText: 'saved right' });
    await drafts.restoreDiffDraftIntoEditors();
    assert.equal(editors[0].model.text, 'saved left'); assert.equal(editors[1].model.text, 'saved right');
    const waiting = deferred(); api.io.read = () => waiting.promise;
    const request = drafts.loadDiffDraftSnapshot();
    state.diffDraftLeftText.value = 'new send';
    waiting.resolve({ leftText: 'old saved', rightText: 'old saved' }); await request;
    assert.equal(state.diffDraftLeftText.value, 'new send');
});

test('production-style split graph keeps rendering and its engine outside the eager facade', async () => {
    const result = await build({
        entryPoints: ['src/components/composables/useDiffEditors.ts'],
        bundle: true, splitting: true, format: 'esm', platform: 'browser', packages: 'external',
        outdir: '/tmp/json-diff-graph-fixture', write: false, metafile: true,
    });
    const outputs = result.metafile.outputs;
    const entry = Object.keys(outputs).find(key => outputs[key].entryPoint?.endsWith('/useDiffEditors.ts'));
    assert.ok(entry);
    const visited = new Set();
    const visit = key => {
        if (visited.has(key)) return;
        visited.add(key);
        for (const item of outputs[key]?.imports ?? []) if (!item.external && item.kind !== 'dynamic-import') visit(item.path);
    };
    visit(entry);
    const eagerInputs = [...visited].flatMap(key => Object.keys(outputs[key]?.inputs ?? {}));
    assert.ok(eagerInputs.some(key => key.endsWith('/diffDrafts.ts')));
    assert.ok(!eagerInputs.some(key => /diffEditorRuntime|diffEngine|diffMonaco/.test(key)), eagerInputs.join('\n'));
    assert.ok(Object.values(outputs).some(output => output.entryPoint?.endsWith('/diffEditorRuntime.ts')));
});
