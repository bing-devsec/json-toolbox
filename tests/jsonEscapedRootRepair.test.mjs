import assert from 'node:assert/strict';
import test from 'node:test';
import { bundleModule, options } from '../scripts/compare-json-repair.mjs';

const { formatWithOptionalRepair } = await bundleModule('src/components/utils/jsonRepair.ts');
const { formatJsonInput } = await bundleModule('src/components/utils/jsonEngine/service.ts');
const encodeRoot = source => JSON.stringify(source).slice(1, -1);

test('repair accepts a complete escaped root object without outer string quotes', async () => {
    const source = JSON.stringify({ requestId: 'REQ-ROOT', data: { message: 'hello', status: true } });
    const input = encodeRoot(source);
    assert.equal(input, source.replaceAll(String.fromCharCode(34), String.fromCharCode(92, 34)));
    const stages = [];
    const result = await formatWithOptionalRepair(input, options, true, stage => stages.push(stage));
    assert.equal(result.repaired, source);
    assert.equal(result.formatted, formatJsonInput(source, options).formatted);
    assert.deepEqual(JSON.parse(result.formatted), { requestId: 'REQ-ROOT', data: { message: 'hello', status: true } });
    assert(stages.includes('repairing'));
    assert.equal(result.repairEdits, undefined, 'decoded offsets must not be advertised as original editor offsets');
});

test('escaped root arrays and encoded pretty-printed roots retain their structure', async () => {
    for (const source of [
        JSON.stringify(['hello', { status: true, rows: [{ id: 1 }, { id: 2 }] }, null]),
        JSON.stringify({ requestId: 'REQ-ROOT', data: { message: 'hello', status: true } }, null, 2),
    ]) {
        const result = await formatWithOptionalRepair(' \r\n' + encodeRoot(source) + '\t ', options, true);
        assert.equal(result.repaired, source);
        assert.equal(result.formatted, formatJsonInput(source, options).formatted);
    }
});

test('one outer transport layer preserves business escapes, encoded payloads and exact number tokens', async () => {
    const fields = {
        path: 'C:\\temp\\file.json',
        network: '\\\\server\\share\\',
        literal: '\\u0041\\n\\x41',
        line: 'first\nsecond',
        quote: '客服说："hello"；} ] 不是结构',
        name: '数码😀',
        payload: JSON.stringify({ user: 'Alice', message: 'say "hello"', path: 'C:\\logs\\' }),
    };
    const source = '{"id":900719925474099312345,"amount":1.2300,"exponent":1.2300e+20,' + JSON.stringify(fields).slice(1);
    for (const encodingMode of [false, true]) {
        for (const preserveNumberLiterals of [false, true]) {
            for (const arrayNewLine of [false, true]) {
                const selected = { ...options, encodingMode, preserveNumberLiterals, arrayNewLine };
                const result = await formatWithOptionalRepair(encodeRoot(source), selected, true);
                assert.equal(result.repaired, source, 'repair must restore the original source, without parsing numeric values');
                assert.equal(result.formatted, formatJsonInput(source, selected).formatted);
                assert.equal(JSON.parse(result.formatted).path, fields.path);
                assert.equal(JSON.parse(result.formatted).network, fields.network);
                assert.equal(typeof JSON.parse(result.formatted).payload, 'string');
                assert.equal(JSON.parse(result.formatted).payload, fields.payload);
                if (preserveNumberLiterals) {
                    assert(result.formatted.includes('900719925474099312345'));
                    assert(result.formatted.includes('1.2300'));
                    assert(result.formatted.includes('1.2300e+20'));
                }
            }
        }
    }
});

test('valid root strings, valid objects and valid nested JSON strings never enter root repair', async () => {
    const original = JSON.stringify({
        path: 'C:\\temp\\file.json',
        literal: '\\n\\u0041',
        payload: JSON.stringify({ message: 'hello', status: true }),
    });
    for (const input of [original, JSON.stringify(original), JSON.stringify([original, { ok: true }])]) {
        const stages = [];
        const result = await formatWithOptionalRepair(input, options, true, stage => stages.push(stage));
        assert.equal(result.repaired, undefined);
        assert.equal(result.formatted, formatJsonInput(input, options).formatted);
        assert(!stages.includes('repairing'));
    }
});

test('turning repair off still rejects an escaped root with missing outer quotes', async () => {
    const stages = [];
    await assert.rejects(
        formatWithOptionalRepair(encodeRoot('{"ok":true}'), options, false, stage => stages.push(stage)),
        { name: 'JsonInputParseError' },
    );
    assert.deepEqual(stages, ['parsing']);
});

test('root-layer recognition cannot repair additional syntax errors, discard trailing fields or invent values', async () => {
    for (const source of [
        '{"missing":}',
        '{"ok":true "next":2}',
        '{"n":1e+}',
        '{"ok":true',
        '{"a":1}{"admin":true}',
        '{"a":1} "admin":true',
        '{"items":[1,,3]}',
    ]) {
        await assert.rejects(formatWithOptionalRepair(encodeRoot(source), options, true), source);
    }
    let overBudget = '{"name":"hello","status":true}';
    for (let layer = 0; layer < 5; layer++) overBudget = encodeRoot(overBudget);
    await assert.rejects(formatWithOptionalRepair(overBudget, options, true), { name: 'JsonRepairSafetyError' }, 'layers beyond the explicit budget are not unwrapped');
});

test('root-layer validation keeps the bounded parser depth limit', async () => {
    const source = '{"key":'.repeat(140) + 'true' + '}'.repeat(140);
    await assert.rejects(formatWithOptionalRepair(encodeRoot(source), options, true), { name: 'JsonRepairSafetyError' });
});
