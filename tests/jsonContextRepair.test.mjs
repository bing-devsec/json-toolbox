import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { bundleModule, createMutationCases, createBusinessEscapeCases, options } from '../scripts/compare-json-repair.mjs';

const { formatWithOptionalRepair } = await bundleModule('src/components/utils/jsonRepair.ts');
const { formatJsonInput } = await bundleModule('src/components/utils/jsonEngine/service.ts');
const { repairJsonWithContext } = await bundleModule('src/components/utils/contextualRepair/parser.ts');
const { applyRepairEdits } = await bundleModule('src/components/utils/contextualRepair/edits.ts');
const fixtures = JSON.parse(await readFile(new URL('./fixtures/jsonContextRepairCases.json', import.meta.url), 'utf8'));

for (const sample of fixtures) {
    test(`context repair integration: ${sample.id}`, async () => {
        if (sample.outcome === 'unsafe' || sample.outcome === 'reject') {
            await assert.rejects(formatWithOptionalRepair(sample.input, options, true), sample.id);
            const candidate = repairJsonWithContext(sample.input);
            if (sample.outcome === 'unsafe') assert.equal(candidate.status, 'unsafe', sample.id);
            assert(!['repaired', 'unchanged'].includes(candidate.status), sample.id);
            assert.deepEqual(candidate.edits, [], 'a rejected candidate cannot expose partial edits');
            assert(candidate.text === undefined || candidate.text === sample.input, 'rejection cannot expose partially repaired text');
            return;
        }
        const stages = [];
        const result = await formatWithOptionalRepair(sample.input, options, true, stage => stages.push(stage));
        const expected = formatJsonInput(sample.expected, options).formatted;
        assert.equal(result.formatted, expected, 'the complete values, hierarchy, literals and string contents must match the independently known original');
        assert.deepEqual(JSON.parse(result.formatted), JSON.parse(expected));
        if (sample.outcome === 'unchanged') {
            assert.equal(result.repaired, undefined);
            assert(!stages.includes('repairing'));
        } else {
            assert.notEqual(result.repaired, undefined);
            assert(stages.includes('repairing'));
            await assert.rejects(formatWithOptionalRepair(sample.input, options, false), { name: 'JsonInputParseError' });
        }
    });
}

test('context parser publishes replayable original-offset edits for supported unambiguous documents', () => {
    for (const sample of fixtures.filter(x => x.outcome === 'repair')) {
        const candidate = repairJsonWithContext(sample.input);
        // Compatibility-only syntaxes may deliberately stay on the legacy fallback.
        if (candidate.status === 'unsupported') continue;
        assert.equal(candidate.status, 'repaired', sample.id);
        assert(candidate.edits.length > 0, sample.id);
        assert.equal(applyRepairEdits(sample.input, candidate.edits), candidate.text, sample.id);
        assert.equal(formatJsonInput(candidate.text, options).formatted, formatJsonInput(sample.expected, options).formatted, sample.id);
        for (const edit of candidate.edits) {
            assert(Number.isInteger(edit.start) && Number.isInteger(edit.end));
            assert(edit.start >= 0 && edit.start <= edit.end && edit.end <= sample.input.length);
            assert.equal(typeof edit.text, 'string');
            assert.equal(typeof edit.reason, 'string');
            assert(['syntax', 'inferred'].includes(edit.risk));
        }
    }
});

test('repair edits retain duplicate keys before existing formatter semantics are applied', async () => {
    const sample = fixtures.find(x => x.id === 'duplicate-keys-remain-in-repaired-source');
    const result = await formatWithOptionalRepair(sample.input, options, true);
    assert.equal((result.repaired.match(/"id"\s*:/g) || []).length, 2);
    assert.equal(result.repaired.replace(/\s/g, ''), sample.expected);
});

test('context repairs preserve inner JSON lexical whitespace, numeric literals and duplicate keys', async () => {
    for (const id of ['embedded-lexical-whitespace-and-duplicate-keys', 'nested-encoded-string-stays-a-string']) {
        const sample = fixtures.find(x => x.id === id);
        const result = await formatWithOptionalRepair(sample.input, options, true);
        const expected = JSON.parse(formatJsonInput(sample.expected, options).formatted);
        assert.equal(JSON.parse(result.formatted).payload, expected.payload, id);
    }
});

const mutations = createMutationCases();
test('fixed-seed mutation generation is reproducible', () => {
    assert.deepEqual(createMutationCases(), mutations);
    assert.equal(mutations.length, 144);
});
for (const sample of mutations) {
    test(`context mutation: ${sample.id}`, async () => {
        const result = await formatWithOptionalRepair(sample.input, options, true);
        const expected = JSON.parse(sample.expected);
        const data = JSON.parse(result.formatted);
        assert.equal(result.formatted, formatJsonInput(sample.expected, options).formatted, sample.id);
        assert.deepEqual(data, expected, sample.id);
        if (Object.hasOwn(expected, 'payload')) {
            assert.equal(typeof data.payload, 'string', sample.id);
            assert.equal(data.payload, expected.payload, sample.id);
            assert.deepEqual(data.stats, expected.stats, sample.id);
        }
    });
}

test('complex legal inputs and JSON5 values retain the ordinary formatter for every option combination', async () => {
    for (const sample of fixtures.filter(x => x.outcome === 'unchanged')) {
        for (const encodingMode of [false, true]) {
            for (const preserveNumberLiterals of [false, true]) {
                const selected = { ...options, encodingMode, preserveNumberLiterals };
                const stages = [];
                const result = await formatWithOptionalRepair(sample.input, selected, true, stage => stages.push(stage));
                assert.equal(result.repaired, undefined, sample.id);
                assert.equal(result.formatted, formatJsonInput(sample.input, selected).formatted, sample.id);
                assert(!stages.includes('repairing'), sample.id);
            }
        }
    }
});

test('unsafe tokens inside quoted strings or comments do not trigger whole-document rejection', async () => {
    for (const text of ['[1,,3]', '{"missing":}', '1e+', '｛bad：［1，，3］｝', '"a":,"stats":1']) {
        const original = JSON.stringify({ text, next: 1 });
        const broken = original.replace(',"next":', ' "next":');
        const result = await formatWithOptionalRepair(broken, options, true);
        assert.deepEqual(JSON.parse(result.formatted), { text, next: 1 });
    }
    const input = '{/* [1,,3] {"missing":} 1e+ */"ok":1 "next":2}';
    assert.deepEqual(JSON.parse((await formatWithOptionalRepair(input, options, true)).formatted), { ok: 1, next: 2 });
});

test('parser depth, work, edit and duration limits discard every partial repair', () => {
    for (const [input, limits] of [
        ['{"a":{"b":{"c":1}}}', { maxDepth: 2 }],
        ['{"a":1 "b":2 "c":3}', { maxEdits: 1 }],
        ['{"a":1 "b":2}', { maxWork: 1 }],
        ['{"a":1 "b":2}', { maxDurationMs: 0 }],
    ]) {
        const candidate = repairJsonWithContext(input, limits);
        assert.equal(candidate.status, 'limit', JSON.stringify(limits));
        assert.deepEqual(candidate.edits, []);
        assert(candidate.text === undefined || candidate.text === input);
    }
});

test('source edits use UTF-16 offsets without modifying supplementary Unicode text', () => {
    const input = '{"name":"数码😀" "next":1}';
    const candidate = repairJsonWithContext(input);
    assert.equal(candidate.status, 'repaired');
    assert.equal(applyRepairEdits(input, candidate.edits), '{"name":"数码😀", "next":1}');
    assert.deepEqual(JSON.parse(candidate.text), { name: '数码😀', next: 1 });
});

test('applying source edits rejects overlap and out-of-range positions', () => {
    const make = (start, end, text) => ({ start, end, text, reason: 'test', risk: 'syntax' });
    assert.equal(applyRepairEdits('abc', [make(1, 1, ':'), make(1, 1, ',')]), 'a:,bc');
    for (const edits of [[make(0, 2, 'x'), make(1, 3, 'y')], [make(-1, 0, '')], [make(0, 4, '')], [make(2, 1, '')]]) {
        assert.throws(() => applyRepairEdits('abc', edits), RangeError);
    }
});

test('an unrelated missing separator never rewrites valid embedded JSON, punctuation or business escapes', async () => {
    const samples = [
        '{ "id" : 900719925474099312345, "id":2, "name":"数码  " }',
        'prefix {"a":1} suffix',
        '[]{} : , // # /* business text */',
        '正文，冒号：括号｛｝［］；“引号” ‘单引号’',
        'C:\\logs\\\\server\\share\\u0041\\n\\x41',
        'before\n}\n]\n"stats":true\nafter',
        '```json\n{"keep":true}\n```',
    ];
    for (const text of samples) {
        const expected = JSON.stringify({ text, nested: { payload: JSON.stringify({ text, ok: true }) }, stats: { ok: true } });
        const input = expected.replace(',"stats":', ' "stats":');
        const result = await formatWithOptionalRepair(input, options, true);
        assert.equal(result.formatted, formatJsonInput(expected, options).formatted, text);
        assert.deepEqual(JSON.parse(result.formatted), JSON.parse(expected), text);
    }
});

for (const sample of createBusinessEscapeCases()) {
    test(`combined repair preserves business escapes and nested encoded values: ${sample.id}`, async () => {
        const result = await formatWithOptionalRepair(sample.input, options, true);
        assert.equal(result.formatted, formatJsonInput(sample.expected, options).formatted);
        assert.deepEqual(JSON.parse(result.formatted), JSON.parse(sample.expected));
        assert.equal(JSON.parse(result.formatted).payload, JSON.parse(sample.expected).payload);
    });
}

// Run adversarial numeric tokens in a bounded child: a backtracking regression
// must fail this test rather than hang the test runner or the user's Worker.
test('long incomplete numeric tokens cannot bypass the work and time budget through regex backtracking', () => {
    const source = `
        import { bundleModule } from './scripts/compare-json-repair.mjs';
        const { repairJsonWithContext } = await bundleModule('src/components/utils/contextualRepair/parser.ts');
        for (const tail of ['e+', 'x']) {
            const candidate = repairJsonWithContext('{"n":' + '9'.repeat(200000) + tail + '}');
            if (candidate.status !== 'unsafe') throw new Error('Expected refusal, got ' + candidate.status);
        }
        console.log('numeric-budget-ok');
    `;
    const child = spawnSync(process.execPath, ['--input-type=module'], {
        input: source, encoding: 'utf8', timeout: 5000, maxBuffer: 64 * 1024,
    });
    assert.ifError(child.error);
    assert.equal(child.status, 0, child.stderr || `child terminated with ${child.signal}`);
    assert.match(child.stdout, /numeric-budget-ok/);
});
