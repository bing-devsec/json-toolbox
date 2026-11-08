import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { transform } from 'esbuild';
import { parseTree, visit } from 'jsonc-parser';
import { findJsonStringRangeByPrefix } from '../src/components/utils/jsonStringHitTest.ts';
import { api, createModel } from './helpers/selectionTextModel.mjs';
import { vueDeclarations } from './helpers/vueDeclarations.mjs';

const workbench = 'src/components/JsonToolWorkbench.vue';
const names = ['findStringRangeByAst', 'findStringRangeByScan', 'findStringRange'];
const globals = { parseTree, monacoApi: { Range: api.Range }, findJsonStringRangeByPrefix };
const actual = await vueDeclarations(workbench, names, globals);
// The unchanged AST fallback in the real workbench is the differential oracle.
const baseline = await vueDeclarations(workbench, names, { ...globals, findJsonStringRangeByPrefix: () => null });
const rangeOffsets = (model, range) => range && {
    offset: model.getOffsetAt(range.getStartPosition()),
    length: model.getOffsetAt(range.getEndPosition()) - model.getOffsetAt(range.getStartPosition()),
};

test('bounded local gate never starts a second parse for numeric/boolean/null hits or long minified lines', async () => {
    const source = readFileSync('src/components/utils/jsonStringHitTest.ts', 'utf8').replace(/^import .* from 'jsonc-parser';\n/, '');
    const { code } = await transform(source, { loader: 'ts', format: 'cjs' });
    const module = { exports: {} };
    runInNewContext(code, { module, exports: module.exports, visit: () => assert.fail('gate must not start a prefix parse') });
    const gated = module.exports.findJsonStringRangeByPrefix;
    for (const literal of ['123', 'true', 'false', 'null']) {
        const text = `[\n  {"id":${literal},"other":"text"}\n]`;
        assert.equal(gated(text, text.indexOf(literal) + 1), null);
    }
    for (const text of ['[\n123,456\n]', '[\ntrue,false,null\n]', '{"x":"y"}\n   ']) {
        assert.equal(gated(text, text.length), null);
    }
    const long = '["x",'.repeat(1000) + '"tail"]';
    assert.equal(gated(long, long.indexOf('tail') + 1), null);
    const pastBudget = '\n'.repeat(256 * 1024) + '"tail"';
    assert.equal(gated(pastBudget, pastBudget.indexOf('tail')), null);
    for (const offset of [-1, Infinity, NaN, 99]) assert.equal(gated('"x"', offset), null);
});

test('prefix budget preserves complete boundary tokens and falls back for crossing strings/comments', async () => {
    const limit = 256 * 1024;
    const complete = ' '.repeat(limit - 8) + '\n"value"';
    assert.equal(complete.length, limit);
    assert.deepEqual(findJsonStringRangeByPrefix(complete + ' invalid suffix', limit), { offset: limit - 7, length: 7 });
    const crossing = ' '.repeat(limit - 5) + '\n"value"';
    assert.equal(findJsonStringRangeByPrefix(crossing, limit - 2), null, 'truncated string must use the full AST');
    const inputs = [
        [crossing, limit - 2],
        ['"' + 'a'.repeat(limit + 100) + '"', 3],
        ['"' + 'a'.repeat(limit + 100), 3],
        ['/*\n"looks like a string"\n' + 'a'.repeat(limit) + '*/ "root"', 10],
    ];
    for (const [text, offset] of inputs) {
        const model = createModel(text);
        try {
            const position = model.getPositionAt(offset);
            assert.deepEqual(actual.findStringRangeByAst(model, position), baseline.findStringRangeByAst(model, position));
        } finally { model.dispose(); }
    }
    const source = readFileSync('src/components/utils/jsonStringHitTest.ts', 'utf8').replace(/^import .* from 'jsonc-parser';\n/, '');
    const { code } = await transform(source, { loader: 'ts', format: 'cjs' });
    const module = { exports: {} }, scannedLengths = [];
    runInNewContext(code, { module, exports: module.exports, visit: (text, ...args) => {
        scannedLengths.push(text.length);
        return visit(text, ...args);
    } });
    assert.equal(module.exports.findJsonStringRangeByPrefix(inputs[1][0], 3), null);
    assert.deepEqual(scannedLengths, [limit], 'the visitor never receives the unbounded token suffix');
    const unicodeToken = '"😀\\uD83D\\uDE00\\\"中"';
    for (let cut = 0; cut <= unicodeToken.length; cut++) {
        const text = ' '.repeat(limit - cut - 1) + '\n' + unicodeToken + ' trailing';
        const model = createModel(text);
        try {
            const position = model.getPositionAt(limit - cut + 1);
            assert.deepEqual(actual.findStringRangeByAst(model, position), baseline.findStringRangeByAst(model, position),
                `budget cuts Unicode/escape token at UTF-16 unit ${cut}`);
        } finally { model.dispose(); }
    }
});

function compareEveryPosition(input, language = 'json') {
    const model = createModel(input);
    if (language !== 'json') model.getLanguageId = () => language;
    let comparisons = 0;
    try {
        // Monaco normalizes CR/CRLF and may clamp offsets inside a surrogate pair.
        // Exercise its real getPositionAt/getOffsetAt mapping instead of a line-1 stub.
        for (let offset = 0; offset <= model.getValueLength(); offset++) {
            const position = model.getPositionAt(offset);
            for (const method of ['findStringRangeByAst', 'findStringRange']) {
                assert.deepEqual(actual[method](model, position), baseline[method](model, position),
                    `${method} ${language} ${offset} ${JSON.stringify(model.getValue())}`);
            }
            comparisons++;
        }
    } finally { model.dispose(); }
    return comparisons;
}

test('prefix hits preserve key/value quotes, inclusive right edge and offset-minus-one fallback', () => {
    const model = createModel('{"a":"😀中é","":""}  ');
    try {
        const text = model.getValue();
        const offset = text.indexOf('"😀');
        const end = text.indexOf('",""') + 1;
        for (const at of [offset, offset + 1, offset + 2, end - 1, end]) {
            assert.deepEqual(findJsonStringRangeByPrefix(text, at), { offset, length: end - offset });
        }
        assert.deepEqual(rangeOffsets(model, actual.findStringRangeByAst(model, model.getPositionAt(end))),
            { offset, length: end - offset });
        assert.equal(findJsonStringRangeByPrefix('"abc"  ', 6), null);
        const root = createModel('"abc"  ');
        try {
            assert.equal(root.getValueInRange(actual.findStringRangeByAst(root, root.getPositionAt(6))), '"abc"');
            assert.equal(actual.findStringRangeByAst(root, root.getPositionAt(7)), null);
        } finally { root.dispose(); }
    } finally { model.dispose(); }
    compareEveryPosition('{"a":"😀中é","":""}  ');
});

test('malformed prefix and ambiguous adjacent tokens use the exact AST fallback', async () => {
    for (const [text, target] of [
        ['[0"hello"]', '"hello"'],
        ['["first" "second"]', '"second"'],
        ['{"a":1,"b":"bad\\j"}', '"bad\\j"'],
        ['{"a":1,,"b":"ok"}', '"ok"'],
    ]) {
        const offset = text.indexOf(target);
        assert.equal(findJsonStringRangeByPrefix(text, offset), null, text);
        const model = createModel(text);
        try {
            assert.equal(model.getValueInRange(actual.findStringRangeByAst(model, model.getPositionAt(offset))), target);
        } finally { model.dispose(); }
        compareEveryPosition(text);
    }
    for (const text of ['["a""b"]', '[true"s"]', '[null"s"]', '{"a" "b" "c"}',
        '"root" "extra"', '{} "extra"', '{"a":"x"} "extra"', '{"a":"unterminated',
        '["", "', '["a\\uZZZZ", "b"]', '{"a": ["x"}', '{"a":\n"x"\n',
        '{"a":"hello, "b":3"last"}', '\ufeff{"a":"x"}']) compareEveryPosition(text);
});

test('valid prefix bypasses AST allocation even when the unread suffix is malformed', async () => {
    const fastOnly = await vueDeclarations(workbench, ['findStringRangeByAst'], {
        ...globals, parseTree: () => assert.fail('eligible prefix must not build a full AST'),
    });
    const texts = [
        '{"key":"value",broken suffix',
        '/* before */\r\n{"key":"value", /* after */}',
        '["value",' + '{"id":123,"key":"value","active":true},'.repeat(10000) + ']',
    ];
    for (const text of texts) {
        const model = createModel(text);
        try {
            const position = model.getPositionAt(model.getValue().indexOf('value') + 2);
            const range = fastOnly.findStringRangeByAst(model, position);
            assert.equal(model.getValueInRange(range), '"value"');
            assert.deepEqual(range, baseline.findStringRangeByAst(model, position));
        } finally { model.dispose(); }
    }
});

test('real Monaco offsets preserve Unicode, CRLF, comments, incomplete strings and line-scan fallback', () => {
    const texts = [
        '{\r\n  "😀": "中é\\uD83D\\uDE00",\r\n "x":"\ud800\udc00\ud800\udc00",\r\n}',
        '{\r"key":"é",\r"empty":""\r}',
        '["literal\\\\path", "escaped\\\"quote", "\\u0041", "\\uD800", "\\uDC00"]',
        '{/* "ignored" */ "k": "v", // "comment"\r\n"last":"z",}',
        '["bad\r\nstring", "later"]', '["bad\u0000string", "later"]',
        '["line\u2028separator", "paragraph\u2029separator"]',
        '{"a":"x"}\r\n"not in the JSON AST"',
    ];
    for (const text of texts) compareEveryPosition(text);
    for (const language of ['yaml', 'javascript', 'plaintext']) {
        compareEveryPosition('name: "😀 text"\r\nnext: "escaped\\\"quote"\r\n', language);
    }
    compareEveryPosition('['.repeat(128) + '"deep"' + ']'.repeat(128));
    compareEveryPosition('{"x":'.repeat(64) + '"deep"' + '}'.repeat(64));
});

test('seeded deletion/insertion/truncation differential covers partial and malformed editor text', t => {
    let seed = 19223;
    const next = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed >>> 0; };
    const fragments = ['{}[]:,"abc012/\\\n\r\t', '😀中é\ud800\udc00\u0000\u2028\u2029',
        '""', '/* */', '//\r\n', 'true', 'null', '-1.2e+3', '\\u0041', '\\uD800', '\\"'];
    let comparisons = 0;
    for (let i = 0; i < 1500; i++) {
        let text = JSON.stringify({ a: ['hello', 'world', '😀'], b: { c: 'A\\u0041', d: '\ud800' }, d: i }, null, i % 2 ? undefined : 2);
        if (i % 4 === 0) text = text.replaceAll('\n', '\r\n');
        for (let j = 0; j < 1 + next() % 8; j++) {
            const at = next() % (text.length + 1), type = next() % 4;
            if (type === 0) text = text.slice(0, at) + text.slice(at + 1 + next() % 4);
            else if (type === 1) text = text.slice(0, at);
            else {
                const fragment = fragments[next() % fragments.length];
                const insert = next() % 2 ? fragment : fragment[next() % fragment.length];
                text = text.slice(0, at) + insert + text.slice(at + (type === 3 ? 1 : 0));
            }
        }
        comparisons += compareEveryPosition(text);
    }
    assert.ok(comparisons > 60000, `expected broad position coverage, got ${comparisons}`);
    t.diagnostic(`${comparisons} real Monaco positions, checking both AST-only and line-scan fallback results`);
});

test('existing double-click selects/copies exact UTF-16 source text on its original deferred turn', async () => {
    const pending = [], copied = [], selections = [], messages = [];
    const Position = class { constructor(lineNumber, column) { this.lineNumber = lineNumber; this.column = column; } };
    const runtime = await vueDeclarations(workbench, [...names, 'setupDoubleClickSelectString'], {
        ...globals, monacoApi: { Range: api.Range, Position },
        setTimeout: (callback, delay) => pending.push({ callback, delay }),
        copyToClipboard: value => copied.push(value), showMessageSuccess: value => messages.push(value),
    });
    const model = createModel('{\r\n "key": "😀\\u0041\\\"中"\r\n}');
    let mouseDown;
    const editor = {
        onMouseDown: callback => { mouseDown = callback; }, getModel: () => model,
        setSelection: range => selections.push(range),
    };
    const position = model.getPositionAt(model.getValue().indexOf('😀') + 1);
    try {
        runtime.setupDoubleClickSelectString(editor);
        mouseDown({ target: { position }, event: { detail: 1 } });
        mouseDown({ target: { position: null }, event: { detail: 2 } });
        assert.equal(pending.length, 0);
        mouseDown({ target: { position }, event: { detail: 2 } });
        assert.equal(pending.length, 1);
        assert.equal(pending[0].delay, 10);
        assert.equal(selections.length, 0);
        pending.shift().callback();
        assert.equal(model.getValueInRange(selections[0]), '😀\\u0041\\\"中');
        assert.deepEqual(copied, ['😀\\u0041\\\"中']);
        assert.equal(messages.length, 1);
        runtime.setupDoubleClickSelectString(editor, false);
        mouseDown({ target: { position }, event: { detail: 2 } });
        pending.shift().callback();
        assert.equal(selections.length, 2);
        assert.equal(copied.length, 1, 'copy-disabled editor still selects without writing clipboard');
    } finally { model.dispose(); }
});
