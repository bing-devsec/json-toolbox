import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { runInNewContext } from 'node:vm';

async function bundleComposable(path) {
    const result = await build({ entryPoints: [path], bundle: true, write: false, format: 'cjs', platform: 'node',
        plugins: [{ name: 'vue-watch-fixture', setup(builder) {
            builder.onResolve({ filter: /^vue$/ }, () => ({ path: 'vue', namespace: 'fixture' }));
            builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ loader: 'js', contents: `
                export const ref = value => ({ value });
                export const watch = (source, callback, options) => { watched.push({source, callback}); if(options?.immediate) callback(typeof source === 'function' ? source() : source.value); };
                export const nextTick = callback => Promise.resolve().then(callback);
            ` }));
        } }],
    });
    return result.outputFiles[0].text;
}
const settingsBundle = await bundleComposable('src/components/composables/useJsonToolSettingsDialog.ts');
const tabBundle = await bundleComposable('src/components/composables/useTabId.ts');
function evaluate(code, globals = {}) {
    const module = { exports: {} };
    runInNewContext(code, { module, exports: module.exports, watched: [], ...globals });
    return module.exports;
}

test('indent and array settings never parse editor text and retain empty-input fold reset', () => {
    const watched = [];
    let reads = 0, text = '{"value":9007199254740993}';
    const json = Object.create(JSON);
    json.parse = () => assert.fail('Changing settings must not parse the entire document');
    const { useJsonToolSettingsDialog } = evaluate(settingsBundle, { watched, JSON: json });
    const ctx = {
        indentSize: { value: 4 }, arrayNewLine: { value: true }, selectedLevel: { value: 3 },
        buttonVisibility: { value: { format: true, collapse: true, fullscreen: true } },
        getInputEditor: () => ({ getValue: () => { reads++; return text; } }),
    };
    useJsonToolSettingsDialog(ctx);
    const watcher = watched.find(({ source }) => Array.isArray(source) && source[0] === ctx.indentSize);
    assert(watcher);
    for (const value of ['{"value":9007199254740993}', '{not valid JSON', ' '.repeat(100)]) {
        text = value;
        reads = 0;
        ctx.selectedLevel.value = 3;
        watcher.callback();
        assert.equal(reads, 1);
        assert.equal(ctx.selectedLevel.value, value.trim() ? 3 : 0);
    }
});

function tabFixture() {
    const timers = [], messages = [], saved = new Map([['json-tool:tab-id', 'copied-tab']]);
    let channel;
    const { useTabId } = evaluate(tabBundle, {
        window: {}, crypto: { randomUUID: (() => { let count = 0; return () => `uuid-${++count}`; })() },
        sessionStorage: { getItem: key => saved.get(key), setItem: (key, value) => saved.set(key, value) },
        setTimeout: callback => { timers.push(callback); return timers.length; },
        BroadcastChannel: class {
            constructor() { channel = this; }
            addEventListener(_event, callback) { this.listener = callback; }
            removeEventListener() {} close() {}
            postMessage(message) { messages.push(message); }
        },
    });
    const api = useTabId();
    api.setupTabIdChannel();
    const conflict = () => channel.listener({ data: { type: 'alive', tabId: api.tabId.value, requesterInstanceId: api.runtimeInstanceId, responderInstanceId: 'other-tab' } });
    return { api, timers, messages, saved, conflict };
}

test('repeated tab identity checks share a single probe and rotate once', async () => {
    const { api, messages, timers, saved, conflict } = tabFixture();
    const first = api.ensureUniqueTabIdForThisPage();
    assert.equal(api.ensureUniqueTabIdForThisPage(), first);
    assert.equal(messages.length, 1);
    conflict();
    timers.shift()();
    await first;
    assert.notEqual(api.tabId.value, 'copied-tab');
    assert.equal(saved.get('json-tool:tab-id'), api.tabId.value);
    api.disposeTabIdChannel();
});

test('tab conflict results cannot rewrite storage after closing or channel disposal', async () => {
    for (const action of ['closing', 'dispose']) {
        const { api, timers, saved, conflict } = tabFixture();
        const pending = api.ensureUniqueTabIdForThisPage();
        conflict();
        if (action === 'closing') api.isTabPageClosing.value = true;
        else api.disposeTabIdChannel();
        timers.shift()();
        await pending;
        assert.equal(api.tabId.value, 'copied-tab');
        assert.equal(saved.get('json-tool:tab-id'), 'copied-tab');
    }
});
