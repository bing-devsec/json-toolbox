import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const options = Object.freeze({ indentSize: 2, arrayNewLine: true, preserveNumberLiterals: true, encodingMode: false });

export async function bundleModule(path) {
    const built = await build({ entryPoints: [resolve(projectRoot, path)], absWorkingDir: projectRoot, bundle: true, write: false, format: 'esm', platform: 'node', logLevel: 'silent' });
    const source = built.outputFiles[0].text + '\n//# sourceURL=' + pathToFileURL(resolve(projectRoot, path)).href + '?context-repair-bundle\n';
    return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
}

// The original document is known before damage. Only definite structural separators
// or inner quote escapes are removed; ordinary text is never assigned a guessed value.
export function createMutationCases(seed = 0x51a7c0de, count = 48) {
    let state = seed >>> 0;
    const next = () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return state >>> 0; };
    const cases = [];
    for (let index = 0; index < count; index++) {
        const number = next() % 100000;
        const inner = JSON.stringify({ id: number, name: index % 2 ? '数码' : 'Alice', active: index % 3 === 0, child: { qty: index + 1 }, tags: ['首单', 'JSON'] });
        const original = JSON.stringify({ requestId: `REQ-${number}`, payload: inner, stats: { ok: true, count: index } });
        const token = JSON.stringify(inner);
        const escaped = [];
        for (let offset = 0; offset < token.length - 1; offset++) {
            if (token[offset] === '\\' && token[offset + 1] === '"') { escaped.push(offset); offset++; }
        }
        const position = escaped[next() % escaped.length];
        const single = token.slice(0, position) + token.slice(position + 1);
        cases.push({ id: `seed-${seed}-single-${index}`, category: 'seeded-single-escape', outcome: 'repair', input: original.replace(token, single), expected: original });
        // No business backslash appears in these inner documents, so removing all
        // inner quote escapes has one independently known lexical restoration.
        const multiple = original.replace(token, '"' + inner + '"').replace(',"stats":', ' "stats":');
        cases.push({ id: `seed-${seed}-multiple-${index}`, category: 'seeded-combined-errors', outcome: 'repair', input: multiple, expected: original });
        const plain = JSON.stringify({ id: number, label: `row-${index}`, rows: [{ qty: 1 }, { qty: 2 }], stats: { ok: true } });
        cases.push({ id: `seed-${seed}-separators-${index}`, category: 'seeded-separators', outcome: 'repair', input: plain.replace(',"label":', ' "label":').replace(',"rows":', ' "rows":').replace(',"stats":', ' "stats":'), expected: plain });
    }
    return cases;
}

export function createBusinessEscapeCases(count = 16) {
    return Array.from({ length: count }, (_, index) => {
        const inner = JSON.stringify({
            id: index,
            quote: '客服说："hello"；} ] 不是结构；// # /* text */',
            path: 'C:\\temp\\' + index + '\\',
            network: '\\\\server\\share\\',
            literal: '\\u0041\\n\\x41',
            child: JSON.stringify({ index, enabled: index % 2 === 0, items: ['首单', '{ordinary text}'] }),
        }, null, index % 2 ? 2 : undefined);
        const original = JSON.stringify({ requestId: `REQ-${index}`, payload: inner, stats: { ok: true, index } });
        const token = JSON.stringify(inner);
        const escape = token.indexOf('\\"');
        if (escape < 1) throw new Error('Business escape fixture must contain an inner quotation mark');
        const damagedToken = token.slice(0, escape) + token.slice(escape + 1);
        return { id: `business-escapes-${index}`, category: 'business-escapes-and-outer-error', outcome: 'repair',
            input: original.replace(token, damagedToken).replace(',"stats":', ' "stats":'), expected: original };
    });
}

export async function loadCorpus({ mutations = true, legacyFixtures = true } = {}) {
    const focused = JSON.parse(await readFile(resolve(projectRoot, 'tests/fixtures/jsonContextRepairCases.json'), 'utf8'));
    const legacy = legacyFixtures ? JSON.parse(await readFile(resolve(projectRoot, 'tests/fixtures/jsonRepairCases.json'), 'utf8')).map((sample, index) => ({
        id: `legacy-${index + 1}-${sample.name}`, category: 'existing-fixtures', input: sample.input,
        outcome: sample.expected == null ? 'reject' : 'repair', ...(sample.expected == null ? {} : { expected: sample.expected }),
    })) : [];
    return [...legacy, ...focused, ...(mutations ? [...createMutationCases(), ...createBusinessEscapeCases()] : [])];
}

function checkSourceFidelity(sample, result) {
    if (sample.id === 'duplicate-keys-remain-in-repaired-source') {
        return typeof result.repaired === 'string' && (result.repaired.match(/"id"\s*:/g) || []).length === 2;
    }
    return true;
}

export async function evaluateEngine(engine, corpus, formatJsonInput) {
    const rows = [];
    for (const sample of corpus) {
        const start = performance.now();
        try {
            const result = await engine(sample.input, options, true);
            const rejectionExpected = sample.outcome === 'unsafe' || sample.outcome === 'reject';
            const expected = rejectionExpected ? undefined : formatJsonInput(sample.expected, options).formatted;
            const correct = !rejectionExpected && result.formatted === expected && checkSourceFidelity(sample, result)
                && (sample.outcome !== 'unchanged' || result.repaired === undefined);
            rows.push({ id: sample.id, category: sample.category, expectation: sample.outcome, outcome: correct ? 'correct' : 'misrepair', milliseconds: +(performance.now() - start).toFixed(3),
                ...(!correct ? { actual: result.formatted.slice(0, 600), ...(expected ? { expected: expected.slice(0, 600) } : {}) } : {}) });
        } catch (error) {
            const rejectionExpected = sample.outcome === 'unsafe' || sample.outcome === 'reject';
            rows.push({ id: sample.id, category: sample.category, expectation: sample.outcome, outcome: rejectionExpected ? 'correct-rejection' : 'error', milliseconds: +(performance.now() - start).toFixed(3), error: String(error?.message || error).slice(0, 400) });
        }
    }
    const counts = { total: rows.length, correct: 0, correctRejections: 0, errors: 0, misrepairs: 0, milliseconds: 0 };
    for (const row of rows) {
        counts[row.outcome === 'correct' ? 'correct' : row.outcome === 'correct-rejection' ? 'correctRejections' : row.outcome === 'error' ? 'errors' : 'misrepairs']++;
        counts.milliseconds += row.milliseconds;
    }
    counts.milliseconds = +counts.milliseconds.toFixed(3);
    return { ...counts, knownExpectedAccuracy: +((counts.correct + counts.correctRejections) / rows.length * 100).toFixed(2),
        errorRate: +(counts.errors / rows.length * 100).toFixed(2), misrepairRate: +(counts.misrepairs / rows.length * 100).toFixed(2), rows };
}

function makeLargeInput(count) {
    const chunks = ['{\n"rows":[\n'];
    let chunk = '';
    for (let id = 0; id < count; id++) {
        chunk += `${id ? ',\n' : ''}{"id":${id},"name":"demo-${id}","amount":1.2300}`;
        if (chunk.length >= 65536) { chunks.push(chunk); chunk = ''; }
    }
    chunks.push(chunk, '\n],"stats":{"count":' + count + '}}');
    return chunks.join('');
}

async function main() {
    const args = process.argv.slice(2);
    const baselineOnly = args.includes('--baseline-only');
    const noMutations = args.includes('--no-mutations');
    const jsonIndex = args.indexOf('--json');
    if (jsonIndex >= 0 && !args[jsonIndex + 1]) throw new Error('--json requires an output path');
    const corpus = await loadCorpus({ mutations: !noMutations });
    const { formatJsonInput } = await bundleModule('src/components/utils/jsonEngine/service.ts');
    const legacy = await bundleModule('src/components/utils/legacyJsonRepair.ts');
    const engines = [['legacy', legacy.formatWithOptionalRepair]];
    if (!baselineOnly) engines.push(['contextual', (await bundleModule('src/components/utils/jsonRepair.ts')).formatWithOptionalRepair]);
    const report = { scope: 'Node integration: complete formatting output and original text fidelity; timing is not browser UI or peak memory. Expected-value tests are a bounded regression corpus, not a claim about all malformed JSON.', seed: '0x51a7c0de', engines: {} };
    for (const [name, engine] of engines) report.engines[name] = await evaluateEngine(engine, corpus, formatJsonInput);
    const largeArg = args.find(arg => arg === '--large' || arg.startsWith('--large='));
    if (largeArg) {
        const count = largeArg.includes('=') ? Number(largeArg.split('=')[1]) : 1000000;
        if (!Number.isSafeInteger(count) || count < 1 || count > 3000000) throw new Error('--large count must be between 1 and 3000000');
        const input = makeLargeInput(count);
        report.large = { rows: count, inputBytes: Buffer.byteLength(input), cases: [] };
        let referenceHash;
        for (const [name, engine] of engines) {
            for (const damaged of [false, true]) {
                const start = performance.now();
                try {
                    const result = await engine(damaged ? input.slice(0, -1) : input, options, true);
                    const outputSha256 = createHash('sha256').update(result.formatted).digest('hex');
                    referenceHash ??= outputSha256;
                    report.large.cases.push({ engine: name, damaged, milliseconds: +(performance.now() - start).toFixed(3), formattedLength: result.formatted.length, repaired: result.repaired !== undefined, outputSha256, matchesReference: outputSha256 === referenceHash });
                } catch (error) {
                    report.large.cases.push({ engine: name, damaged, milliseconds: +(performance.now() - start).toFixed(3), error: String(error?.message || error) });
                }
            }
        }
    }
    const summaries = Object.fromEntries(Object.entries(report.engines).map(([name, result]) => [name, Object.fromEntries(Object.entries(result).filter(([key]) => key !== 'rows'))]));
    console.log(JSON.stringify({ ...report, engines: summaries }, null, 2));
    if (jsonIndex >= 0) await writeFile(resolve(args[jsonIndex + 1]), JSON.stringify(report, null, 2) + '\n');
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
    main().catch(error => { console.error(error); process.exitCode = 1; });
}
