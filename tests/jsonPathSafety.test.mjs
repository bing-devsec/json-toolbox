import assert from 'node:assert/strict';
import test from 'node:test';
import { getValueByPath, setValueByPath, parsePathToParts } from '../src/components/utils/jsonPath.ts';
import { bundleModule } from '../scripts/compare-json-repair.mjs';
const { sortJsonByField } = await bundleModule('src/components/utils/jsonSort.ts');

test('indexed paths preserve falsy values at root and nested locations', () => {
    for (const value of [0, false, '', null]) {
        assert.equal(getValueByPath([value], '[0]'), value);
        assert.equal(getValueByPath({a:[value]}, 'a[0]'), value);
        assert.equal(getValueByPath({a:[value]}, 'a[*]'), value);
    }
    assert.equal(getValueByPath([], '[10]'), null);
    const values = [{v:[1]}, {v:[0]}, {v:[-1]}];
    assert.deepEqual(sortJsonByField(values, 'v[0]').map(x => x.v[0]), [-1,0,1]);
});
test('own prototype-named fields remain readable and writable as ordinary JSON', () => {
    const data = JSON.parse('{"__proto__":{"prototype":{"constructor":0}},"constructor":{"prototype":false}}');
    assert.equal(getValueByPath(data, '__proto__.prototype.constructor'), 0);
    assert.equal(setValueByPath(data, '__proto__.prototype.constructor', 7), true);
    assert.equal(getValueByPath(data, '__proto__.prototype.constructor'), 7);
    assert.equal(setValueByPath(data, 'constructor.prototype', ''), true);
    assert.equal(getValueByPath(data, 'constructor.prototype'), '');
    assert.equal(setValueByPath(data, '__proto__', {ok:true}), true);
    assert.equal(Object.getPrototypeOf(data), Object.prototype);
    assert.deepEqual(data.__proto__, {ok:true});
});
test('inherited paths are neither read nor followed for writes', () => {
    const inherited = {secret:{value:1}, list:[1]};
    const data = Object.create(inherited);
    assert.equal(getValueByPath(data, 'secret.value'), null);
    assert.equal(setValueByPath(data, 'secret.value', 2), false);
    assert.equal(setValueByPath(data, 'secret', 2), false);
    assert.equal(setValueByPath(data, 'list[0]', 2), false);
    assert.equal(setValueByPath({}, '__proto__.polluted', true), false);
    assert.equal(setValueByPath({}, 'constructor.prototype.polluted', true), false);
    assert.deepEqual(inherited, {secret:{value:1}, list:[1]});
    assert.equal(Object.prototype.polluted, undefined);
    const array = new Array(1);Object.setPrototypeOf(array, {0:{value:1}});
    assert.equal(getValueByPath(array, '[0].value'), null);
    assert.equal(setValueByPath(array, '[0].value', 2), false);
});
test('ordinary writes preserve indexed containers and allow new ordinary fields', () => {
    const data = {a:[0,false,'']};
    assert.equal(setValueByPath(data, 'a[1]', 4), true);
    assert.deepEqual(data.a, [0,4,'']);
    assert.equal(setValueByPath(data, 'new', false), true);
    assert.equal(data.new, false);
});

test('consecutive named indexes read and write the selected value without changing sibling arrays', () => {
    const data = {a: [[0, false], ['', 7]]};
    assert.equal(getValueByPath(data, 'a[0][1]'), false);
    assert.equal(getValueByPath(data, 'a[1][0]'), '');
    assert.equal(setValueByPath(data, 'a[0][1]', true), true);
    assert.deepEqual(data, {a: [[0, true], ['', 7]]});
});

test('consecutive root indexes preserve each array level during reads and writes', () => {
    const data = [[{id: 'a'}, {id: 'b'}], [{id: 'c'}, {id: 'd'}]];
    assert.equal(getValueByPath(data, '[0][1].id'), 'b');
    assert.equal(setValueByPath(data, '[0][1]', {id: 'updated'}), true);
    assert.deepEqual(data, [[{id: 'a'}, {id: 'updated'}], [{id: 'c'}, {id: 'd'}]]);
});

test('properties after consecutive indexes keep their parent and unrelated branches intact', () => {
    const data = {a: [[{items: ['first']}, {items: ['target']}], [{items: ['other']}]]};
    assert.deepEqual(getValueByPath(data, 'a[0][1].items'), ['target']);
    assert.equal(setValueByPath(data, 'a[0][1].items', ['updated']), true);
    assert.deepEqual(data, {a: [[{items: ['first']}, {items: ['updated']}], [{items: ['other']}]]});
});

test('malformed paths cannot be partially parsed into a different target', () => {
    const data = {users: [{id: 2}, {id: 1}]};
    for (const path of ['users[abc]', 'users[0', 'users..', '.users', 'users[]', 'users[-1]', 'users[0]suffix']) {
        assert.throws(() => parsePathToParts(path), /Invalid JSON path/);
        assert.equal(getValueByPath(data, path), null, path);
        assert.equal(setValueByPath(data, path, []), false, path);
    }
    assert.deepEqual(data, {users: [{id: 2}, {id: 1}]});
});

test('array steps reject object containers instead of skipping the index', () => {
    const data = {record: {items: [{id: 2}, {id: 1}]}};
    for (const path of ['record[0].items', 'record[0][1].items', 'record[*].items', '[0].record.items']) {
        assert.equal(getValueByPath(data, path), null, path);
        assert.equal(setValueByPath(data, path, []), false, path);
    }
    assert.deepEqual(data, {record: {items: [{id: 2}, {id: 1}]}});
});
