import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { load as loadYaml } from 'js-yaml';

const built = await build({
    stdin: { contents: `
        export { convertToYAML, convertToXML, convertToTOML } from './src/components/utils/jsonConvert';
        export { parseJsonInput, formatJsonInput } from './src/components/utils/jsonEngine/service';
        export { prepareHighPrecisionConversion } from './src/components/utils/jsonEngine/numberLiteral';
    `, resolveDir: process.cwd(), loader: 'ts' },
    bundle: true, platform: 'node', format: 'esm', write: false,
});
const api = await import('data:text/javascript;base64,' + Buffer.from(built.outputFiles[0].text).toString('base64'));
const options = { indentSize: 2, arrayNewLine: true, preserveNumberLiterals: true, encodingMode: true };
const prepare = input => api.prepareHighPrecisionConversion(api.parseJsonInput(input, options).data);
const convert = async (input, format = 'YAML') => {
    const prepared = prepare(input);
    return prepared.restoreOutput(await api[`convertTo${format}`](prepared.data));
};
const oldMarker = '__HPN_START_7f3a9c__123__HPN_END_7f3a9c__';

test('normal strings resembling old number markers stay strings at root, nested and array positions', async () => {
    for (const data of [oldMarker, [oldMarker, 'prefix ' + oldMarker + ' suffix'], { text: oldMarker, nested: { text: 'prefix ' + oldMarker + ' suffix' } }]) {
        assert.deepEqual(loadYaml(await convert(JSON.stringify(data))), data);
    }
});

test('user marker text and keys coexist with real precision-sensitive numbers', async () => {
    const input = `{"text":${JSON.stringify(oldMarker)},"${oldMarker}":"keep","id":9223372036854775807,"decimal":2.00,"exponent":1e400,"tiny":1e-1000}`;
    const output = await convert(input);
    const data = loadYaml(output);
    assert.equal(data.text, oldMarker); assert.equal(data[oldMarker], 'keep');
    for (const literal of ['9223372036854775807', '2.00', '1e400', '1e-1000']) assert.ok(output.includes(': ' + literal), literal);
    assert.doesNotMatch(output, /__JSON_TOOL_NUM@/);
});

test('even text identical to the next generated marker is reserved, including mapping keys', async () => {
    const probe = prepare('{"id":9223372036854775807}');
    const [, sequence] = probe.data.id.match(/^__JSON_TOOL_NUM@(\d+)_\d+__$/);
    const conflicting = `__JSON_TOOL_NUM@${Number(sequence) + 1}_0__`;
    const input = `{"text":${JSON.stringify(conflicting)},"${conflicting}":"field","id":9223372036854775807}`;
    const prepared = prepare(input);
    assert.notEqual(prepared.data.id, conflicting);
    const output = prepared.restoreOutput(await api.convertToYAML(prepared.data));
    const restored = loadYaml(output);
    assert.equal(restored.text, conflicting); assert.equal(restored[conflicting], 'field');
    assert.match(output, /id: 9223372036854775807/);
});

test('number restoration is isolated per conversion and does not restore foreign or unknown tokens', async () => {
    const first = prepare('{"id":9223372036854775807}');
    const second = prepare('{"id":9223372036854775808}');
    const [firstOutput, secondOutput] = await Promise.all([api.convertToYAML(first.data), api.convertToYAML(second.data)]);
    assert.notEqual(first.data.id, second.data.id);
    assert.equal(first.restoreOutput(secondOutput), secondOutput);
    assert.equal(second.restoreOutput(firstOutput), firstOutput);
    assert.equal(first.restoreOutput('"__JSON_TOOL_NUM@999999999_99__"'), '"__JSON_TOOL_NUM@999999999_99__"');
    assert.match(first.restoreOutput(firstOutput), /9223372036854775807/);
    assert.match(second.restoreOutput(secondOutput), /9223372036854775808/);
});

test('multiline strings containing YAML-looking syntax or numeric markers preserve all content', async () => {
    const data = { text: 'name: Alice\n# not a YAML comment\n' + oldMarker + '\n__JSON_TOOL_NUM@0_0__\n', nested: ['first\nsecond'] };
    const input = JSON.stringify(data).replace(/}$/, ',"id":9223372036854775807}');
    const output = await convert(input);
    const restored = loadYaml(output);
    assert.equal(restored.text, data.text); assert.deepEqual(restored.nested, data.nested);
    assert.match(output, /text: \|/);
});

test('TOML and XML restoration also leave original marker strings untouched', async () => {
    const input = `{"text":${JSON.stringify(oldMarker)},"id":9223372036854775807,"decimal":2.00}`;
    const toml = await convert(input, 'TOML');
    assert.ok(toml.includes(`text = "${oldMarker}"`));
    assert.match(toml, /id = 9223372036854775807/); assert.match(toml, /decimal = 2\.00/);
    const xml = await convert(input, 'XML');
    assert.ok(xml.includes(`<text>${oldMarker}</text>`));
    assert.match(xml, /<id>9223372036854775807<\/id>/); assert.match(xml, /<decimal>2\.00<\/decimal>/);
});

test('special JSON keys survive parse, conversion copying and YAML round-trip as own properties', async () => {
    const input = '{"__proto__":{"enabled":true},"constructor":"c","prototype":"p","hasOwnProperty":"h","nested":[{"__proto__":null,"id":1}]}';
    const expected = JSON.parse(input);
    const prepared = prepare(input);
    assert.deepEqual(prepared.data, expected);
    assert.equal(Object.getPrototypeOf(prepared.data), Object.prototype);
    assert.equal(Object.hasOwn(prepared.data, '__proto__'), true);
    assert.equal(Object.hasOwn(prepared.data.nested[0], '__proto__'), true);
    assert.deepEqual(loadYaml(prepared.restoreOutput(await api.convertToYAML(prepared.data))), expected);
    assert.equal(Object.prototype.enabled, undefined);
});

test('special keys with precision-sensitive values also survive TOML and XML conversion', async () => {
    const input = '{"__proto__":9223372036854775807,"constructor":"ordinary","nested":{"__proto__":"keep"}}';
    assert.match(await convert(input), /__proto__: 9223372036854775807/);
    assert.match(await convert(input, 'TOML'), /__proto__ = 9223372036854775807/);
    assert.match(await convert(input, 'XML'), /<__proto__>9223372036854775807<\/__proto__>/);
});

test('unsupported values cause YAML conversion failure instead of a partially missing document', async () => {
    for (const value of [{ keep: 1, unsupported: () => 1 }, [1, Symbol('unsupported')]]) {
        await assert.rejects(api.convertToYAML(value), error => error.code === 'CONVERT_YAML_FAILED');
    }
});

test('YAML multiline blocks preserve leading/trailing newlines and indentation', async () => {
    for (const text of ['first\nsecond', 'first\nsecond\n', 'first\nsecond\n\n', '\nfirst\nsecond', '  first\nsecond', '\n', '\n\n', '  \n']) {
        assert.equal(loadYaml(await api.convertToYAML(text)), text, 'root ' + JSON.stringify(text));
        for (const value of [{ text }, [text], { nested: { text } }]) assert.deepEqual(loadYaml(await api.convertToYAML(value)), value);
    }
});

test('XML continues showing visible escapes while YAML uses multiline blocks', async () => {
    const input = String.raw`{"expectedYaml":"name: Alice\nage: 30"}`;
    assert.equal(await convert(input), 'expectedYaml: |-\n  name: Alice\n  age: 30\n');
    assert.ok((await convert(input, 'XML')).includes('<expectedYaml>name: Alice\\nage: 30</expectedYaml>'));
});
