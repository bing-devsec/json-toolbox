import assert from 'node:assert/strict';
import test from 'node:test';
import { bundleModule, options } from '../scripts/compare-json-repair.mjs';

const { formatWithOptionalRepair } = await bundleModule('src/components/utils/jsonRepair.ts');
const { formatJsonInput } = await bundleModule('src/components/utils/jsonEngine/service.ts');
const body = "// 非标准外层与合法嵌套字符串组合[2021-10-31 12:01:09]\n{\n  requestId: 'REQ-JSON5',\n  payload: \"{\\\"user\\\":{\\\"id\\\":\\\"U001\\\",\\\"name\\\":\\\"张三\\\",\\\"enabled\\\":true},\\\"message\\\":\\\"客服说：\\\\\\\"明天送达\\\\\\\"；不要把 } ] 或 \\\\\\\"amount\\\\\\\": 1 当作外层结构。\\\",\\\"path\\\":\\\"C:\\\\\\\\logs\\\\\\\\orders\\\\\\\\2026\\\\\\\\\\\",\\\"url\\\":\\\"https://example.com/search?q=JSON&lang=zh\\\",\\\"lines\\\":\\\"第一行\\\\n第二行\\\\t结束\\\"}\"\n  enabled: true,\n  missing: undefined,\n  invalid: NaN,\n  hex: 0xFF,\n  tags: ['json', 'json5',],\n}";
const validBody = body.replace('\n  enabled:', ',\n  enabled:');
const expected = formatJsonInput(validBody, options).formatted;
const timestamp = '[2021-10-31 12:01:09]';

test('ignore the reported trailing log timestamp and retain the complete JSON5 object and encoded payload', async () => {
    const input = body + '\nuu关于gig关于' + timestamp;
    const result = await formatWithOptionalRepair(input, options, true);
    assert.equal(result.formatted, expected);
    assert.equal(result.repairEdits, undefined, 'root extraction must not publish rebased source offsets');
    const value = JSON.parse(result.formatted);
    assert.equal(typeof value.payload, 'string');
    assert.equal(value.payload, JSON.parse(expected).payload);
    assert.deepEqual(JSON.parse(value.payload).user, { id: 'U001', name: '张三', enabled: true });
    assert.deepEqual({ enabled: value.enabled, missing: value.missing, invalid: value.invalid, hex: value.hex, tags: value.tags },
        { enabled: true, missing: null, invalid: null, hex: 255, tags: ['json', 'json5'] });
});

test('only complete date-time log markers are ignored across common separators and timezone suffixes', async () => {
    for (const marker of [timestamp, '[2026-10-24T00:01:09Z]', '[2026-10-24 00:01:09.123+08:00]', '[ 2026-10-24 00:01:09 ]']) {
        for (const gap of ['\n', '\r\n日志', '']) {
            assert.equal((await formatWithOptionalRepair(body + gap + marker + '\n', options, true)).formatted, expected);
        }
    }
    assert.equal((await formatWithOptionalRepair(body + '\n日志' + timestamp + ' more logs ' + timestamp, options, true)).formatted, expected);
});

test('a dominant object ignores shallow auxiliary roots after a timestamp while nested data stays independent', async () => {
    for (const tail of ['[]', '[1698753669]', '[2021,10,31]', '["2021-10-31 12:01:09"]', '{"after":true}', '[{"time":"2021-10-31 12:01:09"}]']) {
        const result = await formatWithOptionalRepair(body + '\n' + timestamp + '\n' + tail, options, true);
        const expectedInput = tail.startsWith('[{') ? '[' + validBody + ',' + tail + ']' : validBody;
        assert.equal(result.formatted, formatJsonInput(expectedInput, options).formatted);
    }
});

test('timestamps in field strings, encoded JSON and ordinary arrays are never removed', async () => {
    const original = JSON.stringify({ log: timestamp, payload: JSON.stringify({ message: timestamp }), rows: [timestamp, 1698753669], next: true });
    const broken = original.replace(',"next":', ' "next":');
    for (const input of [original, broken, broken + '\n' + timestamp]) {
        const result = await formatWithOptionalRepair(input, options, true);
        assert.equal(result.formatted, formatJsonInput(original, options).formatted);
    }
});

test('a log marker alone does not manufacture an empty JSON document', async () => {
    await assert.rejects(formatWithOptionalRepair(timestamp, options, true));
    await assert.rejects(formatWithOptionalRepair('日志' + timestamp, options, true));
});

test('malformed or data-bearing bracket content is not silently discarded as a timestamp', async () => {
    for (const marker of ['[2021-10-31]', '[2021-10-31 12:01:09,42]', '[2021-10-31 12:01:09 extra]', '[2021-13-31 12:01:09]', '[2021-10-31 24:01:09]', '[2021-10-31 12:01:09']) {
        await assert.rejects(formatWithOptionalRepair(body + '\n' + marker, options, true), marker);
    }
});

test('ordinary unquoted text arrays continue to be repaired as data rather than dropped', async () => {
    const result = await formatWithOptionalRepair(body + '\n' + timestamp + '\n[business data]', options, true);
    const data = JSON.parse(result.formatted);
    assert.deepEqual(data, [JSON.parse(expected), ['business data']]);
});

test('an invalid timestamp-shaped array inside a real document remains an error', async () => {
    await assert.rejects(formatWithOptionalRepair('{"rows":' + timestamp + ',"after":true}', options, true));
});

test('ignoring a log timestamp must not hide subsequent orphaned keys or incomplete field data', async () => {
    for (const tail of ['"after":1', "'after':1", 'after:1', '"after":', 'after:', '"after" /* comment */ :1', 'after /* comment */ :1']) {
        await assert.rejects(formatWithOptionalRepair(body + '\n' + timestamp + '\n' + tail, options, true), tail);
    }
});

test('repair-disabled mode continues to reject the log-wrapped input', async () => {
    const stages = [];
    await assert.rejects(formatWithOptionalRepair(body + '\n' + timestamp, options, false, x => stages.push(x)), { name: 'JsonInputParseError' });
    assert.deepEqual(stages, ['parsing']);
});
