import assert from 'node:assert/strict';
import test from 'node:test';
import { bundleModule } from '../scripts/compare-json-repair.mjs';

const { parseMaskingInput, isMarkedNumberString } = await bundleModule('src/components/utils/jsonMaskingCodec.ts');

const assertNullPrototypeTree = value => {
    if (Array.isArray(value)) value.forEach(assertNullPrototypeTree);
    else if (value && typeof value === 'object') {
        assert.equal(Object.getPrototypeOf(value), null);
        Object.values(value).forEach(assertNullPrototypeTree);
    }
};

test('escape-free masking retains own special keys and null-prototype nested data', () => {
    const source = '{"__proto__":{"constructor":"secret","prototype":false},"rows":[{"secret":"ABCD","empty":""}],"constructor":0}';
    const codec = parseMaskingInput(source);
    assertNullPrototypeTree(codec.data);
    assert.equal(Object.hasOwn(codec.data, '__proto__'), true);
    codec.data.__proto__.constructor = '[hidden]';
    codec.data.rows[0].secret = 'A**D';
    codec.data.added = { literal: String.raw`\u0041`, value: '\uE000ordinary' };
    const output = JSON.parse(codec.stringify(codec.data));
    const expected = JSON.parse('{"__proto__":{"constructor":"[hidden]","prototype":false},"rows":[{"secret":"A**D","empty":""}],"constructor":0}');
    expected.added = { literal: String.raw`\u0041`, value: '\uE000ordinary' };
    assert.deepEqual(output, expected);
    assert.equal(Object.prototype.constructor, Object);
    assertNullPrototypeTree(codec.data.rows);
});

test('hex-only and non-Unicode JSON5 escapes are decoded once when no spellings need restoration', () => {
    const codec = parseMaskingInput(String.raw`{'\x73ecret':'\x41BCD',keep:'\xE4\xBD\xA0',quote:'can\'t',zero:'\0',vertical:'\v',literal:'\\u0041'}`);
    assert.equal(codec.data.secret, 'ABCD');
    codec.data.secret = 'A**D';
    const output = codec.stringify(codec.data);
    assert.deepEqual(JSON.parse(output), { secret: 'A**D', keep: 'ä½\u00a0', quote: "can't", zero: '\0', vertical: '\v', literal: String.raw`\u0041` });
    assert.ok(!output.includes(String.raw`\x`));
    assert.ok(output.includes('"secret": "A**D"'));
});

test('one Unicode spelling does not change unrelated plain values or new replacements', () => {
    const codec = parseMaskingInput(String.raw`{"escaped":"\u0041BCD","plain":"ABCD","literal":"\\u0041","keep":"\u0041"}`);
    codec.data.escaped = 'A**D';
    codec.data.plain = 'A**D';
    codec.data.newValue = 'A';
    const output = codec.stringify(codec.data);
    assert.ok(output.includes(String.raw`"escaped": "\u0041**D"`));
    assert.ok(output.includes('"plain": "A**D"'));
    assert.ok(output.includes('"newValue": "A"'));
    assert.ok(output.includes(String.raw`"keep": "\u0041"`));
    assert.deepEqual(JSON.parse(output), { escaped: 'A**D', plain: 'A**D', literal: String.raw`\u0041`, keep: 'A', newValue: 'A' });
});

test('literal PUA resembling generated tokens survives forced prefix collisions', t => {
    t.mock.method(globalThis.crypto, 'getRandomValues', bytes => bytes.fill(0));
    const literal = '\uE000' + '\uE001'.repeat(13);
    for (const escaped of [false, true]) {
        const source = '{' + JSON.stringify(literal) + ':' + JSON.stringify(literal) + ',"secret":' + (escaped ? '"\\u0041BCD"' : '"ABCD"') + '}';
        const codec = parseMaskingInput(source);
        assert.equal(codec.data[literal], literal);
        codec.data.secret = 'A**D';
        const output = codec.stringify(codec.data);
        assert.deepEqual(JSON.parse(output), { [literal]: literal, secret: 'A**D' });
        assert.ok(output.includes(JSON.stringify(literal)));
        if (escaped) assert.ok(output.includes(String.raw`\u0041**D`));
    }
});

test('unchanged and replaced primitive roots keep plain, PUA and surrogate semantics', () => {
    for (const [input, replacement, expected] of [
        ['"plain"', 'A"\\\n\t', 'A"\\\n\t'],
        ['""', '\uE000short', '\uE000short'],
        ['123', false, false],
        ['null', null, null],
        [String.raw`"\uD83D\uDE00AB"`, '\uD83D***', '\uD83D***'],
        [String.raw`"\uD800"`, '\uD800', '\uD800'],
    ]) {
        const codec = parseMaskingInput(input);
        assert.equal(JSON.parse(codec.stringify(replacement)), expected);
    }
});

test('no-spelling fast path preserves exact numbers in values and array roots', () => {
    const codec = parseMaskingInput('[9007199254740993,1.2300,1e+40,-0,{"secret":"ABCD","__proto__":0}]');
    for (const value of codec.data.slice(0, 3)) assert.equal(isMarkedNumberString(value), true);
    codec.data[4].secret = '***';
    const output = codec.stringify(codec.data);
    for (const literal of ['9007199254740993', '1.2300', '1e+40', '-0']) assert.ok(output.includes(literal), output);
    assert.equal(JSON.parse(output)[4].secret, '***');
    assert.equal(Object.hasOwn(codec.data[4], '__proto__'), true);
});

test('decoded key collisions retain overwrite order and own prototype keys', () => {
    const codec = parseMaskingInput(String.raw`{'\u0061':'\u0041',a:'B','__proto__':{'\x78':'C'},'\x73ecret':'ABCD'}`);
    assertNullPrototypeTree(codec.data);
    assert.equal(codec.data.a, 'B');
    codec.data.secret = '***';
    const output = JSON.parse(codec.stringify(codec.data));
    assert.deepEqual(output, JSON.parse('{"a":"B","__proto__":{"x":"C"},"secret":"***"}'));
});

test('repeated stringify does not mutate data or confuse spelling state between results', () => {
    for (const source of [String.raw`{"secret":"ABCD","keep":"\\u0041"}`, String.raw`{"secret":"\u0041BCD","keep":"\\u0041"}`]) {
        const codec = parseMaskingInput(source);
        const before = codec.stringify(codec.data);
        codec.data.secret = 'A**D';
        const masked = codec.stringify(codec.data);
        codec.data.secret = 'ABCD';
        assert.equal(codec.stringify(codec.data), before);
        assert.equal(JSON.parse(masked).secret, 'A**D');
        assert.equal(codec.data.keep, String.raw`\u0041`);
    }
});

test('stringify still snapshots an own numeric-marker getter exactly once', () => {
    const codec = parseMaskingInput('{}');
    let reads = 0;
    const value = { get __jsonToolHighPrecisionNumber() { return ++reads; } };
    assert.deepEqual(JSON.parse(codec.stringify(value)), { __jsonToolHighPrecisionNumber: 1 });
    assert.equal(reads, 1);
});

test('stringify does not inspect inherited numeric-marker getters', () => {
    const codec = parseMaskingInput('{}');
    const value = Object.assign(Object.create({
        get __jsonToolHighPrecisionNumber() { throw new Error('inherited getter invoked'); },
    }), { a: 1 });
    assert.deepEqual(JSON.parse(codec.stringify(value)), { a: 1 });
});
