import assert from 'node:assert/strict';
import test from 'node:test';
import { assertMonacoSvgScope, assertMonacoSvgBundleScope, readMonacoSvgScope } from '../scripts/vite/monaco-svg-scope.mjs';

test('current import closure, transformed native Diff boundary and reviewed dynamic-label sources match', async () => {
    await assertMonacoSvgScope();
    const scope = readMonacoSvgScope();
    assert.equal(scope.files.length, 626);
    assert.equal(scope.glyphCodepoints.length, 52);
    assert.equal(scope.ids.length, 80);
    assert.equal(Object.keys(scope.applicationFiles).length, 8);
    assertMonacoSvgBundleScope(scope.files.map(f => process.cwd() + '/' + f.file));
});

test('changed application icon entry or glyph dependency scope cannot silently reuse the subset', async () => {
    const scope = readMonacoSvgScope();
    const app = Object.keys(scope.applicationFiles)[0];
    await assert.rejects(assertMonacoSvgScope(process.cwd(), { ...scope, applicationFiles: { ...scope.applicationFiles, [app]: 'changed' } }), /Review icon reachability/);
    await assert.rejects(assertMonacoSvgScope(process.cwd(), { ...scope, glyphCodepoints: scope.glyphCodepoints.slice(1) }), /glyphCodepoints/);
});

test('a new Monaco UI contribution outside the reviewed graph fails production bundle validation', () => {
    assert.throws(() => assertMonacoSvgBundleScope(['/project/node_modules/monaco-editor/esm/vs/editor/contrib/hover/browser/hoverContribution.js']), /newly bundled Monaco UI module/);
    assertMonacoSvgBundleScope(['/project/components/example.ts']);
});
