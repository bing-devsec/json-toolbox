import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { runInNewContext } from 'node:vm';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
const bundle = await build({
    stdin: { contents: `export { useEditorContextMenu } from './src/components/composables/useEditorContextMenu';`, resolveDir: process.cwd(), loader: 'ts' },
    bundle: true, write: false, platform: 'node', format: 'cjs',
    plugins: [{ name: 'context-fixtures', setup(build) {
        build.onResolve({ filter: /(?:loadJsonToolMessageBox|overlayTarget|jsonSort|jsonDiffSort)$/ }, args => ({ path: args.path, namespace: 'fixture' }));
        build.onResolve({ filter: /^vue$/ }, () => ({ path: 'vue', namespace: 'fixture' }));
        build.onResolve({ filter: /^js-base64$/ }, () => ({ path: 'base64', namespace: 'fixture' }));
        build.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => ({ contents:
            path === 'vue' ? 'export const onBeforeUnmount = fn => fixture.hooks.push(fn); export const nextTick = fn => Promise.resolve().then(fn);' :
            path.endsWith('loadJsonToolMessageBox') ? 'export const loadJsonToolMessageBox = () => fixture.loadMessageBox();' :
            path.endsWith('overlayTarget') ? 'export const getJsonToolOverlayTarget = () => undefined;' :
            path.endsWith('jsonDiffSort') ? 'export const sortJsonArrayByCanonicalKey = array => array;' :
            path.endsWith('jsonSort') ? 'export const sortStringLines = text => text;' :
            'fixture.base64Loads++; export const Base64 = { encode: text => `encoded:${text}`, decode: text => `decoded:${text}` };' }));
    } }],
});
function setup(overrides = {}) {
    const fixture = { hooks: [], base64Loads: 0, prompts: 0, errors: [], successes: [], outputs: [],
        loadMessageBox: async () => ({ prompt: async () => { fixture.prompts++; return { value: 'key' }; } }),
    };
    const module = { exports: {} };
    runInNewContext(bundle.outputFiles[0].text, { module, exports: module.exports, fixture, console, AbortController });
    const actions = new Map();
    const model = { version: 1, disposed: false, getVersionId() { return this.version; }, isDisposed() { return this.disposed; }, getValueInRange: () => 'source' };
    const editor = { model, edits: [], addAction: action => actions.set(action.id, action), getSelection: () => ({}), getModel() { return this.model; }, executeEdits(...args) { this.edits.push(args); } };
    const outputModel = { ...model };
    const outputEditor = { getModel: () => outputModel };
    const messages = new Proxy({}, { get: (_, key) => key === 'msgExtractValuesByKeySuccess' ? () => 'success' : key });
    const context = {
        getInputEditor: () => editor, getOutputEditor: () => outputEditor,
        settingsTxt: { value: messages }, sortMethod: { value: 'dictionary' }, sortOrder: { value: 'asc' }, affix: {},
        showMessageSuccess: value => fixture.successes.push(value), showMessageError: value => fixture.errors.push(value),
        showMessageWarning: () => {}, getEditorSelectedOrFullSource: () => ({ text: '{"key":"value"}', isSelection: false }),
        preprocessJSON: () => ({ data: { key: 'value' }, escapeMap: new Map() }),
        writeProcessingResultToOutput: text => { fixture.outputs.push(text); return true; },
        extractValuesByKey: () => ({ values: ['value'], skippedComplex: 0 }),
        formatJsonValueForContextAction: () => '["value"]',
    };
    Object.assign(context, overrides);
    return { fixture, editor, model, outputModel, context, actions, menu: module.exports.useEditorContextMenu(context) };
}

test('registering context actions does not load MessageBox or Base64', () => {
    const { menu, editor, fixture } = setup();
    menu.registerProcessingActions(editor); menu.registerEncodingActions(editor);
    assert.equal(fixture.prompts, 0); assert.equal(fixture.base64Loads, 0);
});

test('Base64 first-use conversion preserves output while stale model edits are ignored', async () => {
    for (const action of ['base64-encode', 'base64-decode']) {
        for (const stale of ['none', 'edit', 'dispose', 'replace']) {
            const { menu, editor, model, actions, fixture } = setup(); menu.registerEncodingActions(editor);
            const pending = actions.get(action).run(editor);
            if (stale === 'edit') model.version++;
            if (stale === 'dispose') model.disposed = true;
            if (stale === 'replace') editor.model = { ...model };
            await pending;
            assert.equal(editor.edits.length, stale === 'none' ? 1 : 0, `${action}/${stale}`);
            assert.equal(fixture.errors.length, 0);
        }
    }
});

test('failed MessageBox loading is visible and retryable while cancellation stays quiet', async () => {
    const { menu, editor, fixture, actions } = setup(); menu.registerProcessingActions(editor);
    const action = actions.get('json-tool-extract-values-by-key');
    fixture.loadMessageBox = async () => { throw Error('network'); };
    await action.run(editor);
    assert.deepEqual(fixture.errors, ['msgUnknownError']);
    fixture.errors.length = 0;
    fixture.loadMessageBox = async () => ({ prompt: async () => { throw 'cancel'; } });
    await action.run(editor);
    assert.equal(fixture.errors.length, 0);
});

const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
test('extract prompt ignores stale input/output and unmount at both await boundaries', async () => {
    for (const stage of ['import', 'prompt']) for (const stale of ['input', 'output', 'replace', 'unmount']) {
        const f = setup(); f.menu.registerProcessingActions(f.editor);
        const wait = deferred();
        const box = { prompt: async () => { f.fixture.prompts++; return stage === 'prompt' ? wait.promise : { value: 'key' }; } };
        f.fixture.loadMessageBox = () => stage === 'import' ? wait.promise : Promise.resolve(box);
        const pending = f.actions.get('json-tool-extract-values-by-key').run();
        for (let i = 0; i < 8; i++) await Promise.resolve();
        if (stale === 'input') f.model.version++;
        if (stale === 'output') f.outputModel.version++;
        if (stale === 'replace') f.context.getInputEditor = () => null;
        if (stale === 'unmount') f.fixture.hooks.forEach(fn => fn());
        wait.resolve(stage === 'import' ? box : { value: 'key' }); await pending;
        assert.equal(f.fixture.outputs.length, 0, `${stage}/${stale}`);
        assert.equal(f.fixture.prompts, stage === 'import' ? 0 : 1, `${stage}/${stale}`);
        assert.equal(f.fixture.errors.length, 0);
    }
});
test('new extract request supersedes older prompt and stale import rejection is quiet', async () => {
    const f = setup(); f.menu.registerProcessingActions(f.editor);
    const wait = deferred(); f.fixture.loadMessageBox = () => wait.promise;
    const old = f.actions.get('json-tool-extract-values-by-key').run();
    f.fixture.loadMessageBox = async () => ({ prompt: async () => ({ value: 'key' }) });
    await f.actions.get('json-tool-extract-values-by-key').run();
    wait.reject(Error('stale network')); await old;
    assert.equal(f.fixture.outputs.length, 1); assert.equal(f.fixture.errors.length, 0);
});


test('explicit extraction cancellation stops a delayed import before a prompt can appear', async () => {
    const f = setup(); f.menu.registerProcessingActions(f.editor);
    const waiting = deferred();
    f.fixture.loadMessageBox = () => waiting.promise;
    const running = f.actions.get('json-tool-extract-values-by-key').run();
    f.menu.cancelPendingExtraction();
    waiting.resolve({ prompt: async () => { f.fixture.prompts++; return { value: 'key' }; } });
    await running;
    assert.equal(f.fixture.prompts, 0);
    assert.deepEqual(f.fixture.outputs, []);
    assert.deepEqual(f.fixture.errors, []);
});

test('explicit cancellation settles an open prompt even when its provider has not resolved', { timeout: 1500 }, async () => {
    const f = setup(); f.menu.registerProcessingActions(f.editor);
    const waiting = deferred();
    let promptOptions;
    f.fixture.loadMessageBox = async () => ({ prompt: (_message, _title, options) => {
        promptOptions = options; return waiting.promise;
    } });
    const running = f.actions.get('json-tool-extract-values-by-key').run();
    for (let i = 0; i < 8; i++) await Promise.resolve();
    assert.match(promptOptions.customClass, /json-tool-extract-values-prompt/);
    assert.equal(promptOptions.confirmButtonClass, 'json-tool-extract-confirm');
    assert.equal(promptOptions.cancelButtonClass, 'json-tool-extract-cancel');
    f.menu.cancelPendingExtraction();
    await running;
    waiting.resolve({ value: 'key' });
    await Promise.resolve();
    assert.deepEqual(f.fixture.outputs, []);
    assert.deepEqual(f.fixture.successes, []);
    assert.deepEqual(f.fixture.errors, []);
});

test('reentry cancels the old open prompt and old finally cannot detach cancellation from the new prompt', { timeout: 1500 }, async () => {
    const f = setup(); f.menu.registerProcessingActions(f.editor);
    const first = deferred(), second = deferred();
    let opens = 0;
    f.fixture.loadMessageBox = async () => ({ prompt: () => ++opens === 1 ? first.promise : second.promise });
    const action = f.actions.get('json-tool-extract-values-by-key');
    const oldRun = action.run();
    for (let i = 0; i < 8; i++) await Promise.resolve();
    const newRun = action.run();
    await oldRun;
    for (let i = 0; i < 8; i++) await Promise.resolve();
    assert.equal(opens, 2);
    f.menu.cancelPendingExtraction();
    await newRun;
    first.resolve({ value: 'old' }); second.resolve({ value: 'new' });
    await Promise.resolve();
    assert.deepEqual(f.fixture.outputs, []);
    assert.deepEqual(f.fixture.errors, []);
});

// Execute the workbench's actual extraction/formatting functions, not copies of
// their algorithms. This checks the menu against the same lossless JSON engine.
const workbenchSource = await readFile('src/components/JsonToolWorkbench.vue', 'utf8');
const script = workbenchSource.match(/<script\b[^>]*>([\s\S]*?)<\/script>/)[1];
const ast = ts.createSourceFile('workbench.ts', script, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const expressions = new Map();
const findExpressions = node => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer
        && ['extractValuesByKey', 'formatJsonValueForContextAction'].includes(node.name.text)) {
        expressions.set(node.name.text, node.initializer.getText(ast));
    }
    ts.forEachChild(node, findExpressions);
};
findExpressions(ast);
assert.equal(expressions.size, 2);
const realEngine = await build({
    stdin: { resolveDir: process.cwd(), loader: 'ts', contents:
        "import { useJsonEngine } from './src/components/composables/useJsonEngine';\n"
        + "const jsonEngine = useJsonEngine({indentSize:{value:2},arrayNewLine:{value:true},preserveNumberLiterals:{value:true},encodingMode:{value:false}});\n"
        + 'export const parse = jsonEngine.parse;\n'
        + [...expressions].map(([name, expression]) => 'export const ' + name + ' = ' + expression + ';').join('\n') },
    bundle: true, write: false, platform: 'node', format: 'esm',
});
const actual = await import('data:text/javascript;base64,' + Buffer.from(realEngine.outputFiles[0].text).toString('base64'));

async function runActualExtraction(raw, key) {
    const f = setup({
        getEditorSelectedOrFullSource: () => ({ text: raw, isSelection: false }),
        preprocessJSON: actual.parse,
        formatJsonValueForContextAction: actual.formatJsonValueForContextAction,
        extractValuesByKey: actual.extractValuesByKey,
    });
    f.menu.registerProcessingActions(f.editor);
    f.fixture.loadMessageBox = async () => ({ prompt: async () => ({ value: key }) });
    await f.actions.get('json-tool-extract-values-by-key').run();
    assert.deepEqual(f.fixture.errors, []);
    assert.equal(f.fixture.outputs.length, 1);
    return f.fixture.outputs[0];
}

test('real extraction walks nested records and arrays in source order', async () => {
    const result = await runActualExtraction('{"users":[{"name":"Ada"},{"name":"Lin"}],"meta":{"name":"Toolkit"}}', 'name');
    assert.deepEqual(JSON.parse(result), ['Ada', 'Lin', 'Toolkit']);
});

test('real extraction and formatter preserve numeric lexemes and keep quoted numbers as strings', async () => {
    const result = await runActualExtraction('{"name":9007199254740993,"nested":{"name":-0},"more":[{"name":1.2300},{"name":1e+30}],"quoted":{"name":"9007199254740993"}}', 'name');
    assert.equal(result, '[\n  9007199254740993,\n  -0,\n  1.2300,\n  1e+30,\n  "9007199254740993"\n]');
});
