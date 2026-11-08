import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { patchMonacoJsonDiagnostics, monacoJsonDiagnosticsPlugin, verifyMonacoDiagnosticsWorkerContract } from '../scripts/vite/monaco-json-diagnostics.mjs';
import { pruneUnusedJsonModeTypes } from '../scripts/vite/monaco-json-mode-types.mjs';
import ts from 'typescript';
const mode = readFileSync(process.cwd() + '/node_modules/monaco-editor/esm/vs/language/json/jsonMode.js', 'utf8');
const modeId = '/node_modules/monaco-editor/esm/vs/language/json/jsonMode.js';
const pruned = pruneUnusedJsonModeTypes(mode, modeId);
const patched = patchMonacoJsonDiagnostics(pruned, modeId);
const source = patched.slice(patched.indexOf('var DiagnosticsAdapter = class {'), patched.indexOf('\nfunction toSeverity(', patched.indexOf('var DiagnosticsAdapter = class {')));
const native = mode.slice(mode.indexOf('var DiagnosticsAdapter = class {'), mode.indexOf('\nfunction toSeverity(', mode.indexOf('var DiagnosticsAdapter = class {')));
const tick = async () => { for (let i = 0; i < 15; i++)
    await Promise.resolve(); };
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
function event() { const listeners = new Set(); return { listen: fn => { listeners.add(fn); return { dispose: () => listeners.delete(fn) }; }, fire: x => { for (const fn of [...listeners])
        fn(x); } }; }
function shell(adapterSource = source, count = 1, holdProxy = false) {
    const events = { created: event(), removed: event(), language: event(), config: event() };
    const models = new Map(), markers = [], calls = [], errors = [], proxyRequests = [], proxies = new Map(), timers = new Map();
    let timer = 0, workerGeneration = 0;
    const window = { setTimeout: fn => { timers.set(++timer, fn); return timer; }, clearTimeout: id => timers.delete(id) };
    function makeModel(key = 'm' + models.size) { const changes = event(); let version = 1, language = 'json'; const model = { uri: { toString: () => key }, getVersionId: () => version, getLanguageId: () => language, onDidChangeContent: changes.listen, edit: () => { version++; changes.fire(); }, language: lang => { language = lang; events.language.fire({ model }); } }; models.set(key, model); return model; }
    for (let i = 0; i < count; i++)
        makeModel('m' + i);
    const editor = { getModels: () => [...models.values()], getModel: uri => models.get(uri.toString()), setModelMarkers: (model, language, values) => markers.push({ model, language, values }), onDidCreateModel: events.created.listen, onWillDisposeModel: events.removed.listen, onDidChangeModelLanguage: events.language.listen };
    const getProxy = resource => { const generation = workerGeneration; let worker = proxies.get(generation); if (!worker) {
        worker = { doValidation: uri => { const d = deferred(); calls.push({ uri, generation, version: models.get(uri)?.getVersionId(), ...d }); return d.promise; } };
        proxies.set(generation, worker);
    } if (!holdProxy)
        return Promise.resolve(worker); const d = deferred(); proxyRequests.push({ ...d, worker, resource }); return d.promise; };
    const Adapter = new Function('window', 'monaco_editor_core_exports', 'toDiagnostics', 'console', adapterSource + ';return DiagnosticsAdapter;')(window, { editor }, (_uri, d) => d, { error: e => errors.push(e) });
    const adapter = new Adapter('json', getProxy, events.config.listen);
    return { adapter, models, markers, calls, errors, timers, proxyRequests, flush: () => { const ready = [...timers.values()]; timers.clear(); ready.forEach(fn => fn()); }, edit: (key = 'm0') => models.get(key).edit(), remove: (key = 'm0') => { const model = models.get(key); models.delete(key); events.removed.fire(model); return model; }, recreate: (key = 'm0') => { const model = makeModel(key); events.created.fire(model); return model; }, config: () => { workerGeneration++; events.config.fire(); }, idleStop: () => { workerGeneration++; } };
}
const published = s => s.markers.filter(x => x.values.length);
test('baseline: installed adapter queues 11 validations and publishes stale result', async () => { const s = shell(native); await tick(); for (let i = 0; i < 10; i++) {
    s.edit();
    s.flush();
    await tick();
} assert.equal(s.calls.length, 11); s.calls[0].resolve([{ message: 'v1' }]); await tick(); assert.equal(published(s).length, 1); s.adapter.dispose(); });
test('patched: 10 debounce windows coalesce into exactly one latest follow-up', async () => { const s = shell(); await tick(); for (let i = 0; i < 10; i++) {
    s.edit();
    s.flush();
    await tick();
} assert.equal(s.calls.length, 1); s.calls[0].resolve([{ message: 'v1' }]); await tick(); assert.equal(published(s).length, 0); assert.equal(s.calls.length, 2); assert.equal(s.calls[1].version, 11); s.calls[1].resolve([{ message: 'v11' }]); await tick(); assert.deepEqual(published(s).map(x => x.values[0].message), ['v11']); s.adapter.dispose(); });
test('new edit after queue readiness restarts normal debounce', async () => { const s = shell(); await tick(); s.edit(); s.flush(); await tick(); s.edit(); s.calls[0].resolve([]); await tick(); assert.equal(s.calls.length, 1); assert.equal(s.timers.size, 1); s.flush(); await tick(); assert.equal(s.calls.length, 2); s.adapter.dispose(); });
test('stale proxy acquisition skips obsolete validation call', async () => { const s = shell(source, 1, true); await tick(); s.edit(); s.flush(); await tick(); assert.equal(s.proxyRequests.length, 2); s.proxyRequests[0].resolve(s.proxyRequests[0].worker); await tick(); assert.equal(s.calls.length, 0); assert.equal(s.proxyRequests.length, 2); s.proxyRequests[1].resolve(s.proxyRequests[1].worker); await tick(); assert.equal(s.calls.length, 1); assert.equal(s.calls[0].version, 2); s.adapter.dispose(); });
test('independent models can each retain one live request', async () => { const s = shell(source, 2); await tick(); for (let i = 0; i < 3; i++) {
    s.edit('m0');
    s.edit('m1');
    s.flush();
    await tick();
} assert.equal(s.calls.length, 2); s.calls[0].resolve([]); await tick(); assert.equal(s.calls.length, 3); assert.equal(s.calls[2].uri, 'm0'); s.adapter.dispose(); });
test('rejected RPC releases slot and validates latest content', async () => { const s = shell(); await tick(); s.edit(); s.flush(); s.calls[0].reject(new Error('old failed')); await tick(); assert.equal(s.calls.length, 2); s.calls[1].resolve([{ message: 'current' }]); await tick(); assert.equal(published(s).length, 1); s.adapter.dispose(); });
test('current RPC failure does not permanently block future edits', async () => { const s = shell(); await tick(); s.calls[0].reject(new Error('failed')); await tick(); assert.equal(s.errors.length, 1); s.edit(); s.flush(); await tick(); assert.equal(s.calls.length, 2); s.adapter.dispose(); });
test('dispose clears timers and ignores pending completions', async () => { const s = shell(); await tick(); s.edit(); assert.equal(s.timers.size, 1); s.adapter.dispose(); assert.equal(s.timers.size, 0); s.calls[0].resolve([{ message: 'old' }]); await tick(); assert.equal(published(s).length, 0); assert.equal(s.calls.length, 1); });
test('model removal clears timers and ignores old completion', async () => { const s = shell(); await tick(); s.edit(); s.remove(); assert.equal(s.timers.size, 0); s.calls[0].resolve([{ message: 'old' }]); await tick(); assert.equal(published(s).length, 0); assert.equal(s.adapter._states.size, 0); s.adapter.dispose(); });
test('same URI recreation starts a new model lifecycle and publishes only new model', async () => { const s = shell(); await tick(); const old = s.remove(); const replacement = s.recreate(); await tick(); assert.equal(s.calls.length, 2); s.calls[0].resolve([{ message: 'old' }]); await tick(); assert.equal(s.calls.length, 2); assert.equal(published(s).length, 0); s.calls[1].resolve([{ message: 'new' }]); await tick(); assert.equal(published(s)[0].model, replacement); assert.notEqual(old, replacement); s.adapter.dispose(); });
test('language change suppresses JSON result, re-entry validates latest JSON', async () => { const s = shell(); await tick(); s.models.get('m0').language('plaintext'); s.calls[0].resolve([{ message: 'old' }]); await tick(); assert.equal(published(s).length, 0); s.models.get('m0').language('json'); await tick(); assert.equal(s.calls.length, 2); s.adapter.dispose(); });
test('schema config worker reset proceeds even if terminated worker RPC never settles', async () => { const s = shell(); await tick(); s.config(); await tick(); assert.equal(s.calls.length, 2); assert.deepEqual(s.calls.map(x => x.generation), [0, 1]); s.calls[1].resolve([{ message: 'new schema' }]); await tick(); assert.equal(published(s)[0].values[0].message, 'new schema'); s.calls[0].resolve([{ message: 'old schema' }]); await tick(); assert.equal(published(s).length, 1); s.adapter.dispose(); });
test('old worker completion cannot unlock a newer active generation', async () => { const s = shell(); await tick(); s.config(); await tick(); s.edit(); s.flush(); s.calls[0].resolve([]); await tick(); assert.equal(s.calls.length, 2); s.calls[1].resolve([]); await tick(); assert.equal(s.calls.length, 3); assert.equal(s.calls[2].version, 2); s.adapter.dispose(); });
test('several schema resets and edits keep latest generation eventual result', async () => { const s = shell(); await tick(); s.config(); await tick(); s.config(); await tick(); s.edit(); s.flush(); s.calls[2].resolve([]); await tick(); assert.equal(s.calls.length, 4); s.calls[3].resolve([{ message: 'latest' }]); await tick(); s.calls[1].resolve([{ message: 'old' }]); s.calls[0].resolve([{ message: 'old' }]); await tick(); assert.equal(published(s).length, 1); s.adapter.dispose(); });
test('idle-stopped unresolved worker is replaced on next edit without configuration event', async () => { const s = shell(); await tick(); s.idleStop(); s.edit(); s.flush(); await tick(); assert.equal(s.calls.length, 2); assert.deepEqual(s.calls.map(x => x.generation), [0, 1]); s.calls[1].resolve([{ message: 'after idle' }]); await tick(); assert.equal(published(s).length, 1); s.calls[0].resolve([{ message: 'obsolete' }]); await tick(); assert.equal(published(s).length, 1); s.adapter.dispose(); });
test('out-of-order proxy acquisition cannot publish older version or replace new generation', async () => { const s = shell(source, 1, true); await tick(); s.idleStop(); s.edit(); s.flush(); await tick(); assert.equal(s.proxyRequests.length, 2); s.proxyRequests[1].resolve(s.proxyRequests[1].worker); await tick(); assert.equal(s.calls.length, 1); assert.equal(s.calls[0].generation, 1); s.proxyRequests[0].resolve(s.proxyRequests[0].worker); await tick(); assert.equal(s.calls.length, 1); s.calls[0].resolve([{ message: 'latest' }]); await tick(); assert.equal(published(s).length, 1); s.adapter.dispose(); });
test('same URI replacement after idle stop does not wait on dead model RPC', async () => { const s = shell(); await tick(); s.remove(); s.idleStop(); const model = s.recreate(); await tick(); assert.equal(s.calls.length, 2); s.calls[1].resolve([{ message: 'new model' }]); await tick(); assert.equal(published(s)[0].model, model); s.adapter.dispose(); });
test('proxy acquisition failure leaves future edit retryable', async () => { const s = shell(source, 1, true); await tick(); s.proxyRequests[0].reject(new Error('proxy failed')); await tick(); assert.equal(s.errors.length, 1); s.edit(); s.flush(); await tick(); s.proxyRequests[1].resolve(s.proxyRequests[1].worker); await tick(); assert.equal(s.calls.length, 1); s.adapter.dispose(); });
test('removed model state is immediately reclaimed even if its worker RPC never settles', async () => { const s = shell(); await tick(); assert.equal(s.calls.length, 1); s.remove(); assert.equal(s.adapter._states.size, 0); s.adapter.dispose(); });
test('removed model cannot start validation after late proxy acquisition', async () => { const s = shell(source, 1, true); await tick(); s.remove(); assert.equal(s.adapter._states.size, 0); s.proxyRequests[0].resolve(s.proxyRequests[0].worker); await tick(); assert.equal(s.calls.length, 0); s.adapter.dispose(); });
test('installed WorkerManager plus MonacoWebWorkerImpl return stable identity until defaults or idle restart', async () => {
    const nativeWeb = readFileSync(process.cwd() + '/node_modules/monaco-editor/esm/vs/editor/standalone/browser/standaloneWebWorker.js', 'utf8');
    const webClass = nativeWeb.slice(nativeWeb.indexOf('class MonacoWebWorkerImpl extends EditorWorkerClient'));
    class EditorWorkerClient {
        constructor() { this.disposed = false; }
        _getProxy() { return Promise.resolve({ $loadForeignModule: async () => ['doValidation'], $fmr: async () => [] }); }
        workerWithSyncedResources() { return Promise.resolve(); }
        dispose() { this.disposed = true; }
    }
    const WebWorker = new Function('EditorWorkerClient', 'standaloneEditorWorkerDescriptor', 'getAllMethodNames', webClass + ';return MonacoWebWorkerImpl;')(EditorWorkerClient, { amdModuleId: 'mock', esmModuleLocation: 'mock' }, () => []);
    const managerSource = mode.slice(mode.indexOf('var STOP_WHEN_IDLE_FOR'), mode.indexOf('// node_modules/vscode-languageserver-types'));
    const changes = event(), constructed = [], intervals = new Map();
    let now = 0;
    const Manager = new Function('window', 'Date', 'monaco_editor_core_exports', managerSource + ';return WorkerManager;')({ setInterval: fn => { intervals.set(1, fn); return 1; }, clearInterval: () => intervals.clear() }, { now: () => now }, { editor: { createWebWorker: opts => { const w = new WebWorker({}, opts); constructed.push(w); return w; } } });
    const manager = new Manager({ onDidChange: changes.listen, languageId: 'json', diagnosticsOptions: {} });
    const first = await manager.getLanguageServiceWorker('m0');
    assert.equal(await manager.getLanguageServiceWorker('m0'), first);
    changes.fire();
    const afterConfig = await manager.getLanguageServiceWorker('m0');
    assert.notEqual(afterConfig, first);
    assert.equal(await manager.getLanguageServiceWorker('m0'), afterConfig);
    assert.equal(constructed[0].disposed, true);
    now = 121000;
    manager._checkIfIdle();
    const afterIdle = await manager.getLanguageServiceWorker('m0');
    assert.notEqual(afterIdle, afterConfig);
    assert.equal(constructed[1].disposed, true);
    manager.dispose();
});
test('diagnostics patch accepts only reviewed pruned source and changes no other providers', () => {
    assert.equal(patchMonacoJsonDiagnostics(pruned, modeId + '?v=1'), patched);
    assert.equal(patchMonacoJsonDiagnostics(pruned, modeId.replaceAll('/', '\\')), patched);
    assert.equal(patchMonacoJsonDiagnostics(pruned, modeId.replace('/monaco-editor/', '/other/')), null);
    assert.equal(patchMonacoJsonDiagnostics(pruned, '/jsonMode.js'), null);
    for (const changed of [mode, pruned + '\n', pruned.replace('doValidation', 'unknownValidation'), patched])
        assert.throws(() => patchMonacoJsonDiagnostics(changed, modeId), /source and transform order/);
    assert.throws(() => pruneUnusedJsonModeTypes(patched, modeId), /source SHA-256 changed/);
    const start = pruned.indexOf('var DiagnosticsAdapter = class {'), end = pruned.indexOf('\nfunction toSeverity(', start);
    assert.equal(patched.slice(0, start), pruned.slice(0, start));
    assert.equal(patched.slice(patched.indexOf('\nfunction toSeverity(', start)), pruned.slice(end));
    assert.equal(ts.createSourceFile('jsonMode.js', patched, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS).parseDiagnostics.length, 0);
    verifyMonacoDiagnosticsWorkerContract();
    const plugin = monacoJsonDiagnosticsPlugin();
    assert.equal(plugin.name, 'monaco-json-diagnostics');
    assert.equal(plugin.enforce, 'pre');
    assert.deepEqual(plugin.transform(pruned, modeId), { code: patched, map: null });
    assert.equal(plugin.transform(pruned, '/other.js'), null);
    const config = readFileSync(process.cwd() + '/vite.config.ts', 'utf8');
    assert.match(config, /monacoJsonModeTypesPlugin\(\), monacoJsonDiagnosticsPlugin\(\)/);
});
test('disposal before asynchronous proxy acquisition prevents starting worker request', async () => { const s = shell(source, 1, true); s.adapter.dispose(); await tick(); assert.equal(s.proxyRequests.length, 0); assert.equal(s.calls.length, 0); });
