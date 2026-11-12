import assert from 'node:assert/strict';
import test from 'node:test';
import { bundleModule } from '../scripts/compare-json-repair.mjs';

const { getRootPathSuggestions: roots, getFieldPathSuggestions: fields } = await bundleModule('src/components/utils/jsonSortSuggestions.ts');
const paths = (suggestions) => suggestions.map(({ value }) => value);

test('root suggestions retain the complete path after indexed and wildcard ancestors', () => {
    const data = { users: [{ profile: { teams: [], title: 'lead' } }] };
    assert.deepEqual(paths(roots(data, 'users[0].profile.te')), ['users[0].profile.teams', 'users[0].profile.teams[*]']);
    assert.deepEqual(paths(roots(data, 'users[*].profile.')), ['users[*].profile.teams', 'users[*].profile.teams[*]']);
    assert.deepEqual(paths(roots(data, 'users[0]')), ['users[0].profile']);
    assert.deepEqual(paths(roots(data, 'users.')), []);
});

test('root array completion supports root, named and consecutive indexes', () => {
    const data = [{ items: [] }, { items: [] }];
    assert.deepEqual(new Set(paths(roots(data, '[1'))), new Set(['[1]', '[*]']));
    assert.deepEqual(paths(roots({ rows: data }, 'rows[')), ['rows[*]']);
    assert.deepEqual(paths(roots(data, '[*].it')), ['[*].items', '[*].items[*]']);
    assert.deepEqual(paths(roots({ matrix: [[{}]] }, 'matrix[0][')), ['matrix[0][*]']);
});

test('root wildcard navigation keeps its first-element sampling boundary', () => {
    assert.deepEqual(paths(roots([{ first: [] }, { later: [] }], '[*].')), ['[*].first', '[*].first[*]']);
    assert.deepEqual(paths(roots([null, { later: [] }], '[*].')), []);
});

test('field suggestions combine array members and complete nested fields', () => {
    const data = [{ id: 2, user: { profile: { age: 30 } } }, { name: 'a', user: { profile: { active: true } } }];
    assert.deepEqual(paths(fields(data, '', '')), ['id', 'name', 'user']);
    assert.deepEqual(paths(fields(data, '', 'user.profile.ag')), ['user.profile.age']);
    assert.deepEqual(paths(fields(data, '', 'user.profile.')), ['user.profile.active', 'user.profile.age']);
    assert.deepEqual(paths(fields(data, '', 'am')), ['name']);
});

test('complete field matches precede substring matches for native Enter selection', () => {
    const data = [{ grid: 1, id: 2, middle: 3, user: { grid: 1, id: 2, middle: 3 } }];
    assert.deepEqual(paths(fields(data, '', ' id ')), ['id', 'grid', 'middle']);
    assert.deepEqual(paths(fields(data, '', 'user.id')), ['user.id', 'user.grid', 'user.middle']);
    assert.deepEqual(paths(fields(data, '', 'i')), ['grid', 'id', 'middle']);
});

test('complete matches preserve actual key case and prefer case-sensitive equality', () => {
    const data = [{ grid: 1, ID: 2, user: { grid: 1, ID: 2 } }];
    assert.deepEqual(paths(fields(data, '', 'id')), ['ID', 'grid']);
    assert.deepEqual(paths(fields(data, '', 'user.id')), ['user.ID', 'user.grid']);
    assert.deepEqual(paths(fields([{ grid: 1, id: 2, ID: 3 }], '', 'ID')), ['ID', 'grid', 'id']);
    assert.deepEqual(paths(roots({ ID: {}, identity: {} }, 'id')), ['ID', 'identity']);
});

test('map fields use values and include the supported value-field shorthand', () => {
    const data = { B: { id: 2, value: { score: 9 } }, A: { id: 1, value: { score: 3 } } };
    assert.deepEqual(paths(fields(data, '', '')), ['id', 'score', 'value']);
    assert.deepEqual(paths(fields(data, '', 'value.sc')), ['value.score']);
    assert.deepEqual(paths(fields({ B: 2, A: 1 }, '', '')), []);
    assert.deepEqual(paths(fields({ map: data }, 'map', '')), ['id', 'score', 'value']);
});

test('mixed objects and arrays of arrays follow the actual sort comparison scope', () => {
    assert.deepEqual(paths(fields({ meta: { ignored: 1 }, rows: [{ id: 2 }, { score: 1 }] }, '', '')), ['id', 'score']);
    assert.deepEqual(paths(fields([[{ id: 2 }], [{ name: 'a' }], { ignored: true }], '', '')), ['id', 'name']);
    assert.deepEqual(paths(fields({ rows: [[{ id: 2 }]] }, '', '[0].')), ['[0].id']);
});

test('wildcard scopes traverse all selected arrays and return full field paths', () => {
    const data = { groups: [{ users: [{ user: { age: 3 } }] }, { users: [{ user: { name: 'a' } }] }] };
    assert.deepEqual(paths(fields(data, 'groups[*].users', 'user.')), ['user.age', 'user.name']);
    assert.deepEqual(paths(fields(data, 'groups[1].users', 'user.n')), ['user.name']);
    assert.deepEqual(paths(fields([{ id: 2 }, { id: 1 }], '[*]', '')), []);
    assert.deepEqual(paths(fields([[{ id: 2 }], [{ name: 'a' }]], '[*]', '')), ['id', 'name']);
});

test('suggestions exclude unsupported literal keys while preserving safe own prototype-named keys', () => {
    const item = JSON.parse('{"a.b":1,"a[0]":2,"":3,"__proto__":{"rank":4},"constructor":5,"normal":6}');
    assert.deepEqual(paths(fields([item], '', '')), ['__proto__', 'constructor', 'normal']);
    assert.deepEqual(paths(fields([item], '', '__proto__.r')), ['__proto__.rank']);
    const root = JSON.parse('{"a.b":[],"a[0]":[],"":[],"__proto__":{"rows":[]}}');
    assert.deepEqual(paths(roots(root, '')), ['__proto__']);
    assert.deepEqual(paths(roots(root, '__proto__.r')), ['__proto__.rows', '__proto__.rows[*]']);
    const inherited = Object.create({ secret: { rows: [] } });
    inherited.own = [];
    assert.deepEqual(paths(roots(inherited, 'secret.')), []);
    assert.deepEqual(paths(fields([Object.create({ secret: 1 })], '', '')), []);
});

test('consecutive indexes retain complete range and field candidates', () => {
    const data = { groups: [[{ items: [{ id: 2 }, { id: 1 }] }]] };
    assert.deepEqual(paths(roots(data, 'groups[0][0].it')), ['groups[0][0].items', 'groups[0][0].items[*]']);
    assert.deepEqual(paths(fields(data, 'groups[0][0].items', 'i')), ['id']);
    assert.deepEqual(new Set(paths(roots(data, 'groups[0][0'))), new Set(['groups[0][0]', 'groups[0][*]']));
    assert.deepEqual(new Set(paths(fields([{ stats: [[2, 3]] }], '', 'stats[0][1'))), new Set(['stats[0][1]', 'stats[0][*]']));
    assert.deepEqual(paths(roots([[{ items: [] }]], '[0][0].it')), ['[0][0].items', '[0][0].items[*]']);
});

test('suggested paths survive execution trimming without changing the selected key', () => {
    const data = [{ ' score': 1, 'score ': 2, score: 3, user: { ' name': 4, 'name ': 5, name: 6 } }];
    assert.deepEqual(paths(fields(data, '', '')), ['score', 'user']);
    assert.deepEqual(new Set(paths(fields(data, '', 'user.'))), new Set(['user. name', 'user.name']));
    assert.deepEqual(paths(roots({' rows': {}, 'rows ': {}, rows: []}, '')), ['rows', 'rows[*]']);
});
