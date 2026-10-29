import assert from 'node:assert/strict';
import test from 'node:test';
import { JSON_TOOL_EDITOR_FONT_OPTIONS, getJsonToolEditorTypography } from '../src/components/utils/editorTypography.ts';

test('manual editor sizes use matching integer line heights and the shared font family', () => {
    for (const [fontSize, lineHeight] of [[12, 17], [13, 18], [14, 20]]) {
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
        assert.equal(options.lineHeight, 17);
    }
});
