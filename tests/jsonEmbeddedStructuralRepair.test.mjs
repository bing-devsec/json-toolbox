import assert from 'node:assert/strict';
import test from 'node:test';
import { bundleModule, options } from '../scripts/compare-json-repair.mjs';

const { formatWithOptionalRepair } = await bundleModule('src/components/utils/jsonRepair.ts');
const { formatJsonInput } = await bundleModule('src/components/utils/jsonEngine/service.ts');
const { repairJsonWithContext } = await bundleModule('src/components/utils/contextualRepair/parser.ts');
const { applyRepairEdits } = await bundleModule('src/components/utils/contextualRepair/edits.ts');

const input = String.raw`{
  "request": {
    "payload": "{\"orderId\":\"O1\",\"note\":\"数码\",\"tags\":[\"首单\"
  },
  "amount": {
    "payable": 99
  },
  "stats": {
    "ok": true
  }
}`;
const inner = '{"orderId":"O1","note":"数码","tags":["首单"]}';
const expected = JSON.stringify({ request: { payload: inner }, amount: { payable: 99 }, stats: { ok: true } });

test('complete the encoded tags array and payload object before the real outer request closer', async () => {
    const result = await formatWithOptionalRepair(input, options, true);
    assert.equal(result.formatted, formatJsonInput(expected, options).formatted);
    const data = JSON.parse(result.formatted);
    assert.equal(typeof data.request.payload, 'string');
    assert.equal(data.request.payload, inner);
    assert.deepEqual(JSON.parse(data.request.payload), { orderId: 'O1', note: '数码', tags: ['首单'] });
    assert.deepEqual(data.amount, { payable: 99 });
    assert.deepEqual(data.stats, { ok: true });
});


function truncatedLiteral(source, missingClosers = 1) {
    assert.match(source.slice(-missingClosers), /^[\]}]+$/);
    return JSON.stringify(source.slice(0, -missingClosers)).slice(0, -1);
}
function wrapTail(literal, newline = '\n') {
    return ['{', '  "request": {', '    "payload": ' + literal, '  },', '  "amount": {"payable":99},', '  "stats": {"ok":true}', '}'].join(newline);
}
async function expectOriginal(broken, original, selected = options) {
    const result = await formatWithOptionalRepair(broken, selected, true);
    assert.equal(result.formatted, formatJsonInput(original, selected).formatted, broken);
    return result;
}

const containers = [
    '{"number":42}', '[1,2,3]', '[true,false,null]', '["首单","JSON"]',
    '{"rows":[{"id":1,"tags":["a","b"]}]}', '{"rows":[]}', '{"rows":[{},[]]}',
    '{"rows":[{"child":{"tags":["a"]}}]}', '{"empty":"","nested":{"ok":true}}',
];
for (const source of containers) {
    test(`structural closure of every missing final container in ${source}`, async () => {
        const closers = source.match(/[\]}]+$/)[0].length;
        const original = JSON.stringify({ request: { payload: source }, amount: { payable: 99 }, stats: { ok: true } });
        for (let count = 1; count <= closers; count++) {
            const result = await expectOriginal(wrapTail(truncatedLiteral(source, count)), original);
            const value = JSON.parse(result.formatted);
            assert.equal(typeof value.request.payload, 'string');
            assert.equal(value.request.payload, source);
            assert.deepEqual(JSON.parse(value.request.payload), JSON.parse(source));
        }
    });
}

test('complete multiple independent truncated payloads inside nested outer arrays without swallowing siblings', async () => {
    const first = '{"rows":[{"id":1}]}';
    const second = '["数码",{"count":2}]';
    const other = '{"unchanged":true}';
    const original = JSON.stringify({
        records: [{ id: 1, encoded: first, tail: { keep: true } }, { id: 2, body: second, tail: 'keep' }],
        validPayload: other, stats: { count: 2, ok: true },
    }, null, 2);
    const broken = original.replace(JSON.stringify(first), truncatedLiteral(first, 3))
        .replace(JSON.stringify(second), truncatedLiteral(second, 2));
    const result = await expectOriginal(broken, original);
    const value = JSON.parse(result.formatted);
    assert.deepEqual(value.records.map(x => x.tail), [{ keep: true }, 'keep']);
    assert.equal(value.validPayload, other);
    assert.equal(value.records[0].encoded, first);
    assert.equal(value.records[1].body, second);
});

test('a truncated encoded value can precede a same-container sibling with or without its outer comma', async () => {
    const source = '{"id":1,"items":["首单"]}';
    const original = JSON.stringify({ payload: source, amount: { payable: 99 }, stats: { ok: true } }, null, 2);
    const broken = original.replace(JSON.stringify(source), truncatedLiteral(source, 2));
    await expectOriginal(broken, original);
    await expectOriginal(broken.replace(',\n  "amount":', '\n  "amount":'), original);
});

test('truncated string elements in an outer array retain their type and earlier values', async () => {
    const source = '{"tags":["首单"]}';
    const original = JSON.stringify([true, { keep: 1 }, source], null, 2);
    const broken = original.replace(JSON.stringify(source), truncatedLiteral(source, 2));
    const result = await expectOriginal(broken, original);
    const value = JSON.parse(result.formatted);
    assert.equal(typeof value[2], 'string');
    assert.deepEqual(value.slice(0, 2), [true, { keep: 1 }]);
});

test('a matching outer tail can establish the boundary without a physical newline', async () => {
    const source = '{"tags":[1,2]}';
    for (const missing of [1, 2]) {
        const broken = '{"request":{"payload":' + truncatedLiteral(source, missing) + '}}';
        await expectOriginal(broken, JSON.stringify({ request: { payload: source } }));
    }
});

test('CRLF and tab-indented outer layout preserve inner lexical whitespace, unicode and numeric spelling', async () => {
    const source = '{ "id" : 900719925474099312345, "amount":1.2300, "exponent":1.2300e+20, "id":2, "rows":[true,null]}';
    const original = JSON.stringify({ request: { payload: source }, amount: { payable: 99 }, stats: { ok: true } });
    const broken = wrapTail(truncatedLiteral(source, 2), '\r\n').replaceAll('  ', '\t');
    for (const encodingMode of [false, true]) {
        for (const preserveNumberLiterals of [false, true]) {
            const result = await expectOriginal(broken, original, { ...options, encodingMode, preserveNumberLiterals });
            assert.equal(JSON.parse(result.formatted).request.payload, source);
        }
    }
});

test('nested encoded payloads, real business quotes, paths and structure-like text remain opaque', async () => {
    const source = JSON.stringify({
        quote: '客服说："hello"；} ] 不是结构；// # /* text */',
        path: 'C:\\temp\\file.json', network: '\\\\server\\share\\', literal: '\\u0041\\n\\x41',
        child: JSON.stringify({ name: 'Alice', nested: JSON.stringify({ enabled: true, text: 'say "hello"' }) }),
        rows: [{ ok: true }],
    });
    const original = JSON.stringify({ request: { payload: source }, amount: { payable: 99 }, stats: { ok: true } });
    for (const count of [1, 2, 3]) {
        const result = await expectOriginal(wrapTail(truncatedLiteral(source, count)), original);
        assert.equal(JSON.parse(result.formatted).request.payload, source);
    }
});

test('incomplete inner values and trailing separators reject rather than return an invalid JSON string', async () => {
    for (const prefix of [
        '{"missing":', '{"key"', '{"items":[1,', '{"items":[1,,', '{"ok":true,',
        '{"n":1e+', '{"n":-', '{"n":01', '{"ok":tru', '{"name":"首',
        '{"name":"last\\', '{"name":"\\u12', '{"name":"\\q"',
    ]) {
        const broken = wrapTail(JSON.stringify(prefix).slice(0, -1));
        await assert.rejects(formatWithOptionalRepair(broken, options, true), prefix);
        const candidate = repairJsonWithContext(broken);
        assert(!['repaired', 'unchanged'].includes(candidate.status), prefix);
        assert.equal(candidate.text, undefined);
        assert.deepEqual(candidate.edits, []);
    }
});

test('an explicit real close protects legitimate fragment strings even when another outer separator is missing', async () => {
    for (const payload of ['{"tags":["首单"', '{"missing":', '[1,2,', 'ordinary text { [ } ]', '{"broken":"unfinished']) {
        const original = JSON.stringify({ request: { payload }, amount: { payable: 99 }, stats: { ok: true } });
        const stages = [];
        const valid = await formatWithOptionalRepair(original, options, true, stage => stages.push(stage));
        assert.equal(valid.repaired, undefined);
        assert(!stages.includes('repairing'));
        assert.equal(JSON.parse(valid.formatted).request.payload, payload);
        const unrelated = original.replace(',"amount":', ' "amount":');
        const result = await expectOriginal(unrelated, original);
        assert.equal(JSON.parse(result.formatted).request.payload, payload);
    }
});

test('ordinary non-JSON fragments still use the existing text-string recovery', async () => {
    for (const text of ['ordinary business text', '{not JSON', '[ordinary text', 'C:\\logs\\file.json']) {
        const broken = wrapTail(JSON.stringify(text).slice(0, -1));
        const original = JSON.stringify({ request: { payload: text }, amount: { payable: 99 }, stats: { ok: true } });
        await expectOriginal(broken, original);
    }
});

test('UTF-16 source edits replay the structural completion without changing emoji or duplicate keys', async () => {
    const source = '{"text":"中文😀","id":1,"id":2,"tags":["首单"]}';
    const broken = wrapTail(truncatedLiteral(source, 2));
    const candidate = repairJsonWithContext(broken);
    assert.equal(candidate.status, 'repaired');
    assert.equal(applyRepairEdits(broken, candidate.edits), candidate.text);
    assert.equal(JSON.parse(candidate.text).request.payload, source);
    const structural = candidate.edits.filter(x => x.reason.includes('Complete encoded JSON'));
    assert.equal(structural.length, 1);
    assert.equal(structural[0].risk, 'inferred');
    for (const edit of candidate.edits) assert.equal(edit.start, edit.end, 'completion may insert syntax but not delete source values');
});

test('structural completion obeys depth, work, lookahead and edit limits and never publishes partial output', () => {
    for (const limits of [
        { maxDepth: 2 }, { maxWork: 1 }, { maxDurationMs: 0 }, { maxLookahead: 8 }, { maxEdits: 0 },
    ]) {
        const candidate = repairJsonWithContext(input, limits);
        assert(!['repaired', 'unchanged'].includes(candidate.status), JSON.stringify(limits));
        assert.equal(candidate.text, undefined);
        assert.deepEqual(candidate.edits, []);
    }
});

test('repair-disabled mode still rejects the structurally truncated input', async () => {
    const stages = [];
    await assert.rejects(formatWithOptionalRepair(input, options, false, stage => stages.push(stage)), { name: 'JsonInputParseError' });
    assert.deepEqual(stages, ['parsing']);
});


test('fixed-seed structural omissions preserve arbitrary field names and all outer siblings', async () => {
    let state = 0x6a09e667;
    const next = () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return state >>> 0; };
    for (let index = 0; index < 64; index++) {
        let value = { id: index, note: '数码😀 "quote" } ]', tags: ['首单', 'JSON'], child: JSON.stringify({ index, ok: true }) };
        for (let depth = 0, total = 1 + next() % 5; depth < total; depth++) {
            value = next() % 2 ? { ['field_' + next() % 99]: value } : [true, value];
        }
        const encoded = JSON.stringify(value);
        const count = 1 + next() % encoded.match(/[\]}]+$/)[0].length;
        const original = JSON.stringify({ before: { keep: 1 }, data: [{ ['encoded_' + index]: encoded, tail: 'kept' }], after: [1, 2], stats: { ok: true } }, null, 2);
        const broken = original.replace(JSON.stringify(encoded), truncatedLiteral(encoded, count));
        const result = await expectOriginal(broken, original);
        const data = JSON.parse(result.formatted);
        assert.equal(typeof data.data[0]['encoded_' + index], 'string');
        assert.equal(data.data[0]['encoded_' + index], encoded);
        assert.deepEqual(JSON.parse(data.data[0]['encoded_' + index]), value);
    }
});

test('outer JSON5 keys and comments can coexist with structural embedded completion', async () => {
    const broken = input.replace('"request":', 'request:').replace('"amount":', '/* outside payload */ amount:');
    const result = await expectOriginal(broken, expected);
    assert.doesNotThrow(() => JSON.parse(result.repaired));
    assert.equal(JSON.parse(result.formatted).request.payload, inner);
});

test('strict completed candidates keep numeric spelling and legitimate fragment strings before final formatting', async () => {
    const source = '{"id":900719925474099312345,"amount":1.2300,"exponent":1.2300e+20,"id":2,"payload":"{\\"unfinished\\":[1,"}';
    const broken = source.replace(',"amount":', ' "amount":');
    for (const preserveNumberLiterals of [false, true]) {
        const result = await expectOriginal(broken, source, { ...options, preserveNumberLiterals });
        assert.equal(result.repaired, source.replace(',"amount":', ', "amount":'));
        assert(result.repaired.includes('900719925474099312345'));
        assert(result.repaired.includes('1.2300e+20'));
        assert.equal((result.repaired.match(/"id"\s*:/g) ?? []).length, 2);
        assert.equal(JSON.parse(result.formatted).payload, '{"unfinished":[1,');
    }
});

test('large explicitly closed fragments are preserved and oversized structural probes reject cleanly', async () => {
    const payload = '{"fragment":"' + '汉字😀 } ] \\n'.repeat(8192);
    const original = JSON.stringify({ payload, stats: { ok: true } });
    const broken = original.replace(',"stats":', ' "stats":');
    const result = await expectOriginal(broken, original);
    assert.equal(JSON.parse(result.formatted).payload, payload);
    const nested = JSON.stringify({ text: '汉字😀'.repeat(16384), tags: [1, 2] });
    const oversized = wrapTail(truncatedLiteral(nested, 2));
    await assert.rejects(formatWithOptionalRepair(oversized, options, true), { name: 'JsonRepairSafetyError' });
    const candidate = repairJsonWithContext(oversized);
    assert.equal(candidate.text, undefined);
    assert.deepEqual(candidate.edits, []);
});
