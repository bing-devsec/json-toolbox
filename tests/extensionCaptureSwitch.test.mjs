import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';
import { parse, compileScript } from '@vue/compiler-sfc';

const descriptor = parse(await readFile('src/components/JsonResponseCaptureSwitch.vue', 'utf8')).descriptor;
const script = compileScript(descriptor, { id: 'capture-switch-regression' }).content;
const bundle = await build({
    stdin: { contents: script, resolveDir: process.cwd(), loader: 'ts' },
    platform: 'node', format: 'cjs', bundle: true, write: false,
    plugins: [{ name: 'capture-switch-lifecycle', setup(builder) {
        builder.onResolve({ filter: /^vue$/ }, () => ({ path: 'vue', namespace: 'capture-switch' }));
        builder.onResolve({ filter: /^element-plus/ }, () => ({ path: 'ui', namespace: 'capture-switch' }));
        builder.onResolve({ filter: /extension\/captureClient$/ }, () => ({ path: 'client', namespace: 'capture-switch' }));
        builder.onLoad({ filter: /.*/, namespace: 'capture-switch' }, args => ({ contents: args.path === 'vue' ? `
            const hooks = globalThis.captureSwitchHooks;
            export const defineComponent = value => value;
            export const computed = get => ({ get value() { return get(); } });
            export const ref = value => ({ value });
            export const useId = () => 'test-capture-switch';
            export const onMounted = callback => { hooks.mounted = callback; };
            export const onBeforeUnmount = callback => { hooks.unmounted = callback; };
        ` : args.path === 'ui' ? 'export const ElSwitch = {};' : `
            const hooks = globalThis.captureSwitchHooks;
            export const isCaptureAvailable = () => hooks.available !== false;
            export const captureErrorMessage = (error, locale) => locale + ': ' + error.message;
            export const getCaptureStatus = () => hooks.getStatus();
            export const setCaptureEnabled = enabled => hooks.setEnabled(enabled);
        ` }));
    } }],
});
const state = enabled => ({ enabled, origins: ['http://*/*', 'https://*/*'], limitBytes: 20 * 1024 * 1024, maxChunkChars: 65536 });
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
function setup(hooks, props = { locale: 'zh' }) {
    const module = { exports: {} };
    runInNewContext(bundle.outputFiles[0].text, { module, exports: module.exports, captureSwitchHooks: hooks });
    return module.exports.default.setup(props, { expose() {} });
}

test('switch starts on, stays disabled while reading persisted status and never enables capture merely by opening settings', async () => {
    const pending = deferred(); const writes = [];
    const hooks = { getStatus: () => pending.promise, setEnabled: value => { writes.push(value); } };
    const component = setup(hooks);
    assert.equal(component.enabled.value, true); assert.equal(component.busy.value, true);
    const mounting = hooks.mounted(); await component.change(false);
    assert.deepEqual(writes, []);
    pending.resolve(state(true)); await mounting;
    assert.equal(component.enabled.value, true); assert.equal(component.busy.value, false); assert.deepEqual(writes, []);
});

test('a previously disabled preference is restored without writing a default on value', async () => {
    let reads = 0; const writes = []; const props = { locale: 'zh' };
    const hooks = { getStatus: async () => { reads++; return state(false); }, setEnabled: value => writes.push(value) };
    const component = setup(hooks, props); await hooks.mounted();
    assert.equal(component.enabled.value, false); assert.equal(component.confirmedEnabled.value, false);
    assert.deepEqual(writes, []); assert.equal(reads, 1);
    assert.equal(component.txt.value.title, '自动打开 JSON 响应'); props.locale = 'en';
    assert.equal(component.txt.value.title, 'Automatically open JSON responses');
    assert.deepEqual(writes, []); assert.equal(reads, 1);
});

test('changing the switch writes one boolean at a time and commits only the returned backend state', async () => {
    const pending = deferred(); const writes = [];
    const hooks = { getStatus: async () => state(true), setEnabled: value => { writes.push(value); return pending.promise; } };
    const component = setup(hooks); await hooks.mounted();
    const disabling = component.change(false); await component.change(true); await component.change(false);
    assert.deepEqual(writes, [false]); assert.equal(component.busy.value, true);
    assert.equal(component.enabled.value, false); assert.equal(component.confirmedEnabled.value, true);
    pending.resolve(state(false)); await disabling;
    assert.equal(component.confirmedEnabled.value, false); assert.equal(component.busy.value, false);
    hooks.setEnabled = async value => { writes.push(value); return state(value); };
    await component.change(true); assert.deepEqual(writes, [false, true]);
    assert.equal(component.enabled.value, true); assert.equal(component.confirmedEnabled.value, true);
});

test('failed saves restore the confirmed state and keep an actionable localized error', async () => {
    const props = { locale: 'zh' }; let reads = 0;
    const hooks = { getStatus: async () => { reads++; return state(true); }, setEnabled: async () => { throw new Error('storage busy'); } };
    const component = setup(hooks, props); await hooks.mounted(); await component.change(false);
    assert.equal(component.enabled.value, true); assert.equal(component.confirmedEnabled.value, true);
    assert.equal(component.busy.value, false); assert.equal(component.errorMessage.value, 'zh: storage busy');
    assert.equal(reads, 2); props.locale = 'en'; assert.equal(component.errorMessage.value, 'en: storage busy');
});

test('failed status refresh after a save failure does not replace the last confirmed value', async () => {
    let reads = 0;
    const hooks = { getStatus: async () => { if (reads++) throw new Error('offline'); return state(false); }, setEnabled: async () => { throw new Error('save failed'); } };
    const component = setup(hooks); await hooks.mounted(); await component.change(true);
    assert.equal(component.enabled.value, false); assert.equal(component.confirmedEnabled.value, false);
    assert.equal(component.errorMessage.value, 'zh: save failed'); assert.equal(component.busy.value, false);
});

test('a status response after unmount cannot change the closed switch or show late errors', async () => {
    const pending = deferred();
    const hooks = { getStatus: () => pending.promise, setEnabled: async value => state(value) };
    const component = setup(hooks); const mounting = hooks.mounted(); hooks.unmounted();
    pending.resolve(state(false)); await mounting;
    assert.equal(component.enabled.value, true); assert.equal(component.confirmedEnabled.value, true);
    assert.equal(component.errorMessage.value, '');
});

test('save completion after unmount is ignored and cannot launch another operation', async () => {
    const pending = deferred(); const writes = [];
    const hooks = { getStatus: async () => state(true), setEnabled: value => { writes.push(value); return pending.promise; } };
    const component = setup(hooks); await hooks.mounted(); const saving = component.change(false); hooks.unmounted();
    pending.resolve(state(false)); await saving; await component.change(true);
    assert.equal(component.confirmedEnabled.value, true); assert.equal(component.errorMessage.value, ''); assert.deepEqual(writes, [false]);
});

test('ordinary browser previews keep the switch unavailable without sending extension messages', async () => {
    let calls = 0;
    const hooks = { available: false, getStatus: async () => { calls++; return state(true); }, setEnabled: async value => { calls++; return state(value); } };
    const component = setup(hooks); await hooks.mounted(); await component.change(false);
    assert.equal(component.available, false); assert.equal(component.enabled.value, true); assert.equal(calls, 0);
    assert.match(component.txt.value.unavailable, /本地编辑/);
});

test('response capture remains scoped to general settings while editor display preferences are separated', async () => {
    const dialog = parse(await readFile('src/components/SettingsDialog.vue', 'utf8')).descriptor;
    const template = dialog.template.content;
    assert.doesNotMatch(template, /name="capture"|name="toolbar"|ExtensionCaptureSettings/);
    const generalStart = template.indexOf('name="settings"');
    const generalEnd = template.indexOf('</el-collapse-item>', generalStart);
    const general = template.slice(generalStart, generalEnd);
    assert.equal((template.match(/<JsonResponseCaptureSwitch/g) ?? []).length, 1);
    assert.match(general, /<JsonResponseCaptureSwitch v-if="visible && activeName === 'settings'"/);
    assert.match(general, /v-model="buttonVisibilityModel.compress"/);
    assert.doesNotMatch(general, /v-model="showMinimapModel"/);
    const editorStart = template.indexOf('name="editor"');
    const editorEnd = template.indexOf('</el-collapse-item>', editorStart);
    assert.match(template.slice(editorStart, editorEnd), /v-model="showMinimapModel"/);
    assert.match(descriptor.template.content, /:disabled="!available \|\| busy"/);
    assert.match(descriptor.template.content, /aria-labelledby/);
});
