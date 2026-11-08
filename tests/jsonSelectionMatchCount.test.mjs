import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { api, createModel, nativeCount } from './helpers/selectionTextModel.mjs';
import { vueDeclarations } from './helpers/vueDeclarations.mjs';
import { getModelUtf8ByteLength } from '../src/components/utils/modelUtf8ByteLength.ts';

const { countSelectionMatches: count } = api;
const boundedCount = (model, text) => api.countLargeOrMultiline(model, text, text.includes('\n'));
const check = (model, queries, counter = count) => {
    for (const query of queries) assert.equal(counter(model, query), nativeCount(model, query), JSON.stringify(query));
};

test('exact count agrees with real Monaco for overlap, regex punctuation, case, word boundaries and Unicode', () => {
    const model = createModel('aaaaaa ababa AAaa abc abcdef ABC a.b [x] $^\\ \u0000\n' +
        '你好你好 e\u0301 é e\u0301 😀😀 x😀x \ud800 \udc00 \ud800a \udc00b\n');
    try {
        check(model, ['', 'a', 'aa', 'aaa', 'aba', 'AA', 'abc', 'ABC', 'a.b', '[x]', '$^', '\\', '\u0000',
            '你好', 'e\u0301', 'é', '😀', '😀😀', '\ud800', '\udc00', '\ud83d', '\ude00', '\ud800a', '\udc00b']);
        assert.equal(count(model, 'abc'), 2, 'no whole-word restriction');
        assert.equal(count(model, '😀'), 3);
    } finally { model.dispose(); }
});

test('multiline and CRLF selections retain Monaco normalization and fallback semantics', () => {
    for (const text of ['a\nb\na\nb\n', 'a\r\nb\r\na\r\nb\r\n', 'a\rb\ra\rb\r']) {
        const model = createModel(text);
        try { check(model, ['a', 'b', '\n', '\r', '\r\n', 'a\nb', 'a\r\nb', 'b\na', 'a\rb', 'a\nb\na']); }
        finally { model.dispose(); }
    }
});

test('snapshot boundaries preserve exact non-overlap without copying the full model or allocating matches', () => {
    const model = createModel(('ab'.repeat(40000) + '😀').repeat(3));
    try {
        model.applyEdits([{ range: new api.Range(1, 80000, 1, 80000), text: 'abababa😀' }]);
        const expected = new Map(['a', 'aba', 'ababa', '😀', '😀ab', 'ab😀'].map(query => [query, nativeCount(model, query)]));
        const snapshot = model.createSnapshot();
        let chunks = 0;
        while (snapshot.read() !== null) chunks++;
        assert.ok(chunks > 1, 'real piece-tree snapshot has multiple chunks');
        model.findMatches = () => assert.fail('eligible query must not create match ranges');
        model.getValue = () => assert.fail('eligible query must not concatenate the full document');
        for (const [query, result] of expected) assert.equal(count(model, query), result, query);
    } finally { model.dispose(); }
});

test('all possible tiny chunk boundaries preserve greedy matching, including a needle longer than chunks', () => {
    for (const text of ['aaaaaaa', 'abababababa', 'xabcabcabcabcy', '😀😀😀x😀', 'aaaaaxaaaaa']) {
        for (const query of ['a', 'aa', 'aaa', 'aba', 'abcabc', '😀', '😀😀', 'nope']) {
            for (let size = 1; size <= text.length; size++) {
                const model = createModel(text);
                try {
                    const expected = nativeCount(model, query);
                    model.createSnapshot = () => {
                        let i = 0;
                        return { read: () => i < text.length ? text.slice(i, i += size) : null };
                    };
                    assert.equal(count(model, query), expected, `${JSON.stringify([text, query])}: ${size}`);
                } finally { model.dispose(); }
            }
        }
    }
});

test('seeded mixed-Unicode, CRLF and edited-piece queries agree with real Monaco', () => {
    let seed = 173;
    const random = n => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n; };
    const parts = ['a', 'b', '😀', 'e\u0301', 'é', '中', '\ud800', '\udc00', '\n', '\r\n', '*', '\\'];
    for (let i = 0; i < 150; i++) {
        const model = createModel(Array.from({ length: 50 + random(100) }, () => parts[random(parts.length)]).join(''));
        try {
            for (let j = 0; j < 3; j++) {
                const position = model.getPositionAt(random(model.getValueLength() + 1));
                model.applyEdits([{ range: new api.Range(position.lineNumber, position.column, position.lineNumber, position.column), text: parts[random(parts.length)] }]);
            }
            const value = model.getValue();
            check(model, Array.from({ length: 20 }, () => { const start = random(value.length); return value.slice(start, start + 1 + random(8)); }));
        } finally { model.dispose(); }
    }
});

test('one cached short query per model invalidates for edits, undo, redo and EOL changes', async () => {
    const model = createModel('aa aa\naa'), other = createModel('aa');
    let scans = 0;
    const snapshot = model.createSnapshot.bind(model);
    model.createSnapshot = () => { scans++; return snapshot(); };
    try {
        assert.equal(count(model, 'aa'), 3);
        assert.equal(count(model, 'aa'), 3);
        assert.equal(scans, 1);
        assert.equal(count(other, 'aa'), 1);
        model.pushEditOperations(null, [{ range: new api.Range(1, 1, 1, 3), text: 'xx' }], null);
        assert.equal(count(model, 'aa'), 2);
        await model.undo(); assert.equal(count(model, 'aa'), 3);
        await model.redo(); assert.equal(count(model, 'aa'), 2);
        model.setEOL(1); assert.equal(count(model, 'aa'), 2);
        assert.equal(scans, 5);
        count(model, 'xx'); count(model, 'aa');
        assert.equal(scans, 7, 'switching queries does not accumulate a query index');
    } finally { model.dispose(); other.dispose(); }
    assert.throws(() => count(model, 'aa'), /disposed/);
});

test('intermediate selections and lone surrogates retain native search without repeated disposal listeners', () => {
    const model = createModel('a'.repeat(20000) + '😀');
    let calls = 0, registrations = 0, contentRegistrations = 0;
    const findMatches = model.findMatches.bind(model), onWillDispose = model.onWillDispose, onDidChangeContent = model.onDidChangeContent.bind(model);
    model.findMatches = (...args) => { calls++; return findMatches(...args); };
    model.onWillDispose = (...args) => { registrations++; return onWillDispose(...args); };
    model.onDidChangeContent = (...args) => { contentRegistrations++; return onDidChangeContent(...args); };
    try {
        assert.equal(count(model, 'a'), 20000);
        assert.equal(count(model, 'a'.repeat(8193)), 2);
        assert.equal(count(model, 'a'.repeat(8193)), 2);
        assert.equal(count(model, 'a'), 20000);
        assert.equal(count(model, '\ud83d'), nativeCount(model, '\ud83d'));
        assert.equal(calls, 4);
        assert.equal(registrations, 1);
        model.setValue('a'); count(model, 'a');
        model.setValue('aa'); count(model, 'a');
        assert.equal(contentRegistrations, 1);
        assert.equal(registrations, 1);
    } finally { model.dispose(); }
});

test('public count keeps small multiline search native and bounds queries exceeding 1048576 UTF-16 units without a result cap', () => {
    const large = 'a'.repeat(1048577);
    const model = createModel(large + '\n' + large);
    const findMatches = model.findMatches.bind(model);
    let calls = 0;
    model.findMatches = (...args) => { calls++; return findMatches(...args); };
    try {
        assert.equal(count(model, 'a\na'), 1);
        assert.equal(calls, 1, 'preserve the measured faster native small-multiline path');
        model.findMatches = () => assert.fail('large selection must not compile a query-sized regex');
        assert.equal(count(model, large), 2);
        assert.equal(count(model, large + '\na'), 1);
    } finally { model.dispose(); }
});

test('multiline count preserves CRLF/surrogate semantics without native search or whole-model copies', () => {
    const samples = ['a\nb\na\nb\n', 'a\r\nb\r\na\r\nb\r\n', 'aa\naa\naa\naa',
        '😀\n😀\n\ud83d\n\ude00\n😀', 'x\udc00\na\ud800x\n😀\n😀\ud800'];
    const queries = ['\n', 'a\nb', 'a\r\nb', 'aa\naa', '\naa\n', 'a\na\na',
        '😀\n😀', '\ud83d\n', '\n\ude00', '\ude00\n', '\n\ud83d', '\udc00\na\ud800', 'missing\n'];
    for (const text of samples) {
        const model = createModel(text);
        try {
            const expected = new Map(queries.map(query => [query, nativeCount(model, query)]));
            model.findMatches = () => assert.fail('multiline count must not allocate a regular expression or matches');
            model.getValue = model.createSnapshot = () => assert.fail('must not copy or retain the whole model');
            for (const [query, result] of expected) assert.equal(boundedCount(model, query), result, JSON.stringify([text, query]));
        } finally { model.dispose(); }
    }
});

test('multiline literal search agrees exhaustively for short periodic and nonperiodic literals', () => {
    const strings = [''];
    let level = [''];
    for (let length = 1; length <= 6; length++) {
        level = level.flatMap(prefix => ['a', 'b', '\n'].map(char => prefix + char));
        strings.push(...level);
    }
    const queries = strings.filter(value => value.length <= 4 && value.includes('\n'));
    for (const value of strings) {
        const model = createModel(value);
        try { check(model, queries, boundedCount); }
        finally { model.dispose(); }
    }
});

test('repetitive false anchors fall back without quadratic reads or double-counting earlier matches', () => {
    const nonperiodic = 'a'.repeat(8192) + 'b';
    const periodic = 'a\n'.repeat(5000);
    for (const [query, value, expected] of [
        [nonperiodic, nonperiodic + 'a'.repeat(300000) + nonperiodic, 2],
        [periodic, ('a\n'.repeat(4999) + 'b\n').repeat(10) + periodic, 1],
    ]) {
        const model = createModel(value);
        let reads = 0;
        try {
            assert.equal(nativeCount(model, query), expected);
            model.findMatches = () => assert.fail('fallback must not build a huge native regex');
            const getValueInRange = model.getValueInRange.bind(model);
            model.getValueInRange = (...args) => { reads++; return getValueInRange(...args); };
            assert.equal(boundedCount(model, query), expected);
            assert.ok(reads < 200, `unbounded repetitive-candidate verification: ${reads} reads`);
        } finally { model.dispose(); }
    }
});

test('large literal selections preserve greedy non-overlap, periodic failures and block-boundary matches', () => {
    const queries = ['a'.repeat(8193), 'ab'.repeat(4097), 'a'.repeat(8192) + 'b',
        'abc'.repeat(2800) + 'abd', '😀'.repeat(4200), 'a.b[\\]'.repeat(1400)];
    for (const query of queries) {
        const value = 'x'.repeat(1048573) + query + query + query.slice(0, -1) + 'x' + query;
        const model = createModel(value);
        try {
            const expected = nativeCount(model, query);
            model.findMatches = () => assert.fail('large ordinary literal must not compile a native regex');
            model.getValue = model.createSnapshot = () => assert.fail('must not copy or retain the whole model');
            const getValueInRange = model.getValueInRange.bind(model);
            model.getValueInRange = (...args) => {
                const result = getValueInRange(...args);
                assert.ok(result.length <= 1048582, 'each range window must stay bounded');
                return result;
            };
            assert.equal(boundedCount(model, query), expected);
        } finally { model.dispose(); }
    }
});

test('multiline matches normalize CRLF across 1048576-unit blocks while preserving surrogate boundaries', () => {
    const value = 'x'.repeat(1048575) + '\r\n😀a\r\n😀a\r\n' + 'x'.repeat(1048575) + '\r\n\ud800\r\n\udc00';
    const model = createModel(value);
    try {
        check(model, ['\n😀a\n', '😀a\n😀a', '\n\ud800\n', '\n\udc00', '\ude00a\n', '\n\ud83d'], boundedCount);
    } finally { model.dispose(); }
});

test('content invalidation preserves a fresh count published by an earlier status listener', () => {
    const model = createModel('aa aa');
    let scans = 0;
    const snapshot = model.createSnapshot.bind(model);
    model.createSnapshot = () => { scans++; return snapshot(); };
    model.onDidChangeContent(() => count(model, 'aa'));
    try {
        count(model, 'aa'); model.setValue('aa aa aa');
        assert.equal(count(model, 'aa'), 3);
        assert.equal(scans, 2, 'a later invalidation listener must not evict this version');
    } finally { model.dispose(); }
});

test('clearing selection content releases a short SlicedString parent without requiring another count', () => {
    const output = execFileSync(process.execPath, ['--import', './scripts/register-typescript-tests.mjs', '--expose-gc', '--input-type=module', '-e', `
        import { api, createModel } from './tests/helpers/selectionTextModel.mjs';
        const model = createModel('x');
        global.gc(); const baseline = process.memoryUsage().heapUsed;
        (() => {
            model.setValue('unique-target' + 'x'.repeat(60 * 1024 * 1024));
            api.countSelectionMatches(model, model.getValueInRange(new api.Range(1, 1, 1, 14)));
        })();
        model.setValue('x');
        // No further count or dispose: an empty selection must release old text.
        for (let i = 0; i < 3; i++) global.gc();
        console.log(process.memoryUsage().heapUsed - baseline);
        model.dispose();
    `], { encoding: 'utf8' });
    const retained = Number(output.trim());
    assert.ok(retained < 8 * 1024 * 1024, `old 60 MiB parent string retained: ${retained} bytes`);
});

test('Workbench status retains exact text, all-selection bytes, blank selection and focus behavior', async () => {
    const txt = new Proxy({}, { get: (_, name) => (...args) => `${name}:${args.join(',')}` });
    const { updateEditorStatus } = await vueDeclarations('src/components/JsonToolWorkbench.vue', ['updateEditorStatus'], {
        countSelectionMatches: count, getModelUtf8ByteLength, settingsTxt: { value: txt }, Blob, formatFileSize: value => `${value}bytes`,
    });
    const model = createModel('a aa\na'), state = { value: '' };
    let selection = new api.Selection(1, 1, 1, 2), focused = true;
    const editor = { getModel: () => model, getSelection: () => selection, hasWidgetFocus: () => focused };
    try {
        updateEditorStatus(editor, state); assert.equal(state.value, 'statusSelectedCharsWithMatches:1,4');
        selection = new api.Selection(1, 2, 1, 3);
        updateEditorStatus(editor, state); assert.equal(state.value, 'statusSelectedChars:1');
        selection = new api.Selection(1, 1, 2, 2);
        updateEditorStatus(editor, state); assert.equal(state.value, 'statusSelectedAll:2,6,6bytes');
        focused = false;
        updateEditorStatus(editor, state); assert.equal(state.value, 'statusCursor:1,1,2');
        focused = true; selection = new api.Selection(2, 2, 2, 2);
        updateEditorStatus(editor, state); assert.equal(state.value, 'statusCursor:2,2,2');
    } finally { model.dispose(); }
});
