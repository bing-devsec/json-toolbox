import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { build } from 'esbuild';
import { goConversionCases } from './fixtures/jsonGoCases.mjs';

const bundled = await build({
    stdin: { contents: `
        export * from './src/components/utils/jsonConvert';
        export { parseJsonInput } from './src/components/utils/jsonEngine/service';
        export { prepareHighPrecisionConversion } from './src/components/utils/jsonEngine/numberLiteral';
    `, resolveDir: process.cwd(), loader: 'ts' },
    bundle: true, platform: 'node', format: 'esm', write: false,
});
const api = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);
const options = { indentSize: 2, arrayNewLine: true, preserveNumberLiterals: true, encodingMode: true };
const convert = (input) => api.convertToGo(api.parseJsonInput(input, options).data);
const outputFor = (id) => convert(goConversionCases.find((sample) => sample.id === id).input);

test('Go receives number literals without treating precision sentinels as strings', () => {
    assert.match(outputFor('29'), /ID int64/);
    assert.match(outputFor('30'), /ID uint64/);
    for (const id of ['31', '32', '33']) assert.match(outputFor(id), /Value float64/);
    assert.match(outputFor('34'), /import "encoding\/json"/);
    assert.match(outputFor('34'), /Value json\.Number/);
    assert.match(outputFor('56'), /type Root = json\.Number/);
    assert.match(outputFor('52'), /\[\]json\.RawMessage/);
});

test('recursive trees share one definition and directly recursive objects use pointers', () => {
    const tree = outputFor('03');
    assert.equal((tree.match(/struct \{/g) || []).length, 1);
    assert.match(tree, /Children \[\]Root/);
    assert.match(outputFor('26'), /Node \*Node/);
    assert.equal((outputFor('62').match(/struct \{/g) || []).length, 1);
});

test('optional and nullable fields preserve present zero values and explicit null', () => {
    assert.match(outputFor('05'), /Name \*string `json:"name,omitempty"`/);
    assert.match(outputFor('08'), /Name \*string `json:"name"`/);
    assert.match(outputFor('07'), /Values \[\]\*int/);
    assert.match(outputFor('47'), /Value json\.RawMessage `json:"value,omitempty"`/);
    assert.match(outputFor('48'), /Enabled \*bool `json:"enabled,omitempty"`/);
    assert.match(outputFor('48'), /Values \*\[\]any `json:"values,omitempty"`/);
});

test('schema names are scoped to their position and dictionary evidence is conservative', () => {
    const branches = outputFor('61');
    assert.match(branches, /Zip int/);
    assert.match(branches, /Zip string/);
    assert.doesNotMatch(branches, /Zip any/);
    assert.match(branches, /type Root struct/);
    assert.match(outputFor('14'), /type Root map\[string\]/);
    assert.match(outputFor('66'), /type Root map\[string\]/);
    for (const id of ['28', '63']) {
        const output = outputFor(id);
        for (const name of ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'ID', 'Name']) assert.match(output, new RegExp(`    ${name} \\*`));
    }
});

test('unrepresentable JSON tags use maps and legitimate user strings are untouched', () => {
    for (const id of ['21', '22', '23', '24', '43', '44', '45', '46']) assert.match(outputFor(id), /type Root map\[string\]/);
    const collisions = outputFor('60');
    assert.match(collisions, /UserID3 int/);
    assert.match(collisions, /UserID2 int/);
    assert.match(outputFor('58'), /__HPN_START_7f3a9c__123__HPN_END_7f3a9c__/);
    assert.match(outputFor('59'), /Payload string/);
});

test('other converters retain their existing number and encoding path', async () => {
    const parsed = api.parseJsonInput('{"id":9223372036854775807,"text":"\\u4e2d\\u6587","enabled":true}', options).data;
    const prepared = api.prepareHighPrecisionConversion(parsed);
    const unwrapped = prepared.data;
    assert.match(prepared.restoreOutput(await api.convertToYAML(unwrapped)), /id: 9223372036854775807/);
    assert.match(prepared.restoreOutput(await api.convertToTOML(unwrapped)), /id = 9223372036854775807/);
    assert.match(prepared.restoreOutput(await api.convertToXML(unwrapped)), /<text>中文<\/text>/);
    assert.match(api.convertToTypeScript({ id: 1, name: 'Alice', enabled: true }), /id: number/);
    assert.deepEqual(JSON.parse(api.cookieToJSON('session=test; theme=dark')), { session: 'test', theme: 'dark' });
});

test('generated Go compiles, passes vet, and preserves all 68 JSON samples', { timeout: 180000 }, async (t) => {
    const version = spawnSync('go', ['version'], { encoding: 'utf8' });
    if (version.error?.code === 'ENOENT') { t.skip('Go toolchain is unavailable; run this integration check where Go is installed.'); return; }
    assert.equal(version.status, 0, version.stderr);
    const temporary = await mkdtemp(path.join(os.tmpdir(), 'json-go-regression-'));
    t.after(() => rm(temporary, { recursive: true, force: true }));
    const validator = await readFile(new URL('./fixtures/jsonGoValidator.go.txt', import.meta.url), 'utf8');
    const env = { ...process.env, GOCACHE: path.join(os.tmpdir(), 'json-go-audit-cache'), GOPATH: path.join(os.tmpdir(), 'json-go-audit-path'), GO111MODULE: 'off', GOTOOLCHAIN: 'local' };
    const run = (command, args, cwd) => new Promise((resolve, reject) => {
        const process = spawn(command, args, { cwd, env });
        let stdout = '', stderr = '';
        const timer = setTimeout(() => { process.kill('SIGKILL'); reject(new Error(`Timed out: ${command}`)); }, 30000);
        process.stdout.on('data', (data) => stdout += data);
        process.stderr.on('data', (data) => stderr += data);
        process.on('error', (error) => { clearTimeout(timer); reject(error); });
        process.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    });
    let next = 0;
    const worker = async () => {
        while (next < goConversionCases.length) {
            const sample = goConversionCases[next++];
            const dir = path.join(temporary, sample.id);
            await mkdir(dir);
            await Promise.all([
                writeFile(path.join(dir, 'input.json'), sample.standard || sample.input),
                writeFile(path.join(dir, 'generated.go'), `package main\n\n${convert(sample.input)}\n`),
                writeFile(path.join(dir, 'validator.go'), validator),
            ]);
            const message = `${sample.id}: ${sample.name}`;
            const compilation = await run('go', ['build', '-o', 'validate', 'generated.go', 'validator.go'], dir);
            assert.equal(compilation.code, 0, `${message}\n${compilation.stderr}`);
            const vet = await run('go', ['vet', 'generated.go'], dir);
            assert.equal(vet.code, 0, `${message}\n${vet.stderr}`);
            const execution = await run(path.join(dir, 'validate'), [], dir);
            assert.equal(execution.code, 0, `${message}\n${execution.stderr}`);
            const validation = JSON.parse(execution.stdout);
            assert.equal(validation.unmarshalError, undefined, `${message}\n${validation.unmarshalError}`);
            assert.equal(validation.marshalError, undefined, `${message}\n${validation.marshalError}`);
            assert.deepEqual(validation.roundTripDifferences, [], `${message}\n${JSON.stringify(validation.roundTripDifferences)}`);
        }
    };
    await Promise.all([worker(), worker(), worker()]);
});
