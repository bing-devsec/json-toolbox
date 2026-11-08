import assert from 'node:assert/strict';
import test from 'node:test';
import { ChunkedLineSums } from '../src/components/utils/chunkedLineSums.ts';

test('million-line deletion rebuilds offsets once and retains both boundary fragments', () => {
    const values = Array.from({ length: 1000000 }, (_, i) => i % 4);
    const sums = new ChunkedLineSums(values);
    let rebuilds = 0;
    const rebuild = sums.rebuildOffsets.bind(sums);
    sums.rebuildOffsets = () => { rebuilds++; rebuild(); };
    sums.removeValues(513, 998900);
    assert.equal(rebuilds, 1);
    const expected = values.slice(0, 513).concat(values.slice(999413));
    let total = 0;
    for (let i = 0; i < expected.length; i++) {
        total += expected[i]; assert.equal(sums.getPrefixSum(i + 1), total);
    }
    assert.equal(sums.getTotalSum(), total);
    sums.removeValues(0, expected.length + 100);
    assert.equal(sums.getTotalSum(), 0);
    sums.insertValues(0, [0, 2, 1]);
    assert.deepEqual(sums.getIndexOf(2), { index: 2, remainder: 0 });
});
