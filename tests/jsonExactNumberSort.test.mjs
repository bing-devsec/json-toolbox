import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { compareJsonNumberLiterals as compare } from '../src/components/utils/jsonEngine/compareNumberLiterals.ts';

const bundled = await build({ stdin: { contents: `
    export * from './src/components/utils/jsonDiffSort';
    export { createHighPrecisionNumberWrapper, tryParseHighPrecisionWrapper } from './src/components/utils/jsonEngine/numberLiteral';
`, resolveDir: process.cwd() }, bundle: true, write: false, platform: 'node', format: 'esm' });
const api = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);
const wrap = api.createHighPrecisionNumberWrapper;
const unwrap = api.tryParseHighPrecisionWrapper;

test('exact numeric comparison handles precision loss, exponent overflow, underflow and signs', () => {
    const ordered = ['-1e1000', '-9e999', '-10.000000000000000001', '-9.999999999999999999', '-1e-1000', '0', '1e-1000', '9.999999999999999999', '10.000000000000000001', '9e999', '1e1000'];
    for (let i = 0; i < ordered.length; i++) for (let j = 0; j < ordered.length; j++) {
        assert.equal(Math.sign(compare(ordered[i], ordered[j])), Math.sign(i - j), `${ordered[i]} versus ${ordered[j]}`);
    }
    assert.deepEqual(api.sortJsonArrayByCanonicalKey([...ordered].reverse().map(wrap), 'asc').map(unwrap), ordered);
    assert.deepEqual(api.sortJsonArrayByCanonicalKey(ordered.map(wrap), 'desc').map(unwrap), [...ordered].reverse());
});

test('equal numeric values retain their original order, including negative zero and trailing zeros', () => {
    for (const group of [['-0', '0.000', '0e99999', '-0e-99999'], ['1.0', '10e-1', '1', '0.0100e2'], ['-1.2300', '-123e-2', '-0.123e1']]) {
        for (const a of group) for (const b of group) assert.equal(compare(a, b), 0, `${a} versus ${b}`);
        for (const order of ['asc', 'desc']) assert.deepEqual(api.sortJsonArrayByCanonicalKey(group.map(wrap), order).map(unwrap), group);
    }
});

test('huge signed exponents compare in written space, including carry and borrow boundaries', () => {
    const nines = '9'.repeat(10000), next = '1' + '0'.repeat(10000);
    assert.equal(compare(`1e${next}`, `10e${nines}`), 0);
    assert.equal(compare(`1e-${nines}`, `10e-${next}`), 0);
    assert(compare(`9e${nines}`, `1e${next}`) < 0);
    assert(compare(`1e-${next}`, `9e-${nines}`) < 0);
    assert.equal(compare(`-0e${next}`, '0'), 0);
    assert.equal(compare('100e-2', '0.1e1'), 0);
    assert.equal(compare('0.001e+0003', '1'), 0);
});

test('mixed JSON ranks and object/array comparison retain existing nonnumeric rules', () => {
    const values = [{ z: 1 }, [1], 'text', wrap('1e1000'), 2, wrap('-1e1000'), false, true, null];
    const sorted = api.sortJsonArrayByCanonicalKey(values, 'asc');
    assert.deepEqual(sorted, [null, false, true, wrap('-1e1000'), 2, wrap('1e1000'), 'text', [1], { z: 1 }]);
    const same = [wrap('1.00'), 1, wrap('10e-1')];
    assert.deepEqual(api.sortJsonArrayByCanonicalKey(same, 'asc'), same);
});

test('decimal comparator agrees with an independent scaled-BigInt oracle on bounded cases', () => {
    let seed = 23;
    const next = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
    const samples = Array.from({ length: 300 }, () => {
        const coefficient = BigInt(next() % 2000001) - 1000000n;
        const exponent = next() % 41 - 20;
        return { text: `${coefficient}e${exponent}`, scaled: coefficient * 10n ** BigInt(exponent + 20) };
    });
    for (let i = 0; i < samples.length; i++) for (let j = 0; j < samples.length; j++) {
        const a = samples[i], b = samples[j];
        const expected = a.scaled === b.scaled ? 0 : a.scaled < b.scaled ? -1 : 1;
        assert.equal(Math.sign(compare(a.text, b.text)), expected, `${a.text} versus ${b.text}`);
    }
});
