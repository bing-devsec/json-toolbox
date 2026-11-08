import assert from 'node:assert/strict';
import test from 'node:test';
import { bundleModule } from '../scripts/compare-json-repair.mjs';
const { parseMaskingInput, isMarkedNumberString, extractMarkedNumber } = await bundleModule('src/components/utils/jsonMaskingCodec.ts');

test('masking an unrelated field preserves long integers, decimal spelling, exponent and negative zero', () => {
    const codec = parseMaskingInput('{"id":9007199254740993,"decimal":1.2300,"exp":1e+40,"zero":-0,"secret":"private"}', 4);
    codec.data.secret = '[MASKED]';
    const output = codec.stringify(codec.data);
    for (const expected of ['"id": 9007199254740993', '"decimal": 1.2300', '"exp": 1e+40', '"zero": -0', '"secret": "[MASKED]"']) assert.ok(output.includes(expected), output);
    assert.equal(extractMarkedNumber(codec.data.id), '9007199254740993');
    assert.equal(isMarkedNumberString(codec.data.id), true);
    assert.equal(isMarkedNumberString(codec.data.decimal), true);
});

test('legacy PUA markers and forged wrapper strings stay user strings', () => {
    for (const value of ['\uE000HPN:123:HPN\uE000', '\uE000HPN:null,"injected":true:HPN\uE000', JSON.stringify({__jsonToolHighPrecisionNumber:true,originalString:'123'})]) {
        assert.equal(isMarkedNumberString(value), false);
        const codec = parseMaskingInput(JSON.stringify({ value }));
        assert.deepEqual(JSON.parse(codec.stringify(codec.data)), { value });
        assert.throws(() => extractMarkedNumber(value), TypeError);
    }
});

test('unicode escape spelling, literal escape text and PUA characters survive masking', () => {
    const source = String.raw`{"escaped":"\u4f60","literal":"\\u4f60","secret":"private"}`;
    const codec = parseMaskingInput(source);
    codec.data.secret = '\uE100';
    const output = codec.stringify(codec.data);
    assert.ok(output.includes(String.raw`"escaped": "\u4f60"`), output);
    assert.ok(output.includes(String.raw`"literal": "\\u4f60"`), output);
    assert.equal(JSON.parse(output).secret, '\uE100');
});

test('compatible JSON5 and prototype-named keys retain numeric and key data', () => {
    const codec = parseMaskingInput("{ /*comment*/ '__proto__': {id:9007199254740993}, decimal:+.5000, list:[1.00,], }");
    assert.equal(Object.hasOwn(codec.data, '__proto__'), true);
    const output = codec.stringify(codec.data);
    assert.ok(output.includes('9007199254740993'), output);
    assert.ok(output.includes('0.5000'), output);
    assert.ok(output.includes('1.00'), output);
    assert.equal(Object.hasOwn(JSON.parse(output), '__proto__'), true);
});

test('masking data exposes JSON5 characters and UTF-16 units without re-decoding literal escapes', () => {
    const source = String.raw`{'\u0073ecret':'\uD83D\uDE00AB','hex':'\xE4\xBD\xA0','quote':'can\'t','zero':'\0','vertical':'\v','literal':'\\u0041','__proto__':'\u0041'}`;
    const codec = parseMaskingInput(source);
    assert.equal(codec.data.secret, '😀AB');
    assert.equal(codec.data.secret.length, 4);
    assert.equal(codec.data.hex, 'ä½\u00a0'); // JSON5 code units, not UTF-8 byte decoding.
    assert.equal(codec.data.quote, "can't");
    assert.equal(codec.data.zero, '\0');
    assert.equal(codec.data.vertical, '\v');
    assert.equal(codec.data.literal, String.raw`\u0041`);
    assert.equal(Object.hasOwn(codec.data, '__proto__'), true);
    assert.equal(codec.data.__proto__, 'A');
    codec.data.secret = codec.data.secret.slice(0, 2) + '**';
    const output = JSON.parse(codec.stringify(codec.data));
    assert.equal(output.secret, '😀**');
    for (const key of ['hex', 'quote', 'zero', 'vertical', 'literal', '__proto__']) assert.equal(output[key], codec.data[key]);
});

test('Unicode spellings for quotes, backslashes and controls do not escape output syntax', () => {
    const codec = parseMaskingInput(String.raw`{"value":"\u0022\u005c\u000a\u0000","secret":"\u0041BCD"}`);
    assert.equal(codec.data.value, '"\\\n\0');
    codec.data.secret = codec.data.secret.slice(0, 1) + '**' + codec.data.secret.slice(-1);
    const output = codec.stringify(codec.data);
    assert.equal(JSON.parse(output).value, codec.data.value);
    assert.equal(JSON.parse(output).secret, 'A**D');
    assert.ok(output.includes(String.raw`\u0041**D`));
});

test('Unicode spelling stays at its source position, including lone surrogates', () => {
    const codec = parseMaskingInput(String.raw`{"plain":"A","escaped":"\u0041","mixed":"A\u0041A","secret":"\u0041BCD","lone":"\uD800"}`);
    codec.data.secret = 'A**D';
    codec.data.added = 'A';
    const output = codec.stringify(codec.data);
    assert.ok(output.includes('"plain": "A"'), output);
    assert.ok(output.includes(String.raw`"escaped": "\u0041"`), output);
    assert.ok(output.includes(String.raw`"mixed": "A\u0041A"`), output);
    assert.ok(output.includes(String.raw`"secret": "\u0041**D"`), output);
    assert.ok(output.includes('"added": "A"'), output);
    assert.equal(JSON.parse(output).lone, '\uD800');
});
