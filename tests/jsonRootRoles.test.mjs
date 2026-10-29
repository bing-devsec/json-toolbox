import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { bundleModule, options } from '../scripts/compare-json-repair.mjs';
const { formatWithOptionalRepair } = await bundleModule('src/components/utils/jsonRepair.ts');
const { formatJsonInput } = await bundleModule('src/components/utils/jsonEngine/service.ts');
const body = await readFile(new URL('./fixtures/jsonRepairPrimaryRoot.txt', import.meta.url), 'utf8');
const full = JSON.parse(formatJsonInput(body.replace('\n  enabled:', ',\n  enabled:'), options).formatted);
const screenshot = { requestId: full.requestId, payload: full.payload, enabled: true, tags: ['json','json5'] };
async function expect(input, original, selected = options) {
    const result = await formatWithOptionalRepair(input, selected, true);
    assert.equal(result.formatted, formatJsonInput(typeof original === 'string' ? original : JSON.stringify(original), selected).formatted);
    return result;
}

test('the exact four-field screenshot selects its document instead of wrapping its trailing value list', async () => {
    await expect(JSON.stringify(screenshot, null, 2) + '\n["read","write"]', screenshot);
});

test('removing unrelated fields preserves document identity down to one named string or child container', async () => {
    for (const main of [screenshot, { requestId: full.requestId, payload: full.payload, enabled: true }, { requestId: full.requestId, payload: full.payload }, { payload: full.payload }, { tags: [] }, { child: {} }, { a: 1, b: 2 }]) {
        for (const tail of ['["read","write"]', '[1001,1002]', '{"ok":true}', '{}', 'null']) {
            await expect(JSON.stringify(main) + '\n' + tail, main);
        }
    }
});

test('string length and whether a string happens to encode JSON never change root relationships', async () => {
    for (const payload of ['', 'hello', full.payload, '{"fragment":', 'x'.repeat(280000)]) {
        const main = { payload };
        for (const trailer of ['["read","write"]', '{"ok":true}']) {
            const result = await expect(JSON.stringify(main) + '\n' + trailer, main);
            assert.equal(JSON.parse(result.formatted).payload, payload);
        }
    }
});

test('adding irrelevant scalar fields cannot toggle the screenshot classification', async () => {
    for (let count = 0; count < 20; count++) {
        const main = { ...screenshot };
        for (let i = 0; i < count; i++) main['extra_' + i] = i;
        await expect(JSON.stringify(main) + '\n["read","write"]', main);
    }
});

test('simple value arrays remain auxiliary regardless of their element count', async () => {
    for (const count of [0,1,2,10,1000]) {
        await expect(JSON.stringify(screenshot) + '\n' + JSON.stringify(Array.from({ length: count }, (_, i) => i)), screenshot);
    }
});

test('layout, comments and key escape spelling cannot establish or remove document identity', async () => {
    for (const source of ['{payload:"hello"}', '{\n /* notes */ "payload" : "hello"\n}', "{'payload':'hello'}", '{"pay\\u006coad":"hello"}']) {
        const result = await expect(source + '\n{"ok":true}', source);
        assert.deepEqual(JSON.parse(result.formatted), { payload: 'hello' });
    }
});

test('short and long ordinary business record strings are equally retained as records', async () => {
    for (const text of ['', 'x', 'important'.repeat(1000)]) {
        const other = { message: text };
        await expect(JSON.stringify(screenshot) + '\n' + JSON.stringify(other), [screenshot, other]);
    }
});

test('named field relationships preserve related atomic records, independent of optional fields', async () => {
    for (const main of [{ enabled: true, payload: '' }, { enabled: true, payload: '', optional: 0 }, { enabled: true, payload: '', child: {} }]) {
        await expect(JSON.stringify(main) + '\n{"enabled":false}', [main, { enabled: false }]);
        await expect(JSON.stringify(main) + '\n{"unused":false}', main);
    }
});

test('a repeated family of atomic records is retained while unrelated value arrays are removed', async () => {
    const input = JSON.stringify(screenshot) + '\n{"event":1}\n{"event":2}\n["read","write"]';
    await expect(input, [screenshot, { event: 1 }, { event: 2 }]);
});

test('separate log frames protect every record and exclude an unframed auxiliary list', async () => {
    const input = '[2026-10-24 10:00:01] INFO response: ' + JSON.stringify(screenshot) + '\n[2026-10-24 10:00:02] WARN response: {"ok":true}\n["read","write"]';
    await expect(input, [screenshot, { ok: true }]);
});

test('INFO text inside JSON values and unrelated nearby prose are not record frames', async () => {
    const main = { message: 'INFO response: } ]', nested: { text: 'WARN ERROR' } };
    await expect(JSON.stringify(main, null, 2) + '\n{"ok":true}', main);
    await expect(JSON.stringify(main) + ' trailer says INFO\n{"ok":true}', main);
});

test('record collections outrank unframed value lists without changing their own members', async () => {
    const main = [{ id: 1 }, { id: 2 }];
    await expect(JSON.stringify(main) + '\n[1001,1002]', main);
    await expect(JSON.stringify([main, [1001,1002]]).replace('],[' , '] ['), [main, [1001,1002]]);
});

test('no document evidence means arrays, primitives and distinct atomic objects remain peers', async () => {
    for (const values of [[[1,2], [3,4]], [{ a: 1 }, { b: 2 }], [123, { a: 1 }, false, null]]) {
        await expect(values.map(value => JSON.stringify(value)).join('\n'), values);
    }
});

test('ordinary flat multi-field objects remain independent records', async () => {
    const other = { count: 2, active: false };
    await expect(JSON.stringify(screenshot) + '\n' + JSON.stringify(other), [screenshot, other]);
});

test('duplicate key spellings do not turn an atomic wrapper into a multi-attribute document', async () => {
    await expect(JSON.stringify(screenshot) + '\n{"ok":1,"ok":2}', screenshot);
    await expect(JSON.stringify(screenshot) + '\n{"ok":1,"\\u006fk":2}', screenshot);
});

test('canonical field identities are case-sensitive and prototype names remain ordinary data', async () => {
    const main = JSON.parse('{"payload":"x","a.b":1,"__proto__":true,"constructor":2,"Enabled":true}');
    for (const [source, tail] of [['{"a.b":2}', { 'a.b': 2 }], ['{"__proto__":false}', JSON.parse('{"__proto__":false}')], ['{"constructor":3}', { constructor: 3 }], ['{"Enabl\\u0065d":false}', { Enabled: false }]]) {
        const result = await expect(JSON.stringify(main) + '\n' + source, '[' + JSON.stringify(main) + ',' + source + ']');
        assert.deepEqual(JSON.parse(result.formatted), [main, tail]);
    }
    await expect(JSON.stringify(main) + '\n{"enabled":false}', main);
});

test('explicit array membership retains every auxiliary-looking value during repair', async () => {
    const expected = [screenshot, ['read','write'], { ok: true }, null];
    const broken = '[' + JSON.stringify(screenshot) + ' ["read","write"] {"ok":true} null]';
    await expect(broken, expected);
});

test('unsafe secondary data must fail before relationship classification', async () => {
    for (const tail of ['{"ok":}', '[1,,2]', '{"value":1e+}', '"after":1']) {
        await assert.rejects(formatWithOptionalRepair(JSON.stringify(screenshot) + '\n' + tail, options, true));
    }
});


test('repeated standalone numeric values form peer records and keep exact source precision', async () => {
    const first = '900719925474099312345', second = '+1.2300e+20';
    await expect(first + '\n{a:+99 b:undefined}\n' + second, '[900719925474099312345,{"a":99,"b":null},1.2300e+20]');
});


test('overwritten duplicate values cannot change the effective record role', async () => {
    const main = { payload: 'x' };
    for (const tail of ['{"ok":1}', '{"ok":"old","ok":1}', '{"ok":{},"ok":1}', '{"ok":[],"\\u006fk":1}', '{"ok":true,"ok":null}']) {
        await expect(JSON.stringify(main) + '\n' + tail, main);
    }
    for (const tail of ['{"ok":1,"ok":"new"}', '{"ok":1,"ok":{}}']) {
        await expect(JSON.stringify(main) + '\n' + tail, '[' + JSON.stringify(main) + ',' + tail + ']');
    }
});
