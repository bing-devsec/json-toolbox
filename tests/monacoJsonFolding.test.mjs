import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { build } from 'esbuild';
import ts from 'typescript';
import { pruneUnusedJsonModeTypes } from '../scripts/vite/monaco-json-mode-types.mjs';
import { patchMonacoJsonDiagnostics } from '../scripts/vite/monaco-json-diagnostics.mjs';
import { patchMonacoJsonFolding, monacoJsonFoldingPlugin } from '../scripts/vite/monaco-json-folding.mjs';

const id = '/node_modules/monaco-editor/esm/vs/language/json/jsonMode.js';
const original = readFileSync(process.cwd() + id, 'utf8');
const pruned = pruneUnusedJsonModeTypes(original, id);
const diagnostics = patchMonacoJsonDiagnostics(pruned, id);
const patched = patchMonacoJsonFolding(diagnostics, id);
const start = 'var FoldingRangeAdapter = class {', end = '\nfunction toFoldingRangeKind(';
const extract = source => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const tick = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

function setup(source = patched) {
    const acquisitions = [], calls = [], models = new Map();
    function makeModel(key = 'inmemory://folding/model.json') {
        const model = { uri: { toString: () => key }, version: 1, language: 'json', disposed: false,
            getVersionId() { return this.version; }, getLanguageId() { return this.language; },
            isDisposed() { return this.disposed; }, getLineCount: () => 20 };
        models.set(key, model);
        return model;
    }
    const model = makeModel();
    const proxy = { getFoldingRanges(uri, context) { const result = deferred(); calls.push({ uri, context, ...result }); return result.promise; } };
    const Adapter = new Function('monaco_editor_core_exports', 'toFoldingRangeKind', extract(source) + ';return FoldingRangeAdapter;')(
        { editor: { getModel: uri => models.get(uri.toString()) } }, kind => ({ value: kind }),
    );
    const adapter = new Adapter(resource => { const acquisition = deferred(); acquisitions.push({ resource, ...acquisition }); return acquisition.promise; });
    const token = { isCancellationRequested: false };
    return { adapter, model, models, makeModel, token, acquisitions, calls, proxy,
        request: (context = {}) => adapter.provideFoldingRanges(model, context, token),
    };
}

test('native folding queues and maps all 100 requests even after 99 were cancelled during worker acquisition', async () => {
    const s = setup(original), tokens = [], promises = [];
    for (let i = 0; i < 100; i++) {
        if (tokens.length) tokens.at(-1).isCancellationRequested = true;
        const token = { isCancellationRequested: false }; tokens.push(token);
        promises.push(s.adapter.provideFoldingRanges(s.model, {}, token));
    }
    s.acquisitions.forEach(request => request.resolve(s.proxy));
    await tick();
    assert.equal(s.calls.length, 100);
    let mapped = 0;
    s.calls.forEach(call => call.resolve([{ get startLine() { mapped++; return 0; }, endLine: 3 }]));
    await Promise.all(promises);
    assert.equal(mapped, 100);
});

test('cancelled folding acquisition burst dispatches only the one current request', async () => {
    const s = setup(), tokens = [], promises = [];
    for (let i = 0; i < 100; i++) {
        if (tokens.length) tokens.at(-1).isCancellationRequested = true;
        const token = { isCancellationRequested: false }; tokens.push(token);
        promises.push(s.adapter.provideFoldingRanges(s.model, {}, token));
    }
    s.acquisitions.forEach(request => request.resolve(s.proxy));
    await tick();
    assert.equal(s.calls.length, 1);
    s.calls[0].resolve([{ startLine: 0, endLine: 3 }]);
    const results = await Promise.all(promises);
    assert(results.slice(0, -1).every(result => result === undefined));
    assert.deepEqual(results.at(-1), [{ start: 1, end: 4 }]);
});

const invalidations = {
    cancelled: s => { s.token.isCancellationRequested = true; },
    edited: s => { s.model.version++; },
    disposed: s => { s.model.disposed = true; },
    'language changed': s => { s.model.language = 'plaintext'; },
    removed: s => { s.models.clear(); },
    'same URI replacement': s => { s.makeModel(); },
};

for (const [name, invalidate] of Object.entries(invalidations)) {
    test(`${name} while acquiring a worker skips the obsolete folding RPC`, async () => {
        const s = setup(), promise = s.request();
        invalidate(s); s.acquisitions[0].resolve(s.proxy);
        assert.equal(await promise, undefined);
        assert.equal(s.calls.length, 0);
    });
    test(`${name} after dispatch skips stale range mapping`, async () => {
        const s = setup(), promise = s.request();
        s.acquisitions[0].resolve(s.proxy); await tick();
        assert.equal(s.calls.length, 1);
        invalidate(s);
        s.calls[0].resolve([{ get startLine() { assert.fail('Stale ranges must not be copied'); }, endLine: 3 }]);
        assert.equal(await promise, undefined);
    });
}

test('already cancelled, disposed and replaced models never acquire a worker', async () => {
    for (const invalidation of ['cancelled', 'disposed', 'same URI replacement']) {
        const s = setup(); invalidations[invalidation](s);
        assert.equal(await s.request(), undefined);
        assert.equal(s.acquisitions.length, 0);
    }
});

test('uncancelled current folding preserves every range, kind, context and RPC argument', async () => {
    const context = { rangeLimit: 100 }, ranges = [
        { startLine: 0, endLine: 19 }, { startLine: 1, endLine: 4, kind: 'region' },
        { startLine: 5, endLine: 8, kind: 'comment' }, { startLine: 9, endLine: 12, kind: 'imports' },
    ];
    const values = [];
    for (const source of [original, patched]) {
        const s = setup(source), promise = s.request(context);
        assert.equal(s.acquisitions[0].resource, s.model.uri);
        s.acquisitions[0].resolve(s.proxy); await tick();
        assert.equal(s.calls[0].uri, s.model.uri.toString());
        assert.equal(s.calls[0].context, context);
        s.calls[0].resolve(ranges); values.push(await promise);
    }
    assert.deepEqual(values[1], values[0]);
    assert.equal(values[1].length, ranges.length);
});

test('empty and absent native folding results retain their meaning', async () => {
    for (const value of [[], undefined, null]) {
        const s = setup(), promise = s.request();
        s.acquisitions[0].resolve(s.proxy); await tick(); s.calls[0].resolve(value);
        assert.deepEqual(await promise, value ? [] : undefined);
    }
});

test('worker acquisition and RPC failures still reject and later requests remain usable', async () => {
    for (const failure of ['acquisition', 'RPC']) {
        const s = setup(), promise = s.request();
        const rejected = assert.rejects(promise, /expected failure/);
        if (failure === 'acquisition') s.acquisitions[0].reject(new Error('expected failure'));
        else { s.acquisitions[0].resolve(s.proxy); await tick(); s.calls[0].reject(new Error('expected failure')); }
        await rejected;
        const next = s.request(); s.acquisitions.at(-1).resolve(s.proxy); await tick();
        s.calls.at(-1).resolve([{ startLine: 0, endLine: 19 }]);
        assert.deepEqual(await next, [{ start: 1, end: 20 }]);
    }
});

test('real SyntaxRangeProvider and CancellationTokenSource discard cancelled work and preserve live folds', async () => {
    const bundle = await build({ stdin: { resolveDir: process.cwd(), contents: `
        export { SyntaxRangeProvider } from 'monaco-editor/esm/vs/editor/contrib/folding/browser/syntaxRangeProvider.js';
        export { CancellationTokenSource } from 'monaco-editor/esm/vs/base/common/cancellation.js';
    ` }, bundle: true, write: false, platform: 'node', format: 'esm' });
    const { SyntaxRangeProvider, CancellationTokenSource } = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'));
    const s = setup(), updates = [];
    const provider = new SyntaxRangeProvider(s.model, [s.adapter], () => {}, { limit: 5000, update: (...args) => updates.push(args) });
    const cancellation = new CancellationTokenSource(), cancelled = provider.compute(cancellation.token);
    cancellation.cancel(); s.acquisitions[0].resolve(s.proxy);
    assert.equal(await cancelled, null); assert.equal(s.calls.length, 0); assert.equal(updates.length, 0);
    const liveToken = new CancellationTokenSource(), live = provider.compute(liveToken.token);
    s.acquisitions[1].resolve(s.proxy); await tick();
    s.calls[0].resolve([{ startLine: 0, endLine: 19 }, { startLine: 1, endLine: 4 }]);
    const ranges = await live;
    assert.equal(ranges.length, 2);
    assert.equal(ranges.getStartLineNumber(1), 2); assert.equal(ranges.getEndLineNumber(1), 5);
    assert.deepEqual(updates, [[2, false]]);
    provider.dispose(); cancellation.dispose(); liveToken.dispose();
});

test('guarded folding transform changes only its adapter after the existing checked transforms', () => {
    assert.equal(patchMonacoJsonFolding(diagnostics, id + '?v=1'), patched);
    assert.equal(patchMonacoJsonFolding(diagnostics, id.replaceAll('/', '\\')), patched);
    assert.equal(patchMonacoJsonFolding(diagnostics, id.replace('/monaco-editor/', '/other/')), null);
    for (const invalid of [original, pruned, diagnostics + '\n', diagnostics.replace('getFoldingRanges', 'unknown'), patched]) {
        assert.throws(() => patchMonacoJsonFolding(invalid, id), /source and transform order/);
    }
    const first = diagnostics.indexOf(start), last = diagnostics.indexOf(end, first);
    assert.equal(patched.slice(0, first), diagnostics.slice(0, first));
    assert.equal(patched.slice(patched.indexOf(end, first)), diagnostics.slice(last));
    assert.equal(ts.createSourceFile('jsonMode.js', patched, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS).parseDiagnostics.length, 0);
    const plugin = monacoJsonFoldingPlugin();
    assert.equal(plugin.name, 'monaco-json-folding'); assert.equal(plugin.enforce, 'pre');
    assert.deepEqual(plugin.transform(diagnostics, id), { code: patched, map: null });
    assert.equal(plugin.transform(diagnostics, '/other.js'), null);
    const config = readFileSync(process.cwd() + '/vite.config.ts', 'utf8');
    assert.match(config, /monacoJsonModeTypesPlugin\(\), monacoJsonDiagnosticsPlugin\(\), monacoJsonFoldingPlugin\(\)/);
});
