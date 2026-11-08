import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { Worker } from 'node:worker_threads';
import { build } from 'esbuild';
import ts from 'typescript';
import { monacoSingleEditorPlugin } from '../scripts/vite/monaco-single-editor.mjs';
import { monacoWorkerResourcesPlugin } from '../scripts/vite/monaco-worker-resources.mjs';
import { assertNoNativeMonacoDiffConsumers, pruneUnusedMonacoWorkerDiff } from '../scripts/vite/monaco-worker-diff.mjs';

const root = path.dirname(import.meta.dirname);
const vsRoot = path.join(root, 'node_modules/monaco-editor/esm/vs');
const servicePath = path.join(vsRoot, 'editor/browser/services/editorWorkerService.js');
const workerPath = path.join(vsRoot, 'editor/common/services/editorSimpleWorker.js');
const serviceSource = fs.readFileSync(servicePath, 'utf8');
const workerSource = fs.readFileSync(workerPath, 'utf8');
const adapter = monacoSingleEditorPlugin();
const workerAdapter = monacoWorkerResourcesPlugin();
const bundlePlugin = { name: 'test-single-editor-adapter', setup(builder) {
    builder.onLoad({ filter: /monaco-editor\/.*\.js$/ }, args => {
        const original = fs.readFileSync(args.path, 'utf8');
        return { contents: workerAdapter.transform(original, args.path)?.code ?? adapter.transform(original, args.path)?.code ?? original, loader: 'js' };
    });
} };

function classes(code) {
    const source = ts.createSourceFile('module.js', code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const result = new Map();
    const visit = node => {
        if ((ts.isClassDeclaration(node) || ts.isClassExpression(node)) && node.name) result.set(node.name.text, { node, source });
        ts.forEachChild(node, visit);
    };
    visit(source);
    return result;
}

function classText(code, name) {
    const { node, source } = classes(code).get(name);
    return node.getText(source);
}

function memberTexts(code) {
    return new Map([...classes(code)].flatMap(([name, { node, source }]) => {
        let unnamedIndex = 0;
        return node.members.map(member => [
            `${name}.${member.name?.getText(source) ?? `#${unnamedIndex++}`}:${member.modifiers?.some(m => m.kind === ts.SyntaxKind.StaticKeyword) ? 'static' : 'instance'}`,
            member.getText(source),
        ]);
    }));
}

test('worker diff adapter removes exactly four reviewed methods and no other class members', () => {
    const removed = new Set([
        'EditorWorkerService.computeDiff:instance',
        'BaseEditorSimpleWorker.$computeDiff:instance',
        'BaseEditorSimpleWorker.computeDiff:static',
        'BaseEditorSimpleWorker._modelsAreIdentical:static',
    ]);
    const actualRemoved = [];
    for (const [file, original] of [[servicePath, serviceSource], [workerPath, workerSource]]) {
        const patched = pruneUnusedMonacoWorkerDiff(original, file);
        const before = memberTexts(original), after = memberTexts(patched);
        for (const [name, body] of before) {
            if (removed.has(name)) {
                assert(!after.has(name), name);
                actualRemoved.push(name);
            } else assert.equal(after.get(name), body, name);
        }
        assert.equal(after.size, before.size - [...before.keys()].filter(name => removed.has(name)).length);
        assert.equal(ts.createSourceFile(file, patched, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS).parseDiagnostics.length, 0);
        assert.equal(adapter.transform(original, file)?.code, patched);
    }
    assert.deepEqual(actualRemoved.sort(), [...removed].sort());
    assert(!/\b(?:canComputeDiff|computeDirtyDiff|dirtyDiff)\b/.test(serviceSource + workerSource), 'This version has no additional similarly named methods to prune');
    for (const name of ['EditorWorkerClient', 'SynchronousWorkerClient', 'WorkerManager', 'WordBasedCompletionItemProvider']) {
        assert.equal(classText(pruneUnusedMonacoWorkerDiff(serviceSource, servicePath), name), classText(serviceSource, name));
    }
    const patchedWorker = pruneUnusedMonacoWorkerDiff(workerSource, workerPath);
    assert(patchedWorker.includes("import { stringDiff } from '../../../base/common/diff/diff.js';"));
    assert(patchedWorker.includes('const changes = stringDiff(original, text, pretty);'));
    assert.equal(classText(patchedWorker, 'EditorSimpleWorker'), classText(workerSource, 'EditorSimpleWorker'));
});

test('worker diff adapter fails closed for either changed upstream file and only targets exact package paths', () => {
    for (const [file, original] of [[servicePath, serviceSource], [workerPath, workerSource]]) {
        assert.throws(() => pruneUnusedMonacoWorkerDiff(original + '\n', file), /Review the installed Monaco/);
        assert.throws(() => pruneUnusedMonacoWorkerDiff(original.replace('computeDiff', 'differentMethod'), file), /Review the installed Monaco/);
        const patched = pruneUnusedMonacoWorkerDiff(original, file);
        assert.equal(pruneUnusedMonacoWorkerDiff(original, file + '?v=1'), patched);
        assert.equal(pruneUnusedMonacoWorkerDiff(original, file.replaceAll('/', '\\')), patched);
        assert.equal(pruneUnusedMonacoWorkerDiff(original, file.replace('/monaco-editor/', '/monaco-editor-other/')), null);
    }
    assert.equal(pruneUnusedMonacoWorkerDiff('arbitrary source', '/app/editorSimpleWorker.js'), null);
});

test('emitted graph guard rejects known native Diff consumers, including inline edit, without changing safe output', () => {
    const makeBundle = id => ({ 'entry.js': { type: 'chunk', fileName: 'entry.js', code: 'unchanged', modules: { [id]: {} } } });
    for (const suffix of [
        'browser/widget/diffEditor/diffProviderFactoryService.js',
        'browser/widget/multiDiffEditor/multiDiffEditorWidget.js',
        'contrib/inlineEdit/browser/inlineEditSideBySideWidget.js',
        'contrib/inlineEdits/browser/inlineEditsModel.js',
    ]) {
        const id = path.join(vsRoot, 'editor', suffix);
        assert.throws(() => assertNoNativeMonacoDiffConsumers(makeBundle(id)), /Review the single-editor contract/);
        assert.throws(() => assertNoNativeMonacoDiffConsumers(makeBundle(id.replaceAll('/', '\\') + '?v=1')), /Review the single-editor contract/);
        assert.throws(() => adapter.generateBundle({}, { 'entry.js': { type: 'chunk', fileName: 'entry.js', moduleIds: [id] } }), /Review the single-editor contract/);
    }
    const safe = makeBundle(servicePath);
    safe['editor.worker.js'] = { type: 'asset', fileName: 'editor.worker.js', source: 'original complete worker' };
    const original = structuredClone(safe);
    assertNoNativeMonacoDiffConsumers(safe);
    assert.deepEqual(safe, original);
});

async function runtimeBundle(patched) {
    const result = await build({
        stdin: { resolveDir: root, contents: `
            export { BaseEditorSimpleWorker, EditorSimpleWorker } from 'monaco-editor/esm/vs/editor/common/services/editorSimpleWorker.js';
            export { WorkerTextModelSyncClient } from 'monaco-editor/esm/vs/editor/common/services/textModelSync/textModelSync.impl.js';
            export { EditorWorkerHost } from 'monaco-editor/esm/vs/editor/common/services/editorWorkerHost.js';
            export { Disposable } from 'monaco-editor/esm/vs/base/common/lifecycle.js';
            export { Emitter } from 'monaco-editor/esm/vs/base/common/event.js';
            export { canceled } from 'monaco-editor/esm/vs/base/common/errors.js';
            export { URI } from 'monaco-editor/esm/vs/base/common/uri.js';
        ` },
        bundle: true, write: false, format: 'esm', platform: 'node', plugins: patched ? [bundlePlugin] : [],
    });
    return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
}
const runtimes = Promise.all([runtimeBundle(false), runtimeBundle(true)]);

test('real installed worker constructors retain every prototype API except the native diff methods', async () => {
    const [before, after] = await runtimes;
    for (const name of ['BaseEditorSimpleWorker', 'EditorSimpleWorker']) {
        const instanceRemoved = name === 'BaseEditorSimpleWorker' ? ['$computeDiff'] : [];
        const staticRemoved = name === 'BaseEditorSimpleWorker' ? ['computeDiff', '_modelsAreIdentical'] : [];
        assert.deepEqual(Object.getOwnPropertyNames(after[name].prototype), Object.getOwnPropertyNames(before[name].prototype).filter(key => !instanceRemoved.includes(key)));
        assert.deepEqual(Object.getOwnPropertyNames(after[name]), Object.getOwnPropertyNames(before[name]).filter(key => !staticRemoved.includes(key)));
    }
});

const modelUrl = 'inmemory://worker-diff-test/model.json';
const sampleLines = ['alpha beta 123 true', 'https://example.com/a #ff00ff', '// MARK: - Section', '汉字 a\u200bb'];
const range = (startLineNumber, startColumn, endLineNumber, endColumn) => ({ startLineNumber, startColumn, endLineNumber, endColumn });
const normalized = value => JSON.parse(JSON.stringify(value));

async function exerciseWorker(call) {
    const values = {};
    values.ping = await call('$ping');
    await call('$acceptNewModel', { url: modelUrl, lines: [...sampleLines], EOL: '\n', versionId: 1 });
    values.links = await call('$computeLinks', modelUrl);
    values.colors = await call('$computeDefaultDocumentColors', modelUrl);
    values.unicode = await call('$computeUnicodeHighlights', modelUrl, { nonBasicASCII: true, invisibleCharacters: true, ambiguousCharacters: true, allowedCodePoints: [], allowedLocales: [] });
    values.headers = await call('$findSectionHeaders', modelUrl, { findMarkSectionHeaders: true, findRegionSectionHeaders: false });
    values.ranges = await call('$computeWordRanges', modelUrl, range(1, 1, 5, 1), '[A-Za-z]+', 'g');
    values.value = await call('$navigateValueSet', modelUrl, range(1, 12, 1, 15), true, '[A-Za-z0-9]+', 'g');
    for (const pretty of [false, true]) {
        values[`minimal-${pretty}`] = await call('$computeMoreMinimalEdits', modelUrl, [{ range: range(1, 1, 1, 19), text: 'alpha zeta 123 true' }], pretty);
    }
    values.suggest = (await call('$textualSuggest', [modelUrl], 'alpha', '[A-Za-z]+', 'g')).words;
    await call('$acceptModelChanged', modelUrl, { changes: [{ range: range(1, 1, 1, 6), text: 'gamma' }], versionId: 2 });
    values.updatedSuggest = (await call('$textualSuggest', [modelUrl], '', '[A-Za-z]+', 'g')).words;
    await call('$acceptRemovedModel', modelUrl);
    values.removedLinks = await call('$computeLinks', modelUrl);
    values.missingEdits = await call('$computeMoreMinimalEdits', modelUrl, [{ range: range(1, 1, 1, 1), text: 'x' }], false);
    return normalized(values);
}

test('all remaining installed local worker RPCs preserve results and model add/change/remove behavior', async () => {
    const [before, after] = await runtimes;
    const results = [];
    for (const runtime of [before, after]) {
        const worker = new runtime.EditorSimpleWorker({ $fhr: () => Promise.reject(new Error('No foreign host expected')) }, null);
        results.push(await exerciseWorker((name, ...args) => worker[name](...args)));
        worker.dispose();
    }
    assert.deepEqual(results[1], results[0]);
    assert(results[1].links.length > 0);
    assert(results[1].headers.length > 0);
    assert(results[1].unicode.ranges.length > 0);
    assert(results[1].updatedSuggest.includes('gamma'));
    assert(!results[1].updatedSuggest.includes('alpha'));
    assert.equal(results[1].removedLinks, null);
});

function createClient(runtime, patched, createWebWorker, modelService) {
    const source = patched ? pruneUnusedMonacoWorkerDiff(serviceSource, servicePath) : serviceSource;
    const names = ['Disposable', 'EditorWorkerHost', 'EditorSimpleWorker', 'WorkerTextModelSyncClient', 'canceled'];
    const factory = new Function(...names, 'createWebWorker', 'logOnceWebWorkerWarning', `${classText(source, 'SynchronousWorkerClient')}\nreturn (${classText(source, 'EditorWorkerClient')});`);
    const Client = factory(...names.map(name => runtime[name]), createWebWorker, () => {});
    return new Client({ label: 'fallback-test' }, true, modelService);
}

test('unchanged real EditorWorkerClient preserves construction/ping failure fallback, sync, reuse and disposal', async () => {
    const originals = await runtimes;
    for (const failure of ['construction', 'ping']) {
        const outcomes = [];
        for (const [patched, runtime] of originals.entries()) {
            const changes = new runtime.Emitter(), disposals = new runtime.Emitter();
            const uri = runtime.URI.parse(modelUrl);
            const model = {
                uri, isTooLargeForSyncing: () => false, getLinesContent: () => ['alpha beta'],
                getEOL: () => '\n', getVersionId: () => 1,
                onDidChangeContent: changes.event, onWillDispose: disposals.event,
            };
            let attempts = 0;
            const createWebWorker = () => {
                attempts++;
                if (failure === 'construction') throw new Error('Worker blocked or unavailable');
                return { proxy: { $ping: async () => { throw new Error('Worker asset did not load'); } }, setChannel() {}, dispose() {} };
            };
            const client = createClient(runtime, !!patched, createWebWorker, { getModel: resource => resource.toString() === modelUrl ? model : null });
            const proxy = await client.workerWithSyncedResources([uri]);
            const repeated = await client.workerWithSyncedResources([uri]);
            assert.equal(repeated, proxy);
            assert.equal(attempts, 1);
            assert.equal(await proxy.$ping(), 'pong');
            changes.fire({ changes: [{ range: range(1, 1, 1, 6), text: 'gamma' }], versionId: 2 });
            const words = (await client.textualSuggest([uri], '', /[A-Za-z]+/g)).words;
            disposals.fire();
            const removed = await proxy.$computeLinks(modelUrl);
            client.dispose();
            await assert.rejects(client.workerWithSyncedResources([uri]), error => error.name === 'Canceled');
            outcomes.push({ words, removed, attempts });
            changes.dispose(); disposals.dispose();
        }
        assert.deepEqual(outcomes[1], outcomes[0]);
        assert.deepEqual(outcomes[1], { words: ['gamma', 'beta'], removed: null, attempts: 1 });
    }
});

async function startWorkerEntry(entry, patched) {
    const result = await build({ entryPoints: [path.join(vsRoot, entry)], bundle: true, write: false, format: 'iife', platform: 'browser', plugins: patched ? [bundlePlugin] : [] });
    // Actual Monaco entry/protocol in a real Node worker thread. This is not a
    // browser/CSP test: the transport supplies the browser worker globals.
    const worker = new Worker(`
        const { parentPort, workerData } = require('node:worker_threads');
        globalThis.self = globalThis;
        // A module WebWorker exposes importScripts, but invoking it is invalid.
        globalThis.importScripts = () => { throw new Error('importScripts is unavailable in this module worker'); };
        const listeners = new Set();
        globalThis.addEventListener = (type, listener) => { if (type === 'message') listeners.add(listener); };
        globalThis.removeEventListener = (type, listener) => { if (type === 'message') listeners.delete(listener); };
        globalThis.postMessage = message => parentPort.postMessage(message);
        eval(workerData);
        globalThis.onmessage({ data: {} });
        parentPort.on('message', data => {
            const event = { data };
            globalThis.onmessage(event);
            for (const listener of listeners) listener(event);
        });
        parentPort.postMessage({ ready: true });
    `, { eval: true, workerData: result.outputFiles[0].text });
    const pending = new Map();
    let sequence = 0;
    let readyDone = false;
    let rejectReady;
    let readyTimer;
    const fail = error => {
        clearTimeout(readyTimer);
        if (!readyDone) { readyDone = true; rejectReady(error); }
        for (const request of pending.values()) { clearTimeout(request.timer); request.reject(error); }
        pending.clear();
    };
    const ready = new Promise((resolve, reject) => {
        rejectReady = reject;
        readyTimer = setTimeout(() => fail(new Error('Worker entry startup timeout')), 15000);
        worker.on('error', fail);
        worker.on('exit', code => {
            if (!readyDone || pending.size) fail(new Error(`Worker exited before completion (${code})`));
        });
        worker.on('message', message => {
            if (message.ready) { clearTimeout(readyTimer); readyDone = true; resolve(); }
            else if (message.type === 1) {
                const request = pending.get(message.seq);
                if (!request) return;
                clearTimeout(request.timer); pending.delete(message.seq);
                if (message.err) request.reject(Object.assign(new Error(message.err.message), { name: message.err.name }));
                else request.resolve(message.res);
            }
        });
    });
    const call = (method, ...args) => new Promise((resolve, reject) => {
        const req = String(++sequence);
        const timer = setTimeout(() => { pending.delete(req); reject(new Error(`Worker RPC timeout: ${method}`)); }, 15000);
        pending.set(req, { resolve, reject, timer });
        worker.postMessage({ type: 0, vsWorker: 1, req, channel: 'default', method, args });
    });
    try {
        await ready;
        await call('$initialize', 1, null, 'unused-static-entry');
    } catch (error) {
        fail(error); await worker.terminate(); throw error;
    }
    return { call, close: () => { fail(new Error('Worker test closed')); return worker.terminate(); } };
}

test('real editor Worker entry/protocol preserves every remaining RPC when adapted', async () => {
    const results = [];
    for (const patched of [false, true]) {
        const worker = await startWorkerEntry('editor/editor.worker.js', patched);
        try { results.push(await exerciseWorker(worker.call)); }
        finally { await worker.close(); }
    }
    assert.deepEqual(results[1], results[0]);
});

test('real JSON Worker entry preserves foreign API, diagnostics, completion, hover, format and model updates', async () => {
    const results = [];
    for (const patched of [false, true]) {
        const worker = await startWorkerEntry('language/json/json.worker.js', patched);
        try {
            const createData = { languageId: 'json', enableSchemaRequest: false, languageSettings: { validate: true, schemas: [{
                uri: 'inmemory://schemas/count', fileMatch: ['*'], schema: { type: 'object', properties: { count: { type: 'number', description: 'A count.' }, color: { type: 'string', format: 'color' } } },
            }] } };
            const api = await worker.call('$loadForeignModule', 'vs/language/json/jsonWorker', createData, []);
            await worker.call('$acceptNewModel', { url: modelUrl, lines: ['{', '  "count": "wrong",', '  "color": "#ff0000"', '}'], EOL: '\n', versionId: 1 });
            const foreign = (name, ...args) => worker.call('$fmr', name, args);
            const diagnostics = await foreign('doValidation', modelUrl);
            assert(diagnostics.length > 0);
            const values = { api, diagnostics,
                completion: await foreign('doComplete', modelUrl, { line: 1, character: 2 }),
                hover: await foreign('doHover', modelUrl, { line: 1, character: 4 }),
                format: await foreign('format', modelUrl, null, { tabSize: 2, insertSpaces: true }),
                symbols: await foreign('findDocumentSymbols', modelUrl),
                colors: await foreign('findDocumentColors', modelUrl),
                folding: await foreign('getFoldingRanges', modelUrl, {}),
                selections: await foreign('getSelectionRanges', modelUrl, [{ line: 1, character: 4 }]),
            };
            values.resolvedCompletion = await foreign('doResolve', { label: 'count', kind: 10 });
            values.colorPresentations = await foreign('getColorPresentations', modelUrl, { red: 1, green: 0, blue: 0, alpha: 1 }, { start: { line: 2, character: 12 }, end: { line: 2, character: 19 } });
            values.matchingSchemas = await foreign('getMatchingSchemas', modelUrl);
            values.parsedDocument = await foreign('parseJSONDocument', modelUrl);
            await worker.call('$acceptModelChanged', modelUrl, { changes: [{ range: range(2, 12, 2, 19), text: '5' }], versionId: 2 });
            values.updatedDiagnostics = await foreign('doValidation', modelUrl);
            assert.equal(values.updatedDiagnostics.length, 0);
            await worker.call('$acceptRemovedModel', modelUrl);
            values.removedDiagnostics = await foreign('doValidation', modelUrl);
            values.resetSchema = await foreign('resetSchema', 'inmemory://schemas/count');
            results.push(values);
        } finally { await worker.close(); }
    }
    assert.deepEqual(results[1], results[0]);
});

test('actual runtime import graph excludes every native diff caller but retains all product contribution and fallback paths', async () => {
    const contents = "export * from './src/components/utils/monacoRuntimeImpl.ts'; export * from './src/components/composables/useMonacoLanguageRegistry.ts';";
    const result = await build({
        stdin: { contents, resolveDir: root, loader: 'ts' }, bundle: true, write: false, format: 'esm', platform: 'browser', metafile: true,
        loader: { '.css': 'empty', '.ttf': 'empty' }, external: ['vue'],
        plugins: [{ name: 'external-worker-assets', setup(builder) {
            builder.onResolve({ filter: /\?worker$/ }, args => ({ path: args.path, external: true }));
        } }, bundlePlugin],
    });
    const files = Object.keys(result.metafile.inputs);
    assert(!files.some(file => /\/(?:widget\/(?:diffEditor|multiDiffEditor)|contrib\/(?:inlineEdit|inlineEdits)|common\/diff\/(?:defaultLinesDiffComputer|legacyLinesDiffComputer|linesDiffComputers))\//.test(file)), 'No native widgets, inline edit callers or native algorithms may be reachable');
    assert(!files.some(file => /\/(?:defaultLinesDiffComputer|legacyLinesDiffComputer|linesDiffComputers|diffProviderFactoryService)\.js$/.test(file)));
    for (const suffix of [
        'editor/common/services/editorSimpleWorker.js', 'editor/common/services/textModelSync/textModelSync.impl.js',
        'editor/standalone/browser/standaloneWebWorker.js',
        'base/common/diff/diff.js', 'editor/contrib/stickyScroll/browser/stickyScrollController.js',
        'editor/browser/viewParts/minimap/minimap.js', 'editor/contrib/find/browser/findController.js',
        'editor/contrib/folding/browser/folding.js', 'language/json/jsonMode.js',
    ]) assert(files.some(file => file.endsWith(suffix)), suffix);
    const forbiddenNames = new Set(['computeDiff', '$computeDiff', '_modelsAreIdentical', 'computeDirtyDiff', 'canComputeDiff', 'dirtyDiff']);
    for (const file of files.filter(file => file.endsWith('.js') && file.includes('monaco-editor/'))) {
        const absolute = path.resolve(root, file);
        const original = fs.readFileSync(absolute, 'utf8');
        const code = adapter.transform(original, absolute)?.code ?? original;
        const source = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
        const visit = node => {
            if (ts.isPropertyAccessExpression(node)) assert(!forbiddenNames.has(node.name.text), `${file}: ${node.getText(source)}`);
            if (ts.isElementAccessExpression(node) && node.argumentExpression && ts.isStringLiteral(node.argumentExpression)) assert(!forbiddenNames.has(node.argumentExpression.text), `${file}: ${node.getText(source)}`);
            ts.forEachChild(node, visit);
        };
        visit(source);
    }
});
