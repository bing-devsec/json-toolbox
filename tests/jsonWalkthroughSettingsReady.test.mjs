import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';
import ts from 'typescript';

// Exercise the workbench's actual preparation function and playback cancellation.
// Only the component/theme imports and browser timing are controlled by this test.
const source = await readFile('src/components/JsonToolWorkbench.vue', 'utf8');
const script = source.match(/<script\b[^>]*>([\s\S]*?)<\/script>/)[1];
const ast = ts.createSourceFile('workbench.ts', script, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
let expression;
function find(node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'showWalkthroughSettings') expression = node.initializer.getText(ast);
    ts.forEachChild(node, find);
}
find(ast); assert.ok(expression);
assert(expression.includes("import('./SettingsDialog.vue')"));
expression = expression.replace("import('./SettingsDialog.vue')", 'fixture.loadDialog()');
const bundle = await build({
    stdin: { resolveDir: process.cwd(), loader: 'ts', contents:
        "import { createWalkthroughPlayback } from './src/components/utils/walkthroughPlayback';\n"
        + 'const settingsCollapseActiveNames = fixture.activeName;\n'
        + 'const openSettingsDialog = () => { fixture.opens++; };\n'
        + 'const preloadThemeStyles = () => fixture.loadStyles();\n'
        + 'export const walkthroughPlayback = createWalkthroughPlayback(() => {});\n'
        + 'export const show = ' + expression + ';' },
    bundle: true, write: false, format: 'cjs', platform: 'node',
});
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
function setup() {
    const dialog = deferred(), styles = deferred(), timers = new Map(), scrolls = [];
    let id = 0, clock = 0;
    const fixture = { opens: 0, activeName: { value: 'theme' }, current: true, target: null, visible: false, onQuery: null,
        loadDialog: () => dialog.promise, loadStyles: () => styles.promise };
    const section = { getClientRects: () => fixture.visible ? [{}] : [], scrollIntoView: options => scrolls.push({ ...options }) };
    const module = { exports: {} };
    runInNewContext(bundle.outputFiles[0].text, {
        module, exports: module.exports, fixture, AbortController,
        document: { querySelector: selector => { assert.equal(selector, '[data-guide-section="editor"]'); fixture.onQuery?.(); return fixture.target; } },
        Date: { now: () => clock },
        setTimeout: (callback, delay) => { timers.set(++id, { callback, due: clock + delay }); return id; },
        clearTimeout: token => timers.delete(token),
    });
    const fireNext = () => {
        const next = [...timers].sort((a, b) => a[1].due - b[1].due)[0]; assert.ok(next);
        timers.delete(next[0]); clock = next[1].due; next[1].callback();
    };
    return { fixture, section, timers, scrolls, fireNext,
        load: () => { dialog.resolve({}); styles.resolve(); },
        show: () => module.exports.show({ target: '[data-guide-section="editor"]', settingsSection: 'editor' }, () => fixture.current),
        cancel: () => { fixture.current = false; module.exports.walkthroughPlayback.cancel(); },
    };
}

test('cold settings preparation waits for a rendered section even after several frames and ignores hidden DOM', async () => {
    const f = setup(); let completed = false;
    const result = f.show().then(() => { completed = true; });
    f.load(); await flush();
    assert.equal(f.fixture.opens, 1); assert.equal(f.fixture.activeName.value, 'editor');
    for (let i = 0; i < 3; i++) { f.fireNext(); await flush(); }
    assert.equal(completed, false); assert.deepEqual(f.scrolls, []);
    f.fixture.target = f.section; // The dialog node exists, but ElDialog has not shown it yet.
    f.fireNext(); await flush(); assert.equal(completed, false);
    f.fixture.visible = true;
    f.fireNext(); await result;
    assert.deepEqual(f.scrolls, [{ block: 'nearest' }]); assert.equal(f.timers.size, 0);
});

test('leaving while the settings import is pending never opens or scrolls the late dialog', async () => {
    const f = setup(), result = f.show();
    f.cancel(); f.load(); await result;
    assert.equal(f.fixture.opens, 0); assert.equal(f.fixture.activeName.value, 'theme');
    assert.deepEqual(f.scrolls, []); assert.equal(f.timers.size, 0);
});

test('leaving while waiting for the real section aborts polling and late DOM cannot scroll', async () => {
    const f = setup(), result = f.show();
    const cancelled = assert.rejects(result, /playback cancelled/);
    f.load(); await flush(); assert.equal(f.timers.size, 1);
    f.cancel(); await cancelled;
    f.fixture.target = f.section; f.fixture.visible = true; await flush();
    assert.deepEqual(f.scrolls, []); assert.equal(f.timers.size, 0);
});

test('leaving after the target is found but before the awaiting continuation prevents a stale scroll', async () => {
    const f = setup(); f.fixture.target = f.section; f.fixture.visible = true;
    f.fixture.onQuery = () => queueMicrotask(f.cancel);
    const result = f.show();
    const cancelled = assert.rejects(result, /playback cancelled/);
    f.load(); await cancelled;
    assert.deepEqual(f.scrolls, []); assert.equal(f.timers.size, 0);
});
