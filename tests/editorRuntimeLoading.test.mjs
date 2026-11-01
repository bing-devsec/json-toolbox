import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { runInNewContext } from 'node:vm';

const runtimeBundle = await build({
    entryPoints: ['src/components/utils/monacoRuntime.ts'], bundle: true, write: false,
    platform: 'node', format: 'cjs', plugins: [{ name: 'runtime-boundary', setup(builder) {
        builder.onResolve({ filter: /monacoRuntimeImpl$/ }, () => ({ path: 'runtime', namespace: 'fixture' }));
        builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ loader: 'js', contents: `
            const runtime = readRuntimeFixture();
            export const monacoApi = runtime.api;
            export const createMonacoWorker = runtime.worker;
            export const optimizeLargeEditorLineMapping = runtime.optimize;
            export const clearEditorContent = runtime.clear;
        ` }));
    } }],
});

test('editor runtime loads once and publishes API and large-file helpers together', async () => {
    let loads = 0;
    const fixture = { api: { editor: {} }, worker: () => {}, optimize: () => {}, clear: () => {} };
    const module = { exports: {} };
    runInNewContext(runtimeBundle.outputFiles[0].text, { module, exports: module.exports,
        readRuntimeFixture: () => { loads++; return fixture; } });
    const api = module.exports;
    assert.equal(loads, 0, 'importing the shell boundary must not evaluate Monaco');
    assert.equal(api.monacoApi, undefined);
    const first = api.loadMonacoRuntime();
    assert.equal(api.loadMonacoRuntime(), first, 'preload and editor mount share one download');
    assert.equal(await first, fixture.api);
    assert.equal(api.monacoApi, fixture.api);
    assert.equal(api.createMonacoWorker, fixture.worker);
    assert.equal(api.optimizeLargeEditorLineMapping, fixture.optimize);
    assert.equal(api.clearEditorContent, fixture.clear);
    await api.loadMonacoRuntime();
    assert.equal(loads, 1);
});

const guideBundle = await build({
    entryPoints: ['src/components/composables/useJsonToolFirstUseGuide.ts'], bundle: true, write: false,
    platform: 'node', format: 'cjs', plugins: [{ name: 'vue-lifecycle', setup(builder) {
        builder.onResolve({ filter: /^vue$/ }, () => ({ path: 'vue', namespace: 'fixture' }));
        builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ loader: 'js', contents: `
            export const ref = value => ({value});
            export const computed = read => ({get value(){return read();}});
            export const onMounted = callback => callback();
            export const nextTick = callback => Promise.resolve().then(callback);
        ` }));
    } }],
});

test('first-use guidance is available during loading and dismissal survives editor readiness', () => {
    const storage = new Map();
    const module = { exports: {} };
    runInNewContext(guideBundle.outputFiles[0].text, { module, exports: module.exports,
        window: {localStorage: {getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value)}} });
    const ready = {value: false};
    const guide = module.exports.useJsonToolFirstUseGuide({locale: {value: 'zh'}, editorsInitialized: ready,
        isDiffMode: {value: false}, isInputDragActive: {value: false}, getInputEditor: () => null,
        showEditorNotInitError: () => {}, formatJson: () => {}});
    assert.equal(guide.shouldShowFirstUseGuide.value, true, 'guidance must not wait for the editor engine');
    guide.dismissFirstUseGuide();
    assert.equal(guide.shouldShowFirstUseGuide.value, false);
    ready.value = true;
    assert.equal(guide.shouldShowFirstUseGuide.value, false, 'editor readiness must not reopen a dismissed guide');
    assert.equal(storage.get('json-tool:first-use-guide-dismissed:v1'), '1');
});
