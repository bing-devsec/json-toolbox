import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { runInNewContext } from 'node:vm';

const bundle = await build({
    stdin: { contents: `export { applyStoredTheme, clearEarlyTheme } from './src/themes/early';`, resolveDir: process.cwd(), loader: 'ts' },
    bundle: true, write: false, platform: 'node', format: 'cjs',
});
const source = bundle.outputFiles[0].text;

function run(stored) {
    const attributes = new Map();
    const classes = new Map();
    const variables = new Map();
    const document = {
        body: {
            dataset: {},
            classList: { toggle: (name, value) => classes.set(name, Boolean(value)) },
            style: { setProperty: (name, value) => variables.set(name, value), removeProperty: name => variables.delete(name) },
        },
    };
    const localStorage = { getItem: () => stored };
    const module = { exports: {} };
    runInNewContext(source, { module, exports: module.exports, document, localStorage });
    module.exports.applyStoredTheme();
    return { body: document.body, attributes, classes, variables, api: module.exports };
}

test('stored appearance is applied before the workbench renders', () => {
    const result = run(JSON.stringify({ interfaceStyle: 'retro', themeMode: 'dark' }));
    assert.equal(result.body.dataset.interfaceStyle, 'retro');
    assert.equal(result.classes.get('json-tool-theme-dark'), true);
    assert.equal(result.variables.get('--json-tool-surface'), '#1b2d42');
    assert.equal(result.variables.get('--theme-accent'), '#a9d0ff');
    assert.equal([...result.variables.keys()].some(key => key.startsWith('--glass-')), false);
});

test('the workbench can release early theme variables so default stays clean', () => {
    const result = run(JSON.stringify({ interfaceStyle: 'glass', themeMode: 'dark' }));
    assert.ok(result.variables.size > 0);
    result.api.clearEarlyTheme();
    assert.equal(result.variables.size, 0);
});

test('missing or invalid stored appearance falls back to the default theme', () => {
    const result = run('{not json');
    assert.equal(result.body.dataset.interfaceStyle, 'default');
    assert.equal(result.classes.get('json-tool-theme-dark'), false);
    assert.equal(result.variables.get('--el-color-primary'), '#1D6FCC');
});
