import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';

const bundled = await build({
    stdin: { contents: `
        export { compareFieldValues, sortJsonByField } from './src/components/utils/jsonSort';
        export { useJsonEngine } from './src/components/composables/useJsonEngine';
        export { createHighPrecisionNumberWrapper } from './src/components/utils/jsonEngine/numberLiteral';
    `, resolveDir: process.cwd() },
    bundle: true, write: false, platform: 'node', format: 'esm',
});
const api = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);
const engine = api.useJsonEngine({
    indentSize: { value: 2 }, arrayNewLine: { value: true },
    preserveNumberLiterals: { value: true }, encodingMode: { value: false },
});
const sortText = (input, field, order) => {
    const parsed = engine.parse(input);
    return engine.stringify(api.sortJsonByField(parsed.data, field, order), parsed.escapeMap);
};
const thresholdLiterals = (output) => [...output.matchAll(/"threshold":\s*([^,\n}]+)/g)].map((match) => match[1].trim());

// These literals cannot be faithfully compared through Number or lexicographic order.
const ordered = [
    '-1e1000', '-9007199254740993', '-9007199254740992',
    '-10.000000000000000001', '-2.000000000000000001', '-1e-1000',
    '0', '1e-1000', '2.000000000000000001', '10.000000000000000001',
    '9007199254740992', '9007199254740993', '1e1000',
];

for (const shape of ['array', 'map', 'wrapped-map']) {
    test(`field sorting preserves and orders exact numeric literals through the engine: ${shape}`, () => {
        const entries = [...ordered].reverse().map((literal) => {
            const name = `item-${ordered.indexOf(literal)}`;
            const value = `{"name":"${name}","threshold":${literal}}`;
            return shape === 'array' ? value : `"${name}":${shape === 'wrapped-map' ? `{"value":${value}}` : value}`;
        });
        const input = shape === 'array' ? `[${entries.join(',')}]` : `{${entries.join(',')}}`;
        const field = shape === 'wrapped-map' ? 'value.threshold' : 'threshold';
        for (const direction of ['asc', 'desc']) {
            const expected = direction === 'asc' ? ordered : [...ordered].reverse();
            const output = sortText(input, field, direction);
            assert.deepEqual(thresholdLiterals(output), expected);
            const data = JSON.parse(output);
            const names = shape === 'array' ? data.map((item) => item.name) : Object.keys(data);
            assert.deepEqual(names, expected.map((literal) => `item-${ordered.indexOf(literal)}`));
            assert(!output.includes('__jsonToolHighPrecisionNumber'), 'internal numeric wrappers must never leak into JSON output');
        }
    });
}

test('primitive Map values also compare as exact numbers without losing their spelling', () => {
    const input = '{"ten":10.000000000000000001,"two":2.000000000000000001,"tiny":1e-1000}';
    for (const direction of ['asc', 'desc']) {
        const output = sortText(input, '', direction);
        const expected = direction === 'asc' ? ['tiny', 'two', 'ten'] : ['ten', 'two', 'tiny'];
        assert.deepEqual(Object.keys(JSON.parse(output)), expected);
        for (const literal of ['10.000000000000000001', '2.000000000000000001', '1e-1000']) assert(output.includes(literal));
    }
});

test('equal numeric values retain source order in both directions for arrays and Maps', () => {
    const groups = [
        ['-0', '0.000', '0e99999', '-0e-99999'],
        ['1.0', '10e-1', '1', '0.0100e2'],
        ['-1.2300', '-123e-2', '-0.123e1'],
    ];
    for (const literals of groups) {
        for (const shape of ['array', 'map']) {
            const entries = literals.map((literal, index) => {
                const value = `{"name":"item-${index}","threshold":${literal}}`;
                return shape === 'array' ? value : `"item-${index}":${value}`;
            });
            const input = shape === 'array' ? `[${entries.join(',')}]` : `{${entries.join(',')}}`;
            for (const direction of ['asc', 'desc']) {
                const output = sortText(input, 'threshold', direction);
                assert.deepEqual(thresholdLiterals(output), literals);
                const data = JSON.parse(output);
                assert.deepEqual(shape === 'array' ? data.map((item) => item.name) : Object.keys(data), literals.map((_, index) => `item-${index}`));
            }
        }
    }
});

test('ordinary numbers and protected numbers share numeric comparison', () => {
    const wrap = api.createHighPrecisionNumberWrapper;
    assert(api.compareFieldValues(2, wrap('10.000000000000000001')) < 0);
    assert(api.compareFieldValues(wrap('9007199254740993'), 9007199254740992) > 0);
    assert(api.compareFieldValues(wrap('-1e-1000'), 0) < 0);
    assert.equal(api.compareFieldValues(wrap('10e-1'), 1), 0);
    assert.equal(api.compareFieldValues(-0, wrap('-0e99999')), 0);
});

test('ordinary strings and forged wrapper text retain string comparison', () => {
    const input = '[{"name":"two","threshold":"2"},{"name":"ten","threshold":"10"}]';
    const output = sortText(input, 'threshold', 'asc');
    assert.deepEqual(JSON.parse(output).map((item) => item.name), ['ten', 'two']);
    assert.deepEqual(JSON.parse(output).map((item) => typeof item.threshold), ['string', 'string']);
    const forged = JSON.stringify({ __jsonToolHighPrecisionNumber: true, __jsonToolHighPrecisionNumberSecret: 'not-the-runtime-secret', originalString: '1e1000' });
    assert.equal(api.compareFieldValues(forged, '2'), forged.localeCompare('2'));
});

test('missing and null fields retain their existing stable placement around exact numbers', () => {
    const input = '[{"name":"ten","threshold":10.000000000000000001},{"name":"missing"},{"name":"null","threshold":null},{"name":"two","threshold":2.000000000000000001}]';
    assert.deepEqual(JSON.parse(sortText(input, 'threshold', 'asc')).map((item) => item.name), ['missing', 'null', 'two', 'ten']);
    assert.deepEqual(JSON.parse(sortText(input, 'threshold', 'desc')).map((item) => item.name), ['ten', 'two', 'missing', 'null']);
});

test('mixed JSON types have a transitive ordering independent of their input permutation', () => {
    const values = [null, false, true, 2, 10, api.createHighPrecisionNumberWrapper('10.000000000000000001'), '15', '2', [1], { a: 1 }];
    for (let i = 0; i < values.length; i++) {
        for (let j = 0; j < values.length; j++) {
            assert.equal(Math.sign(api.compareFieldValues(values[i], values[j])) || 0, Math.sign(i - j) || 0);
        }
    }
    const cycle = [2, 10, '15'];
    const permutations = (items) => items.length === 0 ? [[]] : items.flatMap((item, index) => permutations(items.filter((_, other) => index !== other)).map((tail) => [item, ...tail]));
    for (const input of permutations(cycle)) {
        for (const direction of ['asc', 'desc']) {
            const sorted = api.sortJsonByField(input.map((value) => ({ value })), 'value', direction).map((item) => item.value);
            assert.deepEqual(sorted, direction === 'asc' ? cycle : [...cycle].reverse());
        }
    }
    for (const direction of ['asc', 'desc']) {
        const expected = direction === 'asc' ? values : [...values].reverse();
        for (let offset = 0; offset < values.length; offset++) {
            const rotated = [...values.slice(offset), ...values.slice(0, offset)];
            assert.deepEqual(api.sortJsonByField(rotated.map((value) => ({ value })), 'value', direction).map((item) => item.value), expected);
        }
    }
});

test('equal nonnumeric values preserve source order without deep object or array sorting', () => {
    const groups = [['same', 'same'], [false, false], [[1, 2], ['1', '2']], [{ b: 2 }, { a: 1 }]];
    for (const values of groups) {
        const items = values.map((value, index) => ({ name: `item-${index}`, value }));
        for (const direction of ['asc', 'desc']) {
            assert.deepEqual(api.sortJsonByField(items, 'value', direction).map((item) => item.name), ['item-0', 'item-1']);
        }
    }
});

test('JSON5 non-finite values share the null group while protected exponents remain numeric', () => {
    const input = '[{"name":"huge","threshold":1e1000},{"name":"nan","threshold":NaN},{"name":"negativeInfinity","threshold":-Infinity},{"name":"null","threshold":null},{"name":"positiveInfinity","threshold":Infinity},{"name":"small","threshold":-1e1000}]';
    const nullNames = ['nan', 'negativeInfinity', 'null', 'positiveInfinity'];
    const ascending = JSON.parse(sortText(input, 'threshold', 'asc'));
    const descending = JSON.parse(sortText(input, 'threshold', 'desc'));
    assert.deepEqual(ascending.map((item) => item.name), [...nullNames, 'small', 'huge']);
    assert.deepEqual(descending.map((item) => item.name), ['huge', 'small', ...nullNames]);
    for (const item of ascending.filter((item) => nullNames.includes(item.name))) assert.equal(item.threshold, null);
    for (const value of [null, undefined, NaN, Infinity, -Infinity]) {
        assert.equal(api.compareFieldValues(value, null), 0);
        assert.equal(api.compareFieldValues(value, NaN), 0);
    }
});

test('ordinary JSON toString and valueOf data keys cannot break field comparison', () => {
    const inputs = [
        '[{"name":"first","threshold":{"toString":"data","valueOf":null}},{"name":"second","threshold":{"id":1}}]',
        '[{"name":"first","threshold":[{"toString":false,"valueOf":1}]},{"name":"second","threshold":[{"id":1}]}]',
        '[{"name":"first","threshold":[null,[{"toString":{},"valueOf":"data"},null]]},{"name":"second","threshold":[null,[{"id":1},null]]}]',
    ];
    for (const input of inputs) {
        for (const direction of ['asc', 'desc']) {
            const output = JSON.parse(sortText(input, 'threshold', direction));
            assert.deepEqual(output, JSON.parse(input), 'equal projections preserve both source order and all data keys');
        }
    }
});

test('safe array projections preserve comma-separated ordering instead of deep numeric sorting', () => {
    const input = '[{"name":"two","threshold":[2,null]},{"name":"ten","threshold":[10,null]}]';
    assert.deepEqual(JSON.parse(sortText(input, 'threshold', 'asc')).map((item) => item.name), ['ten', 'two']);
    assert.deepEqual(JSON.parse(sortText(input, 'threshold', 'desc')).map((item) => item.name), ['two', 'ten']);
    assert.equal(api.compareFieldValues([null, [1, null, 2]], ['', '1,,2']), 0);
});
