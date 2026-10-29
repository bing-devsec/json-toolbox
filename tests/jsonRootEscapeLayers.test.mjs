import assert from 'node:assert/strict';
import test from 'node:test';
import { bundleModule, options } from '../scripts/compare-json-repair.mjs';

const { formatWithOptionalRepair } = await bundleModule('src/components/utils/jsonRepair.ts');
const { formatJsonInput } = await bundleModule('src/components/utils/jsonEngine/service.ts');
const encodeRoot = source => JSON.stringify(source).slice(1, -1);
const payload = JSON.stringify({ name: 'Alice', permissions: ['read', 'write'] });
const original = JSON.stringify({ requestId: 'REQ-ROOT-ENCODED', payload });
// Literal copy of the report: three backslashes at root quotes, seven inside payload.
const reported = String.raw`{\\\"requestId\\\":\\\"REQ-ROOT-ENCODED\\\",\\\"payload\\\":\\\"{\\\\\\\"name\\\\\\\":\\\\\\\"Alice\\\\\\\",\\\\\\\"permissions\\\\\\\":[\\\\\\\"read\\\\\\\",\\\\\\\"write\\\\\\\"]}\\\"}`;

test('reported twice-escaped root restores the outer object while retaining payload as a string', async () => {
    assert.equal(reported, encodeRoot(encodeRoot(original)), 'the regression must match the exact report, with both complete outer layers');
    const result = await formatWithOptionalRepair(reported, options, true);
    assert.equal(result.repaired, original);
    assert.equal(result.formatted, formatJsonInput(original, options).formatted);
    const value = JSON.parse(result.formatted);
    assert.equal(value.requestId, 'REQ-ROOT-ENCODED');
    assert.equal(typeof value.payload, 'string');
    assert.equal(value.payload, payload);
    assert.deepEqual(JSON.parse(value.payload), { name: 'Alice', permissions: ['read', 'write'] });
    assert.equal(result.repairEdits, undefined);
});

const { repairEscapedRoot } = await bundleModule('src/components/utils/contextualRepair/escapedRoot.ts');
function encodeLayers(source, count) {
    for (let layer = 0; layer < count; layer++) source = encodeRoot(source);
    return source;
}

async function expectOriginal(input, source, selected = options) {
    const result = await formatWithOptionalRepair(input, selected, true);
    assert.equal(result.repaired, source);
    assert.equal(result.formatted, formatJsonInput(source, selected).formatted);
    assert.equal(result.repairEdits, undefined);
    return result;
}

test('one through four complete root layers restore objects and arrays without decoding payload strings', async () => {
    for (const source of [original,
        JSON.stringify([1, null, 'first', { payload, stats: { ok: true } }, ['last', false]]),
        JSON.stringify({ data: JSON.stringify({ nested: encodeLayers('{"value":"keep this spelling"}', 2) }), stats: { ok: true } }, null, 2),
    ]) {
        for (let layers = 1; layers <= 4; layers++) {
            await expectOriginal(' \n' + encodeLayers(source, layers) + '\t ', source);
        }
    }
});

test('the first valid root is the stopping point even when payload itself has multiple encoded layers', async () => {
    for (const inner of [payload, encodeLayers(payload, 1), encodeLayers(payload, 2), '{unfinished inner JSON', 'ordinary text']) {
        const source = JSON.stringify({ requestId: 'OPAQUE', payload: inner, stats: { ok: true } });
        const result = await expectOriginal(encodeLayers(source, 2), source);
        const value = JSON.parse(result.formatted);
        assert.equal(typeof value.payload, 'string');
        assert.equal(value.payload, inner);
        assert.deepEqual(value.stats, { ok: true });
    }
});

test('multi-layer decoding preserves lexical numbers, duplicate keys and complex business escapes', async () => {
    const fields = {
        path: 'C:\\temp\\file.json', network: '\\\\server\\share\\', literal: '\\u0041\\n\\x41',
        line: 'first\nsecond\tend', text: '中文😀 "hello" } ] // # /* text */',
        payload: JSON.stringify({ name: 'Alice', permissions: ['read', 'write'], child: JSON.stringify({ path: 'C:\\data\\', text: 'say "hello"' }) }),
    };
    const source = '{"id":900719925474099312345,"amount":1.2300,"exponent":1.2300e+20,"repeat":1,"repeat":2,' + JSON.stringify(fields).slice(1);
    for (const encodingMode of [false, true]) {
        for (const preserveNumberLiterals of [false, true]) {
            for (const arrayNewLine of [false, true]) {
                for (const layers of [2, 4]) {
                    const result = await expectOriginal(encodeLayers(source, layers), source, { ...options, encodingMode, preserveNumberLiterals, arrayNewLine });
                    const value = JSON.parse(result.formatted);
                    assert.equal(value.path, fields.path);
                    assert.equal(value.network, fields.network);
                    assert.equal(value.payload, fields.payload);
                    assert.equal(typeof value.payload, 'string');
                    if (preserveNumberLiterals) {
                        for (const token of ['900719925474099312345', '1.2300', '1.2300e+20']) assert(result.formatted.includes(token));
                    }
                }
            }
        }
    }
});

test('a complete transport wrapper can surround the existing mixed delimiter repair', async () => {
    const source = '{"requestId":"REQ-ROOT","data":{"message":"hello","status":true}}';
    const mixed = String.raw`{\"requestId\":\"REQ-ROOT",\"data\":{\"message\":\"hello\",\"status":true}}`;
    for (let wrappers = 0; wrappers <= 3; wrappers++) await expectOriginal(encodeLayers(mixed, wrappers), source);
});

test('valid roots and quoted root strings remain on the original no-repair path', async () => {
    for (const input of [original, JSON.stringify(original), JSON.stringify(JSON.stringify(original)), JSON.stringify([original, { payload }])]) {
        const stages = [];
        const result = await formatWithOptionalRepair(input, options, true, stage => stages.push(stage));
        assert.equal(result.repaired, undefined);
        assert.equal(result.formatted, formatJsonInput(input, options).formatted);
        assert(!stages.includes('repairing'));
    }
});

test('repair-disabled mode rejects the original layered sample without entering recovery', async () => {
    const stages = [];
    await assert.rejects(formatWithOptionalRepair(reported, options, false, stage => stages.push(stage)), { name: 'JsonInputParseError' });
    assert.deepEqual(stages, ['parsing']);
});

test('each layer must preserve the complete root and cannot add values or discard suffixes', async () => {
    for (const source of [
        '{"missing":}', '{"n":1e+}', '{"items":[1,,3]}', '{"ok":true "next":2}',
        '{"a":1}{"admin":true}', '{"a":1} "admin":true', '{"ok":true} trailing',
        '{"payload":"unfinished}', '{"payload":' + JSON.stringify(payload) + ',"missing":}',
    ]) {
        for (const layers of [1, 2, 4]) {
            const input = encodeLayers(source, layers);
            const candidate = repairEscapedRoot(input);
            assert.equal(candidate.text, undefined, source);
            assert.deepEqual(candidate.edits, [], source);
            await assert.rejects(formatWithOptionalRepair(input, options, true), source);
        }
    }
});

test('layer, work, duration and depth limits do not expose intermediate partially decoded results', async () => {
    for (const [input, limits, maxLayers] of [
        [reported, {}, 1], [encodeLayers(original, 5), {}, 4],
        [reported, { maxWork: reported.length }, 4], [reported, { maxDurationMs: 0 }, 4],
        [reported, { maxWork: Number.NaN }, 4], [reported, {}, 0], [reported, {}, 5],
        [encodeLayers('{"key":'.repeat(140) + 'true' + '}'.repeat(140), 2), {}, 4],
    ]) {
        const candidate = repairEscapedRoot(input, limits, maxLayers);
        assert.equal(candidate.status, 'limit');
        assert.equal(candidate.text, undefined);
        assert.deepEqual(candidate.edits, []);
    }
    await assert.rejects(formatWithOptionalRepair(encodeLayers(original, 5), options, true), { name: 'JsonRepairSafetyError' });
});

test('large opaque strings and near-JSON payloads stay unchanged after layered root recovery', async () => {
    const opaque = '{\\\"data\\\":[' + '中文😀\\n'.repeat(16384);
    const source = JSON.stringify({ payload: opaque, stats: { count: 1, ok: true } });
    for (const layers of [2, 4]) {
        const result = await expectOriginal(encodeLayers(source, layers), source);
        assert.equal(JSON.parse(result.formatted).payload, opaque);
    }
});
