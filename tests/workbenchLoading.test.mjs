import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { runInNewContext } from 'node:vm';

const bundle = await build({
    entryPoints: ['src/components/utils/loadJsonToolWorkbench.ts'], bundle: true, write: false,
    platform: 'node', format: 'cjs', plugins: [{ name: 'module-boundaries', setup(builder) {
        builder.onResolve({ filter: /JsonToolWorkbench\.vue$/ }, () => ({ path: 'workbench', namespace: 'fixture' }));
        builder.onResolve({ filter: /themes\/styles$/ }, () => ({ path: 'theme', namespace: 'fixture' }));
        builder.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ loader: 'js', contents: args.path === 'workbench'
            ? 'recordModuleLoad(); export default { kind: "editor" };'
            : 'export const loadThemeStyles = style => waitForStyles(style);' }));
    } }],
});
function runtime(style) {
    let imports = 0, resolve; const requested = [];
    const styles = new Promise(done => { resolve = done; });
    const module = { exports: {} };
    runInNewContext(bundle.outputFiles[0].text, { module, exports: module.exports,
        document: { body: { dataset: { interfaceStyle: style } } },
        recordModuleLoad: () => imports++, waitForStyles: id => { requested.push(id); return styles; },
    });
    return { api: module.exports, requested, resolve, get imports() { return imports; } };
}

test('concurrent workbench requests share the editor and wait for its saved theme', async () => {
    const run = runtime('glass');
    const first = run.api.loadJsonToolWorkbench();
    const second = run.api.loadJsonToolWorkbench();
    assert.equal(first, second);
    await Promise.resolve(); assert.deepEqual(run.requested, ['glass']);
    let ready = false; void first.then(() => { ready = true; });
    await Promise.resolve(); assert.equal(ready, false, 'editor must wait for its theme');
    run.resolve(); const editor = await first;
    assert.equal(await second, editor); assert.equal(run.imports, 1);
    assert.equal(await run.api.loadJsonToolWorkbench(), editor);
});

test('a cold workbench waits for the saved theme without requiring a warm-up', async () => {
    const run = runtime('paper'); const mounted = run.api.loadJsonToolWorkbench();
    await Promise.resolve(); assert.deepEqual(run.requested, ['paper']);
    run.resolve(); assert.equal((await mounted).kind, 'editor'); assert.equal(run.imports, 1);
});
