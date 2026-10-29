import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { bundleModule, options } from '../scripts/compare-json-repair.mjs';

const { formatWithOptionalRepair } = await bundleModule('src/components/utils/jsonRepair.ts');
const { formatJsonInput } = await bundleModule('src/components/utils/jsonEngine/service.ts');
const body = await readFile(new URL('./fixtures/jsonRepairPrimaryRoot.txt', import.meta.url), 'utf8');
const validBody = body.replace('\n  enabled:', ',\n  enabled:');
const expected = formatJsonInput(validBody, options).formatted;
const main = JSON.parse(expected);
async function expectInput(input, expectedInput = validBody, selected = options) {
    const result = await formatWithOptionalRepair(input, selected, true);
    assert.equal(result.formatted, formatJsonInput(expectedInput, selected).formatted);
    return result;
}

for (const tail of ['["2021-10-31 12:01:09"]', '["read","write"]', '[1001,1002]', '{"ok":true}', '[]', '42', 'false', 'null']) {
    test('select the main JSON5 object instead of merging the auxiliary fragment ' + tail, async () => {
        const result = await expectInput(body + '\n' + tail);
        assert.equal(result.repairEdits, undefined);
        const data = JSON.parse(result.formatted);
        assert.equal(typeof data.payload, 'string');
        assert.equal(data.payload, main.payload);
        assert.deepEqual(JSON.parse(data.payload).user, { id: 'U001', name: '张三', enabled: true });
    });
}

test('main-content selection uses structure independently of root order and whitespace', async () => {
    for (const input of ['{"ok":true}\n' + body, '[1001,1002]\n' + body + '\n["read","write"]', JSON.stringify(main) + '{"ok":true}', JSON.stringify(main, null, 8) + '\r\n{"ok":true}']) {
        await expectInput(input);
    }
});

test('several small auxiliary fragments can surround a clear main object', async () => {
    await expectInput('{"ok":true}\n' + body + '\n["read","write"]\n[1001,1002]');
});

test('unequal records with the same fields remain peers even without log prefixes', async () => {
    const large = JSON.stringify({ requestId: 'R1', data: { rows: Array.from({ length: 12 }, (_, id) => ({ id, enabled: true })) } });
    const small = '{"requestId":"R2","data":null}';
    await expectInput(large + '\n' + small, '[' + large + ',' + small + ']');
});

test('single-field record schemas survive very different payload sizes', async () => {
    const large = JSON.stringify({ data: { rows: Array.from({ length: 12 }, (_, id) => ({ id })) } });
    const small = '{"data":null}';
    await expectInput(large + small, '[' + large + ',' + small + ']');
});

test('explicit separate log records preserve a much smaller differently shaped response', async () => {
    for (const prefix of ['2026-10-24 10:00:01 INFO response: ', '[2026-10-24 10:00:01] INFO response: ', 'INFO response: ']) {
        await expectInput(prefix + validBody.slice(validBody.indexOf('{')) + '\n' + prefix.replace('INFO', 'WARN') + '{"ok":true}', '[' + validBody + ',{"ok":true}]');
    }
});

test('comparable differently shaped roots are retained in source order', async () => {
    const first = '{"id":1,"status":true}';
    const second = '{"name":"Alice","enabled":true}';
    await expectInput('start\n' + first + '\n' + second + '\nend', '[' + first + ',' + second + ']');
});

test('a collection of small independent records cannot be erased by one larger record', async () => {
    const others = Array.from({ length: 16 }, (_, id) => '{"event":' + id + '}');
    await expectInput(body + '\n' + others.join('\n'), '[' + validBody + ',' + others.join(',') + ']');
});

test('named text is a record regardless of length while comments and indentation add no record context', async () => {
    for (const large of [JSON.stringify({ text: 'a'.repeat(20000) }), '{ /*' + 'padding '.repeat(1000) + '*/ "id":1}', '{\n' + ' '.repeat(20000) + '"id":1}']) {
        const hasTextField = large.startsWith('{"text"');
        await expectInput(large + '\n{"ok":true}', hasTextField ? large : '[' + large + ',{"ok":true}]');
    }
});

test('one valid root and valid JSON5 formatting never enter fragment selection', async () => {
    for (const input of ['[' + validBody + ',["read","write"],{"ok":true}]', '[1001,1002]', '{"ok":true}', '["2021-10-31 12:01:09"]']) {
        const stages = [];
        const result = await formatWithOptionalRepair(input, options, true, x => stages.push(x));
        assert.equal(result.repaired, undefined);
        assert.equal(result.formatted, formatJsonInput(input, options).formatted);
        assert(!stages.includes('repairing'));
    }
});

test('explicit array membership and nested auxiliary-looking data survive syntax repair', async () => {
    const input = '[' + validBody + ' ["read","write"] {"ok":true}]';
    await expectInput(input, '[' + validBody + ',["read","write"],{"ok":true}]');
    const nested = JSON.stringify({ ...main, trailers: [[1001,1002], ['read','write'], { ok: true }] });
    await expectInput(nested.replace(',"trailers":', ' "trailers":'), nested);
});

test('a record collection is retained while an unrelated value-list attachment is removed', async () => {
    const large = JSON.stringify(Array.from({ length: 12 }, (_, id) => ({ id, name: 'Alice' })));
    await expectInput(large + '\n[1001,1002]', large);
});

test('complex auxiliary-looking objects remain data when there is no clear shallow fragment', async () => {
    const other = '{"stats":{"ok":true}}';
    await expectInput(body + '\n' + other, '[' + validBody + ',' + other + ']');
});

test('an unsafe smaller root must be rejected before it can be considered auxiliary', async () => {
    for (const tail of ['{"ok":}', '{"value":1e+}', '[1,,2]', '{"name":"unfinished']) {
        await assert.rejects(formatWithOptionalRepair(body + '\n' + tail, options, true), tail);
    }
    for (const field of ['"after":1', 'after:1', '"after" /*comment*/ :1', 'after /*comment*/ :1']) {
        await assert.rejects(formatWithOptionalRepair(body + '\n["read","write"]\n' + field, options, true));
    }
});

test('primary selection preserves source number and escape spellings under existing options', async () => {
    const original = '{"id":900719925474099312345,"amount":1.2300,"exponent":1.20e+20,"raw":"\\u0041","rows":[{"id":1,"name":"Alice"}],"enabled":true}';
    for (const encodingMode of [false, true]) {
        const result = await expectInput(original + '\n{"ok":true}', original, { ...options, encodingMode });
        assert.match(result.repaired, /900719925474099312345/);
        assert.match(result.repaired, /1\.2300/);
    }
});

test('business field names do not determine which fragment is primary', async () => {
    const renamed = validBody.replaceAll('requestId', 'arbitrary').replaceAll('payload', 'encoded').replaceAll('enabled', 'active');
    await expectInput(renamed + '\n{"ok":true}', renamed);
});

test('turning repair off retains parse failure for several roots', async () => {
    await assert.rejects(formatWithOptionalRepair(body + '\n{"ok":true}', options, false), { name: 'JsonInputParseError' });
});


test('large strings do not disable the same record-role selection used for small documents', async () => {
    const oversized = JSON.stringify({ ...main, text: 'x'.repeat(270000) });
    await expectInput(oversized + '\n{"ok":true}', oversized);
});

test('escaped key spellings retain the same role without rewriting original escape text', async () => {
    const escapedKey = validBody.replace('requestId:', '"request\\u0049d":');
    await expectInput(escapedKey + '\n{"ok":true}', escapedKey);
});

test('fixed structural variations select primary content without relying on business names', async () => {
    for (let index = 0; index < 32; index++) {
        const original = JSON.stringify({ ['field_' + index]: index, payload: JSON.stringify({ quote: 'say "hello" } ]', path: 'C:\\logs\\' }), rows: [{ id: index, labels: ['one','two'] }], amount: 1, active: true, after: null });
        const auxiliary = index % 2 ? '["read","write"]' : '{"ok":true}';
        await expectInput(index % 3 ? original + '\n' + auxiliary : auxiliary + '\n' + original, original);
    }
});


test('a large scalar business value is not classified as a small auxiliary root', async () => {
    const other = JSON.stringify({ message: 'important'.repeat(200) });
    await expectInput(body + '\n' + other, '[' + validBody + ',' + other + ']');
});
