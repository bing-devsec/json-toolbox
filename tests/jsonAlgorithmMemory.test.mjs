import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { bundleModule } from '../scripts/compare-json-repair.mjs';

// Exercise collision registration directly without adding a production export.
const utils = new URL('../src/components/utils/', import.meta.url);
const source = await readFile(new URL('jsonUnescape.ts', utils), 'utf8');
const built = await build({stdin: {contents: source + '\nexport { registerParsedEscapes, stringifyJsonValue };', loader: 'ts', resolveDir: fileURLToPath(utils)}, bundle: true, write: false, platform: 'node', format: 'esm'});
const {registerParsedEscapes, stringifyJsonValue, unescapeJsonText} = await import('data:text/javascript;base64,' + Buffer.from(built.outputFiles[0].text).toString('base64'));
const sort = await bundleModule('src/components/utils/jsonSort.ts');
const options = {recursive: true, indentSize: 2, arrayNewLine: true, preserveNumberLiterals: true};
const token = n => '\uE000' + '\uE900'.repeat(12) + String.fromCharCode(0xea00 + n);
const firstAllocation = '\uE000' + '\uE001'.repeat(13);
const context = (entries = []) => ({escapeMap: new Map(entries), nextEscapePlaceholderId: 0});
const decode = (ctx, value) => JSON.parse(stringifyJsonValue(value, ctx.escapeMap, options));

test('escape registration without conflicts does not read or serialize the parsed tree', () => {
    const value = Object.defineProperty({}, 'untouched', {enumerable: true, get() {throw new Error('unneeded tree traversal');}});
    for (const entries of [[], [[token(0), String.raw`\u0041`]]]) {
        const ctx = context(entries);
        assert.strictEqual(registerParsedEscapes(ctx, value, new Map([[token(0), String.raw`\u0041`]])), value);
        assert.equal(ctx.escapeMap.get(token(0)), String.raw`\u0041`);
    }
});

test('collision replacement preserves keys, repeated tokens, unknown PUA and own prototype names', () => {
    const ctx = context([[token(0), String.raw`\u0058`], [token(1), String.raw`\u0059`], [token(2), String.raw`\u005A`]]);
    const value = JSON.parse('{"__proto__":{"safe":true}}');
    value[token(2)] = token(0) + '-' + token(1) + token(0);
    value.keep = [firstAllocation, '\uE000short', '\uE000' + token(1), token(8)];
    const result = registerParsedEscapes(ctx, value, new Map([[token(0), String.raw`\u0041`], [token(1), String.raw`\u0042`], [token(2), String.raw`\u0061`]]));
    const expected = JSON.parse('{"__proto__":{"safe":true},"a":"A-BA"}');
    expected.keep = [firstAllocation, '\uE000short', '\uE000B', token(8)];
    assert.deepEqual(decode(ctx, result), expected);
    assert.equal(Object.hasOwn(result, '__proto__'), true);
    assert.equal(Object.prototype.safe, undefined);
    assert.equal(value[token(2)], token(0) + '-' + token(1) + token(0));
});

test('replacement targets cannot alias another source token that disappeared with a duplicate key', () => {
    const ctx = context([[token(0), String.raw`\u0058`]]);
    // The source map may retain a token from a value overwritten by a duplicate JSON key.
    const sourceMap = new Map([[token(0), String.raw`\u0041`], [firstAllocation, String.raw`\u0042`]]);
    const result = registerParsedEscapes(ctx, {keep: token(0)}, sourceMap);
    assert.deepEqual(decode(ctx, result), {keep: 'A'});
});

test('many cross-layer tokens are replaced once without cascading or changing stable registrations', () => {
    const ctx = context();
    const first = new Map(Array.from({length: 240}, (_, i) => [token(i), String.raw`\u0041`]));
    const original = Array.from(first.keys());
    assert.strictEqual(registerParsedEscapes(ctx, original, first), original);
    const second = new Map(Array.from(first.keys(), key => [key, String.raw`\u0042`]));
    const result = registerParsedEscapes(ctx, {rows: original, [token(0)]: token(1)}, second);
    assert.deepEqual(decode(ctx, result), {rows: Array(240).fill('B'), B: 'B'});
    assert.deepEqual(decode(ctx, original), Array(240).fill('A'));
});

test('public unescape keeps cross-layer escapes, exact numbers, keys and literal backslashes under forced collisions', t => {
    t.mock.method(globalThis.crypto, 'getRandomValues', bytes => bytes.fill(0));
    const nested = String.raw`{"\u0061":"\u0042","repeat":"\u0042\u0043","literal":"\\u0044","big":9007199254740993,"__proto__":{"keep":true}}`;
    const input = '{"outer":"\\u0041","payload":' + JSON.stringify(nested) + '}';
    const result = unescapeJsonText(input, options);
    assert.equal(result.ok, true);
    const expectedPayload = JSON.parse('{"a":"B","repeat":"BC","literal":"\\\\u0044","big":9007199254740993,"__proto__":{"keep":true}}');
    assert.deepEqual(JSON.parse(result.text), {outer: 'A', payload: expectedPayload});
    assert(result.text.includes('9007199254740993'));
    for (const escape of [String.raw`\u0061`, String.raw`\u0041`, String.raw`\u0042`, String.raw`\u0043`]) assert(result.text.includes(escape));
});

test('public unescape never reinterprets an outer user literal as a nested parser token', t => {
    t.mock.method(globalThis.crypto, 'getRandomValues', bytes => bytes.fill(0));
    const input = '{"outer":"\\u0041","literal":' + JSON.stringify(firstAllocation) + ',"payload":' + JSON.stringify(String.raw`{"inner":"\u0042"}`) + '}';
    const result = unescapeJsonText(input, options);
    assert.equal(result.ok, true);
    assert.deepEqual(JSON.parse(result.text), {outer: 'A', literal: firstAllocation, payload: {inner: 'B'}});
});

test('compiled field paths preserve empty-path sorting and falsy roots', () => {
    assert.deepEqual(sort.sortJsonByField([3, 0, 2, 1], ''), [0, 1, 2, 3]);
    assert.equal(sort.getCompareFunction('field', '')({a: 1}, {a: 2}), 0);
    const compare = sort.getCompareFunction('field', 'ignored');
    assert.equal(compare(0, false), sort.compareFieldValues(0, false));
    assert.equal(compare('', null), sort.compareFieldValues('', null));
    assert.equal(compare(undefined, false), sort.compareFieldValues(undefined, false));
});

test('compiled indexed and wildcard paths preserve falsy elements and stable equal keys', () => {
    const rows = [{id:'high', meta:{items:[{score: 2}]}}, {id:'zero', meta:{items:[{score: 0}]}}, {id:'low', meta:{items:[{score: -1}]}}, {id:'same', meta:{items:[{score: 0}]}}];
    for (const path of ['meta.items[0].score', 'meta.items[*].score']) {
        assert.deepEqual(sort.sortJsonByField(rows, path).map(row => row.id), ['low','zero','same','high']);
        assert.deepEqual(sort.sortJsonByField(rows, path, 'desc').map(row => row.id), ['high','zero','same','low']);
    }
    assert.deepEqual(rows.map(row => row.id), ['high','zero','low','same']);
    assert.deepEqual(sort.sortJsonByField([[2], [0], [-1]], '[0]'), [[2], [0], [-1]]); // Existing array-of-arrays branch.
    assert.deepEqual(sort.sortJsonByField([{v:[true]}, {v:[false]}], 'v[0]').map(row => row.v[0]), [false,true]);
});

test('compiled paths never read inherited fields and still read own prototype-named fields', () => {
    const inherited = Object.create({meta:{score:-100}});
    inherited.id = 'missing';
    const own = JSON.parse('{"id":"own","__proto__":{"score":0},"meta":{"score":2}}');
    assert.deepEqual(sort.sortJsonByField([{id:'low',meta:{score:1}}, own, inherited], 'meta.score').map(row => row.id), ['missing','low','own']);
    const special = [JSON.parse('{"__proto__":{"score":2}}'), JSON.parse('{"__proto__":{"score":0}}')];
    assert.deepEqual(sort.sortJsonByField(special, '__proto__.score').map(row => row.__proto__.score), [0,2]);
});

test('map fallback uses only nullish missing values and does not add a second value prefix', () => {
    const data = { high: {value:{score:5}}, zero: {score:0,value:{score:99}}, low: {score:null,value:{score:-1}}, direct: {score:2} };
    assert.deepEqual(Object.keys(sort.sortJsonByField(data, 'score')), ['low','zero','direct','high']);
    const prefixed = {nested:{value:{score:null,value:{score:-10}}}, direct:{value:{score:0}}};
    assert.deepEqual(Object.keys(sort.sortJsonByField(prefixed, 'value.score')), ['nested','direct']);
});

test('raw and Unicode-spelled user tokens stay literal in keys and values across multiple nested layers', t => {
    t.mock.method(globalThis.crypto, 'getRandomValues', bytes => bytes.fill(0));
    const secondLiteral = '\uE000\uE002' + '\uE001'.repeat(12);
    const deepest = String.raw`{"same":"\u0041","different":"\u0042"}`;
    const middle = '{"same":"\\u0041","deep":' + JSON.stringify(deepest) + '}';
    const base = '{"outer":"\\u0041",' + JSON.stringify(firstAllocation) + ':' + JSON.stringify(secondLiteral)
        + ',"literal":' + JSON.stringify(firstAllocation) + ',"payload":' + JSON.stringify(middle) + '}';
    const expected = {outer:'A', [firstAllocation]:secondLiteral, literal:firstAllocation, payload:{same:'A',deep:{same:'A',different:'B'}}};
    for (const spelling of ['raw', 'unicode']) {
        let input = spelling === 'raw' ? base : base.replace(/[\uE000-\uF8FF]/g, char => '\\u' + char.charCodeAt(0).toString(16).padStart(4, '0'));
        for (let wrappers = 0; wrappers < 3; wrappers++) {
            const result = unescapeJsonText(input, options);
            assert.equal(result.ok, true, `${spelling}/${wrappers}`);
            assert.deepEqual(JSON.parse(result.text), expected, `${spelling}/${wrappers}`);
            input = JSON.stringify(input);
        }
    }
});

test('object-map and fallback sort branches preserve plain JSON own special keys without mutating input', () => {
    const objects = JSON.parse('{"__proto__":{"n":2},"constructor":{"n":0},"prototype":{"n":1}}');
    const originalObjects = JSON.stringify(objects);
    const sortedObjects = sort.sortJsonByField(objects, 'n');
    assert.deepEqual(Object.keys(sortedObjects), ['constructor','prototype','__proto__']);
    assert.equal(Object.getPrototypeOf(sortedObjects), Object.prototype);
    assert.strictEqual(sortedObjects.__proto__, objects.__proto__);
    assert.equal(JSON.stringify(objects), originalObjects);

    const primitives = JSON.parse('{"__proto__":2,"constructor":0,"prototype":1}');
    const sortedPrimitives = sort.sortJsonByField(primitives, '');
    assert.deepEqual(Object.keys(sortedPrimitives), ['constructor','prototype','__proto__']);
    assert.equal(sortedPrimitives.__proto__, 2);
    assert.equal(Object.getPrototypeOf(sortedPrimitives), Object.prototype);

    const fallback = JSON.parse('{"__proto__":[{"n":2},{"n":0}],"constructor":{"keep":true},"prototype":false}');
    const originalFallback = JSON.stringify(fallback);
    const sortedFallback = sort.sortJsonByField(fallback, 'n');
    assert.deepEqual(sortedFallback.__proto__, [{n:0},{n:2}]);
    assert.equal(Object.getPrototypeOf(sortedFallback), Object.prototype);
    assert.strictEqual(sortedFallback.constructor, fallback.constructor);
    assert.equal(sortedFallback.prototype, false);
    assert.equal(JSON.stringify(fallback), originalFallback);
    assert.equal(Object.prototype.n, undefined);
});
