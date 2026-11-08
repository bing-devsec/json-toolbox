import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { transform } from 'esbuild';
import { runInNewContext } from 'node:vm';

// Execute the real workbench lifecycle and mode state machine, not a mirrored implementation.
const workbench = readFileSync('src/components/JsonToolWorkbench.vue', 'utf8');
const mode = readFileSync('src/components/composables/useDiffMode.ts', 'utf8').replace(/^import[\s\S]*?;\n/gm, '');
const lifecycle = workbench.slice(workbench.indexOf('const getOutputEditorLanguage ='), workbench.indexOf('// ==================== Diff 模式 composable'));
const state = workbench.slice(workbench.indexOf('let normalModeInputSnapshot ='), workbench.indexOf('// ==================== Tab/Storage'));
const code = (await transform(`${mode}\n${state}\n${lifecycle}\n
const diffMode = useDiffMode({ isFullscreen: ref(false), isTabPageClosing, cacheNormalEditorsState, destroyNormalEditors, restoreNormalEditors });
globalThis.api = { diffMode, cacheNormalEditorsState, restoreNormalEditors,
    snapshots: () => [normalModeInputSnapshot, normalModeOutputSnapshot],
    editors: () => [inputEditor, outputEditor],
};`, { loader: 'ts', format: 'cjs' })).code;
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
function fixture(localeTransitionState) {
    const hooks = [], loads = [], ticks = [], calls = { creates: 0, views: 0 };
    const ref = value => ({ value });
    const editor = text => ({ text, getValue() { return this.text; }, saveViewState: () => ({ position: 3 }), restoreViewState() { calls.views++; } });
    const context = {
        module: { exports: {} }, ref, watch() {}, onMounted() {}, onBeforeUnmount: fn => hooks.push(fn), localeTransitionState,
        inputEditor: editor('IMPORTANT INPUT'), outputEditor: editor('IMPORTANT OUTPUT'),
        inputEditorResizeObserver: null, inputEditorTextareaAttrObserver: null, outputEditorResizeObserver: null, outputEditorTextareaAttrObserver: null, inputMarkersListener: null,
        inputEditorContainer: ref({}), outputEditorContainer: ref({}), editorsInitialized: ref(true), inputEditorErrors: ref([]), currentErrorIndex: ref(-1), inputEditorStatus: ref(''), outputEditorStatus: ref(''), outputType: ref('yaml'), isTabPageClosing: ref(false),
        repair: { cancel() {} }, cancelPendingLevelAnalysis() {}, detectInputLanguage: () => 'json',
        loadMonacoLanguageContribution() { const d = deferred(); loads.push(d); return d.promise; },
        nextTick(fn) { if (fn) { ticks.push(fn); return Promise.resolve(); } const d = deferred(); ticks.push(d); return d.promise; },
        disposeInputEditorWithModel() { context.inputEditor = null; }, disposeOutputEditorWithModel() { context.outputEditor = null; },
        createInputEditor() { calls.creates++; context.inputEditor = editor(''); }, createOutputEditor() { calls.creates++; context.outputEditor = editor(''); },
        setInputEditorValue(value) { context.inputEditor.text = value; }, setOutputEditorValue(value) { context.outputEditor.text = value; void context.loadMonacoLanguageContribution().catch(() => {}); },
        useDiffEditors: () => new Proxy({ diffDraftLeftText: ref(''), diffDraftRightText: ref(''), diffCount: ref(0), activeDiffIndex: ref(0) }, { get: (target, key) => target[key] ?? (() => {}) }),
    };
    for (const name of ['configureInputEditor', 'configureOutputEditor', 'initializeEditorLayout', 'setupResizeObservers', 'refreshInputEditorErrors', 'updateLineNumberWidth', 'updateEditorHeight', 'refreshEditorStatus']) context[name] = () => {};
    runInNewContext(code, context);
    return { ...context.api, context, calls, loads, ticks, hooks, async languages(start = 0, fail = false) { loads.slice(start).forEach(d => fail ? d.reject(Error('offline')) : d.resolve()); await flush(); }, async tick() { while (ticks.length) { const item = ticks.shift(); if (typeof item === 'function') item(); else item?.resolve(); } await flush(); } };
}

test('rapid enter/exit before Vue mounts preserves both normal snapshots', async () => {
    const f = fixture(); f.diffMode.enterDiffMode(); const first = f.diffMode.exitDiffMode();
    f.diffMode.enterDiffMode();
    assert.deepEqual(Array.from(f.snapshots()), ['IMPORTANT INPUT', 'IMPORTANT OUTPUT']);
    await f.languages(); await f.tick(); await first;
    const second = f.diffMode.exitDiffMode(); await f.languages(2); await f.tick(); await second;
    assert.deepEqual(Array.from(f.editors(), e => e.getValue()), ['IMPORTANT INPUT', 'IMPORTANT OUTPUT']);
});

test('only newest restoration may create editors across several toggles', async () => {
    const f = fixture(); f.diffMode.enterDiffMode(); const old = f.diffMode.exitDiffMode();
    f.diffMode.enterDiffMode(); const current = f.diffMode.exitDiffMode();
    await f.languages(2); await f.tick(); await current;
    f.context.inputEditor.text = 'NEW EDIT';
    await f.languages(0); await f.tick(); await old;
    assert.equal(f.calls.creates, 2); assert.equal(f.context.inputEditor.text, 'NEW EDIT');
});

test('re-entering during nextTick prevents stale normal editor creation', async () => {
    const f = fixture(); f.diffMode.enterDiffMode(); const restore = f.diffMode.exitDiffMode();
    await f.languages(); f.diffMode.enterDiffMode(); await f.tick(); await restore;
    assert.equal(f.calls.creates, 0);
});

test('text restores without waiting for optional highlighting; failed highlighting permits retry', async () => {
    const f = fixture(); f.diffMode.enterDiffMode(); let restore = f.diffMode.exitDiffMode();
    await f.tick(); await restore;
    assert.equal(f.loads.length, 1);
    assert.equal(f.context.outputEditor.text, 'IMPORTANT OUTPUT');
    await f.languages(0, true);
    f.diffMode.enterDiffMode(); restore = f.diffMode.exitDiffMode(); await f.tick(); await restore; await f.languages(1);
    assert.equal(f.context.inputEditor.text, 'IMPORTANT INPUT');
});

test('locale capture while restoring retains snapshots; unload during nextTick never recreates editors', async () => {
    const f = fixture(); f.diffMode.enterDiffMode(); const restore = f.diffMode.exitDiffMode();
    f.cacheNormalEditorsState(); assert.deepEqual(Array.from(f.snapshots()), ['IMPORTANT INPUT', 'IMPORTANT OUTPUT']);
    await f.languages(); f.context.isTabPageClosing.value = true; f.hooks.forEach(fn => fn()); await f.tick(); await restore;
    assert.equal(f.calls.creates, 0);
});

test('unmount alone invalidates pending language loads and deferred view restoration', async () => {
    const f = fixture(); f.diffMode.enterDiffMode(); const restore = f.diffMode.exitDiffMode();
    f.hooks.forEach(fn => fn()); await f.languages(); await f.tick(); await restore;
    assert.equal(f.calls.creates, 0);
    const g = fixture(); g.diffMode.enterDiffMode(); const ready = g.diffMode.exitDiffMode();
    await g.languages(); await g.tick(); await ready;
    g.diffMode.enterDiffMode(); await g.tick(); assert.equal(g.calls.views, 0);
});

test('real empty editor values replace snapshots while detached extension editors retain the cached text', async () => {
    const f = fixture(); f.context.inputEditor.text = ''; f.context.outputEditor.text = '';
    f.diffMode.enterDiffMode(); assert.deepEqual(Array.from(f.snapshots()), ['', '']);
    const g = fixture(); g.cacheNormalEditorsState();
    g.context.inputEditor = g.context.outputEditor = null; g.cacheNormalEditorsState();
    const restore = g.restoreNormalEditors(); await g.languages(); await g.tick(); await restore;
    assert.deepEqual(Array.from(g.editors(), e => e.text), ['IMPORTANT INPUT', 'IMPORTANT OUTPUT']);
});
