import assert from 'node:assert/strict';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';

const bundle = await build({ entryPoints: ['src/components/utils/monacoMenuItems.ts'], bundle: true, write: false, format: 'cjs', platform: 'node' });
const selector = '.monaco-menu-container [role="menuitem"]';
function load(document) {
    const module = { exports: {} };
    runInNewContext(bundle.outputFiles[0].text, { module, exports: module.exports, ...(document ? { document } : {}) });
    return module.exports.getMonacoMenuItems;
}

test('server rendering has no document and returns no menu items', () => {
    assert.equal(load()().length, 0);
});

test('looks only in the document and known open Monaco hosts without recursing into unrelated shadow trees', () => {
    const normal = { id: 'normal' }, shadow = { id: 'shadow' }, nested = { id: 'submenu' };
    const queried = [];
    const getItems = load({ querySelectorAll: query => {
        queried.push(['document', query]);
        if (query === selector) return [normal];
        assert.equal(query, '.shadow-root-host');
        return [
            { shadowRoot: null },
            { shadowRoot: { querySelectorAll: inner => { queried.push(['open', inner]); assert.equal(inner, selector); return [shadow, nested]; } } },
        ];
    } });
    assert.deepEqual([...getItems()], [normal, shadow, nested]);
    assert.deepEqual(queried, [['document', selector], ['document', '.shadow-root-host'], ['open', selector]]);
});

test('each query reflects the currently mounted menu and does not retain detached items', () => {
    const item = { id: 'first' }; let current = [item];
    const getItems = load({ querySelectorAll: query => query === selector ? current : [] });
    assert.equal(getItems()[0], item);
    current = [];
    assert.equal(getItems().length, 0);
});
