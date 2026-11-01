import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { runInNewContext } from 'node:vm';
import { load as loadYaml } from 'js-yaml';

const built = await build({
    stdin: { contents: `
        export { convertToYAML, convertToXML, convertToTOML } from './src/components/utils/jsonConvert';
        export { parseJsonInput } from './src/components/utils/jsonEngine/service';
        export { prepareHighPrecisionConversion } from './src/components/utils/jsonEngine/numberLiteral';
        export { useMonacoLanguageRegistry } from './src/components/composables/useMonacoLanguageRegistry';
        export { captures } from 'monaco-editor/esm/vs/editor/editor.api';
    `, resolveDir: process.cwd(), loader: 'ts' },
    bundle: true, platform: 'node', format: 'cjs', write: false,
    plugins: [{ name: 'capture-editor-registration', setup(build) {
        build.onResolve({ filter: /^monaco-editor\/esm\/vs\/editor\/editor\.api$/ }, () => ({ path: 'editor', namespace: 'capture' }));
        build.onResolve({ filter: /\?worker$/ }, () => ({ path: 'worker', namespace: 'capture' }));
        build.onResolve({ filter: /monacoRuntime$/ }, () => ({ path: 'runtime', namespace: 'capture' }));
        build.onResolve({ filter: /^vue$/ }, () => ({ path: 'vue', namespace: 'capture' }));
        build.onResolve({ filter: /^monaco-editor\/esm\/vs\/basic-languages\// }, args => ({ path: args.path, external: true }));
        build.onLoad({ filter: /.*/, namespace: 'capture' }, args => ({ contents: args.path === 'runtime' ? `
            import * as monacoApi from 'monaco-editor/esm/vs/editor/editor.api';
            export {monacoApi};
            export const createMonacoWorker = () => ({});
        ` : args.path === 'editor' ? `
            export const captures = { registrations: [], definitions: new Map(), providers: new Map() };
            export const languages = {
                register: value => captures.registrations.push(value),
                setMonarchTokensProvider: (id, value) => captures.definitions.set(id, value),
                setTokensProvider: (id, value) => captures.providers.set(id, value)
            };
            export const editor = {};
        ` : args.path === 'vue' ? 'export const onBeforeUnmount = () => {};' : 'export default class TestWorker {};' }));
    } }],
});
const module = { exports: {} };
runInNewContext(built.outputFiles[0].text, { module, exports: module.exports, console, TextEncoder, TextDecoder, setTimeout, clearTimeout, URL, Buffer, process });
const api = module.exports;
const options = { indentSize: 2, arrayNewLine: true, preserveNumberLiterals: true, encodingMode: true };
const parseForConvert = text => api.prepareHighPrecisionConversion(api.parseJsonInput(text, options).data).data;

test('YAML restores the reported embedded text as a literal block scalar', async () => {
    const input = String.raw`{"expectedYaml":"name: Alice\nage: 30"}`;
    const output = await api.convertToYAML(parseForConvert(input));
    assert.equal(output, 'expectedYaml: |-\n  name: Alice\n  age: 30\n');
    assert.deepEqual(loadYaml(output), JSON.parse(input));
});

test('YAML default block chomping preserves the exact trailing newline count', async () => {
    for (const [value, header] of [['first\nsecond', '|-'], ['first\nsecond\n', '|'], ['first\nsecond\n\n', '|+']]) {
        const output = await api.convertToYAML({ value });
        assert.equal(output.split('\n')[0], `value: ${header}`);
        assert.deepEqual(loadYaml(output), { value });
    }
});

test('YAML preserves controls, quotes, literal escapes and Unicode with default scalar styles', async () => {
    const data = {
        text: 'first\nsecond\tend\r\n',
        controls: '\u0000\b\f',
        quotes: 'say "hello"',
        path: String.raw`C:\work\demo`,
        literalNewline: String.raw`\n`,
        nested: '{"note":"first\\nsecond"}',
        unicode: '中文🙂',
    };
    const output = await api.convertToYAML(data);
    assert.match(output, /text: "first\\nsecond\\tend\\r\\n"/);
    assert.match(output, /path: C:\\work\\demo/);
    assert.match(output, /literalNewline: \\n/);
    assert.deepEqual(loadYaml(output), data);
});

test('YAML retains types, nesting, field order and protected number literals', async () => {
    const data = { '中文 key': ['hello\nworld', { enabled: true, count: 2, nil: null, text: 'true' }], empty: '' };
    const output = await api.convertToYAML(data);
    assert.deepEqual(loadYaml(output), data);
    assert.match(output, /enabled: true/); assert.match(output, /count: 2/); assert.match(output, /text: "true"/);
    const context = api.prepareHighPrecisionConversion(api.parseJsonInput('{"id":9223372036854775807,"decimal":2.00,"neg":-0}', options).data);
    const converted = context.restoreOutput(await api.convertToYAML(context.data));
    assert.match(converted, /id: 9223372036854775807/);
    assert.match(converted, /decimal: 2\.00/);
    assert.match(converted, /neg: -0/);
});

test('YAML root strings, array strings and escaped field names round-trip', async () => {
    for (const value of ['first\nsecond', ['a\tb', String.raw`\n`], { 'line\nbreak': 'a\nb', 'quote"key': 'text', 'space key': 'value' }]) {
        const output = await api.convertToYAML(value);
        assert.deepEqual(loadYaml(output), value);
    }
});

test('XML displays the requested newline as literal backslash-n', async () => {
    const input = String.raw`{"expectedYaml":"name: Alice\nage: 30"}`;
    assert.equal(await api.convertToXML(parseForConvert(input)), '<?xml version="1.0" encoding="UTF-8"?>\n<root>\n  <expectedYaml>name: Alice\\nage: 30</expectedYaml>\n</root>');
});

test('XML displays JSON string escapes in values and still escapes XML markup', async () => {
    const value = 'first\r\nsecond\t"quoted"\\end\b\f\u0000<&>';
    const output = await api.convertToXML({ value, items: ['a\nb'], unicode: '中文🙂', enabled: true, count: 2, empty: null });
    const expected = JSON.stringify(value).slice(1, -1).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    assert.ok(output.includes(`<value>${expected}</value>`));
    assert.ok(output.includes('<item>a\\nb</item>'));
    assert.match(output, /<unicode>中文🙂<\/unicode>/);
    assert.match(output, /<enabled>true<\/enabled>/); assert.match(output, /<count>2<\/count>/); assert.match(output, /<empty\/>/);
});

test('XML distinguishes real newline from literal backslash-n and escapes Unicode line separators', async () => {
    const output = await api.convertToXML({ actual: 'a\nb', literal: String.raw`a\nb`, separators: 'a\u2028b\u2029c' });
    assert.ok(output.includes('<actual>a\\nb</actual>'));
    assert.ok(output.includes('<literal>a\\\\nb</literal>'));
    assert.ok(output.includes('<separators>a\\u2028b\\u2029c</separators>'));
});

const registry = api.useMonacoLanguageRegistry({ value: 'light' });
registry.ensureMonacoLanguageRegistered('yaml');
// Exercise the actual provider registered in production, passing each endState to the next line.
const tokenizer = api.captures.providers.get('yaml');
assert.ok(tokenizer, 'YAML registers its stateful TokensProvider');
const tokenize = (line, state = tokenizer.getInitialState()) => {
    const result = tokenizer.tokenize(line, state);
    return { tokens: result.tokens.map(token => ({ offset: token.startIndex, type: token.scopes })), endState: result.endState };
};
const tokenizeLines = source => {
    let state = tokenizer.getInitialState();
    return source.split('\n').map(line => {
        const result = tokenize(line, state);
        state = result.endState;
        return { line, ...result };
    });
};
const tokenAt = (tokens, position) => tokens.filter(token => token.offset <= position).at(-1)?.type;
const assertType = (line, text, type, tokens = tokenize(line).tokens) => {
    const start = line.indexOf(text); assert.ok(start >= 0);
    for (let index = start; index < start + text.length; index++) assert.equal(tokenAt(tokens, index), `${type}.yaml`, `${line} at ${index}`);
};
const assertBlockLine = row => assert.deepEqual(JSON.parse(JSON.stringify(row.tokens)), [{ offset: 0, type: 'string.yaml' }], row.line);

test('YAML registers once and highlights root, nested, array, Unicode and quoted keys', () => {
    registry.ensureMonacoLanguageRegistered('yaml');
    assert.equal(api.captures.registrations.filter(value => value.id === 'yaml').length, 1);
    for (const [line, key] of [['name: "Alice"', 'name'], ['  age: 30', 'age'], ['  - name: "Alice"', 'name'], ['中文字段: "值"', '中文字段'], ['"space key": "value"', '"space key"'], ['"quote\\"key": "value"', '"quote\\"key"']]) assertType(line, key, 'type');
});

test('YAML quoted text keeps hashes, colons and visible escape sequences inside the string', () => {
    for (const text of [String.raw`"name: Alice\nage: 30 # text"`, String.raw`"say \"hi\" \\path\tend"`, String.raw`'C:\'`, "'it''s # text'"]) {
        const line = `value: ${text} # comment`;
        assertType(line, text, 'string'); assertType(line, '# comment', 'comment');
    }
});

test('YAML scalar words and negative numbers are not partially colored as another type', () => {
    assertType('value: true story', 'true story', 'string');
    assertType('value: text#tag', 'text#tag', 'string');
    assertType('value: false', 'false', 'keyword');
    assertType('value: -2.5', '-2.5', 'number');
    assertType('value: 1.2e+3', '1.2e+3', 'number');
    assertType('value: .nan', '.nan', 'number');
});

test('YAML block styles keep blank lines, colons, hashes and quotes inside string tokens', () => {
    for (const header of ['|', '|-', '|+', '>', '>-', '>+']) {
        const rows = tokenizeLines(`value: ${header} # header comment

  name: Alice
  age:30
  # text, not a comment
  "quoted": 'value'
    - true
  tail

next: false`);
        assertType(rows[0].line, 'value', 'type', rows[0].tokens);
        assertType(rows[0].line, header, 'string', rows[0].tokens);
        assertType(rows[0].line, '# header comment', 'comment', rows[0].tokens);
        rows.slice(1, 9).forEach(assertBlockLine);
        assertType(rows[9].line, 'next', 'type', rows[9].tokens);
        assertType(rows[9].line, 'false', 'keyword', rows[9].tokens);
    }
});

test('YAML block indentation follows the first content line and restores sibling keys after dedent', () => {
    const rows = tokenizeLines('parent:\n  value: |-\n         \n\n      name: Alice\n        # deeper text\n      "quoted": false\n  sibling: true\nnext: 2');
    rows.slice(2, 7).forEach(assertBlockLine);
    assertType(rows[7].line, 'sibling', 'type', rows[7].tokens);
    assertType(rows[7].line, 'true', 'keyword', rows[7].tokens);
    assertType(rows[8].line, 'next', 'type', rows[8].tokens);
    assertType(rows[8].line, '2', 'number', rows[8].tokens);
});

test('YAML explicit block indentation accepts both indicator orders and more-indented first content', () => {
    for (const [header, width] of [['|2-', 2], ['|-2', 2], ['>3+', 3], ['>+3', 3]]) {
        const padding = ' '.repeat(2 + width);
        const rows = tokenizeLines(`parent:
  value: ${header}
${padding}  first: text
${padding}# still text
  sibling: true`);
        rows.slice(2, 4).forEach(assertBlockLine);
        assertType(rows[4].line, 'sibling', 'type', rows[4].tokens);
        assertType(rows[4].line, 'true', 'keyword', rows[4].tokens);
    }
});

test('YAML array, compact mapping, nested array and root blocks preserve text across lines', () => {
    const array = tokenizeLines('- |-\n  name: Alice\n  # text\n- value: >-\n    "quoted": false\n  sibling: true\n- - |+\n    content: true\n  - next: false');
    [1, 2, 4, 7].forEach(index => assertBlockLine(array[index]));
    assertType(array[3].line, 'value', 'type', array[3].tokens);
    assertType(array[5].line, 'sibling', 'type', array[5].tokens);
    assertType(array[8].line, 'next', 'type', array[8].tokens);
    const root = tokenizeLines('|-\n\n  name: Alice\n    # still text\n  "quote": true\n---\nnext: false');
    root.slice(1, 5).forEach(assertBlockLine);
    assertType(root[6].line, 'next', 'type', root[6].tokens);
});

test('YAML block headers on a separate line inherit their parent indentation through blank lines and comments', () => {
    const rows = tokenizeLines('value:\n\n# comment\n  |2-\n  name: Alice\n    # text\nnext: true');
    rows.slice(4, 6).forEach(assertBlockLine);
    assertType(rows[6].line, 'next', 'type', rows[6].tokens);
    const array = tokenizeLines('-\n  >-\n  text: value\n- next: false');
    assertBlockLine(array[2]);
    assertType(array[3].line, 'next', 'type', array[3].tokens);
});

test('YAML ordinary scalars, quoted indicators and comments do not start block state', () => {
    for (const first of ['value: text |', 'value: plain >-', 'value: "|"', "value: '>-#'", '# |-', 'value: | not a header', 'value: |# not a header', 'value: |22', 'value: ||']) {
        const rows = tokenizeLines(`${first}\n  sibling: true`);
        assertType(rows[1].line, 'sibling', 'type', rows[1].tokens);
        assertType(rows[1].line, 'true', 'keyword', rows[1].tokens);
    }
});

test('YAML tokenizer states clone, compare and remain immutable for incremental tokenization', () => {
    const initial = tokenizer.getInitialState();
    const initialClone = initial.clone();
    assert.ok(initial.equals(initialClone));
    assert.ok(initialClone.equals(initial));
    const pending = tokenize('parent:', initial).endState;
    assert.ok(!pending.equals(initial));
    const header = tokenize('value: |-', initial).endState;
    const headerClone = header.clone();
    assert.ok(header.equals(headerClone));
    assert.ok(!header.equals(initial));
    const body = tokenize('  name: Alice', header).endState;
    assert.ok(header.equals(headerClone), 'tokenizing a line does not mutate the incoming state');
    assert.ok(!body.equals(header), 'first content line determines a new indentation state');
    assert.ok(body.equals(body.clone()));
    const sameBody = tokenize('    # text', body).endState;
    assert.ok(sameBody.equals(body));
    const deeperBody = tokenize('    name: Alice', headerClone).endState;
    assert.ok(!deeperBody.equals(body));
    const afterBlock = tokenize('next: true', body).endState;
    assert.ok(afterBlock.equals(initial));
    assert.ok(body.equals(sameBody), 'dedenting does not mutate the previous block state');
});

test('actual YAML conversion output retains block text, array strings and nested key highlighting', async () => {
    const output = await api.convertToYAML({ nested: { expectedYaml: 'name: Alice\nage: 30' }, values: ['first\nsecond', 'a\tb'] });
    const rows = tokenizeLines(output);
    const headerIndex = rows.findIndex(row => row.line.includes('expectedYaml:'));
    assertType(rows[headerIndex].line, 'expectedYaml', 'type', rows[headerIndex].tokens);
    assertType(rows[headerIndex].line, '|-', 'string', rows[headerIndex].tokens);
    rows.slice(headerIndex + 1, headerIndex + 3).forEach(assertBlockLine);
    const valuesIndex = rows.findIndex(row => row.line.startsWith('values:'));
    assertType(rows[valuesIndex].line, 'values', 'type', rows[valuesIndex].tokens);
    assertType(rows[valuesIndex + 1].line, '|-', 'string', rows[valuesIndex + 1].tokens);
    rows.slice(valuesIndex + 2, valuesIndex + 4).forEach(assertBlockLine);
    assertType(rows[valuesIndex + 4].line, String.raw`"a\tb"`, 'string', rows[valuesIndex + 4].tokens);
});
