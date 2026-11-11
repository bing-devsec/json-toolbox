import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getSourceInfo } from '../scripts/package-info.mjs';

function createFixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'json-package-source-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    for (const directory of ['src', 'public', 'scripts', 'assets', 'reports']) {
        fs.mkdirSync(path.join(root, directory));
    }
    const scope = path.join(root, 'reports/monaco-svg-scope.json');
    fs.writeFileSync(scope, JSON.stringify({ glyphCodepoints: ['0xeab4'] }));
    return { root, scope };
}

test('changing the reviewed SVG build input invalidates the package source fingerprint', t => {
    const { root, scope } = createFixture(t);
    const before = getSourceInfo(root);
    fs.writeFileSync(scope, JSON.stringify({ glyphCodepoints: ['0xeab4', '0xeab6'] }));
    const after = getSourceInfo(root);
    assert.notEqual(after.sourceSha256, before.sourceSha256);
    assert.equal(after.sourceFileCount, before.sourceFileCount);
});

test('unrelated historical reports do not change the package source fingerprint', t => {
    const { root } = createFixture(t);
    const before = getSourceInfo(root);
    fs.writeFileSync(path.join(root, 'reports/manual-review.md'), 'Historical UI review');
    assert.deepEqual(getSourceInfo(root), before);
});
