import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { transform } from 'esbuild';
import ts from 'typescript';
import { pruneUnusedJsonWorkerTypes } from '../scripts/vite/monaco-json-worker-types.mjs';
import { monacoWorkerResourcesPlugin } from '../scripts/vite/monaco-worker-resources.mjs';
import { pruneUnusedMonacoWorkerDiff } from '../scripts/vite/monaco-worker-diff.mjs';

const root = path.dirname(import.meta.dirname);
const file = path.join(root, 'node_modules/monaco-editor/esm/vs/language/json/json.worker.js');
const original = fs.readFileSync(file, 'utf8');
const beginMarker = '// node_modules/vscode-languageserver-types/lib/esm/main.js';
const endMarker = '// node_modules/vscode-languageserver-textdocument/lib/esm/main.js';

function privateUnits(code) {
    const source = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    assert.equal(source.parseDiagnostics.length, 0);
    const begin = code.indexOf(beginMarker), end = code.indexOf(endMarker);
    const units = new Map();
    for (let i = 0; i < source.statements.length; i++) {
        const node = source.statements[i];
        if (node.getStart(source) < begin || node.getStart(source) >= end) continue;
        assert(ts.isVariableStatement(node));
        assert.equal(node.declarationList.declarations.length, 1);
        const declaration = node.declarationList.declarations[0];
        const last = declaration.initializer ? node : source.statements[++i];
        units.set(declaration.name.text, code.slice(node.getStart(source), last.end));
    }
    return { units, source };
}

test('JSON Worker pruning removes only 62 private unreachable units and preserves every service byte', () => {
    const patched = pruneUnusedJsonWorkerTypes(original, file);
    assert.equal(patched.slice(0, patched.indexOf(beginMarker)), original.slice(0, original.indexOf(beginMarker)));
    assert.equal(patched.slice(patched.indexOf(endMarker)), original.slice(original.indexOf(endMarker)));
    const before = privateUnits(original), after = privateUnits(patched);
    assert.equal(before.units.size, 81);
    assert.equal(after.units.size, 19);
    for (const [name, text] of after.units) assert.equal(text, before.units.get(name), name);
    const removed = new Set([...before.units.keys()].filter(name => !after.units.has(name)));
    assert.equal(removed.size, 62);
    for (const name of ['WorkspaceEdit', 'DocumentHighlightKind', 'TextDocument', 'FullTextDocument']) assert(removed.has(name), name);
    for (const name of ['URI', 'Position', 'Range', 'Diagnostic', 'CompletionItem', 'TextEdit', 'SelectionRange']) assert(after.units.has(name), name);
    const visit = node => {
        if (ts.isIdentifier(node)) assert(!removed.has(node.text), node.text);
        ts.forEachChild(node, visit);
    };
    visit(after.source);
});

test('JSON Worker adapter targets only the reviewed worker file and fails closed on source changes', () => {
    const patched = pruneUnusedJsonWorkerTypes(original, file);
    assert.equal(pruneUnusedJsonWorkerTypes(original, file + '?v=1'), patched);
    assert.equal(pruneUnusedJsonWorkerTypes(original, file.replaceAll('/', '\\')), patched);
    assert.equal(pruneUnusedJsonWorkerTypes(original, file.replace('/monaco-editor/', '/monaco-editor-other/')), null);
    assert.equal(pruneUnusedJsonWorkerTypes(original, file.replace('json.worker.js', 'jsonMode.js')), null);
    assert.equal(pruneUnusedJsonWorkerTypes('arbitrary text', '/app/json.worker.js'), null);
    for (const changed of [original + '\n', original.replace('JSONWorker', 'ChangedWorker'), original.replace('WorkspaceEdit2.is = is;', 'sideEffect(); WorkspaceEdit2.is = is;')]) {
        assert.throws(() => pruneUnusedJsonWorkerTypes(changed, file), /source SHA-256 changed/);
    }
});

// Replacing a hash happens only in this in-memory test fixture. There is no
// production bypass: every changed installed source fails before structural proof.
async function adapterForFixture(fixture) {
    const adapterFile = path.join(root, 'scripts/vite/monaco-json-worker-types.mjs');
    const originalAdapter = fs.readFileSync(adapterFile, 'utf8');
    const digest = createHash('sha256').update(fixture).digest('hex');
    const rewritten = originalAdapter.replace(/const SOURCE_SHA256 = '[a-f0-9]{64}';/, `const SOURCE_SHA256 = '${digest}';`);
    assert.notEqual(rewritten, originalAdapter);
    const code = (await transform(rewritten, { format: 'cjs', target: 'es2022' })).code;
    const module = { exports: {} };
    vm.runInNewContext(code, { module, exports: module.exports, require: createRequire(adapterFile) });
    return module.exports.pruneUnusedJsonWorkerTypes;
}

test('worker source review rejects newly live types, effects, dynamic evaluation and layout drift', async () => {
    const fixtures = [
        ['var JSONWorker = class {', 'var newlyLiveType = WorkspaceEdit;\nvar JSONWorker = class {', /reachability changed/],
        ['WorkspaceEdit2.is = is;', 'globalThis.touched = true; WorkspaceEdit2.is = is;', /own plain object/],
        ['WorkspaceEdit2.is = is;', 'sideEffect(); WorkspaceEdit2.is = is;', /eager namespace statement/],
        ['WorkspaceEdit2.is = is;', 'WorkspaceEdit2.is = sideEffect();', /literal or local function/],
        ['})(WorkspaceEdit || (WorkspaceEdit = {}));', '})(WorkspaceEdit || (WorkspaceEdit = { changed: true }));', /fresh plain object/],
        ['function(WorkspaceEdit2)', 'function(WorkspaceEdit2 = sideEffect())', /IIFE shape/],
        ['var FullTextDocument = class {', 'var FullTextDocument = class { static { sideEffect(); }', /eager class effect/],
        ['var FullTextDocument = class {', 'var FullTextDocument = class { [sideEffect()]() {}', /eager class effect/],
        ['var JSONWorker = class {', 'eval("WorkspaceEdit");\nvar JSONWorker = class {', /dynamic evaluation/],
        ['var JSONWorker = class {', 'new Function("return WorkspaceEdit");\nvar JSONWorker = class {', /dynamic evaluation/],
        [endMarker, 'var ExtraPrivateUnit = 1;\n' + endMarker, /declaration count changed/],
    ];
    for (const [needle, replacement, expected] of fixtures) {
        assert(original.includes(needle), needle);
        const fixture = original.replace(needle, replacement);
        const adapter = await adapterForFixture(fixture);
        assert.throws(() => adapter(fixture, file), expected, replacement);
    }
});

test('worker-only plugin composes reviewed transforms without changing main plugin or fallback routing', () => {
    const plugin = monacoWorkerResourcesPlugin();
    assert.equal(plugin.transform(original, file).code, pruneUnusedJsonWorkerTypes(original, file));
    const workerFile = path.join(root, 'node_modules/monaco-editor/esm/vs/editor/common/services/editorSimpleWorker.js');
    const worker = fs.readFileSync(workerFile, 'utf8');
    assert.equal(plugin.transform(worker, workerFile).code, pruneUnusedMonacoWorkerDiff(worker, workerFile));
    for (const relative of ['editor/editor.worker.js', 'language/json/jsonMode.js']) {
        const unchangedFile = path.join(root, 'node_modules/monaco-editor/esm/vs', relative);
        assert.equal(plugin.transform(fs.readFileSync(unchangedFile, 'utf8'), unchangedFile), null);
    }
    const config = fs.readFileSync(path.join(root, 'vite.config.ts'), 'utf8');
    assert.match(config, /worker:\s*\{\s*format:\s*'es',\s*plugins:\s*\(\)\s*=>\s*\[monacoWorkerResourcesPlugin\(\)\]/);
    const mainPlugins = config.match(/^\s*plugins: \[(.*)\],$/m)?.[1];
    assert(mainPlugins?.includes('monacoSingleEditorPlugin()'));
    assert(!mainPlugins.includes('monacoWorkerResourcesPlugin()'));
    const safe = { 'worker.js': { type: 'chunk', code: 'unchanged', fileName: 'worker.js', modules: { [workerFile]: {} } } };
    const copy = structuredClone(safe);
    plugin.generateBundle({}, safe);
    assert.deepEqual(safe, copy);
    for (const suffix of ['browser/widget/diffEditor/diffProviderFactoryService.js', 'contrib/inlineEdit/browser/inlineEditSideBySideWidget.js', 'contrib/inlineEdits/browser/inlineEditsModel.js']) {
        const id = path.join(root, 'node_modules/monaco-editor/esm/vs/editor', suffix);
        assert.throws(() => plugin.generateBundle({}, { 'worker.js': { type: 'chunk', fileName: 'worker.js', moduleIds: [id] } }), /Review the single-editor contract/);
    }
});
