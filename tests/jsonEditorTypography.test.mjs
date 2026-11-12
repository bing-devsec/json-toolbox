import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { JSON_TOOL_EDITOR_FONT_OPTIONS, getJsonToolEditorTypography } from '../src/components/utils/editorTypography.ts';

test('manual editor sizes use matching integer line heights and the shared font family', () => {
    for (const [fontSize, lineHeight] of [[12, 16], [13, 18], [14, 20]]) {
        const options = getJsonToolEditorTypography(fontSize);
        assert.equal(options.fontSize, fontSize);
        assert.equal(options.lineHeight, lineHeight);
        assert.equal(options.fontFamily, JSON_TOOL_EDITOR_FONT_OPTIONS.fontFamily);
        assert.equal(options.fontWeight, 'normal');
        assert.equal(options.fontLigatures, false);
    }
});

test('shared typography calls do not mutate one another or the common font options', () => {
    const first = getJsonToolEditorTypography(12);
    first.lineHeight = 999;
    const second = getJsonToolEditorTypography(14);
    assert.equal(second.lineHeight, 20);
    assert.equal('lineHeight' in JSON_TOOL_EDITOR_FONT_OPTIONS, false);
    assert.equal('fontSize' in JSON_TOOL_EDITOR_FONT_OPTIONS, false);
});

test('invalid manual sizes always use the fixed 12px fallback and never reach Monaco as invalid metrics', () => {
    for (const invalid of [NaN, Infinity, -1, 0, 15, '14', 'auto', null, undefined]) {
        const options = getJsonToolEditorTypography(invalid);
        assert.equal(options.fontSize, 12);
        assert.equal(options.lineHeight, 16);
    }
});


test('editor uses the packaged JetBrains Mono Regular with a matching CSS family and license', () => {
    assert.match(JSON_TOOL_EDITOR_FONT_OPTIONS.fontFamily, /^'JetBrains Mono', Menlo, Monaco, Consolas,/);
    const css = readFileSync('src/style.css', 'utf8');
    const face = css.match(/@font-face\s*\{[^}]*font-family:\s*'JetBrains Mono'[^}]*\}/)?.[0];
    assert.ok(face, 'JetBrains Mono must have a local font-face declaration');
    assert.match(face, /url\('\.\.\/assets\/fonts\/JetBrainsMono-Regular\.woff2'\) format\('woff2'\)/);
    assert.match(face, /font-weight:\s*400;/);
    assert.match(face, /font-display:\s*swap;/);
    const cssFamily = css.match(/--json-tool-font-code:\s*([^;]+);/)?.[1];
    assert.equal(cssFamily, JSON_TOOL_EDITOR_FONT_OPTIONS.fontFamily);
    const font = readFileSync('assets/fonts/JetBrainsMono-Regular.woff2');
    assert.equal(createHash('sha256').update(font).digest('hex'), 'a9cb1cd82332b23a47e3a1239d25d13c86d16c4220695e34b243effa999f45f2');
    assert.match(readFileSync('public/fonts/LICENSE.JetBrainsMono.txt', 'utf8'), /SIL OPEN FONT LICENSE/);
});
