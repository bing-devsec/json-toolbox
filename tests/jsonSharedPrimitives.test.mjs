import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeUTF8Bytes } from '../src/components/utils/decode.ts';
import { getDiffLineRangeInfo } from '../src/components/utils/diffLineRange.ts';

test('shared UTF-8 decoder accepts ASCII, controls, and all valid sequence boundaries', () => {
    for (const text of ['', '\0\t\n\x7f', 'ASCII', '\u0080\u07ff', '\u0800\ud7ff\ue000\uffff', '\u{10000}\u{10ffff}', '中文🙂']) {
        assert.equal(decodeUTF8Bytes([...new TextEncoder().encode(text)]), text);
    }
});

test('shared UTF-8 decoder rejects truncation, overlong sequences, surrogates, invalid continuations and out-of-range scalars', () => {
    const invalid = [
        [0x80], [0xbf], [0xc0, 0x80], [0xc1, 0xbf], [0xc2], [0xc2, 0x20],
        [0xe0, 0x80, 0x80], [0xe1, 0x80], [0xe1, 0x80, 0x20], [0xed, 0xa0, 0x80],
        [0xed, 0xbf, 0xbf], [0xf0, 0x80, 0x80, 0x80], [0xf0, 0x90, 0x80],
        [0xf4, 0x90, 0x80, 0x80], [0xf5, 0x80, 0x80, 0x80], [0xff],
    ];
    for (const bytes of invalid) {
        assert.equal(decodeUTF8Bytes(bytes), null, JSON.stringify(bytes));
        assert.equal(decodeUTF8Bytes([0x41, ...bytes, 0x42]), null, `embedded ${bytes}`);
    }
});

test('shared Diff ranges preserve inclusive counts and empty-side insertion/deletion boundaries', () => {
    const cases = [
        [[1, 1, 1, 1], [true, true, 1, 1]],
        [[1, 0, 1, 3], [false, true, 0, 3]],
        [[1, 3, 1, 0], [true, false, 3, 0]],
        [[5, 4, 9, 8], [false, false, 0, 0]],
        [[10, 12, 20, 23], [true, true, 3, 4]],
        [[2000000, 3000000, 1, 0], [true, false, 1000001, 0]],
    ];
    for (const [[originalStartLineNumber, originalEndLineNumber, modifiedStartLineNumber, modifiedEndLineNumber], expected] of cases) {
        const result = getDiffLineRangeInfo({ originalStartLineNumber, originalEndLineNumber, modifiedStartLineNumber, modifiedEndLineNumber });
        assert.deepEqual([result.hasLeft, result.hasRight, result.leftLineCount, result.rightLineCount], expected);
    }
});
