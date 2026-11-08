import assert from 'node:assert/strict';
import test from 'node:test';
import { bundleModule } from '../scripts/compare-json-repair.mjs';
const sort = await bundleModule('src/components/utils/jsonSort.ts');
const { detectInconsistentEscapeLevels } = await bundleModule('src/components/utils/jsonStructure.ts');

test('dictionary comparator matches localeCompare options including stable ties', () => {
    const words = ['中文', 'z', 'A', 'a', 'é', 'e', 'a10', 'a2', '🙂', '', 'Ö', 'o'];
    const expected = [...words].sort((a,b) => a.localeCompare(b, undefined, { numeric: false, sensitivity: 'base' }));
    assert.deepEqual([...words].sort(sort.compareDictionary), expected);
    assert.equal(sort.sortStringLines(words.filter(Boolean).join('\n'), 'dictionary', 'asc'), expected.filter(Boolean).join('\n'));
});

test('all object sorting branches preserve own prototype-named JSON properties', () => {
    for (const input of [
        '{"__proto__":{"rank":2},"constructor":{"rank":1},"a":{"rank":3}}',
        '{"__proto__":[{"rank":2},{"rank":1}],"a":[]}',
        '{"__proto__":2,"constructor":1,"a":3}',
    ]) {
        const data = JSON.parse(input);
        for (const method of ['dictionary', 'length', 'field']) {
            const result = sort.sortJsonObject(data, method, 'asc', 'rank');
            assert.equal(Object.hasOwn(result, '__proto__'), true);
            assert.equal(Object.getPrototypeOf(result), Object.prototype);
            assert.deepEqual(Object.keys(result).sort(), Object.keys(data).sort());
        }
        const result = sort.sortJsonByField(data, 'rank');
        assert.equal(Object.hasOwn(result, '__proto__'), true);
        assert.equal(Object.getPrototypeOf(result), Object.prototype);
    }
    assert.equal(Object.prototype.rank, undefined);
});

test('escape level matching uses the nearest preceding structural quote', () => {
    const consistent = '{' + Array.from({length: 12000}, (_, i) => String.raw`\"k${i}\":\"\\u0041\"`).join(',') + '}';
    assert.equal(detectInconsistentEscapeLevels(consistent), false);
    assert.equal(detectInconsistentEscapeLevels(consistent.slice(0, -1) + String.raw`,\"bad\":\"\u0041\"}`), true);
    assert.equal(detectInconsistentEscapeLevels(String.raw`{"ordinary":"\\u0041"}`), false);
});

const { decodeHex, smartDecode } = await import('../src/components/utils/decode.ts');
test('long unreadable hex runs remain verbatim and later readable runs still decode', () => {
    const run = String.raw`\x00\xFF\xC2\x80`.repeat(12000);
    assert.equal(decodeHex(run), null);
    assert.equal(smartDecode(run), run);
    assert.equal(decodeHex(run + String.raw`\x41`), run + 'A');
    assert.equal(smartDecode(run + String.raw`\u0041`), run + 'A');
});
test('long backslash runs preserve original parity and decode only one layer', () => {
    const even = '\\'.repeat(24000);
    assert.equal(smartDecode(even + 'u0041'), even + 'u0041');
    assert.equal(smartDecode(even + String.raw`\u0041`), even + 'A');
    assert.equal(smartDecode(String.raw`\u005Cu0041`), String.raw`\u0041`);
});

const { cookieToJSON } = await bundleModule('src/components/utils/jsonConvert.ts');
test('cookie conversion retains prototype-named cookie keys as ordinary data', () => {
    const result = JSON.parse(cookieToJSON('__proto__=value; constructor=other; normal=ok'));
    assert.equal(Object.hasOwn(result, '__proto__'), true);
    assert.equal(result.__proto__, 'value');
    assert.equal(result.constructor, 'other');
});

const { replaceUndefinedValuesWithNull } = await bundleModule('src/components/utils/jsonEngine/preprocess.ts');
test('undefined preprocessing keeps strings, keys, identifiers and comments opaque', () => {
    for (const [input,expected] of [
        ['[undefined, undefined]', '[null, null]'],
        ['{undefined: undefined, xundefined: "undefined"}', '{undefined: null, xundefined: "undefined"}'],
        ['[/* undefined */ undefined,// undefined\nundefined]', '[/* undefined */ null,// undefined\nnull]'],
        ['[\'undefined\',undefined]', '[\'undefined\',null]'],
        ['[undefinedThing, undefined_1, $undefined]', '[undefinedThing, undefined_1, $undefined]'],
        ['{ a: /*x*/ undefined /*y*/ }', '{ a: /*x*/ null /*y*/ }'],
        ['[\n# undefined\nundefined]', '[\n# undefined\nnull]'],
    ]) assert.equal(replaceUndefinedValuesWithNull(input),expected);
});
test('large minified undefined lists preserve every value without repeated prefix scans', () => {
    const input = '[' + 'undefined,'.repeat(50000) + 'undefined]';
    assert.equal(replaceUndefinedValuesWithNull(input), '[' + 'null,'.repeat(50000) + 'null]');
});

test('field sorting preserves empty paths, nested array branches and non-array siblings', () => {
    assert.deepEqual(sort.sortJsonByField([3, 0, 1], ''), [0, 1, 3]);
    assert.deepEqual(sort.sortJsonByField([[{n:2},{n:1}], {keep:true}], 'n'), [[{n:1},{n:2}], {keep:true}]);
    assert.deepEqual(sort.sortJsonByField({list:[{n:2},{n:1}], keep:'same'}, 'n'), {list:[{n:1},{n:2}], keep:'same'});
    assert.deepEqual(sort.sortJsonObject({list:[{n:1},{n:2}], nested:{list:[{n:0},{n:3}]}}, 'field', 'desc', 'n'), {list:[{n:2},{n:1}], nested:{list:[{n:3},{n:0}]}});
});

test('single-encoding decoders do not accidentally activate the other encoding', async () => {
    const { decodeUnicode, decodeHex } = await import('../src/components/utils/decode.ts');
    assert.equal(decodeUnicode(String.raw`\x41-\u0042`), String.raw`\x41-B`);
    assert.equal(decodeHex(String.raw`\x41-\u0042`), String.raw`A-\u0042`);
    assert.equal(decodeUnicode(String.raw`\x41`), null);
    assert.equal(decodeHex(String.raw`\u0042`), null);
});
