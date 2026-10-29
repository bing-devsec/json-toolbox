import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { build } from 'esbuild';

async function bundle(path) {
    const result = await build({ entryPoints: [path], bundle: true, write: false, format: 'esm', platform: 'node' });
    const url = `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`;
    return { url, api: await import(url) };
}

const { url: formatterUrl, api: { JsonPlusFormatter } } = await bundle('src/components/utils/jsonEngine/formatter.ts');
const { api: { preprocessSpecialJsonValues } } = await bundle('src/components/utils/jsonEngine/preprocess.ts');
const createFormatter = (decode = false, arrayNewLine = true) => new JsonPlusFormatter(decode, 2, arrayNewLine, true);
const format = (input, decode = false) => {
    const formatter = createFormatter(decode);
    const parsed = formatter.parseJson5(input);
    return formatter.format(parsed.data, parsed.escapeMap);
};

test('number protection retains exact decimals, exponents and integers across unchanged spans', () => {
    const input = '{"before":1,"decimal":1.2300,"id":9007199254740993,"tiny":1e-30,"after":"keep 1.2300 and 9007199254740993","tail":40.40}';
    const output = format(input);
    assert.equal(output, '{\n  "before": 1,\n  "decimal": 1.2300,\n  "id": 9007199254740993,\n  "tiny": 1e-30,\n  "after": "keep 1.2300 and 9007199254740993",\n  "tail": 40.40\n}');
});

test('numeric candidates inside strings and comments do not change JSON5 values or keys', () => {
    const input = String.raw`{
      // ignored 9007199254740993 and 1.2300
      'id 1.2300': 'text \' 9007199254740993',
      /* ignored 2.50 */
      n: 1,
      tail: 40.40,
    }`;
    assert.deepEqual(JSON.parse(format(input)), { 'id 1.2300': "text \\' 9007199254740993", n: 1, tail: 40.4 });
    assert.match(format(input), /"tail": 40\.40/);
});

test('batched ordinary string spans preserve quote, slash and control escapes', () => {
    const expected = { text: 'prefix "quoted" \\ suffix\nline\tend', path: 'https://example.com/a#b', tail: 40.4 };
    assert.deepEqual(JSON.parse(format(JSON.stringify(expected))), expected);
    for (const newline of ['\n', '\r\n', '\u2028', '\u2029']) {
        const input = '{text:"first\\ \t' + newline + 'second",tail:40.40}';
        assert.deepEqual(JSON.parse(format(input)), { text: 'firstsecond', tail: 40.4 });
    }
});

test('hex and Unicode escape policies remain consistent through chunk boundaries', () => {
    const prefix = '前'.repeat(70_000);
    const input = '{"text":"' + prefix + String.raw`\xE4\xB8\xAD\u6587\q","tail":40.40}`;
    const preserved = format(input);
    assert(preserved.includes(String.raw`\\xE4\\xB8\\xAD\u6587`));
    assert.equal(JSON.parse(preserved).text, prefix + String.raw`\xE4\xB8\xAD` + '文\\q');
    assert.equal(JSON.parse(format(input, true)).text, prefix + '中文\\q');
    assert.match(preserved, /"tail": 40\.40/);
});

test('special-value preprocessing replaces only undefined values and preserves untouched text', () => {
    const input = String.raw`{
      undefined: undefined,
      text: "undefined 1.2300 \\",
      // undefined in a comment
      array: [undefined, "undefined"],
      tail: 40.40
    }`;
    const expected = input.replace('undefined: undefined', 'undefined: null').replace('[undefined,', '[null,');
    assert.equal(preprocessSpecialJsonValues(input), expected);
    assert.deepEqual(JSON.parse(format(input)), { undefined: null, text: 'undefined 1.2300 \\', array: [null, 'undefined'], tail: 40.4 });
    const untouched = '{"undefined": "undefined", "n": 1}';
    assert.equal(preprocessSpecialJsonValues(untouched), untouched);
});

test('large batches of protected numbers keep every literal under both array layouts', () => {
    const literals = Array.from({ length: 24_000 }, (_, i) => i % 3 === 0 ? '1.2300' : i % 3 === 1 ? '9007199254740993' : '1e-30');
    const input = '[' + literals.join(',') + ']';
    for (const arrayNewLine of [false, true]) {
        const formatter = createFormatter(false, arrayNewLine);
        const parsed = formatter.parseJson5(input);
        assert.equal(formatter.compress(parsed.data, parsed.escapeMap), input);
        const output = formatter.format(parsed.data, parsed.escapeMap);
        assert.equal(output.replace(/\s/g, ''), input);
    }
});

test('a decimal after a large string formats within a bounded heap instead of building per-character ropes', () => {
    // This shape triggered full-document preprocessing even though only the final number needed protection.
    // Isolate the heap budget so a regression cannot crash the test runner or require a huge fixture file.
    const source = `
      import assert from 'node:assert/strict';
      import { JsonPlusFormatter } from ${JSON.stringify(formatterUrl)};
      const size = 12 * 1024 * 1024;
      const input = '{"padding":"' + 'a'.repeat(size) + '","tail":40.40}';
      const formatter = new JsonPlusFormatter(false, 2, true, true);
      const parsed = formatter.parseJson5(input);
      const output = formatter.format(parsed.data, parsed.escapeMap);
      assert.equal(JSON.parse(output).padding.length, size);
      assert(output.endsWith('"tail": 40.40\\n}'));
      console.log('large-format-ok');
    `;
    const child = spawnSync(process.execPath, ['--max-old-space-size=192', '--input-type=module'], {
        input: source, encoding: 'utf8', timeout: 20_000, maxBuffer: 64 * 1024,
    });
    assert.ifError(child.error);
    assert.equal(child.status, 0, child.stderr || `child terminated with ${child.signal}`);
    assert.match(child.stdout, /large-format-ok/);
});


test('negative zero survives root, array and object formatting and compression on the native parse path', () => {
    const inputs = ['-0', '[-0,0,-1]', '{"negative":-0,"positive":0,"text":"-0","-0":-0}'];
    for (const preserve of [false,true]) for (const decode of [false,true]) for (const arrayNewLine of [false,true]) {
        const formatter = new JsonPlusFormatter(decode,2,arrayNewLine,preserve);
        for (const input of inputs) {
            const parsed = formatter.parseJson5(input);
            const formatted = formatter.format(parsed.data,parsed.escapeMap);
            const compressed = formatter.compress(parsed.data,parsed.escapeMap);
            assert.equal(compressed,input);
            assert.equal(formatted.replace(/\s/g,''),input);
            assert.deepEqual(JSON.parse(formatted),JSON.parse(input));
        }
    }
});

test('negative zero and existing protected number spellings survive the numeric preprocessing path', () => {
    const input = '{"negative":-0,"positive":0,"decimal":2.0,"trailing":2.0000,"fractionZero":-0.00,"exponentZero":-0E+00,"exponent":1E+003,"id":9007199254740993,"tiny":-1e-400}';
    for (const decode of [false,true]) for (const arrayNewLine of [false,true]) {
        const formatter = createFormatter(decode,arrayNewLine);
        const parsed=formatter.parseJson5(input);
        assert.equal(formatter.compress(parsed.data,parsed.escapeMap),input);
        assert.equal(formatter.format(parsed.data,parsed.escapeMap).replace(/\s/g,''),input);
    }
});

test('programmatic numeric negative zero keeps its sign while zero and non-finite policies remain intact', () => {
    for (const preserve of [false,true]) {
        const formatter = new JsonPlusFormatter(false,2,true,preserve);
        assert.equal(formatter.format(-0,new Map()),'-0');
        assert.equal(formatter.compress(-0,new Map()),'-0');
        assert.equal(formatter.format(0,new Map()),'0');
        assert.equal(formatter.format('-0',new Map()),'"-0"');
        assert.equal(formatter.compress({negative:-0,positive:0,nan:NaN,infinity:Infinity},new Map()),'{"negative":-0,"positive":0,"nan":null,"infinity":null}');
    }
});


for (const encodingMode of [false, true]) {
    for (const syntax of ['strict JSON', 'JSON5']) {
        test(`special JSON property names remain own data properties with encodingMode=${encodingMode} in ${syntax}`, () => {
            const objectPrototypeDescriptors = Object.getOwnPropertyDescriptors(Object.prototype);
            const protoValues = [
                'null',
                'false',
                '0',
                '17',
                '"kept"',
                '{"polluted":"input-only","nested":{"__proto__":"inside-object"}}',
                '[{"__proto__":"inside-array"},null,"kept"]',
            ];
            const assertOwnDataProperties = (value) => {
                if (value === null || typeof value !== 'object') return;
                assert.equal(Object.getPrototypeOf(value), Array.isArray(value) ? Array.prototype : Object.prototype);
                for (const key of Object.keys(value)) {
                    assert.equal(Object.hasOwn(value, key), true);
                    const descriptor = Object.getOwnPropertyDescriptor(value, key);
                    assert.equal(descriptor.enumerable, true);
                    assert.equal(descriptor.configurable, true);
                    assert.equal(descriptor.writable, true);
                    assert.equal(Object.hasOwn(descriptor, 'value'), true);
                    assertOwnDataProperties(value[key]);
                }
            };

            try {
                for (const protoValue of protoValues) {
                    const objectInput = `{"__proto__":${protoValue},"constructor":{"prototype":{"polluted":"constructor-only"}},"prototype":"own-prototype","toString":"own-toString","hasOwnProperty":"own-hasOwnProperty","keep":"ok"}`;
                    for (const strictInput of [objectInput, `[{"nested":${objectInput},"items":[${objectInput}]}]`]) {
                        const input = syntax === 'JSON5'
                            ? '/* JSON5 */ ' + strictInput.replaceAll('"__proto__":', '__proto__:')
                            : strictInput;
                        const expected = JSON.parse(strictInput);
                        const formatter = createFormatter(encodingMode);
                        const parsed = formatter.parseJson5(input);
                        assert.deepEqual(parsed.data, expected);
                        assertOwnDataProperties(parsed.data);
                        for (const output of [formatter.format(parsed.data, parsed.escapeMap), formatter.compress(parsed.data, parsed.escapeMap)]) {
                            const reparsed = JSON.parse(output);
                            assert.deepEqual(reparsed, expected);
                            assertOwnDataProperties(reparsed);
                        }
                    }
                }
            } finally {
                assert.deepEqual(Object.getOwnPropertyDescriptors(Object.prototype), objectPrototypeDescriptors);
            }
        });
    }
}
