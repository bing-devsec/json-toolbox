import assert from 'node:assert/strict';
import test from 'node:test';
import { buildJsonFoldingInfo, buildJsonFoldingSummaryIndex, findJsonFoldingSummaryIndexAtOrBefore, getJsonFoldingSummaryByIndex } from '../src/components/utils/foldingInfo.ts';

const indexArrays = source => {
    const { startLines, counts, types } = buildJsonFoldingSummaryIndex(source);
    return { startLines: [...startLines], counts: [...counts], types: [...types] };
};

test('shared scanner preserves Map close-order overwrite versus compact index open-order duplicates', () => {
    const source = '{"a":[1,2],"b":{"c":3}}';
    const maps = buildJsonFoldingInfo(source);
    assert.deepEqual([...maps.info], [[1, { type: 'object', count: 2 }]]);
    assert.deepEqual([...maps.ranges], [[1, { endLine: 1, type: 'object' }]]);
    assert.deepEqual(indexArrays(source), { startLines: [1, 1, 1], counts: [2, 2, 1], types: [1, 2, 1] });
    const index = buildJsonFoldingSummaryIndex(source);
    assert.deepEqual(getJsonFoldingSummaryByIndex(index, findJsonFoldingSummaryIndexAtOrBefore(index, 1)), { type: 'object', count: 1 });
});

test('empty containers remain ranges but do not create nonempty summaries', () => {
    const source = '[\n {"a":1},\n [],\n "text"\n]';
    const maps = buildJsonFoldingInfo(source);
    assert.deepEqual([...maps.info], [[2, { type: 'object', count: 1 }], [1, { type: 'array', count: 3 }]]);
    assert.deepEqual([...maps.ranges], [[2, { endLine: 2, type: 'object' }], [3, { endLine: 3, type: 'array' }], [1, { endLine: 5, type: 'array' }]]);
    assert.deepEqual(indexArrays(source), { startLines: [1, 2], counts: [3, 1], types: [2, 1] });
    assert.deepEqual(indexArrays('[]\n{}'), { startLines: [], counts: [], types: [] });
});

test('quoted escaped punctuation does not affect container counts and CRLF keeps line numbers', () => {
    const source = JSON.stringify({ text: 'a\\"b:[{},]', list: ['x:y', 'a,b', '{}'] }, null, 2).replaceAll('\n', '\r\n');
    assert.deepEqual(indexArrays(source), { startLines: [1, 3], counts: [2, 3], types: [1, 2] });
    assert.deepEqual(buildJsonFoldingInfo(source).info.get(1), { type: 'object', count: 2 });
});

test('incomplete and mismatched containers preserve the existing tolerant scan results', () => {
    for (const source of ['', '[}', '{"a":[1,2']) {
        assert.deepEqual([...buildJsonFoldingInfo(source).info], []);
        assert.deepEqual(indexArrays(source), { startLines: [], counts: [], types: [] });
    }
    // A valid child may close even if its enclosing container never does.
    assert.deepEqual(indexArrays('[\n{"x":1}'), { startLines: [2], counts: [1], types: [1] });
    assert.deepEqual([...buildJsonFoldingInfo('[\n{"x":1}').ranges], [[2, { endLine: 2, type: 'object' }]]);
});
