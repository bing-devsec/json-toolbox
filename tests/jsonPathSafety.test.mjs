import assert from 'node:assert/strict';
import test from 'node:test';
import { getValueByPath, setValueByPath } from '../src/components/utils/jsonPath.ts';
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
