import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { effectScope, nextTick, ref } from 'vue';

// Exercise the composable and real JSON5 parser together. Only browser editor
// adapters are stubbed; Vue refs/watchers remain attached to a real effect scope.
const require = createRequire(import.meta.url);
const bundled = await build({
    stdin: {
        contents: `export { useJsonSort } from './src/components/composables/useJsonSort';
                   export { useJsonEngine } from './src/components/composables/useJsonEngine';`,
        resolveDir: fileURLToPath(new URL('..', import.meta.url)),
        loader: 'ts',
    },
    bundle: true,
    write: false,
    platform: 'node',
    format: 'cjs',
    external: ['vue'],
    plugins: [{
        name: 'sort-editor-adapters',
        setup(builder) {
            builder.onResolve({ filter: /^monaco-editor(?:\/|$)|\/diffMonaco$/ }, args => ({ path: args.path, namespace: 'editor-fixture' }));
            builder.onLoad({ filter: /.*/, namespace: 'editor-fixture' }, ({ path }) => ({
                contents: path.endsWith('/diffMonaco')
                    ? 'export const replaceEditorValuePreservingUndo = (editor, value) => editor.setValue(value);'
                    : 'export const editor = {};',
            }));
        },
    }],
});
const module = { exports: {} };
new Function('require', 'module', 'exports', bundled.outputFiles[0].text)(require, module, module.exports);
const { useJsonSort, useJsonEngine } = module.exports;

function createEditor(initialValue) {
    let value = initialValue;
    let version = 1;
    const model = { getVersionId: () => version, isDisposed: () => false };
    return {
        getValue: () => value,
        setValue(nextValue) { value = nextValue; version++; },
        getModel: () => model,
        updateOptions() {},
    };
}

function fixture(t, initialValue, diffValues = {}) {
    const scope = effectScope();
    t.after(() => scope.stop());
    let inputEditor = createEditor(initialValue);
    const outputEditor = createEditor('previous output');
    const diffEditors = {
        left: createEditor(diffValues.left ?? ''),
        right: createEditor(diffValues.right ?? ''),
    };
    const errors = [], successes = [], parsedInputs = [], parsedResults = [];
    const sortOrder = ref('asc');
    const engine = useJsonEngine({
        indentSize: ref(2), arrayNewLine: ref(true),
        preserveNumberLiterals: ref(true), encodingMode: ref(false),
    });
    const sort = scope.run(() => useJsonSort({
        settingsTxt: ref({
            msgSortDataRequired: 'input required',
            msgNoAvailableEditor: 'missing editor',
            msgSortFail: reason => `sort failed: ${reason}`,
            msgFieldSortPathNotSortable: path => `not sortable: ${path}`,
            msgFieldSortInvalidPath: path => `invalid scope: ${path}`,
            msgFieldSortInvalidField: path => `invalid field: ${path}`,
            fieldSortPathData: path => path,
            fieldSortRootData: 'root',
            msgFieldSortSuccess: (field, path) => `sorted ${path} by ${field}`,
        }),
        sortMethod: ref('field'), sortOrder,
        getInputEditor: () => inputEditor,
        getOutputEditor: () => outputEditor,
        getDiffSideEditor: side => diffEditors[side],
        isDiffMode: ref(false), enterDiffMode() {}, exitDiffMode: async () => {},
        updateDiffEditorOptions() {}, ensureProcessingFeatureAvailable: () => true,
        showMessageError: message => errors.push(message),
        showMessageSuccess: message => successes.push(message),
        preprocessJSON(raw, options) {
            parsedInputs.push(raw);
            const parsed = engine.parse(raw, options);
            parsedResults.push(parsed);
            return parsed;
        },
        formatJsonResult: (data, escapeMap) => engine.stringify(data, escapeMap),
        formatDemoResult: data => engine.stringify(data),
        writeOutputJson: value => outputEditor.setValue(value),
        setOutputTypeJson() {}, clearOutputEditor: () => outputEditor.setValue(''),
        clearOutputFoldingInfo() {}, updateEditorHeight() {}, updateLineNumberWidth() {},
    }));
    return {
        sort, errors, successes, parsedInputs, parsedResults, sortOrder, outputEditor, diffEditors,
        get inputEditor() { return inputEditor; },
        replaceInput(value) { inputEditor = value === null ? null : createEditor(value); },
        queryRoot: query => querySuggestions(sort.queryRootPaths, query),
        queryField: query => querySuggestions(sort.queryFieldPathsFromScope, query),
    };
}

async function querySuggestions(query, input = '') {
    const calls = [];
    await query(input, suggestions => calls.push(suggestions));
    assert.equal(calls.length, 1, 'each query completes its callback exactly once');
    assert(Array.isArray(calls[0]));
    return calls[0].map(suggestion => suggestion.value);
}

// A selected suggestion is assigned through v-model, exactly like typed text;
// no custom keydown/select/input handler is needed to finish a relative path.
test('JSON5 scope and field suggestions return complete paths accepted by sorting', async t => {
    const source = `{ // compatible input uses comments, single quotes and trailing commas
        groups: [{ users: [{ profile: { age: 2 }, label: 'later' }, { profile: { age: 1 }, label: 'first' },], },],
    }`;
    const f = fixture(t, source);
    f.sort.applySort();
    assert.equal(f.sort.fieldSortDialogVisible.value, true);
    assert.deepEqual(await f.queryRoot('groups[*].u'), ['groups[*].users', 'groups[*].users[*]']);
    f.sort.sortRootPath.value = 'groups[*].users';
    assert.deepEqual(await f.queryField('profile.a'), ['profile.age']);
    f.sort.sortFieldName.value = 'profile.age';
    f.sort.executeFieldSort();
    assert.deepEqual(f.errors, []);
    assert.equal(f.successes.length, 1);
    assert.equal(f.sort.fieldSortDialogVisible.value, false);
    assert.deepEqual(JSON.parse(f.outputEditor.getValue()).groups[0].users.map(item => item.label), ['first', 'later']);
    assert.equal(f.inputEditor.getValue(), source);
});

test('map suggestions describe compared values and choosing id changes the output order', async t => {
    const source = '{"second":{"id":2,"value":{"score":20}},"first":{"id":1,"value":{"score":10}}}';
    const f = fixture(t, source);
    f.sort.applySort();
    const fields = await f.queryField('');
    assert(fields.includes('id'));
    assert(fields.includes('value'));
    assert(!fields.includes('first'));
    assert(!fields.includes('second'));
    assert.deepEqual(await f.queryField('value.s'), ['value.score']);
    f.sort.sortFieldName.value = 'id';
    f.sort.executeFieldSort();
    assert.deepEqual(Object.keys(JSON.parse(f.outputEditor.getValue())), ['first', 'second']);
    assert.equal(f.inputEditor.getValue(), source);
    assert.deepEqual(f.errors, []);
});

test('field suggestions immediately follow the current scope and nested field query', async t => {
    const f = fixture(t, '{"first":[{"oldId":2}],"second":[{"rank":1,"profile":{"age":4}}]}');
    f.sort.applySort();
    f.sort.sortRootPath.value = 'first';
    assert.deepEqual(await f.queryField(''), ['oldId']);
    f.sort.sortRootPath.value = 'second';
    assert.deepEqual(await f.queryField(''), ['profile', 'rank']);
    assert.deepEqual(await f.queryField('profile.a'), ['profile.age']);
    f.sort.sortRootPath.value = 'missing';
    assert.deepEqual(await f.queryField(''), []);
    f.sort.sortRootPath.value = 'first';
    assert.deepEqual(await f.queryField(''), ['oldId']);
});

test('suggestions follow edits and replacement input models without retaining parsed data', async t => {
    const f = fixture(t, '{"old":[{"oldField":1}]}');
    f.sort.applySort();
    assert.deepEqual(await f.queryRoot(''), ['old', 'old[*]']);
    f.sort.sortRootPath.value = 'old';
    assert.deepEqual(await f.queryField(''), ['oldField']);
    f.inputEditor.setValue('{"edited":[{"editedField":1}]}');
    assert.deepEqual(await f.queryRoot(''), ['edited', 'edited[*]']);
    f.sort.sortRootPath.value = 'edited';
    assert.deepEqual(await f.queryField(''), ['editedField']);
    f.replaceInput('{"replacement":[{"replacementField":1}]}');
    assert.deepEqual(await f.queryRoot(''), ['replacement', 'replacement[*]']);
    f.sort.sortRootPath.value = 'replacement';
    assert.deepEqual(await f.queryField(''), ['replacementField']);
});

test('cancel and reopen discard previous path context while keeping the chosen direction', async t => {
    const f = fixture(t, '{"groups":[{"users":[{"id":1}]}]}');
    f.sort.applySort();
    assert.deepEqual(await f.queryRoot('groups[*].u'), ['groups[*].users', 'groups[*].users[*]']);
    f.sort.sortRootPath.value = 'groups[*].users';
    f.sort.sortFieldName.value = 'id';
    f.sortOrder.value = 'desc';
    f.sort.fieldSortDialogVisible.value = false;
    await nextTick();
    f.inputEditor.setValue('{"latest":[{"score":3}]}');
    f.sort.applySort();
    assert.equal(f.sort.sortRootPath.value, '');
    assert.equal(f.sort.sortFieldName.value, '');
    assert.equal(f.sortOrder.value, 'desc');
    assert.deepEqual(await f.queryRoot('l'), ['latest', 'latest[*]']);
    f.sort.sortRootPath.value = 'latest';
    assert.deepEqual(await f.queryField(''), ['score']);
    f.sort.sortRootPath.value = '';
    f.sort.sortFieldName.value = '';
    assert.deepEqual(await f.queryRoot(''), ['latest', 'latest[*]']);
    assert.equal(f.sort.sortRootPath.value, '', 'queries must not fill a cleared model');
    assert.equal(f.sort.sortFieldName.value, '');
});

test('empty, invalid and unavailable sources complete suggestions without stale candidates', async t => {
    const f = fixture(t, '{"valid":[{"id":1}]}');
    f.sort.applySort();
    assert.deepEqual(await f.queryRoot(''), ['valid', 'valid[*]']);
    for (const raw of ['', '   ', '{broken:', 'null']) {
        f.inputEditor.setValue(raw);
        f.sort.sortRootPath.value = '';
        assert.deepEqual(await f.queryRoot(''), [], raw);
        assert.deepEqual(await f.queryField(''), [], raw);
    }
    f.replaceInput(null);
    assert.deepEqual(await f.queryRoot(''), []);
    assert.deepEqual(await f.queryField(''), []);
    assert.deepEqual(f.errors, [], 'typing suggestions do not show parse error notifications');
    assert.equal(f.outputEditor.getValue(), 'previous output');
});

test('empty input does not open a dialog and failed execution preserves existing output', t => {
    const f = fixture(t, '   ');
    f.sort.applySort();
    assert.equal(f.sort.fieldSortDialogVisible.value, false);
    assert.deepEqual(f.errors, ['input required']);
    f.inputEditor.setValue('{broken:');
    f.sort.applySort();
    assert.equal(f.sort.fieldSortDialogVisible.value, true);
    f.sort.executeFieldSort();
    assert.equal(f.sort.fieldSortDialogVisible.value, false);
    assert.equal(f.outputEditor.getValue(), 'previous output');
    assert.equal(f.errors.length, 2);
    assert.equal(f.successes.length, 0);
});

// This composable API currently has no Diff UI caller. Keep its existing target
// contract covered without adding or implying a new field-sort UI capability.
test('latent Diff field-sort API uses the selected side for both suggestions and execution', async t => {
    const f = fixture(t, '{"normal":[{"normalField":0}]}', {
        left: '{leftRows:[{leftId:2},{leftId:1}]}',
        right: '{rightRows:[{rightId:4},{rightId:3}]}',
    });
    for (const [side, root, field, expected] of [
        ['left', 'leftRows', 'leftId', [1, 2]],
        ['right', 'rightRows', 'rightId', [3, 4]],
    ]) {
        const opposite = side === 'left' ? 'right' : 'left';
        const oppositeBefore = f.diffEditors[opposite].getValue();
        const source = f.diffEditors[side].getValue();
        f.parsedInputs.length = 0;
        f.sort.openFieldSortDialogForDiff(side);
        assert.deepEqual(await f.queryRoot(''), [root, `${root}[*]`]);
        f.sort.sortRootPath.value = root;
        assert.deepEqual(await f.queryField(''), [field]);
        f.sort.sortFieldName.value = field;
        f.sort.executeFieldSort();
        assert.deepEqual(JSON.parse(f.diffEditors[side].getValue())[root].map(item => item[field]), expected);
        assert.equal(f.diffEditors[opposite].getValue(), oppositeBefore);
        assert(f.parsedInputs.length > 0);
        assert(f.parsedInputs.every(raw => raw === source), 'suggestions and execution parse only the selected side');
    }
    assert.equal(f.inputEditor.getValue(), '{"normal":[{"normalField":0}]}');
    assert.equal(f.outputEditor.getValue(), 'previous output');
    assert.deepEqual(f.errors, []);
});


test('escaped keys never expose parser placeholders in root or field suggestions', async t => {
    const source = String.raw`{"\u0072oot":[{"hidden":1}],"rows":[{"\u0069d":2,"name":"two","profile":{"\u0061ge":2,"score":20}},{"\u0069d":1,"name":"one","profile":{"\u0061ge":1,"score":10}}]}`;
    const f = fixture(t, source);
    f.sort.applySort();
    const assertNoProtectedTokens = suggestions => {
        const parsed = f.parsedResults.at(-1);
        const tokens = [...parsed.escapeMap.keys()];
        assert(tokens.length > 0, 'the real engine protects this fixture with escapeMap tokens');
        assert(Object.keys(parsed.data).some(key => tokens.some(token => key.includes(token))),
            'the fixture includes an actual protected root key before suggestion filtering');
        for (const suggestion of suggestions) {
            assert(!tokens.some(token => suggestion.includes(token)), 'internal escape tokens are never user-editable paths');
        }
    };
    const rootSuggestions = await f.queryRoot('');
    assertNoProtectedTokens(rootSuggestions);
    assert.deepEqual(rootSuggestions, ['rows', 'rows[*]']);
    f.sort.sortRootPath.value = 'rows';
    const fieldSuggestions = await f.queryField('');
    assertNoProtectedTokens(fieldSuggestions);
    assert.deepEqual(fieldSuggestions, ['name', 'profile']);
    const nestedSuggestions = await f.queryField('profile.');
    assertNoProtectedTokens(nestedSuggestions);
    assert.deepEqual(nestedSuggestions, ['profile.score']);
    assert.deepEqual(f.errors, []);
    assert.equal(f.inputEditor.getValue(), source);
});

test('a consecutive-index sort scope changes only the selected nested array', t => {
    const source = '{"a":[[[{"id":4},{"id":3}],[{"id":2},{"id":1}]],[[{"id":8},{"id":7}],[{"id":6},{"id":5}]]]}';
    const f = fixture(t, source);
    f.sort.applySort();
    f.sort.sortRootPath.value = 'a[0][1]';
    f.sort.sortFieldName.value = 'id';
    f.sort.executeFieldSort();
    assert.deepEqual(f.errors, []);
    assert.deepEqual(JSON.parse(f.outputEditor.getValue()), {
        a: [
            [[{id: 4}, {id: 3}], [{id: 1}, {id: 2}]],
            [[{id: 8}, {id: 7}], [{id: 6}, {id: 5}]],
        ],
    });
    assert.equal(f.inputEditor.getValue(), source);
});

test('a sort field with consecutive indexes compares the intended scalar value', t => {
    const source = '[{"name":"A","stats":[[0,20],[1,0]]},{"name":"B","stats":[[0,10],[9,0]]}]';
    const f = fixture(t, source);
    f.sort.applySort();
    f.sort.sortFieldName.value = 'stats[0][1]';
    f.sort.executeFieldSort();
    assert.deepEqual(f.errors, []);
    assert.deepEqual(JSON.parse(f.outputEditor.getValue()), [
        {name: 'B', stats: [[0, 10], [9, 0]]},
        {name: 'A', stats: [[0, 20], [1, 0]]},
    ]);
    assert.equal(f.inputEditor.getValue(), source);
});

test('array scope, wildcard element traversal and nested array scope retain distinct meanings', t => {
    const source = '{"users":[{"id":2,"items":[{"id":4},{"id":3}]},{"id":1,"items":[{"id":2},{"id":1}]}]}';
    const cases = [
        ['users', {users: [
            {id: 1, items: [{id: 2}, {id: 1}]},
            {id: 2, items: [{id: 4}, {id: 3}]},
        ]}],
        // [*] visits the objects. It does not select their parent array for sorting.
        ['users[*]', JSON.parse(source)],
        ['users[*].items', {users: [
            {id: 2, items: [{id: 3}, {id: 4}]},
            {id: 1, items: [{id: 1}, {id: 2}]},
        ]}],
    ];
    for (const [rootPath, expected] of cases) {
        const f = fixture(t, source);
        f.sort.applySort();
        f.sort.sortRootPath.value = rootPath;
        f.sort.sortFieldName.value = 'id';
        f.sort.executeFieldSort();
        assert.deepEqual(f.errors, [], rootPath);
        assert.deepEqual(JSON.parse(f.outputEditor.getValue()), expected, rootPath);
        assert.equal(f.inputEditor.getValue(), source, rootPath);
    }
});

// Expected data and entry order below are specified independently of the sorter.
// Comparing the reserialized output also checks object insertion order, which a
// structural deepEqual alone would not catch for Map sorting.
function assertFieldSortResult(t, data, rootPath, field, expected, order = 'asc') {
    const source = JSON.stringify(data);
    const f = fixture(t, source);
    f.sortOrder.value = order;
    f.sort.applySort();
    f.sort.sortRootPath.value = rootPath;
    f.sort.sortFieldName.value = field;
    f.sort.executeFieldSort();
    assert.deepEqual(f.errors, [], `${rootPath || '<root>'}: ${field}`);
    assert.equal(f.successes.length, 1);
    const output = JSON.parse(f.outputEditor.getValue());
    assert.equal(JSON.stringify(output), JSON.stringify(expected), 'target order, values and unrelated structure match the independent expectation');
    assert.equal(f.inputEditor.getValue(), source, 'sorting never writes back into the input editor');
    return { f, output };
}

const demoPeople = [
    { id: 3, education: [{ graduationYear: 2015 }, { graduationYear: 2010 }] },
    { id: 1, education: [{ graduationYear: 2000 }, { graduationYear: 1990 }] },
    { id: 2, education: [{ graduationYear: 2020 }, { graduationYear: 2005 }] },
];
const demoMapEntries = {
    B: { id: 102, value: { score: 20 } },
    A: { id: 101, value: { score: 40 } },
    C: { id: 103, value: { score: 10 } },
};
const fourDemoCases = [
    { name: 'array by id', data: demoPeople, scope: '', field: 'id',
        asc: [demoPeople[1], demoPeople[2], demoPeople[0]],
        desc: [demoPeople[0], demoPeople[2], demoPeople[1]] },
    { name: 'each education array by graduationYear', data: demoPeople, scope: '[*].education', field: 'graduationYear',
        asc: [
            { id: 3, education: [{ graduationYear: 2010 }, { graduationYear: 2015 }] },
            { id: 1, education: [{ graduationYear: 1990 }, { graduationYear: 2000 }] },
            { id: 2, education: [{ graduationYear: 2005 }, { graduationYear: 2020 }] },
        ], desc: demoPeople },
    { name: 'Map by id', data: demoMapEntries, scope: '', field: 'id',
        asc: { A: demoMapEntries.A, B: demoMapEntries.B, C: demoMapEntries.C },
        desc: { C: demoMapEntries.C, B: demoMapEntries.B, A: demoMapEntries.A } },
    { name: 'Map by nested value.score', data: demoMapEntries, scope: '', field: 'value.score',
        asc: { C: demoMapEntries.C, B: demoMapEntries.B, A: demoMapEntries.A },
        desc: { A: demoMapEntries.A, B: demoMapEntries.B, C: demoMapEntries.C } },
];
for (const example of fourDemoCases) {
    for (const nested of [false, true]) {
        for (const order of ['asc', 'desc']) {
            test(`four demo compositions: ${example.name}, ${nested ? 'nested' : 'root'}, ${order}`, t => {
                const wrap = value => ({ envelope: { keep: ['z', 'a'], payload: value }, untouched: [{ id: 9 }, { id: 8 }] });
                const data = nested ? wrap(example.data) : example.data;
                const expected = nested ? wrap(example[order]) : example[order];
                const path = nested ? `envelope.payload${example.scope}` : example.scope;
                assertFieldSortResult(t, data, path, example.field, expected, order);
            });
        }
    }
}

test('deep threshold Map preserves missing, null and equal-value stability in both directions', t => {
    const entries = {
        high: { threshold: 0.9, llm_threshold: 0.3 },
        missing: { llm_threshold: 0.6 },
        equalFirst: { threshold: 0.1 },
        empty: { threshold: null },
        equalSecond: { threshold: 0.1, note: 'same threshold' },
        zero: { threshold: 0 },
    };
    const wrap = value => {
        let result = value;
        for (let level = 10; level >= 2; level--) result = { [`level${level}`]: result, keep: [2, 1] };
        return result;
    };
    const path = Array.from({ length: 9 }, (_, i) => `level${i + 2}`).join('.');
    const asc = { missing: entries.missing, empty: entries.empty, zero: entries.zero, equalFirst: entries.equalFirst, equalSecond: entries.equalSecond, high: entries.high };
    const desc = { high: entries.high, equalFirst: entries.equalFirst, equalSecond: entries.equalSecond, zero: entries.zero, missing: entries.missing, empty: entries.empty };
    for (const [order, expected] of [['asc', asc], ['desc', desc]]) {
        assertFieldSortResult(t, wrap(entries), path, 'threshold', wrap(expected), order);
    }
});

test('deep Map suggestions come from compared values and preserve nested-field completion', async t => {
    const f = fixture(t, '{"outer":{"rules":{"late":{"threshold":0.9,"value":{"score":8}},"early":{"threshold":0.1,"value":{"score":2}}}}}');
    f.sort.applySort();
    f.sort.sortRootPath.value = 'outer.rules';
    assert.deepEqual(await f.queryField('th'), ['threshold']);
    assert.deepEqual(await f.queryField('value.s'), ['value.score']);
    assert(!(await f.queryField('')).includes('late'));
});

test('wildcard-selected Maps sort entries without reordering their parent users or sibling data', t => {
    const first = { id: 2, rules: { B: { threshold: 0.8 }, A: { threshold: 0.2 } }, keep: [2, 1] };
    const second = { id: 1, rules: { Y: { threshold: 0.6 }, X: { threshold: 0.1 } } };
    const data = { users: [first, second], untouched: { Z: { threshold: 0.9 }, A: { threshold: 0.1 } } };
    const expected = { users: [
        { ...first, rules: { A: first.rules.A, B: first.rules.B } },
        { ...second, rules: { X: second.rules.X, Y: second.rules.Y } },
    ], untouched: data.untouched };
    assertFieldSortResult(t, data, 'users[*].rules', 'threshold', expected);
});

test('multiple wildcards can reach both arrays and Maps at the same target path', t => {
    const map = { Z: { threshold: 0.9 }, A: { threshold: 0.1 } };
    const array = [{ threshold: 0.8, tag: 'later' }, { threshold: 0.2, tag: 'earlier' }];
    const data = { groups: [
        { id: 'first', users: [{ id: 2, rules: map }, { id: 1, rules: array }] },
        { id: 'second', users: [{ id: 3, rules: {} }, { id: 4 }] },
    ], keep: ['b', 'a'] };
    const expected = { groups: [
        { id: 'first', users: [{ id: 2, rules: { A: map.A, Z: map.Z } }, { id: 1, rules: [array[1], array[0]] }] },
        { id: 'second', users: [{ id: 3, rules: {} }, { id: 4 }] },
    ], keep: ['b', 'a'] };
    assertFieldSortResult(t, data, 'groups[*].users[*].rules', 'threshold', expected);
});

test('consecutive indexes can select a Map and leave every other nested Map unchanged', t => {
    const map = { B: { id: 2 }, A: { id: 1 } };
    const data = { groups: [[{ rules: map }, { rules: map }], [{ rules: map }]], untouched: [2, 1] };
    const expected = structuredClone(data);
    expected.groups[0][1].rules = { A: map.A, B: map.B };
    assertFieldSortResult(t, data, 'groups[0][1].rules', 'id', expected);
});

test('primitive-value Maps keep their root behavior when selected through an explicit scope', t => {
    const values = { high: 3, firstEqual: 1, missing: null, secondEqual: 1, low: -1 };
    const expected = { missing: null, low: -1, firstEqual: 1, secondEqual: 1, high: 3 };
    assertFieldSortResult(t, values, '', '', expected);
    assertFieldSortResult(t, { values, keep: [3, 2, 1] }, 'values', '', { values: expected, keep: [3, 2, 1] });
});

test('Map value-field shorthand behaves the same at root and nested scopes', t => {
    const values = { B: { value: { score: 8 } }, A: { value: { score: 2 } } };
    const expected = { A: values.A, B: values.B };
    assertFieldSortResult(t, values, '', 'score', expected);
    assertFieldSortResult(t, { values, keep: [3, 2, 1] }, 'values', 'score', { values: expected, keep: [3, 2, 1] });
});

for (const rootPath of ['users[abc]', 'users[0', 'users..']) {
    test(`malformed scope ${rootPath} rejects without replacing the existing preview`, async t => {
        const source = '{"users":[{"id":2},{"id":1}]}';
        const f = fixture(t, source);
        f.sort.applySort();
        f.sort.sortRootPath.value = rootPath;
        f.sort.sortFieldName.value = 'id';
        assert.deepEqual(await f.queryField(''), [], 'invalid scopes must not suggest fields from a partially parsed path');
        f.sort.executeFieldSort();
        assert.deepEqual(f.errors, [`sort failed: invalid scope: ${rootPath}`]);
        assert.deepEqual(f.successes, [], 'rejected execution does not show a success notification');
        assert.equal(f.outputEditor.getValue(), 'previous output');
        assert.equal(f.inputEditor.getValue(), source);
    });
}

for (const rootPath of ['record[0].items', 'record[0][1].items']) {
    test(`array index on a record in ${rootPath} never falls through to record.items`, async t => {
        const source = '{"record":{"items":[{"id":2},{"id":1}]},"keep":[2,1]}';
        const f = fixture(t, source);
        f.sort.applySort();
        f.sort.sortRootPath.value = rootPath;
        f.sort.sortFieldName.value = 'id';
        assert.deepEqual(await f.queryField(''), [], 'type-invalid indexes must not provide record.items fields');
        f.sort.executeFieldSort();
        assert.deepEqual(f.errors, [`sort failed: not sortable: ${rootPath}`]);
        assert.deepEqual(f.successes, []);
        assert.equal(f.outputEditor.getValue(), 'previous output', 'invalid indexed selection cannot overwrite an earlier result');
        assert.equal(f.inputEditor.getValue(), source);
    });
}

test('malformed field id[abc] rejects instead of sorting by its valid prefix', t => {
    const source = '{"users":[{"id":2},{"id":1}]}';
    const f = fixture(t, source);
    f.sort.applySort();
    f.sort.sortRootPath.value = 'users';
    f.sort.sortFieldName.value = 'id[abc]';
    f.sort.executeFieldSort();
    assert.deepEqual(f.errors, ['sort failed: invalid field: id[abc]']);
    assert.deepEqual(f.successes, []);
    assert.equal(f.outputEditor.getValue(), 'previous output');
    assert.equal(f.inputEditor.getValue(), source);
});

test('wildcard traversal skips branches whose indexed value is not an array', async t => {
    const validItems = [{ rank: 2 }, { rank: 1 }];
    const invalidItems = [{ wrongField: 4 }, { wrongField: 3 }];
    const cases = [
        {
            scope: 'users[*].record[0].items',
            data: { users: [
                { name: 'valid', record: [{ items: validItems }] },
                { name: 'record-not-array', record: { items: invalidItems } },
                { name: 'null-record', record: null },
                { name: 'missing-record' },
            ], keep: ['z', 'a'] },
            expected: { users: [
                { name: 'valid', record: [{ items: [validItems[1], validItems[0]] }] },
                { name: 'record-not-array', record: { items: invalidItems } },
                { name: 'null-record', record: null },
                { name: 'missing-record' },
            ], keep: ['z', 'a'] },
        },
        {
            scope: 'users[*].record[0][1].items',
            data: { users: [
                { name: 'valid', record: [[{ items: invalidItems }, { items: validItems }]] },
                { name: 'record-not-array', record: { items: invalidItems } },
                { name: 'first-element-not-array', record: [{ items: invalidItems }] },
                { name: 'missing-record' },
            ], keep: ['z', 'a'] },
            expected: { users: [
                { name: 'valid', record: [[{ items: invalidItems }, { items: [validItems[1], validItems[0]] }]] },
                { name: 'record-not-array', record: { items: invalidItems } },
                { name: 'first-element-not-array', record: [{ items: invalidItems }] },
                { name: 'missing-record' },
            ], keep: ['z', 'a'] },
        },
    ];
    for (const example of cases) {
        const { f } = assertFieldSortResult(t, example.data, example.scope, 'rank', example.expected);
        f.sort.applySort();
        f.sort.sortRootPath.value = example.scope;
        assert.deepEqual(await f.queryField(''), ['rank'], 'suggestions and execution skip the same type-mismatched branches');
    }
});

test('terminal wildcard sorts selected child Maps and arrays while preserving ordinary records and parent order', async t => {
    const childMap = { late: { id: 2 }, early: { id: 1 } };
    const childArray = [{ id: 4 }, { id: 3 }];
    const ordinaryRecord = { id: 9, recordOnly: 'keep', items: [{ id: 6 }, { id: 5 }] };
    const values = [ordinaryRecord, childMap, childArray, { id: 8, recordOnly: 'last' }, {}];
    for (const order of ['asc', 'desc']) {
        const expectedValues = [ordinaryRecord,
            order === 'asc' ? { early: childMap.early, late: childMap.late } : childMap,
            order === 'asc' ? [childArray[1], childArray[0]] : childArray,
            values[3], {},
        ];
        for (const nested of [false, true]) {
            const data = nested ? { users: values, keep: ['z', 'a'] } : values;
            const expected = nested ? { users: expectedValues, keep: ['z', 'a'] } : expectedValues;
            const scope = nested ? 'users[*]' : '[*]';
            const { f } = assertFieldSortResult(t, data, scope, 'id', expected, order);
            f.sort.applySort();
            f.sort.sortRootPath.value = scope;
            assert.deepEqual(await f.queryField(''), ['id'], 'ordinary records and their nested items arrays are excluded from field suggestions');
        }
    }
});

for (const nested of [false, true]) {
    for (const order of ['asc', 'desc']) {
        test(`Map value-array shorthand preserves bracket syntax: ${nested ? 'nested' : 'root'}, ${order}`, async t => {
            const map = { Z: { value: [{ score: 2 }] }, A: { value: [{ score: 1 }] } };
            const sortedMap = order === 'asc' ? { A: map.A, Z: map.Z } : map;
            const wrap = value => ({ outer: { records: value, keep: [2, 1] }, untouched: { Z: 2, A: 1 } });
            const data = nested ? wrap(map) : map;
            const expected = nested ? wrap(sortedMap) : sortedMap;
            const rootPath = nested ? 'outer.records' : '';
            const source = JSON.stringify(data);
            const f = fixture(t, source);
            f.sortOrder.value = order;
            f.sort.applySort();
            f.sort.sortRootPath.value = rootPath;
            assert.deepEqual(await f.queryField('[0].s'), ['[0].score'], 'value fallback keeps the leading array index, without inserting a dot');
            assert.deepEqual(await f.queryField('value[0].s'), ['value[0].score'], 'explicit value path suggests the same scalar field');
            for (const field of ['[0].score', 'value[0].score']) {
                f.sort.applySort();
                f.sort.sortRootPath.value = rootPath;
                f.sort.sortFieldName.value = field;
                f.sort.executeFieldSort();
                assert.deepEqual(f.errors, [], `${rootPath || '<root>'}: ${field} must be executable`);
                assert.equal(JSON.stringify(JSON.parse(f.outputEditor.getValue())), JSON.stringify(expected), 'shorthand and explicit value paths produce the same Map entry order and preserve siblings');
                assert.equal(f.inputEditor.getValue(), source, 'original input is preserved');
            }
            assert.equal(f.successes.length, 2, 'both valid field spellings report success');
        });
    }
}
