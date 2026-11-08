import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';

const bundled = await build({ entryPoints: ['src/components/utils/jsonStructure.ts'], bundle: true, write: false, format: 'esm', platform: 'node' });
const { calculateJsonStructure, calculateMaxLevel } = await import('data:text/javascript;base64,' + Buffer.from(bundled.outputFiles[0].text).toString('base64'));

test('dense parsed arrays do not allocate an index-key list for structure analysis', () => {
    const input = Array.from({ length: 100_000 }, (_, i) => i);
    const keys = Object.keys;
    let arrayKeyCalls = 0;
    Object.keys = value => {
        if (value === input) arrayKeyCalls++;
        return keys(value);
    };
    try {
        assert.equal(calculateMaxLevel(input), 1);
        assert.equal(calculateJsonStructure(input), 1);
    } finally {
        Object.keys = keys;
    }
    assert.equal(arrayKeyCalls, 0);
});

test('nested arrays and objects retain separate depth and level semantics', () => {
    const input = [1, { child: [{ value: null }, []] }];
    assert.equal(calculateMaxLevel(input), 4);
    assert.equal(calculateJsonStructure(input), 4);
    assert.equal(calculateMaxLevel([1, 2, 3]), 1);
    assert.equal(calculateJsonStructure([1, 2, 3]), 1);
    assert.equal(calculateMaxLevel(1), 0);
    assert.equal(calculateJsonStructure(1), 0);
    assert.equal(calculateMaxLevel(input, 5), 8);
});

test('empty and all-hole arrays preserve their existing short circuit', () => {
    for (const value of [[], Array(5), {}]) {
        assert.equal(calculateMaxLevel(value), 1);
        assert.equal(calculateJsonStructure(value), 0);
        assert.equal(calculateJsonStructure(value, 'depth', 101), 101);
    }
});

test('sparse arrays with missing first index still visit populated later indexes', () => {
    const input = Array(4);
    input[3] = [[{ value: 1 }]];
    assert.equal(calculateMaxLevel(input), 4);
    assert.equal(calculateJsonStructure(input), 4);
    const firstPresent = [1];
    firstPresent.length = 5;
    firstPresent[4] = input;
    assert.equal(calculateMaxLevel(firstPresent), 5);
});

test('non-enumerable and inherited index zero do not make an otherwise empty array nonempty', () => {
    const nonEnumerable = Array(1);
    Object.defineProperty(nonEnumerable, '0', { value: [[[1]]], enumerable: false });
    assert.equal(calculateMaxLevel(nonEnumerable), 1);
    assert.equal(calculateJsonStructure(nonEnumerable), 0);
    const inherited = Array(1);
    Object.setPrototypeOf(inherited, Object.assign(Object.create(Array.prototype), { 0: [[[1]]] }));
    assert.equal(calculateMaxLevel(inherited), 1);
    assert.equal(calculateJsonStructure(inherited), 0);
});

test('named array properties keep existing emptiness and iteration behavior', () => {
    const emptyWithProperty = Object.assign([], { extra: [[[1]]] });
    assert.equal(calculateMaxLevel(emptyWithProperty), 1);
    assert.equal(calculateJsonStructure(emptyWithProperty), 0);
    const holesWithProperty = Object.assign(Array(3), { extra: [[[1]]] });
    assert.equal(calculateMaxLevel(holesWithProperty), 1);
    assert.equal(calculateJsonStructure(holesWithProperty), 1);
});

test('checking the first index never evaluates its getter before iteration', () => {
    const calls = [];
    const input = [];
    Object.defineProperty(input, '0', { enumerable: true, get() { calls.push('zero'); return { value: 1 }; } });
    Object.defineProperty(input, '1', { enumerable: true, get() { calls.push('one'); return [[1]]; } });
    assert.equal(calculateMaxLevel(input), 3);
    assert.deepEqual(calls, ['zero', 'one']);
});

test('depth cap remains 100 for nonempty arrays and objects', () => {
    for (const value of [[1], { value: 1 }]) {
        assert.equal(calculateJsonStructure(value, 'depth', 99), 100);
        assert.equal(calculateJsonStructure(value, 'depth', 100), 100);
        assert.equal(calculateJsonStructure(value, 'depth', 101), 100);
    }
    assert.equal(calculateJsonStructure([1], 'level', 101), 101);
});
