import assert from 'node:assert/strict';
import test from 'node:test';
import { bundleModule, options } from '../scripts/compare-json-repair.mjs';

const { formatWithOptionalRepair } = await bundleModule('src/components/utils/jsonRepair.ts');
const { formatJsonInput } = await bundleModule('src/components/utils/jsonEngine/service.ts');

// The request is literal text, including its backslashes, not a parsed JS string.
const userInput = String.raw`{\"requestId\":\"REQ-ROOT",\"data\":{\"message\":\"hello\",\"status":true}}`;
const expected = '{"requestId":"REQ-ROOT","data":{"message":"hello","status":true}}';

test('repair accepts the reported root with missing escapes on a value closer and a key closer', async () => {
    const result = await formatWithOptionalRepair(userInput, options, true);
    assert.equal(result.repaired, expected);
    assert.equal(result.formatted, formatJsonInput(expected, options).formatted);
    assert.deepEqual(JSON.parse(result.formatted), {
        requestId: 'REQ-ROOT', data: { message: 'hello', status: true },
    });
    assert.equal(result.repairEdits, undefined);
});

const { repairMixedEscapedRoot } = await bundleModule('src/components/utils/contextualRepair/escapedRoot.ts');
const encodeRoot = source => JSON.stringify(source).slice(1, -1);

// Damage only known JSON token delimiters in a known original document. Quotes
// belonging to business text or encoded payloads keep every existing escape.
function damageDelimiters(source, remove) {
    let inString = false, escaped = false, delimiter = 0;
    const pieces = [];
    for (const char of source) {
        const isDelimiter = char === '"' && !escaped;
        pieces.push(isDelimiter && remove(delimiter++) ? '"' : encodeRoot(char));
        if (inString && escaped) escaped = false;
        else if (inString && char === '\\') escaped = true;
        else if (char === '"') inString = !inString;
    }
    return { input: pieces.join(''), delimiters: delimiter };
}

async function expectOriginal(input, source, selected = options) {
    const result = await formatWithOptionalRepair(input, selected, true);
    assert.equal(result.repaired, source, input);
    assert.equal(result.formatted, formatJsonInput(source, selected).formatted, input);
    assert.equal(result.repairEdits, undefined, 'transport-decoded offsets are not original editor edits');
    return result;
}

test('each key/value opening or closing quote may independently miss its transport escape', async () => {
    for (const source of [expected, '["first",{"name":"Alice","ok":true},["last",null,2]]']) {
        const intact = damageDelimiters(source, () => false);
        assert.equal(intact.input, encodeRoot(source));
        for (let index = 0; index < intact.delimiters; index++) {
            await expectOriginal(damageDelimiters(source, position => position === index).input, source);
        }
    }
});

test('several missing delimiters preserve nested objects, arrays, empty strings and later siblings', async () => {
    const source = JSON.stringify({
        requestId: 'REQ-MIXED',
        rows: [{ id: 1, name: '' }, { id: 2, tags: ['中文😀', '', 'last'] }],
        stats: { ok: true, count: 2, optional: null },
    });
    const inputs = new Set();
    for (let seed = 1; seed <= 64; seed++) {
        let state = seed;
        const damaged = damageDelimiters(source, () => {
            state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
            return (state >>> 29) < 3;
        });
        inputs.add(damaged.input);
        await expectOriginal(damaged.input, source);
    }
    assert.equal(inputs.size, 64, 'different seeds must exercise distinct damage patterns');
});

test('all small-object delimiter combinations either restore the original or preserve an already valid document', async () => {
    const source = '{"x":"a","y":1}';
    const { delimiters } = damageDelimiters(source, () => false);
    assert.equal(delimiters, 6);
    // Zero is the already-covered complete transport layer; all bits set is
    // ordinary valid JSON and must use the existing no-repair fast path.
    let validDocuments = 0, repairedDocuments = 0;
    for (let mask = 1; mask < (1 << delimiters) - 1; mask++) {
        const input = damageDelimiters(source, position => Boolean(mask & (1 << position))).input;
        let alreadyValid = false;
        try { JSON.parse(input); alreadyValid = true; } catch (error) { if (!(error instanceof SyntaxError)) throw error; }
        if (alreadyValid) {
            // Some damage patterns form legal keys containing escaped quotes,
            // e.g. one key named x":"a","y. Its actual meaning takes priority
            // over the hypothetical original used by this mutation generator.
            const result = await formatWithOptionalRepair(input, options, true);
            assert.equal(result.repaired, undefined);
            assert.equal(result.formatted, formatJsonInput(input, options).formatted);
            validDocuments++;
        } else {
            await expectOriginal(input, source);
            repairedDocuments++;
        }
    }
    assert(validDocuments > 0);
    assert(repairedDocuments > 0);
    assert.equal(validDocuments + repairedDocuments, 62);
});

test('mixed transport quotes retain all business escapes, nested string types and numeric spelling', async () => {
    const fields = {
        path: 'C:\\temp\\file.json', network: '\\\\server\\share\\',
        literal: '\\u0041\\n\\x41', line: 'first\nsecond\tend',
        quote: '客服说："hello"；} ] // # /* 都是文本 */',
        injection: 'prefix","admin":true,"suffix":"text',
        payload: JSON.stringify({ user: 'Alice', active: true, nested: JSON.stringify({ text: 'a "quote"', path: 'C:\\data\\' }) }),
    };
    const source = '{"id":900719925474099312345,"amount":1.2300,"exponent":1.2300e+20,"repeat":1,"repeat":2,' + JSON.stringify(fields).slice(1);
    const input = damageDelimiters(source, index => index % 3 === 1).input;
    for (const encodingMode of [false, true]) {
        for (const preserveNumberLiterals of [false, true]) {
            for (const arrayNewLine of [false, true]) {
                const result = await expectOriginal(input, source, { ...options, encodingMode, preserveNumberLiterals, arrayNewLine });
                const value = JSON.parse(result.formatted);
                assert.equal(value.path, fields.path);
                assert.equal(value.network, fields.network);
                assert.equal(value.quote, fields.quote);
                assert.equal(value.injection, fields.injection);
                assert.equal(typeof value.payload, 'string');
                assert.equal(value.payload, fields.payload);
                assert.equal(value.admin, undefined);
                if (preserveNumberLiterals) {
                    for (const literal of ['900719925474099312345', '1.2300', '1.2300e+20']) assert(result.formatted.includes(literal));
                }
            }
        }
    }
});

test('encoded pretty-printing and raw layout whitespace do not change string boundaries', async () => {
    const source = JSON.stringify({ rows: [{ name: 'hello', ok: true }], stats: { count: 1 } }, null, 2);
    const damaged = damageDelimiters(source, index => index % 2 === 0).input;
    await expectOriginal(' \r\n' + damaged + '\t ', source);
    await expectOriginal(damaged.replaceAll('\\n', '\n'), source);
});

test('valid documents with business escapes and JSON string roots keep the normal fast path', async () => {
    const source = JSON.stringify({ path: 'C:\\temp\\', payload: JSON.stringify({ message: 'say "hello"', ok: true }) });
    for (const input of [source, JSON.stringify(source), JSON.stringify([source, { ok: true }])]) {
        const stages = [];
        const result = await formatWithOptionalRepair(input, options, true, stage => stages.push(stage));
        assert.equal(result.repaired, undefined);
        assert.equal(result.formatted, formatJsonInput(input, options).formatted);
        assert(!stages.includes('repairing'));
    }
    // The existing nested-string and separator repair must not be intercepted.
    const broken = source.replace(',"payload":', ' "payload":');
    assert.equal((await formatWithOptionalRepair(broken, options, true)).formatted, formatJsonInput(source, options).formatted);
});

test('repair-disabled mode still rejects mixed transport escaping', async () => {
    const stages = [];
    await assert.rejects(formatWithOptionalRepair(userInput, options, false, stage => stages.push(stage)), { name: 'JsonInputParseError' });
    assert.deepEqual(stages, ['parsing']);
});

test('mixed root decoding cannot invent missing values, fix other syntax, or discard suffixes', async () => {
    for (const source of [
        '{"missing":}', '{"ok":true "next":2}', '{"n":1e+}', '{"items":[1,,3]}',
        '{"a":1}{"admin":true}', '{"a":1} "admin":true', '{"a":"unfinished}',
        '{"rows":[{"name":"Alice"}]} "next":2', '{"rows":[{"name":"Alice"}]} trailing',
    ]) {
        const input = damageDelimiters(source, index => index % 2 === 1).input;
        const candidate = repairMixedEscapedRoot(input);
        assert.equal(candidate.text, undefined, source);
        assert.deepEqual(candidate.edits, [], source);
        await assert.rejects(formatWithOptionalRepair(input, options, true), source);
    }
    const repeatedLayer = damageDelimiters(encodeRoot(expected), index => index === 0).input;
    await assert.rejects(formatWithOptionalRepair(repeatedLayer, options, true));
});

test('a missing escape within a business quote cannot be reinterpreted as a structural delimiter', async () => {
    for (const message of ['say "hello"', 'prefix","admin":true,"suffix":"text']) {
        const source = JSON.stringify({ message, stats: { ok: true } });
        const input = damageDelimiters(source, index => index === 1).input.replace(String.raw`\\\"`, String.raw`\\"`);
        const candidate = repairMixedEscapedRoot(input);
        assert.equal(candidate.status, 'unsafe');
        assert.equal(candidate.text, undefined);
        assert.deepEqual(candidate.edits, []);
        await assert.rejects(formatWithOptionalRepair(input, options, true));
    }
    for (const input of [
        String.raw`{\"message\":\"say "hello"\",\"ok":true}`,
        String.raw`{\"message\":\"x\q\",\"ok":true}`,
    ]) await assert.rejects(formatWithOptionalRepair(input, options, true));
});

test('mixed repair budgets reject without exposing partial text or decoded edits', () => {
    for (const limits of [
        { maxEdits: 1 }, { maxWork: userInput.length - 1 }, { maxDurationMs: 0 },
        { maxDepth: 1 }, { maxWork: Number.NaN }, { maxLookahead: -1 },
    ]) {
        const candidate = repairMixedEscapedRoot(userInput, limits);
        assert.equal(candidate.status, 'limit', JSON.stringify(limits));
        assert.equal(candidate.text, undefined);
        assert.deepEqual(candidate.edits, []);
    }
});

test('large opaque business strings remain intact and depth limits still apply', async () => {
    const source = JSON.stringify({ message: '汉字😀\\n'.repeat(16384), stats: { ok: true } });
    await expectOriginal(damageDelimiters(source, index => index === 3).input, source);
    const deep = '{"key":'.repeat(140) + 'true' + '}'.repeat(140);
    const input = damageDelimiters(deep, index => index === 0).input;
    const candidate = repairMixedEscapedRoot(input);
    assert.equal(candidate.status, 'limit');
    await assert.rejects(formatWithOptionalRepair(input, options, true), { name: 'JsonRepairSafetyError' });
});
