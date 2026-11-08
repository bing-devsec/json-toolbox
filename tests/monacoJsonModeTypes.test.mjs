import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import test from 'node:test';
import { transform } from 'esbuild';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import ts from 'typescript';
import { pruneUnusedJsonModeTypes } from '../scripts/vite/monaco-json-mode-types.mjs';
const root = path.dirname(import.meta.dirname);
const file = path.join(root, 'node_modules/monaco-editor/esm/vs/language/json/jsonMode.js');
test('pruned JSON mode preserves its public providers, tokenization, worker routing and lifecycle', async () => {
    const original = fs.readFileSync(file, 'utf8'),
        patched = pruneUnusedJsonModeTypes(original, file);
    const result = {
        checks: []
    };
    function ok(label) {
        result.checks.push(label);
    }
    assert.equal(pruneUnusedJsonModeTypes(original, file + '?v=1'), patched);
    assert.equal(pruneUnusedJsonModeTypes(original, file.replaceAll('/', '\\')), patched);
    assert.equal(pruneUnusedJsonModeTypes(original, file.replace('/monaco-editor/', '/monaco-editor-other/')), null);
    for (const changed of [original + '\n', original.replace('setupMode', 'setupModeChanged'), original.replace('WorkspaceEdit2.is = is;', 'globalThis.sideEffect = true; WorkspaceEdit2.is = is;')]) assert.throws(() => pruneUnusedJsonModeTypes(changed, file), /source SHA-256 changed/);
    ok('exact path/query/Windows normalization and changed source rejection');
    const marker = '// node_modules/vscode-languageserver-types/lib/esm/main.js',
        endMarker = '// src/language/common/lspLanguageFeatures.ts';
    assert.equal(patched.slice(0, patched.indexOf(marker)), original.slice(0, original.indexOf(marker)));
    assert.equal(patched.slice(patched.indexOf(endMarker)), original.slice(original.indexOf(endMarker)));
    ok('every byte outside the private embedded LSP library remains identical');
    const removedNames = new Set([
        'DocumentUri', 'URI', 'Location', 'LocationLink', 'ColorInformation', 'ColorPresentation',
        'FoldingRange', 'DiagnosticRelatedInformation', 'DiagnosticTag', 'CodeDescription', 'Diagnostic',
        'Command', 'TextEdit', 'ChangeAnnotation', 'ChangeAnnotationIdentifier', 'AnnotatedTextEdit',
        'TextDocumentEdit', 'CreateFile', 'RenameFile', 'DeleteFile', 'WorkspaceEdit', 'TextDocumentIdentifier',
        'VersionedTextDocumentIdentifier', 'OptionalVersionedTextDocumentIdentifier', 'TextDocumentItem',
        'MarkupKind', 'MarkupContent', 'CompletionItemTag', 'InsertReplaceEdit', 'InsertTextMode',
        'CompletionItemLabelDetails', 'CompletionItem', 'CompletionList', 'MarkedString', 'Hover',
        'ParameterInformation', 'SignatureInformation', 'DocumentHighlight', 'SymbolTag', 'SymbolInformation',
        'WorkspaceSymbol', 'DocumentSymbol', 'CodeActionKind', 'CodeActionTriggerKind', 'CodeActionContext',
        'CodeAction', 'CodeLens', 'FormattingOptions', 'DocumentLink', 'SelectionRange', 'SemanticTokenTypes',
        'SemanticTokenModifiers', 'SemanticTokens', 'InlineValueText', 'InlineValueVariableLookup',
        'InlineValueEvaluatableExpression', 'InlineValueContext', 'InlayHintKind', 'InlayHintLabelPart',
        'InlayHint', 'StringValue', 'InlineCompletionItem', 'InlineCompletionList',
        'InlineCompletionTriggerKind', 'SelectedCompletionInfo', 'InlineCompletionContext', 'WorkspaceFolder',
        'TextDocument', 'FullTextDocument',
    ]);
    const dropped = [...removedNames];
    const sf = ts.createSourceFile('pruned.js', patched, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    assert.equal(sf.parseDiagnostics.length, 0);
    const residual = [];
    function walk(n) {
        if (ts.isIdentifier(n) && dropped.includes(n.text)) residual.push(n.text);
        ts.forEachChild(n, walk);
    }
    walk(sf);
    assert.deepEqual(residual, []);
    ok('no residual reference to any of the 69 removed private units');
    function createHost() {
        const log = [],
            providers = {},
            listeners = new Set(),
            intervals = new Map();
        let next = 0;
        const disposable = kind => ({
            dispose() {
                log.push(['dispose', kind]);
            }
        });
        class Range {
            constructor(startLineNumber, startColumn, endLineNumber, endColumn) {
                Object.assign(this, {
                    startLineNumber,
                    startColumn,
                    endLineNumber,
                    endColumn
                });
            }
        }
        const enums = new Proxy({}, {
            get: (_t, k) => String(k)
        });
        const languages = {
            CompletionItemKind: enums,
            CompletionItemInsertTextRule: enums,
            DocumentHighlightKind: enums,
            SymbolKind: enums,
            FoldingRangeKind: enums
        };
        for (const method of ['registerDocumentFormattingEditProvider', 'registerDocumentRangeFormattingEditProvider', 'registerCompletionItemProvider', 'registerHoverProvider', 'registerDocumentSymbolProvider', 'setTokensProvider', 'registerColorProvider', 'registerFoldingRangeProvider', 'setLanguageConfiguration', 'registerSelectionRangeProvider']) languages[method] = (id, provider) => {
            providers[method] = provider;
            log.push(['register', method, id]);
            return disposable(method);
        };
        const editor = {
            getModels: () => [],
            getModel: () => null,
            createWebWorker(options) {
                log.push(['createWebWorker', options]);
                return {
                    getProxy: () => Promise.resolve({
                        fixture: true
                    }),
                    withSyncedResources(resources) {
                        log.push(['sync', resources.map(String)]);
                        return Promise.resolve();
                    },
                    dispose() {
                        log.push(['dispose', 'worker']);
                    }
                };
            }
        };
        for (const name of ['onDidCreateModel', 'onWillDisposeModel', 'onDidChangeModelLanguage']) editor[name] = () => disposable(name);
        editor.setModelMarkers = (...args) => log.push(['markers', ...args]);
        const core = {
            Range,
            Uri: {
                parse: value => ({
                    value,
                    toString() {
                        return value;
                    }
                })
            },
            MarkerSeverity: enums,
            languages,
            editor
        };
        const defaults = {
            languageId: 'json',
            diagnosticsOptions: {
                enableSchemaRequest: false,
                validate: true
            },
            modeConfiguration: {
                documentFormattingEdits: true,
                documentRangeFormattingEdits: true,
                completionItems: true,
                hovers: true,
                documentSymbols: true,
                tokens: true,
                colors: true,
                foldingRanges: true,
                diagnostics: true,
                selectionRanges: true
            },
            onDidChange(fn) {
                listeners.add(fn);
                return {
                    dispose() {
                        listeners.delete(fn);
                    }
                };
            }
        };
        return {
            core,
            providers,
            defaults,
            log,
            intervals,
            listeners,
            window: {
                setInterval(fn, ms) {
                    const id = ++next;
                    intervals.set(id, {
                        fn,
                        ms
                    });
                    return id;
                }
            },
            clearInterval(id) {
                intervals.delete(id);
            }
        };
    }
    async function load(code) {
        const host = createHost();
        const exports = {},
            module = {
                exports
            };
        const compiled = (await transform(code, {
            format: 'cjs',
            target: 'es2022'
        })).code;
        const context = vm.createContext({
            exports,
            module,
            require: id => {
                assert.equal(id, '../../editor/editor.api.js');
                return host.core;
            },
            console,
            window: host.window,
            clearInterval: host.clearInterval,
            setTimeout,
            clearTimeout
        });
        vm.runInContext(compiled, context);
        return {
            host,
            api: module.exports
        };
    }
    const before = await load(original),
        after = await load(patched);
    assert.deepEqual(Object.keys(after.api), Object.keys(before.api));
    for (const name of Object.keys(before.api)) {
        assert.equal(after.api[name].toString(), before.api[name].toString(), name);
        if (before.api[name].prototype) assert.deepEqual(Object.getOwnPropertyNames(after.api[name].prototype), Object.getOwnPropertyNames(before.api[name].prototype), name);
    }
    ok('all 21 export names, public function/class bodies, and prototype members identical');
    const norm = x => x === undefined ? '__undefined' : JSON.parse(JSON.stringify(x));
    const lspRange = {
            start: {
                line: 1,
                character: 2
            },
            end: {
                line: 3,
                character: 4
            }
        },
        monoRange = {
            startLineNumber: 2,
            startColumn: 3,
            endLineNumber: 4,
            endColumn: 5
        };
    const model = {
        uri: {
            toString: () => 'inmemory://json/sample.json'
        },
        getWordUntilPosition: () => ({
            startColumn: 1,
            endColumn: 4
        })
    };
    const position = {
        lineNumber: 2,
        column: 3
    };
    let fixtureCount = 0;
    async function compareProvider(className, method, workerMethod, fixtures, args = []) {
        for (const fixture of fixtures) {
            const values = [];
            for (const runtime of [before, after]) {
                const calls = [];
                const worker = new Proxy({}, {
                    get: (_t, name) => name === 'then' ? undefined : (...a) => {
                        calls.push([name, ...a]);
                        return Promise.resolve(fixture);
                    }
                });
                const provider = new runtime.api[className](async uri => {
                    calls.push(['worker', String(uri)]);
                    return worker;
                }, [' ', ':', '"']);
                let response;
                try {
                    response = {
                        value: norm(await provider[method](model, ...args))
                    };
                } catch (error) {
                    response = {
                        error: error.name,
                        message: error.message
                    };
                }
                assert.equal(response.error, undefined, `${className}/${method} must succeed for its valid/null fixture`);
                assert.equal(calls[1]?.[0], workerMethod, `${className}/${method} calls its expected worker method`);
                values.push({
                    response,
                    calls: norm(calls)
                });
            }
            assert.deepEqual(values[1], values[0], `${className}/${method}/${fixtureCount}`);
            fixtureCount++;
        }
    }
    const edits = [{
        range: lspRange,
        newText: 'replacement'
    }];
    const completions = [null, ...Array.from({
        length: 28
    }, (_, i) => ({
        isIncomplete: !!(i % 2),
        items: [{
            label: 'key',
            kind: i,
            insertTextFormat: i % 2 + 1,
            insertText: 'value',
            command: {
                command: i % 2 ? 'editor.action.triggerSuggest' : 'ignored',
                title: 'Suggest',
                arguments: ['x']
            },
            documentation: {
                kind: 'markdown',
                value: '**doc**'
            },
            additionalTextEdits: edits,
            textEdit: i % 2 ? {
                newText: 'r',
                range: lspRange
            } : {
                newText: 'r',
                insert: lspRange,
                replace: lspRange
            }
        }]
    }))];
    await compareProvider('CompletionAdapter', 'provideCompletionItems', 'doComplete', completions, [position, {}, {}]);
    await compareProvider('HoverAdapter', 'provideHover', 'doHover', [null, ...['plain', {
        kind: 'plaintext',
        value: '*hello*.'
    }, {
        kind: 'markdown',
        value: '**md**'
    }, {
        language: 'json',
        value: '{}'
    }, ['one', {
        language: 'js',
        value: 'true'
    }]].map(contents => ({
        range: lspRange,
        contents
    }))], [position, {}]);
    await compareProvider('DocumentHighlightAdapter', 'provideDocumentHighlights', 'findDocumentHighlights', [null, [], ...Array.from({
        length: 6
    }, (_, kind) => [{
        range: lspRange,
        kind
    }])], [position, {}]);
    await compareProvider('DefinitionAdapter', 'provideDefinition', 'findDefinition', [null, {
        uri: 'file:///definition.json',
        range: lspRange
    }], [position, {}]);
    await compareProvider('ReferenceAdapter', 'provideReferences', 'findReferences', [null, [], [{
        uri: 'file:///reference.json',
        range: lspRange
    }]], [position, {}, {}]);
    await compareProvider('RenameAdapter', 'provideRenameEdits', 'doRename', [null, {}, {
        changes: {
            'file:///rename.json': edits
        }
    }], [position, 'newName', {}]);
    const symbols = [null, [], ...Array.from({
        length: 28
    }, (_, kind) => [{
        name: 'symbol',
        kind,
        containerName: 'parent',
        location: {
            uri: 'file:///s.json',
            range: lspRange
        }
    }, {
        name: 'nested',
        kind,
        range: lspRange,
        selectionRange: lspRange,
        children: [{
            name: 'child',
            kind,
            range: lspRange,
            selectionRange: lspRange,
            children: []
        }]
    }])];
    await compareProvider('DocumentSymbolAdapter', 'provideDocumentSymbols', 'findDocumentSymbols', symbols, [{}]);
    await compareProvider('DocumentLinkAdapter', 'provideLinks', 'findDocumentLinks', [null, [], [{
        range: lspRange,
        target: 'https://example.invalid'
    }]], [{}]);
    await compareProvider('DocumentFormattingEditProvider', 'provideDocumentFormattingEdits', 'format', [null, [], edits], [{
        tabSize: 2,
        insertSpaces: true
    }, {}]);
    await compareProvider('DocumentRangeFormattingEditProvider', 'provideDocumentRangeFormattingEdits', 'format', [null, [], edits], [monoRange, {
        tabSize: 4,
        insertSpaces: false
    }, {}]);
    await compareProvider('DocumentColorAdapter', 'provideDocumentColors', 'findDocumentColors', [null, [], [{
        color: {
            red: 1,
            green: .5,
            blue: 0,
            alpha: 1
        },
        range: lspRange
    }]], [{}]);
    await compareProvider('DocumentColorAdapter', 'provideColorPresentations', 'getColorPresentations', [null, [], [{
        label: 'rgb()',
        textEdit: edits[0],
        additionalTextEdits: edits
    }]], [{
        color: {
            red: 1,
            green: 0,
            blue: 0,
            alpha: 1
        },
        range: monoRange
    }, {}]);
    await compareProvider('FoldingRangeAdapter', 'provideFoldingRanges', 'getFoldingRanges', [null, [], ...['comment', 'imports', 'region', 'unknown', undefined].map(kind => [{
        startLine: 1,
        endLine: 9,
        kind
    }])], [{}, {}]);
    await compareProvider('SelectionRangeAdapter', 'provideSelectionRanges', 'getSelectionRanges', [null, [], [{
        range: lspRange,
        parent: {
            range: lspRange
        }
    }]], [[position], {}]);
    ok(`${fixtureCount} provider fixtures across all 15 provider methods: same results/errors and worker calls`);
    for (const runtime of [before, after]) {
        const {
            api,
            host
        } = runtime;
        await assert.rejects(api.getWorker(), e => e === 'JSON not registered!');
        runtime.disposable = api.setupMode(host.defaults);
        assert.equal(host.intervals.size, 1);
        runtime.tokenizer = host.providers.setTokensProvider;
        const worker = await api.getWorker();
        await worker(model.uri);
        host.defaults.modeConfiguration = {
            ...host.defaults.modeConfiguration,
            diagnostics: false,
            documentSymbols: false,
            colors: false
        };
        for (const listener of [...host.listeners]) listener(host.defaults);
    }
    assert.deepEqual(norm(after.host.log), norm(before.host.log));
    ok('setupMode provider registration, live mode update, worker creation/model sync agree');
    let seed = 723812;
    function rnd(n) {
        seed = Math.imul(seed, 1664525) + 1013904223 >>> 0;
        return seed % n;
    }
    const atoms = ['{', '}', '[', ']', ':', ',', '"hello"', '"key"', '12', '-1.5e+2', 'true', 'false', 'null', '/* comment */', '//end', '"unterminated', '\\n', ' ', '\t', '😺', '中'];
    let tokenLines = 0;
    for (let sample = 0; sample < 400; sample++) {
        let states = [before.tokenizer.getInitialState(), after.tokenizer.getInitialState()];
        for (let line = 0; line < 15; line++) {
            let text = '';
            for (let i = 0, len = rnd(12); i < len; i++) text += atoms[rnd(atoms.length)];
            const results = [before.tokenizer, after.tokenizer].map((t, i) => t.tokenize(text, states[i]));
            assert.deepEqual(norm(results[1]), norm(results[0]), text);
            states = results.map(r => r.endState);
            tokenLines++;
        }
    }
    ok(`${tokenLines} seeded valid/malformed token lines, stateful tokens and end states agree`);
    let diagnosticsCases = 0;
    for (const severity of [undefined, 0, 1, 2, 3, 4, 99]) {
        const outputs = [];
        for (const runtime of [before, after]) {
            const {
                host,
                api
            } = runtime;
            host.core.editor.getModel = () => ({
                getLanguageId: () => 'json'
            });
            const worker = async () => ({
                doValidation: async () => [{
                    range: lspRange,
                    severity,
                    code: 17,
                    message: 'diagnostic',
                    source: 'json'
                }, {
                    range: lspRange,
                    severity,
                    code: 'schema',
                    message: 'schema description remains',
                    source: 'json'
                }]
            });
            const adapter = new api.DiagnosticsAdapter('json', worker, host.defaults.onDidChange);
            const start = host.log.length;
            adapter._doValidate(model.uri, 'json');
            await new Promise(resolve => setImmediate(resolve));
            outputs.push(norm(host.log.slice(start)));
            adapter.dispose();
        }
        assert.deepEqual(outputs[1], outputs[0]);
        diagnosticsCases++;
    }
    ok(`${diagnosticsCases} diagnostics severity/code fixtures preserve marker results`);
    for (const runtime of [before, after]) runtime.disposable.dispose();
    assert.deepEqual(norm(after.host.log), norm(before.host.log));
    assert.equal(before.host.intervals.size, 0);
    assert.equal(after.host.intervals.size, 0);
    ok('provider/worker/timer disposal agrees');
    result.diagnosticsCases = diagnosticsCases;
    result.fixtureCount = fixtureCount;
    result.tokenLines = tokenLines;
    result.removedUnits = dropped.length;
    assert.equal(result.removedUnits, 69);
    assert.equal(result.fixtureCount, 106);
    assert.equal(result.tokenLines, 6000);
    assert.equal(result.diagnosticsCases, 7);
});

// Test the second layer of checks without adding any production hash override.
// Only this in-memory test copy gets the fixture's source hash; the real adapter
// still rejects every changed installed source before it reaches these checks.
async function adapterForReviewedFixture(fixture) {
    const adapterFile = path.join(root, 'scripts/vite/monaco-json-mode-types.mjs');
    const original = fs.readFileSync(adapterFile, 'utf8');
    const digest = createHash('sha256').update(fixture).digest('hex');
    const rewritten = original.replace(/const SOURCE_SHA256 = '[a-f0-9]{64}';/, `const SOURCE_SHA256 = '${digest}';`);
    assert.notEqual(rewritten, original);
    const code = (await transform(rewritten, { format: 'cjs', target: 'es2022' })).code;
    const module = { exports: {} };
    const require = createRequire(adapterFile);
    vm.runInNewContext(code, { module, exports: module.exports, require });
    return module.exports.pruneUnusedJsonModeTypes;
}

test('independent source review rejects newly live namespaces and observable initializer effects', async () => {
    const original = fs.readFileSync(file, 'utf8');
    const fixtures = [
        ['export {\n  CompletionAdapter,', 'export {\n  WorkspaceEdit,\n  CompletionAdapter,', /reachability changed/],
        ['WorkspaceEdit2.is = is;', 'globalThis.touched = true; WorkspaceEdit2.is = is;', /own plain object/],
        ['WorkspaceEdit2.is = is;', 'sideEffect(); WorkspaceEdit2.is = is;', /eager namespace statement/],
        ['WorkspaceEdit2.is = is;', 'WorkspaceEdit2.is = sideEffect();', /literal or local function/],
        ['})(WorkspaceEdit || (WorkspaceEdit = {}));', '})(WorkspaceEdit || (WorkspaceEdit = { changed: true }));', /fresh plain object/],
        ['function(WorkspaceEdit2)', 'function(WorkspaceEdit2 = sideEffect())', /IIFE shape/],
        ['var FullTextDocument = class {', 'var FullTextDocument = class { static { sideEffect(); }', /eager class effect/],
        ['var FullTextDocument = class {', 'var FullTextDocument = class { [sideEffect()]() {}', /eager class effect/],
        ['function setupMode(defaults) {', 'function setupMode(defaults) { eval("WorkspaceEdit");', /dynamic evaluation/],
        ['function setupMode(defaults) {', 'function setupMode(defaults) { new Function("return WorkspaceEdit");', /dynamic evaluation/],
        ['// src/language/common/lspLanguageFeatures.ts', 'var ExtraPrivateUnit = 1;\n// src/language/common/lspLanguageFeatures.ts', /declaration count changed/],
    ];
    for (const [needle, replacement, expected] of fixtures) {
        assert(original.includes(needle), needle);
        const fixture = original.replace(needle, replacement);
        const adapter = await adapterForReviewedFixture(fixture);
        assert.throws(() => adapter(fixture, file), expected, replacement);
    }
});
