import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { build } from 'vite';
import { monacoFontPlugin } from '../scripts/vite/monaco-font.mjs';

const cssPath = path.resolve('node_modules/monaco-editor/esm/vs/base/browser/ui/codicons/codicon/codicon.css');
const source = readFileSync(cssPath, 'utf8');
test('font evidence matches the shipped complete font and the unchanged source', () => {
    const report = JSON.parse(readFileSync('reports/font-validation.json', 'utf8'));
    const font = readFileSync('assets/fonts/codicon-0.52.2.woff2');
    const original = readFileSync(path.join(path.dirname(cssPath), 'codicon.ttf'));
    const hash = bytes => createHash('sha256').update(bytes).digest('hex');
    assert.equal(report.woff2Sha256, hash(font));
    assert.equal(report.sourceSha256, hash(original));
    assert.equal(report.woff2Bytes, font.length);
    assert.equal(report.glyphs, 462);
    assert.equal(report.codepoints, 462);
    assert.equal(report.savedBytes, report.baselineCompleteWoff2.bytes - font.length);
    assert.equal(report.savedBytes, 1728);
    assert.deepEqual(report.retainedCmaps, [[0, 3, 4], [1, 0, 0], [3, 1, 4]]);
    assert.deepEqual(report.identicalDecodedTables, ['GSUB', 'OS/2', 'glyf', 'hhea', 'hmtx', 'loca', 'maxp', 'name', 'post']);
    assert.equal(report.rasterValidation.comparisons, 3696);
    assert.match(report.rasterValidation.result, /not a browser test/);
});

test('optional font maintenance dependencies run the cmap refusal and table-parity tests', t => {
    const probe = spawnSync('python3', ['-c', 'import fontTools, brotli'], { encoding: 'utf8' });
    if (probe.error?.code === 'ENOENT' || /ModuleNotFoundError: No module named '(?:fontTools|brotli)'/.test(probe.stderr || '')) {
        t.skip('Optional maintenance check requires Python, fonttools==4.61.1 and brotli==1.2.1; font artifact/hash checks still run.');
        return;
    }
    assert.equal(probe.status, 0, probe.error?.message || probe.stderr);
    const result = spawnSync('python3', ['-B', 'tests/monacoFontConversion.test.py'], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.error?.message || result.stdout + result.stderr);
});

test('Monaco font transform preserves all CSS except font URL and container format', () => {
    const plugin = monacoFontPlugin();
    assert.equal(plugin.transform('body {}', '/app.css'), null);
    const output = plugin.transform(source, cssPath).code;
    assert.equal(output.replace(/url\("[^"\n]+codicon-0\.52\.2\.woff2"\) format\("woff2"\)/, 'url(./codicon.ttf) format("truetype")'), source);
    assert.throws(() => plugin.transform(source.replace('format("truetype")', 'format("unexpected")'), cssPath), /stylesheet layout/);
});
test('Monaco font adapter refuses an unreviewed installed font', () => {
    const temp = mkdtempSync(path.join(tmpdir(), 'json-font-test-'));
    try {
        const file = path.join(temp, 'monaco-editor/esm/vs/base/browser/ui/codicons/codicon/codicon.css');
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(path.join(path.dirname(file), 'codicon.ttf'), 'unreviewed');
        assert.throws(() => monacoFontPlugin().transform(source, file), /Regenerate and validate/);
    } finally { rmSync(temp, { recursive: true, force: true }); }
});
test('production CSS resolves and emits the complete WOFF2, never the original TTF', async () => {
    const temp = mkdtempSync(path.join(tmpdir(), 'json-font-vite-'));
    try {
        const entry = path.join(temp, 'entry.js');
        writeFileSync(entry, `import ${JSON.stringify(cssPath)};`);
        const result = await build({ configFile: false, publicDir: false, logLevel: 'silent', plugins: [monacoFontPlugin()],
            build: { write: false, assetsInlineLimit: 0, rollupOptions: { input: entry } } });
        const fonts = result.output.filter(asset => asset.fileName.endsWith('.woff2'));
        assert.equal(fonts.length, 1);
        assert.deepEqual(Buffer.from(fonts[0].source), readFileSync('assets/fonts/codicon-0.52.2.woff2'));
        const license = result.output.find(asset => asset.fileName === 'assets/LICENSE.codicon.txt');
        assert.ok(license, 'The font license must ship with the generated WOFF2 asset');
        assert.deepEqual(Buffer.from(license.source), readFileSync('assets/fonts/LICENSE.codicon.txt'));
        assert.equal(result.output.filter(asset => asset.fileName.endsWith('.ttf')).length, 0);
        assert.match(result.output.find(asset => asset.fileName.endsWith('.css')).source, /format\("woff2"\)/);
    } finally { rmSync(temp, { recursive: true, force: true }); }
});
