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

test('late web font completion refreshes glyph widths once without blocking editor readiness', async () => {
    let completeFont;
    const pendingFont = new Promise(resolve => { completeFont = resolve; });
    let fontLoads = 0;
    let measurements = 0;
    const fixture = { api: { editor: { remeasureFonts: () => { measurements++; } } } };
    const module = { exports: {} };
    runInNewContext(runtimeBundle.outputFiles[0].text, { module, exports: module.exports,
        readRuntimeFixture: () => fixture,
        document: { fonts: { load: font => {
            assert.equal(font, '12px "JetBrains Mono"');
            fontLoads++;
            return pendingFont;
        } } },
    });
    assert.equal(await module.exports.loadMonacoRuntime(), fixture.api);
    assert.equal(measurements, 0, 'editor is ready while the font is still downloading');
    completeFont([{}]);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(measurements, 1, 'late font must invalidate Monaco fallback metrics');
    await module.exports.loadMonacoRuntime();
    assert.equal(fontLoads, 1);
    assert.equal(measurements, 1);
});

test('failed or unavailable web fonts preserve the usable system-font editor', async () => {
    for (const fonts of [undefined, { load: () => Promise.reject(new Error('font offline')) }, { load: () => Promise.resolve([]) }]) {
        let measurements = 0;
        const fixture = { api: { editor: { remeasureFonts: () => { measurements++; } } } };
        const module = { exports: {} };
        runInNewContext(runtimeBundle.outputFiles[0].text, { module, exports: module.exports,
            readRuntimeFixture: () => fixture, document: { fonts },
        });
        assert.equal(await module.exports.loadMonacoRuntime(), fixture.api);
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(measurements, 0);
    }
});

const guideBundle = await build({
    entryPoints: ['src/components/composables/useJsonToolFirstUseGuide.ts'], bundle: true, write: false,
    platform: 'node', format: 'cjs', plugins: [{ name: 'vue-lifecycle', setup(builder) {
        builder.onResolve({ filter: /^vue$/ }, () => ({ path: 'vue', namespace: 'fixture' }));
        builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ loader: 'js', contents: `
            export const ref = value => ({value});
            export const shallowRef = ref;
            export const onBeforeUnmount = () => {};
            export const watch = () => {};
            export const computed = read => ({get value(){return read();}});
            export const onMounted = callback => callback();
            export const nextTick = callback => Promise.resolve().then(callback);
        ` }));
    } }],
});

test('first-use invitation waits for editor readiness and remembers dismissal across readiness changes', () => {
    const storage = new Map();
    const module = { exports: {} };
    runInNewContext(guideBundle.outputFiles[0].text, { module, exports: module.exports,
        localStorage: {getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value)} });
    const ready = {value: false};
    const guide = module.exports.useJsonToolFirstUseGuide({locale: {value: 'zh'}, editorsInitialized: ready,
        isDiffMode: {value: false}, isInputDragActive: {value: false}, unavailable: {value: false},
        beginDemo: () => false, restoreDemo: () => {}, prepareStep: () => {}, performStep: () => {}, getTarget: () => null});
    assert.equal(guide.shouldShowFirstUseGuide.value, false, 'an actionable invitation waits until the editor is ready');
    ready.value = true;
    assert.equal(guide.shouldShowFirstUseGuide.value, true);
    guide.dismissFirstUseGuide();
    assert.equal(guide.shouldShowFirstUseGuide.value, false);
    ready.value = false;
    assert.equal(guide.shouldShowFirstUseGuide.value, false);
    ready.value = true;
    assert.equal(guide.shouldShowFirstUseGuide.value, false, 'editor readiness must not reopen a dismissed guide');
    assert.equal(storage.get('json-tool:first-use-guide-dismissed:v1'), '1');
});
